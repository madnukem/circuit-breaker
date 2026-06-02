#!/usr/bin/env node
// edge.test.js — Adversarial & real-world edge case tests

const { createSuite, createTestRunner } = require('./helpers');
const { test, assert, results } = createTestRunner();
const { sendEvent, cleanState, cleanLog, cleanAll, readState, stateFile, logFile, cleanup } = createSuite('edge');
const fs = require('fs');

function hasFailureEntry(state) { return Object.keys(state).some(k => k.startsWith('f:')); }

// ──────────────────────────────────────────────────────────────────────────────
// 1. FALSE POSITIVES
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n╔══ 1. False Positives — "error" in output but success ══╗\n');

test('"0 errors found" does NOT trigger failure detection', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run lint' },
    tool_output: 'Linting complete. 0 errors, 0 warnings.\nexit code 0' });
  assert(!hasFailureEntry(readState()), `"0 errors" should NOT create failure entry`);
});

test('"Error handling module loaded" does NOT trigger failure detection', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'python app.py' },
    tool_output: 'Starting server...\nError handling module initialized.\nListening on port 8080\nexit code 0' });
  assert(!hasFailureEntry(readState()), `"Error handling module" should NOT create failure entry`);
});

test('"No errors occurred" exits cleanly', () => {
  cleanAll();
  const r = sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn clean install' },
    tool_output: 'BUILD SUCCESS\nTotal time: 12.3 s\nNo errors occurred during build.' });
  assert(r.exitCode === 0, `Should exit 0`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. FALSE NEGATIVES
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n╔══ 2. False Negatives — silent/hard failures ══╗\n');

test('segfault detected as failure', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: './run-tests' },
    tool_output: 'Segmentation fault (core dumped)\nexit code 139' });
  assert(hasFailureEntry(readState()), `Segfault should be detected`);
});

test('OOM kill detected as failure', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'java -Xmx512m -jar app.jar' },
    tool_output: 'java.lang.OutOfMemoryError: Java heap space\nexit code 137' });
  assert(hasFailureEntry(readState()), `OutOfMemoryError should be detected`);
});

test('timeout kill — "Killed" detected as failure', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run e2e' },
    tool_output: 'Killed\nexit code 137' });
  assert(hasFailureEntry(readState()), `"Killed" should be detected`);
});

test('"exit code 1" detected as failure', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' },
    tool_output: 'exit code 1' });
  assert(hasFailureEntry(readState()), `"exit code 1" should be detected`);
});

test('Python traceback detected as failure', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'python train.py' },
    tool_output: 'Traceback (most recent call last):\n  File "train.py", line 42\nSyntaxError: invalid syntax\nexit code 1' });
  assert(hasFailureEntry(readState()), `Python SyntaxError should be detected`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. FINGERPRINTING
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n╔══ 3. Fingerprinting accuracy ══╗\n');

test('same error with different paths produces ONE fingerprint', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' },
    tool_output: 'ERROR] /home/user/project/src/main/java/App.java:[12,5] cannot find symbol\nexit code 1' });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' },
    tool_output: 'ERROR] /tmp/build/src/main/java/App.java:[12,5] cannot find symbol\nexit code 1' });
  const fks = Object.keys(readState()).filter(k => k.startsWith('f:'));
  assert(fks.length === 1, `Expected 1, got ${fks.length}`);
});

test('same error with different line numbers produces ONE fingerprint', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run build' },
    tool_output: "Error: Cannot find module './utils' at line 42\nexit code 1" });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run build' },
    tool_output: "Error: Cannot find module './utils' at line 87\nexit code 1" });
  const fks = Object.keys(readState()).filter(k => k.startsWith('f:'));
  assert(fks.length === 1, `Expected 1, got ${fks.length}`);
});

test('truly different errors produce DIFFERENT fingerprints', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn clean install' },
    tool_output: 'ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin\nexit code 1' });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn clean install' },
    tool_output: 'ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin: Tests failed\nexit code 1' });
  const fks = Object.keys(readState()).filter(k => k.startsWith('f:'));
  assert(fks.length === 2, `Expected 2, got ${fks.length}`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. COMMAND CATEGORY EDGE CASES
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n╔══ 4. Command category edge cases ══╗\n');

test('sudo prefix stripped — same category as non-sudo', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'sudo docker build -t app .' },
    tool_output: 'ERROR: failed to solve\nexit code 1' });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' },
    tool_output: 'ERROR: failed to solve\nexit code 1' });
  const fks = Object.keys(readState()).filter(k => k.startsWith('f:'));
  assert(fks.length === 1, `Expected 1 fingerprint, got ${fks.length}`);
  assert(readState()[fks[0]].count === 2, `Expected count 2`);
});

test('npx prefix stripped from category', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npx npm run build' },
    tool_output: 'Build complete' });
  const keys = Object.keys(readState()).filter(k => k.includes('npm run build'));
  assert(keys.length > 0, `Should have entry with "npm run build" category`);
});

test('pipelines: category based on first command', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run build && npm run test' },
    tool_output: 'Build complete.\nTests: 12 passed.' });
  const keys = Object.keys(readState()).filter(k => k.startsWith('s:'));
  assert(keys.length === 1 && keys[0].includes('npm run build'), `Category should be first command`);
});

test('very long command truncated in log', () => {
  cleanAll();
  const longCmd = 'docker build ' + '--build-arg VAR=' + 'x'.repeat(500) + ' -t app .';
  sendEvent({ tool_name: 'Bash', tool_input: { command: longCmd }, tool_output: 'Successfully built abc' });
  const log = fs.readFileSync(logFile, 'utf8');
  const entry = JSON.parse(log.trim().split('\n').pop());
  assert(entry.cmd.length <= 300, `Truncated to 300, got ${entry.cmd.length}`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. JAVA/MAVEN REAL-WORLD SCENARIOS
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n╔══ 5. Java/Maven real-world scenarios ══╗\n');

test('mvn compile fails 3x → breaker trips', () => {
  cleanAll();
  const fail = '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile\n[ERROR] compilation error\nexit code 1';
  for (let i = 0; i < 2; i++) sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn clean compile' }, tool_output: fail });
  const r = sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn clean compile' }, tool_output: fail });
  assert(r.exitCode === 2 && r.stderr.includes('FAILURE LOOP'), `Should trip`);
});

test('mvn -DskipTests succeeds then mvn test fails — separate categories', () => {
  cleanAll();
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn clean install -DskipTests' },
    tool_output: 'BUILD SUCCESS' }).exitCode === 0);
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn test' },
    tool_output: 'Tests run: 42, Failures: 3\nBUILD FAILURE\nexit code 1' }).exitCode === 0);
  const r3 = sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn test' },
    tool_output: 'Tests run: 42, Failures: 3\nBUILD FAILURE\nexit code 1' });
  assert(r3.exitCode === 0 && r3.stderr.includes('WARNING'), `Should warn on 2nd fail`);
});

test('gradle build × 3 → suspicious success', () => {
  cleanAll();
  const ok = 'BUILD SUCCESSFUL in 4s\n3 actionable tasks: 3 executed';
  for (let i = 0; i < 2; i++) sendEvent({ tool_name: 'Bash', tool_input: { command: 'gradle build' }, tool_output: ok });
  const r = sendEvent({ tool_name: 'Bash', tool_input: { command: 'gradle build' }, tool_output: ok });
  assert(r.exitCode === 2 && r.stderr.includes('SUSPICIOUS'), `Should flag`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. THE RIMCOOP SCENARIO
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n╔══ 6. The rimCoop scenario ══╗\n');

test('e2e test passes 3x → suspicious success triggers', () => {
  cleanAll();
  const e2e = 'Running e2e scenarios...\n  ✓ Player joins game\n  ✓ Player moves\n  ✓ Game ends\n\n3 passing (2s)\nexit code 0';
  for (let i = 0; i < 2; i++) assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' }, tool_output: e2e }).exitCode === 0);
  const r = sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' }, tool_output: e2e });
  assert(r.exitCode === 2 && (r.stderr.includes('SUSPICIOUS') || r.stderr.includes('observability')));
});

test('e2e pass × 2 then fail — failure counter starts, no breaker trip', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' }, tool_output: '3 passing\nexit code 0' });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' }, tool_output: '3 passing\nexit code 0' });
  const r = sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm run test:e2e' },
    tool_output: '1 failing\n  1) Player movement test\nexit code 1' });
  assert(r.exitCode === 0, `Should allow`);
  const fks = Object.keys(readState()).filter(k => k.startsWith('f:'));
  assert(fks.length === 1 && readState()[fks[0]].count === 1, `1 failure entry with count=1`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. STATE RESILIENCE
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n╔══ 7. State resilience ══╗\n');

test('corrupted state file — hook survives', () => {
  fs.writeFileSync(stateFile, '{invalid json!!!');
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' },
    tool_output: 'BUILD FAILURE\nexit code 1' }).exitCode === 0);
});

test('missing state file — hook creates it', () => {
  try { fs.unlinkSync(stateFile); } catch {}
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'BUILD FAILURE\nexit code 1' });
  assert(fs.existsSync(stateFile), `Should create state file`);
});

test('corrupted log line — hook survives', () => {
  cleanAll();
  fs.writeFileSync(logFile, 'not json\nalso not json\n');
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' },
    tool_output: 'Successfully built abc' }).exitCode === 0);
});

test('very large log — triggers rotation', () => {
  cleanAll();
  const chunk = (JSON.stringify({ ts: '2026-01-01', tool: 'Bash', cmd: 'x'.repeat(200), ok: true, category: 'x' }) + '\n').repeat(1000);
  // ~268KB per chunk, need >5MB → 20 iterations
  for (let i = 0; i < 20; i++) fs.appendFileSync(logFile, chunk);
  const before = fs.statSync(logFile).size;
  assert(before > 5 * 1024 * 1024, `Log should exceed 5MB, got ${(before/1024/1024).toFixed(1)}MB`);
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'BUILD SUCCESS' });
  const after = fs.statSync(logFile).size;
  assert(after < before, `Log should shrink. Before: ${(before/1024/1024).toFixed(1)}MB, After: ${(after/1024/1024).toFixed(1)}MB`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. INTERLEAVED SCENARIOS
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n╔══ 8. Interleaved & complex scenarios ══╗\n');

test('fail × 2, fix, success — breaker resets', () => {
  cleanAll();
  const f = 'ERROR: compilation failed\nexit code 1';
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: f });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: f });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: 'BUILD SUCCESS' });
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'mvn compile' }, tool_output: f }).exitCode === 0, `Reset`);
});

test('docker build fail, docker run fail — separate categories', () => {
  cleanAll();
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' }, tool_output: 'ERROR: failed to solve\nexit code 1' });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker build -t app .' }, tool_output: 'ERROR: failed to solve\nexit code 1' });
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'docker run --rm app' },
    tool_output: 'Error: No such image: app\nexit code 1' }).exitCode === 0, `Different category`);
});

test('Python ML: train.py OOM 3x → breaker', () => {
  cleanAll();
  const oom = 'torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB\nexit code 1';
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'python train.py' }, tool_output: oom });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'python train.py' }, tool_output: oom });
  const r = sendEvent({ tool_name: 'Bash', tool_input: { command: 'python train.py' }, tool_output: oom });
  assert(r.exitCode === 2 && r.stderr.includes('FAILURE LOOP'));
});

test('kubectl apply × 3 → suspicious success', () => {
  cleanAll();
  const out = 'deployment.apps/myapp configured\nexit code 0';
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'kubectl apply -f deployment.yaml' }, tool_output: out });
  sendEvent({ tool_name: 'Bash', tool_input: { command: 'kubectl apply -f deployment.yaml' }, tool_output: out });
  assert(sendEvent({ tool_name: 'Bash', tool_input: { command: 'kubectl apply -f deployment.yaml' }, tool_output: out }).exitCode === 2);
});

test('alternating success/failure does not trip breaker', () => {
  cleanAll();
  for (let i = 0; i < 4; i++) {
    sendEvent({ tool_name: 'Bash', tool_input: { command: 'npm test' },
      tool_output: i % 2 === 0 ? 'Tests: 12 passed\nexit code 0' : 'Tests: 1 failed\nexit code 1' });
  }
  const brk = Object.entries(readState()).find(([k]) => k.startsWith('brk:'));
  assert(!brk || brk[1].status !== 'open', `Should not trip`);
});

cleanAll();
cleanup();
process.exit(results() > 0 ? 1 : 0);
