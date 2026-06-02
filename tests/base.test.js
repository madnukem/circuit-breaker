#!/usr/bin/env node
// base.test.js — Core circuit breaker tests

const { createSuite, createTestRunner } = require('./helpers');
const { test, assert, results } = createTestRunner();
const { sendEvent, cleanState, cleanLog, writeState, readState, cleanup } = createSuite('base');

cleanState(); cleanLog();

console.log('\nTesting circuit-breaker.js (enhanced)\n');

test('success exits 0', () => {
  const r = sendEvent({
    tool_name: 'Bash',
    tool_input: { command: 'docker build -t app .' },
    tool_output: 'Successfully built abc123\nSuccessfully tagged app:latest',
  });
  assert(r.exitCode === 0, `Expected exit 0, got ${r.exitCode}`);
});

test('skips git status', () => {
  const r = sendEvent({
    tool_name: 'Bash', tool_input: { command: 'git status' },
    tool_output: 'On branch main',
  });
  assert(r.exitCode === 0, `Expected exit 0, got ${r.exitCode}`);
});

test('skips Read tool', () => {
  const r = sendEvent({
    tool_name: 'Read', tool_input: { file_path: '/some/file' },
    tool_output: 'file contents',
  });
  assert(r.exitCode === 0, `Expected exit 0, got ${r.exitCode}`);
});

// ── Failure Loop Detection ──────────────────────────────────────────────────

test('first failure exits 0 (no trip)', () => {
  cleanState(); cleanLog();
  const r = sendEvent({
    tool_name: 'Bash', tool_input: { command: 'docker build -t app .' },
    tool_output: 'ERROR: failed to solve: process "/bin/sh -c npm install" did not complete successfully: exit code 1',
  });
  assert(r.exitCode === 0, `Expected exit 0, got ${r.exitCode}`);
});

test('second failure shows warning', () => {
  const r = sendEvent({
    tool_name: 'Bash', tool_input: { command: 'docker build -t app .' },
    tool_output: 'ERROR: failed to solve: process "/bin/sh -c npm install" did not complete successfully: exit code 1',
  });
  assert(r.exitCode === 0, `Expected exit 0, got ${r.exitCode}`);
  assert(r.stderr.includes('WARNING'), `Expected WARNING, got: ${r.stderr.slice(0, 200)}`);
});

test('third failure trips breaker (exit 2)', () => {
  const r = sendEvent({
    tool_name: 'Bash', tool_input: { command: 'docker build -t app .' },
    tool_output: 'ERROR: failed to solve: process "/bin/sh -c npm install" did not complete successfully: exit code 1',
  });
  assert(r.exitCode === 2, `Expected exit 2, got ${r.exitCode}`);
  assert(r.stderr.includes('FAILURE LOOP'), `Expected FAILURE LOOP, got: ${r.stderr.slice(0, 200)}`);
});

test('different error starts fresh counter', () => {
  cleanState(); cleanLog();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn clean install' }, tool_output: 'BUILD FAILURE\nexit code 1' });
  const r = sendEvent({
    tool_name: 'Bash', tool_input: { command: 'mvn clean install' },
    tool_output: 'COMPILATION ERROR : cannot find symbol\nexit code 1',
  });
  assert(r.exitCode === 0, `Expected exit 0 for different error, got ${r.exitCode}`);
});

test('success resets failure breaker', () => {
  cleanState(); cleanLog();
  const fp = 'f:Bash:mvn clean install:abc12345';
  writeState({ [fp]: { count: 2, lastFail: Date.now(), category: 'mvn clean install', cmd: 'mvn clean install' } });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn clean install' }, tool_output: 'BUILD SUCCESS' });
  const state = readState();
  assert(!state[fp], `Failure breaker should be cleared after success`);
});

// ── Suspicious Success Detection ────────────────────────────────────────────

test('first consequential success exits 0', () => {
  cleanState(); cleanLog();
  const r = sendEvent({
    tool_name: 'Bash', tool_input: { command: 'npm run test' },
    tool_output: 'Tests: 12 passed, 0 failed\nexit code 0',
  });
  assert(r.exitCode === 0, `Expected exit 0, got ${r.exitCode}`);
});

test('second consequential success exits 0 (warning zone)', () => {
  const r = sendEvent({
    tool_name: 'Bash', tool_input: { command: 'npm run test' },
    tool_output: 'Tests: 12 passed, 0 failed\nexit code 0',
  });
  assert(r.exitCode === 0, `Expected exit 0, got ${r.exitCode}`);
});

test('third consequential success trips suspicious success breaker', () => {
  const r = sendEvent({
    tool_name: 'Bash', tool_input: { command: 'npm run test' },
    tool_output: 'Tests: 12 passed, 0 failed\nexit code 0',
  });
  assert(r.exitCode === 2, `Expected exit 2, got ${r.exitCode}`);
  assert(r.stderr.includes('SUSPICIOUS SUCCESS'), `Expected SUSPICIOUS SUCCESS, got: ${r.stderr.slice(0, 200)}`);
});

test('non-consequential success not tracked', () => {
  cleanState(); cleanLog();
  for (let i = 0; i < 5; i++) {
    const r = sendEvent({ tool_name: 'Bash', tool_input: { command: 'echo hello' }, tool_output: 'hello' });
    assert(r.exitCode === 0, `Expected exit 0 on echo run ${i+1}, got ${r.exitCode}`);
  }
});

test('docker build success tracked as consequential', () => {
  cleanState(); cleanLog();
  for (let i = 0; i < 2; i++) {
    sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t myapp .' }, tool_output: 'Successfully built abc' });
  }
  const r = sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t myapp .' }, tool_output: 'Successfully built abc' });
  assert(r.exitCode === 2, `Expected exit 2 on 3rd docker build, got ${r.exitCode}`);
});

cleanup();
process.exit(results() > 0 ? 1 : 0);
