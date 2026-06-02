// helpers.js — Shared test utilities for circuit-breaker test suites.
// Creates an isolated temp directory per suite via CB_STATE_DIR.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_DIR = path.join(__dirname, '..', 'hooks');
const CB_HOOK = path.join(HOOK_DIR, 'circuit-breaker.js');
const PF_HOOK = path.join(HOOK_DIR, 'pre-flight.js');

function createSuite(prefix) {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `cb-${prefix}-`));
  const stateFile = path.join(testDir, 'breaker-state.json');
  const logFile = path.join(testDir, 'decision-log.jsonl');
  const env = { ...process.env, CB_STATE_DIR: testDir };

  function sendEvent(event, hook) {
    const result = spawnSync('node', [hook || CB_HOOK], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      timeout: 5000,
      env,
    });
    return {
      exitCode: result.status != null ? result.status : -1,
      signal: result.signal,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  function sendPreEvent(event) {
    return sendEvent(event, PF_HOOK);
  }

  function cleanState() { try { fs.writeFileSync(stateFile, '{}'); } catch {} }
  function cleanLog() { try { fs.writeFileSync(logFile, ''); } catch {} }
  function cleanAll() { cleanState(); cleanLog(); }

  function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { return {}; }
  }

  function readStateRaw() {
    try { return fs.readFileSync(stateFile, 'utf8'); }
    catch { return ''; }
  }

  function writeState(data) {
    fs.writeFileSync(stateFile, JSON.stringify(data));
  }

  /** Send one failure, return actual fingerprint key. */
  function getActualFp(cmd, failOut) {
    cleanAll();
    sendEvent({ tool_name: 'Bash', tool_input: { command: cmd }, tool_output: failOut });
    const keys = Object.keys(readState()).filter(k => k.startsWith('f:'));
    return keys[0] || null;
  }

  function cleanup() {
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
  }

  return {
    testDir, stateFile, logFile, env,
    sendEvent, sendPreEvent,
    cleanState, cleanLog, cleanAll,
    readState, readStateRaw, writeState,
    getActualFp, cleanup,
    CB_HOOK, PF_HOOK,
  };
}

function createTestRunner() {
  let passed = 0, failed = 0, total = 0;

  function test(name, fn) {
    total++;
    try { fn(); console.log(`  PASS: ${name}`); passed++; }
    catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failed++; }
  }

  function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

  function results() {
    console.log(`\nResults: ${passed} passed, ${failed} failed, ${total} total\n`);
    return failed;
  }

  return { test, assert, results, passed: () => passed, failed: () => failed, total: () => total };
}

module.exports = { createSuite, createTestRunner };
