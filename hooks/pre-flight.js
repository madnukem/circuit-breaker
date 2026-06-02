#!/usr/bin/env node
// pre-flight.js — PreToolUse hook. Gates commands when breaker is OPEN.
// OPEN + blockCount=0 → block (exit 2) with forced recovery prompt
// OPEN + blockCount=1 → transition to HALF-OPEN, allow one probe
// HALF-OPEN → allow (PostToolUse handles result)
// CLOSED / no breaker → allow

'use strict';

const {
  CFG, shouldSkip, commandCategory, breakerKey, checkHalfOpenTimeout,
  withLock, loadState, saveState,
} = require('./lib/common');

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

  const category = commandCategory(cmd);
  const tool = 'Bash';
  const bkKey = breakerKey(tool, category);

  withLock(() => {
    const data = loadState();
    const breaker = data[bkKey] || null;

    if (!breaker || breaker.status === 'closed') {
      process.exit(0);
      return;
    }

    if (breaker.status === 'open') {
      if (breaker.blockCount === 0) {
        // First attempt after trip — block and demand recovery plan
        breaker.blockCount = 1;
        data[bkKey] = breaker;
        saveState(data);

        const reason = breaker.reason === 'suspicious-success'
          ? `"${category}" succeeded ${breaker.count} times without verification.`
          : `"${category}" failed ${breaker.count} consecutive times.`;

        process.stderr.write([
          '',
          '╔══════════════════════════════════════════════════════════╗',
          '║          CIRCUIT BREAKER: BLOCKED (OPEN)                ║',
          '╠══════════════════════════════════════════════════════════╣',
          `║  ${reason.padEnd(56)}║`,
          '║                                                          ║',
          '║  Before retrying, you MUST:                             ║',
          '║  1. Identify the ROOT CAUSE (not the symptom)           ║',
          '║  2. Articulate a RECOVERY PLAN                          ║',
          '║  3. Verify PREREQUISITES are met                         ║',
          '║                                                          ║',
          '║  One probe attempt will be allowed after this block.    ║',
          '╚══════════════════════════════════════════════════════════╝',
          '',
        ].join('\n'));
        process.exit(2);
        return;
      }

      // Second attempt — transition to HALF-OPEN, allow one probe
      breaker.status = 'half-open';
      breaker.blockCount = 0;
      breaker.since = Date.now();
      data[bkKey] = breaker;
      saveState(data);

      process.stderr.write(
        `[CIRCUIT BREAKER] Probe allowed for "${category}". Breaker is HALF-OPEN.\n`
      );
      process.exit(0);
      return;
    }

    if (breaker.status === 'half-open') {
      if (checkHalfOpenTimeout(breaker, Date.now())) {
        data[bkKey] = breaker;
        saveState(data);
        process.stderr.write(
          `[CIRCUIT BREAKER] HALF-OPEN probe timed out for "${category}". Back to OPEN.\n`
        );
        process.exit(2);
        return;
      }
      // Allow — PostToolUse will handle the result
      process.exit(0);
      return;
    }

    process.exit(0);
  });
}

main();
