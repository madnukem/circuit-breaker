#!/usr/bin/env node
// regression.test.js — Bug fix verification + regression

const { createSuite, createTestRunner } = require('./helpers');
const { test, assert, results } = createTestRunner();
const { sendEvent, cleanState, cleanLog, cleanAll, readState, readStateRaw,
        writeState, getActualFp, stateFile, logFile, cleanup } = createSuite('reg');
const fs = require('fs');

const MAX_LOG = 5 * 1024 * 1024;

// ══════════════════════════════════════════════════════════════════════════════
// BUG 1: Single decay — applied ONCE, not twice
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══ BUG 1: Single decay point ══╗\n');

test('decay NOT applied when halfLife < 1 (3min < 5min decay)', () => {
  cleanAll();
  const cmd = 'mvn clean compile';
  const failOut = 'ERROR: compilation failed\nexit code 1';
  const fp = getActualFp(cmd, failOut);
  cleanState(); cleanLog();

  writeState({ [fp]: { count: 2, lastFail: Date.now() - 3 * 60 * 1000, category: 'mvn clean compile', cmd } });
  sendEvent({ tool_name: 'Bash', tool_input: { command: cmd }, tool_output: failOut });
  assert(readState()[fp].count === 3, `halfLife<1: no decay. Expected 3, got ${readState()[fp].count}`);
});

test('decay IS applied when halfLife >= 1 (12min, 2.4 halfLives)', () => {
  cleanAll();
  const cmd = 'gradle build';
  const failOut = 'FAILURE: Build failed\nexit code 1';
  const fp = getActualFp(cmd, failOut);
  cleanState(); cleanLog();

  writeState({ [fp]: { count: 6, lastFail: Date.now() - 12 * 60 * 1000, category: 'gradle build', cmd } });
  sendEvent({ tool_name: 'Bash', tool_input: { command: cmd }, tool_output: failOut });
  assert(readState()[fp].count === 2, `Expected 2, got ${readState()[fp].count}. If 1 → double decay bug!`);
});

test('fresh entries: no decay, count increments linearly', () => {
  cleanAll();
  const cmd = 'docker build -t app .';
  const failOut = 'ERROR: failed to solve\nexit code 1';
  const fp = getActualFp(cmd, failOut);
  cleanState(); cleanLog();

  writeState({ [fp]: { count: 2, lastFail: Date.now(), category: 'docker build -t', cmd } });
  sendEvent({ tool_name: 'Bash', tool_input: { command: cmd }, tool_output: failOut });
  assert(readState()[fp].count === 3, `Fresh: expected 3`);
});

// ══════════════════════════════════════════════════════════════════════════════
// BUG 2: Rotation always checks
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══ BUG 2: Rotation always checks ══╗\n');

test('rotation triggers when log exceeds 5MB', () => {
  cleanAll();
  const line = JSON.stringify({ ts: '2026-01-01T00:00:00Z', tool: 'Bash', cmd: 'x'.repeat(200), ok: true, category: 'x' }) + '\n';
  const bigChunk = line.repeat(Math.ceil(MAX_LOG / line.length) + 100);
  fs.writeFileSync(logFile, bigChunk);
  const before = fs.statSync(logFile).size;
  assert(before > MAX_LOG);
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'BUILD SUCCESS' });
  assert(fs.statSync(logFile).size < before, `Log should shrink`);
});

// ══════════════════════════════════════════════════════════════════════════════
// BUG 3: Atomic write
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══ BUG 3: Atomic state write ══╗\n');

test('state valid JSON after 10 writes', () => {
  cleanAll();
  for (let i = 0; i < 10; i++) {
    sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' },
      tool_output: i % 2 === 0 ? 'FAIL\nexit code 1' : 'OK' });
  }
  JSON.parse(readStateRaw());
});

test('no .tmp file left behind', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'FAIL\nexit code 1' });
  assert(!fs.existsSync(stateFile + '.tmp'), 'No temp file');
});

test('survives 50 rapid writes', () => {
  cleanAll();
  for (let i = 0; i < 50; i++) {
    sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm test' },
      tool_output: i % 4 === 0 ? 'FAIL\nexit code 1' : 'OK' });
  }
  const raw = readStateRaw();
  assert(raw === JSON.stringify(JSON.parse(raw)), 'Valid JSON');
});

// ══════════════════════════════════════════════════════════════════════════════
// BUG 4: Graceful error handling
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══ BUG 4: Graceful errors ══╗\n');

test('state is directory → hook survives', () => {
  try { fs.unlinkSync(stateFile); } catch {}
  try { fs.mkdirSync(stateFile, { recursive: true }); } catch {}
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'OK' }).exitCode === 0);
  try { fs.rmSync(stateFile, { recursive: true }); } catch {}
});

test('log is directory → hook survives', () => {
  cleanState();
  try { fs.unlinkSync(logFile); } catch {}
  try { fs.mkdirSync(logFile, { recursive: true }); } catch {}
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'FAIL\nexit code 1' }).exitCode === 0);
  try { fs.rmSync(logFile, { recursive: true }); } catch {}
});

test('missing state → creates new', () => {
  try { fs.unlinkSync(stateFile); } catch {}
  try { fs.unlinkSync(stateFile + '.tmp'); } catch {}
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'FAIL\nexit code 1' });
  assert(fs.existsSync(stateFile));
  JSON.parse(readStateRaw());
});

test('corrupted state → recovers', () => {
  fs.writeFileSync(stateFile, '}}}broken{');
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'FAIL\nexit code 1' }).exitCode === 0);
  JSON.parse(readStateRaw());
});

// ══════════════════════════════════════════════════════════════════════════════
// BUG 5: Same decay for success and failure
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══ BUG 5: Consistent decay ══╗\n');

test('success and failure use same applyDecay function', () => {
  cleanAll();
  const cmd = 'npm test';
  const failOut = 'FAIL tests\nexit code 1';
  const ffp = getActualFp(cmd, failOut);
  cleanState(); cleanLog();

  const twelveMinAgo = Date.now() - 12 * 60 * 1000;
  const sfp = 's:Bash:npm test';
  const state = {};
  if (ffp) state[ffp] = { count: 8, lastFail: twelveMinAgo, category: 'npm test', cmd };
  state[sfp] = { count: 8, lastRun: twelveMinAgo, category: 'npm test', cmd };
  writeState(state);

  sendEvent({ tool_name: 'Bash', tool_input: { command: cmd }, tool_output: failOut });
  const after = readState();
  assert(after[ffp] && after[ffp].count === 2, `Failure: expected 2, got ${after[ffp]?.count}`);
  assert(after[sfp] && after[sfp].count === 8, `Success: expected 8 (untouched), got ${after[sfp]?.count}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// REGRESSION
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══ REGRESSION ══╗\n');

test('failure loop breaker', () => {
  cleanAll();
  const f = 'ERROR: failed\nexit code 1';
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' }, tool_output: f });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' }, tool_output: f });
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' }, tool_output: f }).exitCode === 2);
});

test('suspicious success breaker', () => {
  cleanAll();
  const ok = 'OK\nexit code 0';
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' }, tool_output: ok });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' }, tool_output: ok });
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' }, tool_output: ok }).exitCode === 2);
});

test('different errors → different fingerprints', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn install' }, tool_output: 'ERROR] compiler plugin\nexit code 1' });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn install' }, tool_output: 'ERROR] surefire: tests failed\nexit code 1' });
  assert(Object.keys(readState()).filter(k => k.startsWith('f:')).length === 2);
});

test('success resets failures', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'gradle build' }, tool_output: 'FAIL\nexit code 1' });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'gradle build' }, tool_output: 'FAIL\nexit code 1' });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'gradle build' }, tool_output: 'BUILD SUCCESS' });
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'gradle build' }, tool_output: 'FAIL\nexit code 1' }).exitCode === 0);
});

test('alternating fail/success: suspicious success fires on 3rd success', () => {
  cleanAll();
  const rs = [];
  for (let i = 0; i < 6; i++) {
    rs.push(sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm test' },
      tool_output: i % 2 === 0 ? 'FAIL\nexit code 1' : 'OK\nexit code 0' }));
  }
  assert(rs[5].exitCode === 2, `3rd success should trip`);
  assert(rs.slice(0, 5).every(r => r.exitCode === 0), `First 5 should pass`);
});

cleanAll();
cleanup();
process.exit(results() > 0 ? 1 : 0);
