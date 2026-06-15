#!/usr/bin/env node
// payload.test.js — Payload completeness test (T1 + T4 from SKILL-REQUIREMENTS.md)
//
// circuit-breaker is a Claude Code plugin (not a single skill), so the
// structural checks are adapted:
//   - skill files live in skills/<name>/SKILL.md (not at root)
//   - hooks/ contains hook scripts AND a hooks.json manifest
//   - .claude-plugin/plugin.json declares the plugin
//
// Regression for INCIDENT-2026-06-15-tdd-workflow-unknown:
// without an explicit `files` whitelist, npm pack falls back to .gitignore
// — fragile, because any .gitignore/.npmignore edit silently breaks the
// tarball.

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function createTestSuite() {
  let passed = 0;
  let failed = 0;
  return {
    test(description, fn) {
      try {
        fn();
        console.log(`  PASS: ${description}`);
        passed++;
      } catch (err) {
        console.log(`  FAIL: ${description}`);
        console.log(`    ${err.message}`);
        failed++;
      }
    },
    results() {
      console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
      return failed > 0 ? 1 : 0;
    },
  };
}

const { test, assert, results } = (() => {
  const suite = createTestSuite();
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  return { test: suite.test, assert, results: suite.results };
})();

const PKG_ROOT = path.join(__dirname, '..');
const pkg = require(path.join(PKG_ROOT, 'package.json'));

function npmPackFiles() {
  const out = execSync('npm pack --dry-run --json', {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  return parsed[0].files.map(f => f.path);
}

function walkJs(dir, base = '') {
  const out = [];
  const full = path.join(PKG_ROOT, base, dir);
  if (!fs.existsSync(full)) return out;
  for (const ent of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = `${base}${dir}/${ent.name}`;
    if (ent.isDirectory()) {
      out.push(...walkJs(ent.name, `${base}${dir}/`));
    } else if (ent.name.endsWith('.js')) {
      out.push(rel);
    }
  }
  return out;
}

const HOOK_FILES = walkJs('hooks');
const SKILL_DIRS = fs.existsSync(path.join(PKG_ROOT, 'skills'))
  ? fs.readdirSync(path.join(PKG_ROOT, 'skills'), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  : [];

// ── Tarball contains required directories ──────────────────────────────────

test('package.json declares a files whitelist', () => {
  assert(Array.isArray(pkg.files) && pkg.files.length > 0,
    'package.json must have a non-empty "files" array — without it npm pack ' +
    'falls back to .gitignore, which is fragile');
});

test('npm pack includes .claude-plugin/plugin.json', () => {
  const files = npmPackFiles();
  assert(files.includes('.claude-plugin/plugin.json'),
    `.claude-plugin/plugin.json missing. Files:\n${files.join('\n')}`);
});

test('npm pack includes hooks/hooks.json manifest', () => {
  const files = npmPackFiles();
  assert(files.includes('hooks/hooks.json'),
    `hooks/hooks.json missing. Files:\n${files.join('\n')}`);
});

test('npm pack includes every hook file', () => {
  const files = npmPackFiles();
  for (const h of HOOK_FILES) {
    assert(files.includes(h),
      `${h} missing from npm pack output. Files:\n${files.join('\n')}`);
  }
});

test('npm pack includes every skill SKILL.md', () => {
  const files = npmPackFiles();
  assert(SKILL_DIRS.length > 0, 'no skill directories found under skills/');
  for (const dir of SKILL_DIRS) {
    const p = `skills/${dir}/SKILL.md`;
    assert(files.includes(p),
      `${p} missing from npm pack output. Files:\n${files.join('\n')}`);
  }
});

// ── End-to-end install test (T4) ────────────────────────────────────────────
//
// Copy the package into a temp dir and run every hook with empty stdin.
// Catches MODULE_NOT_FOUND-style regressions where the hook resolves paths
// relative to the source repo rather than the install dir.

test('every hook runs from a fresh install copy without MODULE_NOT_FOUND', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${pkg.name}-install-`));
  try {
    const installed = path.join(tmp, 'package');
    fs.mkdirSync(installed);
    for (const entry of pkg.files) {
      const src = path.join(PKG_ROOT, entry);
      const dst = path.join(installed, entry);
      if (!fs.existsSync(src)) continue;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        fs.cpSync(src, dst, { recursive: true });
      } else {
        fs.copyFileSync(src, dst);
      }
    }
    for (const h of HOOK_FILES) {
      const hookPath = path.join(installed, h);
      assert(fs.existsSync(hookPath), `install copy missing ${h}`);
    }
    for (const h of HOOK_FILES) {
      let out = '';
      try {
        out = execSync(
          `node ${h}`,
          { cwd: installed, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            input: '{}',
            env: { ...process.env },
            timeout: 5000 }
        );
      } catch (err) {
        out = (err.stdout || '') + (err.stderr || '');
      }
      assert(!/MODULE_NOT_FOUND/.test(out),
        `${h} printed MODULE_NOT_FOUND from install copy:\n${out}`);
      assert(!/Cannot find module/.test(out),
        `${h} printed "Cannot find module" from install copy:\n${out}`);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

// ── hooks.json commands reference real files ──────────────────────────────

test('every hook in hooks.json resolves to a real file', () => {
  const hooksJsonPath = path.join(PKG_ROOT, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) return;
  const manifest = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  for (const event of Object.keys(manifest)) {
    for (const entry of manifest[event]) {
      for (const hook of entry.hooks || []) {
        if (hook.type !== 'command') continue;
        const m = hook.command.match(/node\s+(\S+\.js)/);
        if (!m) continue;
        const target = path.join(PKG_ROOT, m[1]);
        assert(fs.existsSync(target),
          `hooks.json ${event} references "${m[1]}" but file does not exist`);
      }
    }
  }
});

// ── Plugin is declared in .claude-plugin/plugin.json ───────────────────────

test('.claude-plugin/plugin.json declares this plugin', () => {
  const pluginJson = require(path.join(PKG_ROOT, '.claude-plugin', 'plugin.json'));
  assert(pluginJson.name === pkg.name,
    `plugin.json name "${pluginJson.name}" != package.json name "${pkg.name}"`);
});

const code = results();
process.exit(code);
