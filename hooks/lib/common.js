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
    s = s.replace(re, (match) => {
      // For URL creds: keep protocol, redact user:pass
      if (match.includes('://')) return '://***@';
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
  try { return fn(); }
  finally { if (locked) releaseLock(); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function commandCategory(cmd) {
  const parts = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length && /^(?:sudo|env|time|npx|nice|cmd|powershell|bash|sh|zsh)$/i.test(parts[i])) i++;
  return parts.slice(i, i + 3).join(' ').slice(0, 80);
}

function shouldSkip(cmd) {
  for (let i = 0; i < SKIP.length; i++) {
    if (SKIP[i].test(cmd)) return true;
  }
  return false;
}

function detectFailure(output) {
  for (let i = 0; i < FAILURE_SIGNALS.length; i++) {
    if (FAILURE_SIGNALS[i].test(output)) return true;
  }
  return false;
}

function applyDecay(entry, now) {
  if (entry.count <= 0) return;
  const last = entry.lastFail || entry.lastRun || 0;
  if (last === 0) return;
  const halfLives = (now - last) / CFG.decayMs;
  if (halfLives >= 1) {
    entry.count = Math.floor(entry.count * Math.pow(0.5, halfLives));
    if (entry.count <= 0) entry.count = 0;
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
  return `f:${tool}:${commandCategory(cmd)}:${normalizeError(output)}`;
}

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

function appendLog(entry) {
  const p = paths();
  try { if (fs.statSync(p.LOG_FILE).size > CFG.maxLogBytes) rotateLog(); } catch {}
  // Sanitize command before logging
  if (entry.cmd) entry.cmd = sanitizeCmd(entry.cmd);
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
    const last = e.lastFail || e.lastRun || e.since || 0;
    if (last > 0 && last < cutoff) { delete data[k]; }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  paths,
  CFG,
  SKIP, CONSEQUENTIAL, FAILURE_SIGNALS, ERROR_LINE_RE,
  acquireLock, releaseLock, withLock,
  loadState, saveState,
  commandCategory, shouldSkip, detectFailure, applyDecay, checkHalfOpenTimeout,
  normalizeError, failKey, successKey, breakerKey,
  extractErrorPreview, appendLog, rotateLog, pruneTtl,
  sanitizeCmd,
};
