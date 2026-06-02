#!/usr/bin/env node
// state-machine.test.js — Tests for CLOSED → OPEN → HALF-OPEN → CLOSED transitions

const { createSuite, createTestRunner } = require('./helpers');
const { sendEvent, sendPreEvent, cleanState, cleanLog, readState, writeState, cleanup } = createSuite('sm');
const fs = require('fs');

const { test, assert, results } = (() => {
  let passed = 0, failed = 0;
  const passedList = [], failedList = [];
  function test(name, fn) {
    try { fn(); console.log(`  PASS: ${name}`); passedList.push(name); passed++; }
    catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failedList.push(name + ` — ${e.message}`); failed++; }
  }
  function assert(cond, msg, detail) { if (!cond) throw new Error((msg || 'Assertion failed') + (detail ? ` — ${detail}` : '')); }
  function results() { console.log(`\nPassed: ${passed}\nFailed: ${failed}\n`); return failed; }
  return { test, assert, results };
})();

function makeBashEvent(cmd, output) {
  return { tool_name: 'Bash', tool_input: { command: cmd }, tool_output: output || '' };
}

// T1: CLOSED → OPEN via failure threshold
cleanState(); cleanLog();
(function() {
  test('T1: CLOSED → OPEN via failure threshold', () => {
    const cmd = 'docker build -t app .';
    const err = 'ERROR: failed to solve: process exited with code 1';
    for (let i = 0; i < 3; i++) sendEvent(makeBashEvent(cmd, err));
    const bk = readState()['brk:Bash:docker build -t'];
    assert(bk && bk.status === 'open', 'status=open', JSON.stringify(bk));
    assert(bk && bk.reason === 'failure-loop', 'reason=failure-loop');
    assert(bk && bk.count === 3, 'count=3');
  });
})();

// T2: CLOSED → OPEN via suspicious success
cleanState(); cleanLog();
(function() {
  test('T2: CLOSED → OPEN via suspicious success', () => {
    for (let i = 0; i < 3; i++) sendEvent(makeBashEvent('npm run test:e2e', 'all tests passed'));
    const bk = readState()['brk:Bash:npm run test:e2e'];
    assert(bk && bk.status === 'open', 'status=open');
    assert(bk && bk.reason === 'suspicious-success', 'reason=suspicious-success');
  });
})();

// T3: OPEN → block on first attempt
cleanState(); cleanLog();
(function() {
  test('T3: OPEN → block first attempt via pre-flight', () => {
    writeState({ 'brk:Bash:docker build -t': { status: 'open', since: Date.now(), reason: 'failure-loop', count: 3, cmd: 'docker build -t app .', errPreview: 'build failed', blockCount: 0 } });
    const res = sendPreEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' } });
    assert(res.exitCode === 2, 'exit=2', `got ${res.exitCode}`);
    assert(res.stderr.includes('BLOCKED'), 'BLOCKED msg');
    assert(readState()['brk:Bash:docker build -t'].blockCount === 1, 'blockCount=1');
  });
})();

// T4: OPEN → HALF-OPEN on second attempt
cleanState(); cleanLog();
(function() {
  test('T4: OPEN → HALF-OPEN on second attempt', () => {
    writeState({ 'brk:Bash:docker build -t': { status: 'open', since: Date.now(), reason: 'failure-loop', count: 3, cmd: 'docker build -t app .', errPreview: 'build failed', blockCount: 1 } });
    const res = sendPreEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' } });
    assert(res.exitCode === 0, 'exit=0');
    assert(res.stderr.includes('HALF-OPEN'), 'HALF-OPEN msg');
    const bk = readState()['brk:Bash:docker build -t'];
    assert(bk && bk.status === 'half-open', 'status=half-open');
    assert(bk && bk.blockCount === 0, 'blockCount=0');
  });
})();

// T5: HALF-OPEN → CLOSED on probe success
cleanState(); cleanLog();
(function() {
  test('T5: HALF-OPEN → CLOSED on probe success', () => {
    writeState({ 'brk:Bash:docker build -t': { status: 'half-open', since: Date.now(), reason: 'failure-loop', count: 3, cmd: 'docker build -t app .', errPreview: 'build failed', blockCount: 0 } });
    const res = sendEvent(makeBashEvent('docker build -t app .', 'Successfully built app'));
    assert(res.exitCode === 0, 'exit=0');
    assert(res.stderr.includes('Probe succeeded'), 'probe msg');
    assert(!readState()['brk:Bash:docker build -t'], 'breaker removed');
  });
})();

// T6: HALF-OPEN → OPEN on probe failure
cleanState(); cleanLog();
(function() {
  test('T6: HALF-OPEN → OPEN on probe failure', () => {
    writeState({ 'brk:Bash:docker build -t': { status: 'half-open', since: Date.now(), reason: 'failure-loop', count: 3, cmd: 'docker build -t app .', errPreview: 'build failed', blockCount: 0 } });
    const res = sendEvent(makeBashEvent('docker build -t app .', 'ERROR: failed to solve: process exited with code 1'));
    assert(res.exitCode === 2, 'exit=2');
    assert(res.stderr.includes('PROBE FAILED'), 'PROBE FAILED msg');
    const bk = readState()['brk:Bash:docker build -t'];
    assert(bk && bk.status === 'open', 'back to open');
  });
})();

// T7: Full cycle
cleanState(); cleanLog();
(function() {
  test('T7: Full cycle CLOSED → OPEN → block → HALF-OPEN → CLOSED', () => {
    const cmd = 'mvn clean compile';
    const err = 'compilation failed: BUILD ERROR';
    for (let i = 0; i < 3; i++) sendEvent(makeBashEvent(cmd, err));
    assert(readState()['brk:Bash:mvn clean compile']?.status === 'open', 'step1 open');
    assert(sendPreEvent({ tool_name: 'Bash', tool_input: { command: cmd } }).exitCode === 2, 'step2 blocked');
    assert(sendPreEvent({ tool_name: 'Bash', tool_input: { command: cmd } }).exitCode === 0, 'step3 half-open');
    assert(readState()['brk:Bash:mvn clean compile']?.status === 'half-open', 'step3 check');
    assert(sendEvent(makeBashEvent(cmd, 'BUILD SUCCESS')).exitCode === 0, 'step4 closed');
    assert(!readState()['brk:Bash:mvn clean compile'], 'step4 breaker removed');
  });
})();

// T8: Full cycle with retry
cleanState(); cleanLog();
(function() {
  test('T8: Full cycle with failed probe then successful retry', () => {
    const cmd = 'docker build -t app .';
    const err = 'ERROR: failed to solve: process exited with code 1';
    for (let i = 0; i < 3; i++) sendEvent(makeBashEvent(cmd, err));
    sendPreEvent({ tool_name: 'Bash', tool_input: { command: cmd } });
    sendPreEvent({ tool_name: 'Bash', tool_input: { command: cmd } });
    const res1 = sendEvent(makeBashEvent(cmd, err));
    assert(res1.exitCode === 2 && readState()['brk:Bash:docker build -t']?.status === 'open', 'probe failed');
    assert(sendPreEvent({ tool_name: 'Bash', tool_input: { command: cmd } }).exitCode === 2, 're-blocked');
    assert(sendPreEvent({ tool_name: 'Bash', tool_input: { command: cmd } }).exitCode === 0, 'half-open again');
    assert(sendEvent(makeBashEvent(cmd, 'Successfully built app')).exitCode === 0, 'closed');
    assert(!readState()['brk:Bash:docker build -t'], 'breaker removed');
  });
})();

// T9: HALF-OPEN allows in pre-flight
cleanState(); cleanLog();
(function() {
  test('T9: HALF-OPEN allows command in pre-flight', () => {
    writeState({ 'brk:Bash:docker build -t': { status: 'half-open', since: Date.now(), reason: 'failure-loop', count: 3, cmd: 'docker build -t app .', errPreview: null, blockCount: 0 } });
    assert(sendPreEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' } }).exitCode === 0);
  });
})();

// T10: CLOSED allows everything
cleanState(); cleanLog();
(function() {
  test('T10: CLOSED allows everything in pre-flight', () => {
    assert(sendPreEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' } }).exitCode === 0);
  });
})();

// T11: Pre-flight skips read-only commands even with OPEN breaker
cleanState(); cleanLog();
(function() {
  test('T11: Pre-flight skips read-only commands even with OPEN breaker', () => {
    writeState({ 'brk:Bash:git status': { status: 'open', since: Date.now(), reason: 'failure-loop', count: 3, cmd: 'git status', errPreview: null, blockCount: 0 } });
    assert(sendPreEvent({ tool_name: 'Bash', tool_input: { command: 'git status' } }).exitCode === 0);
  });
})();

// T12: Different category not affected
cleanState(); cleanLog();
(function() {
  test('T12: Different category not affected by OPEN breaker', () => {
    writeState({ 'brk:Bash:docker build -t': { status: 'open', since: Date.now(), reason: 'failure-loop', count: 3, cmd: 'docker build -t app .', errPreview: null, blockCount: 0 } });
    assert(sendPreEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test' } }).exitCode === 0);
  });
})();

// T13: Suspicious success block message
cleanState(); cleanLog();
(function() {
  test('T13: Suspicious success block mentions count', () => {
    writeState({ 'brk:Bash:npm run test:e2e': { status: 'open', since: Date.now(), reason: 'suspicious-success', count: 3, cmd: 'npm run test:e2e', errPreview: null, blockCount: 0 } });
    const res = sendPreEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' } });
    assert(res.exitCode === 2 && res.stderr.includes('succeeded 3 times'), `Should mention count`);
  });
})();

cleanState(); cleanLog();
cleanup();
process.exit(results() > 0 ? 1 : 0);
