#!/usr/bin/env node
// circuit-breaker.js — PostToolUse hook. State machine: CLOSED → OPEN → HALF-OPEN → CLOSED.
// Manages failure/success counting, breaker transitions, and decision logging.

'use strict';

const {
  CFG, CONSEQUENTIAL, shouldSkip, commandCategory, detectFailure,
  applyDecay, checkHalfOpenTimeout, failKey, successKey, breakerKey,
  extractErrorPreview, appendLog, pruneTtl,
  withLock, loadState, saveState,
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
  // Reset failure fingerprints
  const fpPrefix = `f:${tool}:${category}:`;
  for (const k of Object.keys(data)) {
    if (k.startsWith(fpPrefix)) delete data[k];
  }
  // Reset success counter
  data[successKey(tool, category)] = { count: 0, lastRun: 0, category, cmd: '' };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    try { run(JSON.parse(chunks.join(''))); }
    catch { process.exit(0); }
  });
}

function run(event) {
  if (event.tool_name !== 'Bash') { process.exit(0); return; }

  const cmd = (event.tool_input && event.tool_input.command) || '';
  if (!cmd || shouldSkip(cmd)) { process.exit(0); return; }

  const output = typeof event.tool_output === 'string'
    ? event.tool_output
    : (event.tool_output ? JSON.stringify(event.tool_output) : '');

  const failed = detectFailure(output);
  const category = commandCategory(cmd);
  const tool = 'Bash';
  const now = Date.now();
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
      cmd: cmd.slice(0, 300), ok: !failed, category,
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

  if (entry.count === CFG.failThreshold - 1) {
    process.stderr.write(
      `[BREAKER WARNING] "${category}" failed ${entry.count}/${CFG.failThreshold}. ` +
      `One more failure will trip the breaker.\n`
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
  const fpPrefix = `f:${tool}:${category}:`;
  for (const k of Object.keys(data)) {
    if (k.startsWith(fpPrefix)) delete data[k];
  }

  // Suspicious success for consequential commands
  let isConseq = false;
  for (let i = 0; i < CONSEQUENTIAL.length; i++) {
    if (CONSEQUENTIAL[i].test(cmd)) { isConseq = true; break; }
  }

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
      openBreaker(data, tool, category, 'suspicious-success', sEntry.count, cmd, null);
      saveState(data);
      process.stderr.write([
        '',
        '=== CIRCUIT BREAKER: SUSPICIOUS SUCCESS ===',
        '',
        `"${category}" has been run ${sEntry.count} times with exit 0.`,
        `Breaker is now OPEN. Before rerunning, add observability.`,
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

main();
