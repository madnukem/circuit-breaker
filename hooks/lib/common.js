// lib/common.js — Shared constants, patterns, and state management
// for circuit-breaker.js, pre-flight.js, and decision-log.js.
//
// Override state directory via CB_STATE_DIR env var (for testing).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Paths (overridable via CB_STATE_DIR) ──────────────────────────────────────

function resolvePaths() {
  const base = process.env.CB_STATE_DIR || path.join(os.homedir(), '.claude');
  return {
    CLAUDE_DIR: base,
    LOG_FILE: path.join(base, 'decision-log.jsonl'),
    STATE_FILE: path.join(base, 'breaker-state.json'),
    STATE_TMP: path.join(base, 'breaker-state.json.tmp'),
    LOCK_FILE: path.join(base, 'breaker-state.json.lock'),
  };
}

// Lazy-init: resolve once per process
let _paths = null;
function paths() {
  if (!_paths) _paths = resolvePaths();
  return _paths;
}

// ── Config (overridable via env vars) ─────────────────────────────────────────

function resolveConfig() {
  return {
    failThreshold: envInt('CB_FAIL_THRESHOLD', 3),
    successThreshold: envInt('CB_SUCCESS_THRESHOLD', 3),
    decayMs: envInt('CB_DECAY_MS', 5 * 60 * 1000),
    ttlMs: envInt('CB_TTL_MS', 30 * 60 * 1000),
    maxLogBytes: envInt('CB_MAX_LOG_BYTES', 5 * 1024 * 1024),
    halfOpenTimeoutMs: envInt('CB_HALF_OPEN_TIMEOUT_MS', 60 * 1000),
  };
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CFG = resolveConfig();

// ── Patterns ──────────────────────────────────────────────────────────────────

const SKIP = [
  /^git (?:status|diff|log|branch|show)/,
  /^(?:ls|cat|head|tail|which|where|echo|type|pwd|id|whoami|wc|sort|uniq|tee)\b/,
  /(?:version|--version|-V)$/,
  /^(?:find|grep|rg|glob|fd)\b/,
  /^(?:cd|pushd|popd|dirs)\b/,
];

const CONSEQUENTIAL = [
  /\b(?:build|compile|bundle|webpack|rollup|vite|esbuild)\b/i,
  /\btest\b.*\b(?:run|e2e|spec|jest|mocha|pytest|junit|cypress|playwright)\b/i,
  /\b(?:run|start|deploy|launch|serve|exec)\b/i,
  /\bdocker\s+(?:build|run|compose|up|push)\b/i,
  /\bkubectl\s+(?:apply|rollout|deploy|create)\b/i,
  /\bnpm\s+(?:run|test|build|start|publish)\b/i,
  /\bpip\s+(?:install|install-)\b/i,
  /\b(?:mvn|gradle|cargo|make|cmake|bazel)\s+/i,
];

const FAILURE_SIGNALS = [
  /exit code [1-9]/,
  /command failed/i,
  /process exited with code [1-9]/,
  /\bbuild (?:failed|error)\b/i,
  /\bcompilation (?:failed|error)\b/i,
  /\bnon-zero exit\b/i,
  /\b(?:fatal|critical|abort|killed|segfault|core dumped)\b/i,
  /\berror\b.*\b(?:while|during|in|at|on)\b/i,
  /\b(?:OutOfMemory|StackOverflow|TimeoutError|ConnectionRefused)\b/i,
];

const ERROR_LINE_RE = /error|Error|ERROR|fail|FAIL|fatal|FATAL|exception|Exception/i;

// ── Secret Sanitization ───────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  // API keys and tokens in args and URLs
  /(?:Bearer|token|api[_-]?key|apikey|secret|password|passwd|auth)\s+[:"=]\s*['"]?[\w\-]{8,}/gi,
  // Long hex/base64 tokens after flags
  /(?:--token|--key|--secret|--password|--api-key)\s+\S+/gi,
  // URLs with embedded credentials
  /:\/\/[^@\s]+@/g,
  // Common key patterns
  /\b(?:sk|pk|ghp|gho|ghs|github_pat|glpat|xox[bpas])_[\w\-]{20,}/gi,
];

function sanitizeCmd(cmd) {
  let s = cmd;
  for (const re of SECRET_PATTERNS) {
    const global = new RegExp(re.source, 'gi');
    s = s.replace(global, (match) => {
      if (match.includes('://')) {
        const proto = match.match(/^(\w+):\/\//);
        return proto ? proto[1] + '://***@' : '://***@';
      }
      return match.slice(0, Math.min(match.indexOf(' ') + 1, 8)) + '***';
    });
  }
  return s;
}

// ── File Locking ──────────────────────────────────────────────────────────────

function acquireLock(maxWaitMs) {
  if (typeof maxWaitMs !== 'number') maxWaitMs = 3000;
  const lockFile = paths().LOCK_FILE;
  const deadline = Date.now() + maxWaitMs;
  let retries = 0;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      if (++retries > 60) return false; // bail after ~60 attempts
      try {
        const pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
        if (pid > 0) {
          try { process.kill(pid, 0); } catch { fs.unlinkSync(lockFile); continue; }
        }
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > 10000) { fs.unlinkSync(lockFile); continue; }
      } catch { fs.unlinkSync(lockFile); continue; }
    }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(paths().LOCK_FILE); } catch {}
}

// ── State Management ──────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(paths().STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(data) {
  const p = paths();
  try {
    fs.writeFileSync(p.STATE_TMP, JSON.stringify(data));
    fs.renameSync(p.STATE_TMP, p.STATE_FILE);
  } catch {
    try { fs.writeFileSync(p.STATE_FILE, JSON.stringify(data)); } catch {}
  }
}

function withLock(fn) {
  const locked = acquireLock();
  if (!locked) {
    process.stderr.write('[BREAKER WARNING] Failed to acquire lock — proceeding without exclusive access.\n');
  }
  try { return fn(); }
  finally { if (locked) releaseLock(); }
}

function readStdin(cb) {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    try { cb(JSON.parse(chunks.join(''))); }
    catch { process.exit(0); }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function commandCategory(cmd) {
  const parts = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length && /^(?:sudo|env|time|npx|nice|cmd|powershell|bash|sh|zsh)$/i.test(parts[i])) i++;
  return parts.slice(i, i + 3).join(' ').slice(0, 80);
}

function matchesAny(str, patterns) {
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(str)) return true;
  }
  return false;
}

function shouldSkip(cmd) { return matchesAny(cmd, SKIP); }

function detectFailure(output) { return matchesAny(output, FAILURE_SIGNALS); }

function applyDecay(entry, now) {
  if (entry.count <= 0) return;
  const last = entry.lastFail || entry.lastRun || 0;
  if (last === 0) return;
  const halfLives = (now - last) / CFG.decayMs;
  if (halfLives >= 1) {
    entry.count = Math.floor(entry.count * Math.pow(0.5, halfLives));
  }
}

function checkHalfOpenTimeout(breaker, now) {
  if (!breaker || breaker.status !== 'half-open') return false;
  if (now - (breaker.since || 0) > CFG.halfOpenTimeoutMs) {
    breaker.status = 'open';
    breaker.blockCount = 0;
    return true;
  }
  return false;
}

// ── Observability Gap Detection ───────────────────────────────────────────────

function detectObservabilityGap(data, tool, category, now) {
  const key = `obs:${tool}:${category}`;
  const info = data[key] || { runCount: 0, hasRead: false, lastUpdate: 0 };

  // Reset after 10 minutes
  if (now - info.lastUpdate > 10 * 60 * 1000) {
    info.runCount = 0;
    info.hasRead = false;
  }

  info.runCount++;
  info.lastUpdate = now;
  data[key] = info;

  return info.runCount >= 3 && !info.hasRead;
}

function recordReadCommand(data, tool, category, now) {
  const key = `obs:${tool}:${category}`;
  const info = data[key];
  if (info) info.hasRead = true;
}

// ── Progress Detection ────────────────────────────────────────────────────────

const PROGRESS_PATTERNS = [
  { key: 'failing', re: /(\d+)\s+(?:tests?\s+)?(?:fail|failures?|failing)/i, direction: -1 },
  { key: 'passing', re: /(\d+)\s+(?:tests?\s+)?(?:pass|passed|passing)/i, direction: 1 },
  { key: 'errors', re: /(\d+)\s+(?:error|errors)/i, direction: -1 },
  { key: 'warnings', re: /(\d+)\s+(?:warning|warnings)/i, direction: -1 },
  { key: 'coverage', re: /(\d+)(?:\.\d+)?%\s*(?:coverage|covered)/i, direction: 1 },
  { key: 'complete', re: /(\d+)(?:\.\d+)?%\s*(?:complete|done|finished)/i, direction: 1 },
];

function extractMetrics(output) {
  const m = {};
  for (const { key, re } of PROGRESS_PATTERNS) {
    const match = re.exec(output);
    if (match) m[key] = parseInt(match[1], 10);
  }
  return Object.keys(m).length > 0 ? m : null;
}

function hasProgress(prev, curr) {
  if (!prev || !curr) return false;
  let improved = 0, degraded = 0;
  for (const { key, direction } of PROGRESS_PATTERNS) {
    if (prev[key] != null && curr[key] != null) {
      const delta = (curr[key] - prev[key]) * direction;
      if (delta > 0) improved += delta;
      else if (delta < 0) degraded += Math.abs(delta);
    }
  }
  return improved > degraded && improved > 0;
}

// ── Semantic Error Classification ─────────────────────────────────────────────

const DEFAULT_ERROR_CLASSES = {
  DEPENDENCY_MISSING: [
    /\b(?:cannot|could not)\s+find\s+(?:module|package)\b/i,
    /\bmodule\s+not\s+found\b/i,
    /\bpackage\s+['"]?\w+['"]?\s+(?:is\s+)?not\s+(?:found|installed|defined)\b/i,
    /\bcannot\s+resolve\s+(?:dependency|module|package)\b/i,
    /\bno\s+matching\s+version\s+found\b/i,
    /\bmissing\s+(?:dependency|module|package|peer)\b/i,
    /\bERR_MODULE_NOT_FOUND\b/,
    /\bMODULE_NOT_FOUND\b/,
    /\b(?:npm|yarn|pnpm)\s+ERR!\s+404\b/,
    /\bModuleNotFoundError\b/,
    /\bcargo:.+no\s+matching\s+package\s+named\b/i,
    /\bgem\s+not\s+found\b/i,
  ],
  DEPENDENCY_VERSION: [
    /\bERESOLVE\b.*\b(?:overriding|peer\s+dep|conflicting)/i,
    /\bpeer\s+dependency\s+(?:conflict|mismatch)\b/i,
    /\bversion\s+(?:conflict|mismatch|incompatib)\b/i,
    /\bincompatible\s+(?:with|version)\b/i,
    /\b(?:npm|yarn)\s+ERR!\s+ERESOLVE\b/,
    /\b(?:requires|expected)\s+\S+\s+but\s+(?:got|have|is)\s+/i,
  ],
  TYPE_ERROR: [
    /\b(?:TypeError|TypeError)\b/,
    /\b(?:Cannot|can't)\s+(?:read|set|assign)\s+(?:properties\s+)?of\s+(?:undefined|null)/i,
    /\bundefined\s+is\s+not\s+(?:a\s+)?function\b/i,
    /\b(?:is|are)\s+not\s+(?:a\s+)?(?:function|iterable|callable)\b/i,
    /\bAttributeError\b/,
    /\bClassCastException\b/,
    /\bInvalidCastException\b/,
    /\btype\s*mismatch\b/i,
  ],
  SYNTAX_ERROR: [
    /\bSyntaxError\b/,
    /\b(?:Unexpected|expected)\s+(?:token|end|identifier|string|number)/i,
    /\bparse\s+error\b/i,
    /\bIndentationError\b/,
    /\bTabError\b/,
    /\bcannot find symbol\b/i,
    /\billegal\s+(?:start\s+of\s+)?expression\b/i,
    /\bunclosed\s+(?:string|literal|parenthes|bracket|brace)\b/i,
  ],
  PERMISSION_DENIED: [
    /\b(?:permission|access)\s+denied\b/i,
    /\bEACCES\b/,
    /\bEPERM\b/,
    /\bOperation\s+not\s+permitted\b/i,
    /\b(?:chown|chmod|chgrp).*failed\b/i,
    /\bsudo.*required\b/i,
  ],
  FILE_NOT_FOUND: [
    /\b(?:no\s+such\s+file|file\s+not\s+found|cannot\s+find)\b/i,
    /\bENOENT\b/,
    /\bpath\s+does\s+not\s+exist\b/i,
    /\bdirectory\s+not\s+(?:found|empty)\b/i,
    /\b(?:Cannot|can't)\s+open\s+(?:file|dir)/i,
  ],
  NETWORK_ERROR: [
    /\b(?:connection|network)\s+(?:refused|reset|timed?\s?out|failed)\b/i,
    /\bECONNREFUSED\b/,
    /\bECONNRESET\b/,
    /\bENETUNREACH\b/,
    /\bEHOSTUNREACH\b/,
    /\bEAI_AGAIN\b/,
    /\bDNS\s*(?:error|failure|resolution\s+failed)\b/i,
    /\b(?:socket|request)\s+(?:hang\s+up|closed|aborted)\b/i,
    /\bSSL.*(?:error|handshake|certificate)\b/i,
    /\bcurl.*\(\d+\)\s/i,
  ],
  BUILD_FAILED: [
    /\bBUILD\s+(?:FAILED|FAILURE)\b/i,
    /\bcompilation\s+(?:failed|error)\b/i,
    /\b(?:failed\s+to\s+)?compile\b/i,
    /\b(?:webpack|rollup|vite|esbuild|babel).*error\b/i,
    /\b(?:cargo|rustc)\s+error\b/i,
    /\b(?:make|cmake|bazel).*error\b/i,
    /\blinker\s+error\b/i,
    /\bld\s+returned\b/i,
  ],
  TEST_FAILED: [
    /\b(?:test|tests|spec|specs|scenario)\s*\d*\s*(?:fail|failure|error)/i,
    /\bFAIL(?:ED|URE)?\s+(?:\d+|test|spec)/i,
    /\bassert(?:ion)?\s*(?:failed|error|Failure)\b/i,
    /\bexpected.*but\s+(?:got|was|received)/i,
    /\b(?:jest|mocha|pytest|junit|cypress|playwright|karma).*fail/i,
    /\b(?:RSpec|rspec).*(?:fail|error)/i,
    /\bTests\s+run:.*Failures:\s*[1-9]/i,
  ],
  CONFIG_ERROR: [
    /\bconfig(?:uration)?\s*(?:error|invalid|missing|parse)\b/i,
    /\bmissing\s+(?:env|environment)\s+(?:variable|var)\b/i,
    /\b\.env\b.*(?:missing|not\s+found|error)/i,
    /\binvalid\s+config/i,
    /\bunknown\s+option\s+['"]-/i,
    /\bunsupported\s+(?:option|flag|parameter|config)\b/i,
    /\byaml\s+(?:parse|syntax)\s*error\b/i,
    /\bjson\s+(?:parse|syntax)\s*error\b/i,
    /\btoml\s+(?:parse|syntax)\s*error\b/i,
  ],
  RESOURCE_EXHAUSTED: [
    /\b(?:out\s+of\s+memory|OOM|OutOfMemory|heap\s+space)\b/i,
    /\bdisk\s+(?:full|space)\b/i,
    /\bENOSPC\b/,
    /\btoo\s+many\s+(?:open\s+files|connections|processes)\b/i,
    /\bEMFILE\b/,
    /\bENFILE\b/,
    /\bresource\s+(?:exhausted|limit|unavailable)\b/i,
    /\bquota\s+(?:exceeded|reached)\b/i,
  ],
  RUNTIME_CRASH: [
    /\b(?:segfault|segmentation\s+fault|core\s+dumped)\b/i,
    /\b(?:abort|aborting|SIGABRT)\b/i,
    /\b(?:killed|SIGKILL)\b/i,
    /\b(?:stack\s+overflow|StackOverflowError)\b/i,
    /\b(?:panic|panicked)\b/,
    /\b(?:illegal|invalid)\s+instruction\b/i,
    /\bexit\s+code\s+(?:1[2-9][0-9]|139|137|134)\b/,
  ],
  AUTH_ERROR: [
    /\b(?:401|403|Unauthorized|Forbidden)\b/,
    /\b(?:authentication|authorization)\s+(?:failed|error|required)\b/i,
    /\b(?:invalid|expired|missing)\s+(?:token|api\s*key|credential|secret)\b/i,
    /\b(?:Bearer|JWT|OAuth).*(?:invalid|expired|missing)\b/i,
    /\baccess\s+token\s+(?:expired|invalid|revoked)\b/i,
    /\blogin\s+(?:failed|required|again)\b/i,
  ],
  RATE_LIMIT: [
    /\b429\b/,
    /\brate\s+limit/i,
    /\btoo\s+many\s+requests\b/i,
    /\bquota\s+exceeded\b/i,
    /\bthrottl(?:ed|ing)\b/i,
    /\bAPI\s+(?:rate|usage)\s+limit\b/i,
    /\bretry\s+after\b/i,
  ],
  TIMEOUT: [
    /\b(?:timed?\s?out|timeout)\b/i,
    /\bETIMEDOUT\b/,
    /\bdeadline\s+exceeded\b/i,
    /\b(?:operation|request|connection|query)\s+timed?\s?out\b/i,
    /\b(?:exceeded|surpassed)\s+(?:the\s+)?time\s+limit\b/i,
  ],
  PORT_CONFLICT: [
    /\b(?:address\s+already\s+in\s+use|port.*(?:already|in\s+use|occupied|bound))\b/i,
    /\bEADDRINUSE\b/,
    /\b(?:bind|listen)\s*(?:failed|error).*\b(?:port|address)\b/i,
  ],
};

function loadCustomErrorClasses() {
  const p = paths();
  const customPath = path.join(p.CLAUDE_DIR, 'error-classes.json');
  let custom;
  try { custom = JSON.parse(fs.readFileSync(customPath, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') {
      process.stderr.write(`[BREAKER WARNING] Failed to load ${customPath}: ${e.message}\n`);
    }
    return null;
  }
  return custom;
}

function buildErrorClasses() {
  const classes = {};
  for (const [name, patterns] of Object.entries(DEFAULT_ERROR_CLASSES)) {
    classes[name] = patterns.map(p => typeof p === 'string' ? new RegExp(p, 'i') : p);
  }
  const custom = loadCustomErrorClasses();
  if (!custom) return classes;
  for (const [name, def] of Object.entries(custom)) {
    if (def.disabled) { delete classes[name]; continue; }
    if (def.override && def.patterns) {
      classes[name] = def.patterns.map(p => new RegExp(p, 'i'));
    } else if (def.patterns) {
      classes[name] = [...(classes[name] || []), ...def.patterns.map(p => new RegExp(p, 'i'))];
    }
  }
  return classes;
}

let _errorClasses = null;
function getErrorClasses() {
  if (!_errorClasses) _errorClasses = buildErrorClasses();
  return _errorClasses;
}

function classifyError(output) {
  const classes = getErrorClasses();
  for (const [name, patterns] of Object.entries(classes)) {
    if (matchesAny(output, patterns)) return name;
  }
  return 'UNKNOWN';
}

// ── Error Normalization ──────────────────────────────────────────────────────

function normalizeError(output) {
  const lines = output.split('\n');
  const parts = [];
  for (let i = 0; i < lines.length && parts.length < 2; i++) {
    if (!ERROR_LINE_RE.test(lines[i])) continue;
    parts.push(lines[i]
      .replace(/['"][^'"]{0,200}['"]/g, '"..."')
      .replace(/(?:\\|\/)[^\s'"]+/g, '/...')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<h>')
      // Normalize line/column numbers: :NNN, [NNN], line NNN, at NNN
      .replace(/(?::\s*|line\s+|\[\s*)\d+(?:\s*,\s*\d+)*/gi, (m) => m.replace(/\d+/g, 'N'))
    );
  }
  if (parts.length === 0) return 'unknown';
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function failKey(tool, cmd, output) {
  const cls = classifyError(output);
  const suffix = cls !== 'UNKNOWN' ? cls : normalizeError(output);
  return `f:${tool}:${commandCategory(cmd)}:${suffix}`;
}

// Category-based key — all consequential commands in the same category share one counter.
// Intentional: "npm run test:unit" and "npm run test:e2e" both count toward the
// same suspicious-success threshold, preventing the agent from cycling through variants.
function successKey(tool, cmd) {
  return `s:${tool}:${commandCategory(cmd)}`;
}

function breakerKey(tool, category) {
  return `brk:${tool}:${category}`;
}

function extractErrorPreview(output) {
  const lines = output.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    if (ERROR_LINE_RE.test(lines[i])) hits.push(lines[i].trim());
  }
  return (hits.length > 0 ? hits : lines.filter(l => l.trim()).slice(-3))
    .join(' | ').slice(0, 500);
}

function resetFingerprints(data, tool, category) {
  const fpPrefix = `f:${tool}:${category}:`;
  for (const k of Object.keys(data)) {
    if (k.startsWith(fpPrefix)) delete data[k];
  }
}

function appendLog(entry) {
  const p = paths();
  try { if (fs.statSync(p.LOG_FILE).size > CFG.maxLogBytes) rotateLog(); } catch {}
  if (entry.cmd) entry.cmd = sanitizeCmd(entry.cmd).slice(0, 300);
  try { fs.appendFileSync(p.LOG_FILE, JSON.stringify(entry) + '\n'); } catch {}
}

function rotateLog() {
  const p = paths();
  const ts = Date.now();
  const backup = p.LOG_FILE.replace(/\.jsonl$/, `.${ts}.jsonl`);
  try { fs.renameSync(p.LOG_FILE, backup); } catch {}
  try {
    const dir = path.dirname(p.LOG_FILE);
    const base = path.basename(p.LOG_FILE, '.jsonl');
    const old = fs.readdirSync(dir)
      .filter(f => f.startsWith(base) && f.endsWith('.jsonl') && f !== path.basename(p.LOG_FILE))
      .sort();
    while (old.length > 2) { try { fs.unlinkSync(path.join(dir, old.shift())); } catch {} }
  } catch {}
}

function pruneTtl(data) {
  const cutoff = Date.now() - CFG.ttlMs;
  for (const k of Object.keys(data)) {
    const e = data[k];
    const last = e.lastFail || e.lastRun || e.since || e.lastUpdate || 0;
    if (last > 0 && last < cutoff) { delete data[k]; }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  paths,
  CFG,
  SKIP, CONSEQUENTIAL, FAILURE_SIGNALS, ERROR_LINE_RE,
  acquireLock, releaseLock, withLock, readStdin,
  loadState, saveState,
  matchesAny, commandCategory, shouldSkip, detectFailure, applyDecay, checkHalfOpenTimeout,
  normalizeError, failKey, successKey, breakerKey,
  extractErrorPreview, resetFingerprints, appendLog, rotateLog, pruneTtl,
  sanitizeCmd,
  classifyError, getErrorClasses,
  extractMetrics, hasProgress,
  detectObservabilityGap, recordReadCommand,
};
