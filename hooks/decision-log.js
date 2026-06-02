#!/usr/bin/env node
// decision-log.js — Viewer for the decision log
// Usage: node decision-log.js [command] [options]
//   node decision-log.js              — show last 20 entries
//   node decision-log.js --all        — show all entries
//   node decision-log.js --failures   — show only failures
//   node decision-log.js --summary    — show stats summary
//   node decision-log.js --reset      — clear breaker state
//   node decision-log.js --clear-log  — clear decision log

'use strict';

const fs = require('fs');
const { paths, CFG } = require('./lib/common');

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const failuresOnly = args.includes('--failures');
const summary = args.includes('--summary');
const reset = args.includes('--reset');
const clearLog = args.includes('--clear-log');

const LOG_FILE = paths().LOG_FILE;
const STATE_FILE = paths().STATE_FILE;

if (reset) {
  try {
    fs.writeFileSync(STATE_FILE, '{}');
    console.log('Breaker state reset.');
  } catch (e) {
    console.error('Failed to reset:', e.message);
  }
  process.exit(0);
}

if (clearLog) {
  try {
    fs.writeFileSync(LOG_FILE, '');
    console.log('Decision log cleared.');
  } catch (e) {
    console.error('Failed to clear log:', e.message);
  }
  process.exit(0);
}

function readLog() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8')
      .split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const entries = readLog();

if (entries.length === 0) {
  console.log('No decisions logged yet.');
  process.exit(0);
}

if (summary) {
  const total = entries.length;
  const failures = entries.filter(e => !e.ok).length;
  const categories = {};
  const failCategories = {};

  for (const e of entries) {
    categories[e.category] = (categories[e.category] || 0) + 1;
    if (!e.ok) failCategories[e.category] = (failCategories[e.category] || 0) + 1;
  }

  console.log(`\n=== Decision Log Summary ===\n`);
  console.log(`Total decisions: ${total}`);
  console.log(`Failures: ${failures} (${(failures/total*100).toFixed(1)}%)`);
  console.log(`Successes: ${total - failures}`);
  console.log(`\nTop commands:`);
  Object.entries(categories).sort((a,b) => b[1]-a[1]).slice(0, 10).forEach(([k,v]) => {
    const f = failCategories[k] || 0;
    console.log(`  ${v}x  ${k}${f > 0 ? `  (${f} fail)` : ''}`);
  });

  // Active breakers
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const threshold = CFG.failThreshold;
    const active = Object.entries(state).filter(([,v]) => v.count > 0);
    if (active.length > 0) {
      console.log(`\nActive breaker state:`);
      active.forEach(([fp, v]) => {
        console.log(`  ${v.count}/${threshold}  ${v.category}  ${(v.cmd || '').slice(0, 60)}`);
      });
    }
  } catch {}

  process.exit(0);
}

// Display entries
const filtered = failuresOnly ? entries.filter(e => !e.ok) : entries;
const shown = showAll ? filtered : filtered.slice(-20);

for (const e of shown) {
  const icon = e.ok ? '+' : 'x';
  const ts = e.ts.replace('T', ' ').slice(0, 19);
  const cmd = e.cmd.slice(0, 80);
  console.log(`[${icon}] ${ts}  ${cmd}`);
  if (!e.ok && e.err) {
    console.log(`    -> ${e.err.slice(0, 120)}`);
  }
}

if (!showAll && filtered.length > 20) {
  console.log(`\n... ${filtered.length - 20} more entries. Use --all to see all.`);
}
