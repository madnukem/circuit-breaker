#!/usr/bin/env node
// circuit-breaker.js — PostToolUse hook. State machine: CLOSED → OPEN → HALF-OPEN → CLOSED.
// Manages failure/success counting, breaker transitions, and decision logging.

'use strict';

const {
  CFG, CONSEQUENTIAL, shouldSkip, commandCategory, detectFailure,
  applyDecay, checkHalfOpenTimeout, failKey, successKey, breakerKey,
  extractErrorPreview, appendLog, pruneTtl,
  withLock, loadState, saveState, readStdin,
  extractMetrics, hasProgress,
  detectObservabilityGap, recordReadCommand,
  resetFingerprints, matchesAny,
} = require('./lib/common');

// ── State Machine Transitions ───────────────────────────────────────────────

function openBreaker(data, tool, category, reason, count, cmd, errPreview) {
  data[breakerKey(tool, category)] = {
    status: 'open',
    since: Date.now(),
    reason,
    count,
    cmd: cmd.slice(0, 100),
    errPreview: errPreview || null,
    blockCount: 0,
  };
}

function closeBreaker(data, tool, category) {
  delete data[breakerKey(tool, category)];
  resetFingerprints(data, tool, category);
  // Reset success counter
  data[successKey(tool, category)] = { count: 0, lastRun: 0, category, cmd: '' };
}

// ── Main ────────────────────────────────────────────────────────────────────

function run(event) {
  if (event.tool_name !== 'Bash') { process.exit(0); return; }

  const cmd = (event.tool_input && event.tool_input.command) || '';
  if (!cmd) { process.exit(0); return; }

  const category = commandCategory(cmd);
  const tool = 'Bash';
  const now = Date.now();

  // Track read commands for observability gap detection before early return
  if (shouldSkip(cmd)) {
    withLock(() => {
      const data = loadState();
      recordReadCommand(data, tool, category, now);
      saveState(data);
    });
    process.exit(0);
    return;
  }

  const output = typeof event.tool_output === 'string'
    ? event.tool_output
    : (event.tool_output ? JSON.stringify(event.tool_output) : '');

  const failed = detectFailure(output);
  const errPreview = failed ? extractErrorPreview(output) : null;

  withLock(() => {
    const data = loadState();
    pruneTtl(data);

    const bkKey = breakerKey(tool, category);
    const breaker = data[bkKey] || null;

    // HALF-OPEN timeout: if stuck without resolution, revert to OPEN
    checkHalfOpenTimeout(breaker, now);

    // Log decision
    appendLog({
      ts: new Date(now).toISOString(), tool,
      cmd, ok: !failed, category,
      ...(failed && errPreview ? { err: errPreview } : {}),
    });

    if (failed) {
      onFailed(data, tool, category, breaker, cmd, output, errPreview, now);
    } else {
      onSuccess(data, tool, category, breaker, cmd, now);
    }
  });
}

// ── Failure Handler ──────────────────────────────────────────────────────────

function onFailed(data, tool, category, breaker, cmd, output, errPreview, now) {
  // HALF-OPEN + failure → back to OPEN
  if (breaker && breaker.status === 'half-open') {
    openBreaker(data, tool, category, breaker.reason, breaker.count, cmd, errPreview);
    saveState(data);
    process.stderr.write([
      '',
      '=== CIRCUIT BREAKER: PROBE FAILED ===',
      '',
      `Probe attempt for "${category}" FAILED.`,
      `Error: ${errPreview}`,
      '',
      'Breaker stays OPEN. Articulate a DIFFERENT plan before retrying.',
      '======================================',
      '',
    ].join('\n'));
    process.exit(2);
    return;
  }

  // Normal failure counting
  const fp = failKey(tool, cmd, output);
  let entry = data[fp];
  if (!entry) entry = { count: 0, lastFail: 0, category, cmd: cmd.slice(0, 100) };

  // Check for numerical progress (e.g., 112→57→11 failing tests)
  const metricsKey = `metrics:${tool}:${category}`;
  const currentMetrics = extractMetrics(output);
  if (currentMetrics) {
    const prevMetrics = data[metricsKey];
    if (prevMetrics && hasProgress(prevMetrics, currentMetrics)) {
      // Progress detected — log but don't increment counter
      data[metricsKey] = currentMetrics;
      saveState(data);
      process.stderr.write(
        `[BREAKER] Progress detected for "${category}": metrics improving. Counter not incremented.\n`
      );
      process.exit(0);
      return;
    }
    data[metricsKey] = currentMetrics;
  }

  applyDecay(entry, now);
  entry.count++;
  entry.lastFail = now;
  entry.cmd = cmd.slice(0, 100);
  data[fp] = entry;

  // CLOSED → OPEN when threshold reached
  if (entry.count >= CFG.failThreshold && (!breaker || breaker.status === 'closed')) {
    openBreaker(data, tool, category, 'failure-loop', entry.count, entry.cmd, errPreview);
    saveState(data);
    process.stderr.write([
      '',
      '=== CIRCUIT BREAKER TRIPPED: FAILURE LOOP ===',
      '',
      `"${category}" failed ${entry.count} consecutive times.`,
      `Error: ${errPreview}`,
      '',
      'Breaker is now OPEN. You MUST articulate a recovery plan before retrying.',
      '=============================================',
      '',
    ].join('\n'));
    process.exit(2);
    return;
  }

  const gapDetected = detectObservabilityGap(data, tool, category, now);
  if (entry.count === CFG.failThreshold - 1) {
    const gapMsg = gapDetected
      ? '\n[BREAKER HINT] No read/debug commands between retries. Add observability before retrying.'
      : '';
    process.stderr.write(
      `[BREAKER WARNING] "${category}" failed ${entry.count}/${CFG.failThreshold}. ` +
      `One more failure will trip the breaker.${gapMsg}\n`
    );
  }

  saveState(data);
  process.exit(0);
}

// ── Success Handler ──────────────────────────────────────────────────────────

function onSuccess(data, tool, category, breaker, cmd, now) {
  // HALF-OPEN + success → CLOSED
  if (breaker && breaker.status === 'half-open') {
    closeBreaker(data, tool, category);
    saveState(data);
    process.stderr.write(
      `[CIRCUIT BREAKER] Probe succeeded for "${category}". Breaker CLOSED.\n`
    );
    process.exit(0);
    return;
  }

  // Reset failure fingerprints on success
  resetFingerprints(data, tool, category);

  // Suspicious success for consequential commands
  const isConseq = matchesAny(cmd, CONSEQUENTIAL);

  if (isConseq) {
    const sfp = successKey(tool, cmd);
    let sEntry = data[sfp];
    if (!sEntry) sEntry = { count: 0, lastRun: 0, category, cmd: cmd.slice(0, 100) };

    applyDecay(sEntry, now);
    sEntry.count++;
    sEntry.lastRun = now;
    sEntry.cmd = cmd.slice(0, 100);
    data[sfp] = sEntry;

    if (sEntry.count >= CFG.successThreshold && (!breaker || breaker.status === 'closed')) {
      const gap = detectObservabilityGap(data, tool, category, now);
      openBreaker(data, tool, category, 'suspicious-success', sEntry.count, cmd, null);
      saveState(data);
      const gapHint = gap
        ? '\nNo read/debug commands between retries. Add logging, read output files, or check runtime state.'
        : '';
      process.stderr.write([
        '',
        '=== CIRCUIT BREAKER: SUSPICIOUS SUCCESS ===',
        '',
        `"${category}" has been run ${sEntry.count} times with exit 0.`,
        `Breaker is now OPEN. Before rerunning, add observability.${gapHint}`,
        '===========================================',
        '',
      ].join('\n'));
      process.exit(2);
      return;
    }
  }

  saveState(data);
  process.exit(0);
}

readStdin(run);