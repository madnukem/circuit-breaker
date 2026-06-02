# Circuit Breaker for Claude Code

> PreToolUse + PostToolUse hooks that detect failure loops and suspicious success patterns — forces the model to step back and change approach.

By Vassa

## The Problem

The model gets stuck in two types of loops:

**Failure loop** — the same command fails, the model "fixes" and retries without checking prerequisites.
```
docker build → FAIL → fix → docker build → FAIL → fix → docker build → FAIL
A human would: first verify the service builds locally, then docker build.
```

**Suspicious success (rimCoop case)** — a command "passes" (exit 0), but the result is wrong. The model keeps rerunning e2e tests, not realizing it lacks observability.
```
npm run test:e2e → OK → "not working" → npm run test:e2e → OK → "not working" → npm run test:e2e → OK
The model doesn't understand that fail ≠ crash, it's incorrect behavior. It needs logs, not a rerun.
```

## Solution

Two layers:

### Layer 1: SKILL.md — Prompt Framework

Teaches the model to define BEFORE execution:
- What SUCCESS looks like (not "exit 0", but a specific observable result)
- What FAILURE looks like (not "error", but specific incorrect behavior)
- How to VERIFY (what to check afterwards)

### Layer 2: Hooks — Mechanical Guard

**PostToolUse hook** (`circuit-breaker.js`) — logs and counts:
- Consecutive failures with the same fingerprint → failure loop
- Consecutive successes for consequential commands → suspicious success

**PreToolUse hook** (`pre-flight.js`) — gates when breaker is OPEN:
- First attempt after trip → blocked with forced recovery plan
- Second attempt → transitions to HALF-OPEN, one probe allowed
- Probe succeeds → CLOSED, probe fails → back to OPEN

```
State machine:

  CLOSED ──(threshold)──▶ OPEN ──(block)──▶ OPEN(blockCount=1)
    ▲                                              │
    │                                         (2nd attempt)
    │                                              ▼
    └─────(probe success)──── HALF-OPEN ◀───(transition)
                                    │
                              (probe fail)
                                    │
                                    ▼
                                  OPEN
```

```
Failure loop:
  attempt 1 → FAIL (count=1) → log, continue
  attempt 2 → FAIL (count=2) → log + WARNING
  attempt 3 → FAIL (count=3) → CIRCUIT BREAKER TRIPPED → OPEN
  attempt 4 → BLOCKED → "articulate recovery plan"
  attempt 5 → HALF-OPEN (one probe allowed)
  attempt 6 → FAIL → back to OPEN / SUCCESS → CLOSED

Suspicious success:
  run 1 → OK (count=1) → log, continue
  run 2 → OK (count=2) → log, continue
  run 3 → OK (count=3) → SUSPICIOUS SUCCESS → OPEN
```

## Architecture

```
                    ┌──────────────────────┐
                    │   Claude Code        │
                    │                      │
  User prompt ────▶│  LLM decides to      │
                    │  run "docker build"  │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  PreToolUse          │
                    │  pre-flight.js       │◀── OPEN → block/allow
                    └──────────┬───────────┘
                               │ allow
                    ┌──────────▼───────────┐
                    │  Tool executes       │
                    │  "docker build ..."  │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  PostToolUse         │
                    │  circuit-breaker.js  │◀── Counting + transitions
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  Shared State        │
                    │  lib/common.js       │
                    │  ~/.claude/          │
                    │  breaker-state.json  │
                    │  decision-log.jsonl  │
                    └──────────────────────┘
```

### Key Components

| File | Purpose |
|------|---------|
| `hooks/lib/common.js` | Shared module: patterns, state management, file locking, helpers |
| `hooks/circuit-breaker.js` | PostToolUse hook — logging + failure/success counting + transitions |
| `hooks/pre-flight.js` | PreToolUse hook — gate commands when breaker is OPEN |
| `hooks/hooks.json` | Hook registration (auto-loaded by Claude Code) |
| `hooks/decision-log.js` | CLI viewer for logs (`--summary`, `--failures`, `--reset`) |
| `skills/circuit-breaker/SKILL.md` | Pre-flight check prompt framework |

## Installation

### Manual

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node <path-to>/hooks/pre-flight.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node <path-to>/hooks/circuit-breaker.js"
          }
        ]
      }
    ]
  }
}
```

Use absolute paths. Example: `node /home/user/circuit-breaker/hooks/circuit-breaker.js`.

### Install SKILL.md (optional)

Copy `SKILL.md` to `~/.claude/skills/pre-flight-check/SKILL.md`.

## Configuration

All settings can be overridden via environment variables:

| Env Var | Default | Description |
|---------|---------|-------------|
| `CB_FAIL_THRESHOLD` | 3 | Failures before failure-loop breaker trips |
| `CB_SUCCESS_THRESHOLD` | 3 | Successes before suspicious-success breaker trips |
| `CB_DECAY_MS` | 300000 | Exponential decay half-life (5 min) |
| `CB_TTL_MS` | 1800000 | Time-to-live for stale state entries (30 min) |
| `CB_MAX_LOG_BYTES` | 5242880 | Log rotation threshold (5 MB) |
| `CB_HALF_OPEN_TIMEOUT_MS` | 60000 | HALF-OPEN → OPEN timeout (60 s) |
| `CB_STATE_DIR` | `~/.claude` | Directory for state files (useful for testing) |

## Decision Log

All actions are logged to `~/.claude/decision-log.jsonl`:

```jsonl
{"ts":"2026-06-02T10:30:15.123Z","tool":"Bash","cmd":"docker build -t app .","ok":false,"category":"docker build -t","err":"ERROR: failed to solve..."}
{"ts":"2026-06-02T10:31:22.456Z","tool":"Bash","cmd":"mvn clean install","ok":true,"category":"mvn clean install"}
```

Commands are sanitized before logging — API keys, tokens, and passwords are redacted.

### Viewer

```bash
node hooks/decision-log.js               # last 20 entries
node hooks/decision-log.js --all         # all entries
node hooks/decision-log.js --failures    # failures only
node hooks/decision-log.js --summary     # stats summary
node hooks/decision-log.js --reset       # reset breaker state
node hooks/decision-log.js --clear-log   # clear decision log
```

## Fingerprinting

Failure fingerprint = hash of `(tool + command_category + normalized_error)`.

Error normalization:
- File paths → `/...`
- Hex hashes → `<h>`
- Line/column numbers → `N`
- Quoted strings → `"..."`

This groups errors with different paths/line numbers into one fingerprint:
```
"Error at /home/user/project/App.java:[42,5]" →  one fingerprint
"Error at /tmp/build/src/App.java:[87,5]"      →  (paths and numbers normalized)
```

But genuinely different errors get different fingerprints:
```
"maven-compiler-plugin: compilation error" → fingerprint A
"maven-surefire-plugin: test failure"      → fingerprint B
```

## Breaker State

Stored in `~/.claude/breaker-state.json`, protected by advisory file locking.

```json
{
  "f:Bash:docker build -t:a1b2c3d4": {
    "count": 2,
    "lastFail": 1748901234567,
    "category": "docker build -t",
    "cmd": "docker build -t app ."
  },
  "brk:Bash:docker build -t": {
    "status": "open",
    "since": 1748901234567,
    "reason": "failure-loop",
    "count": 3,
    "blockCount": 0
  }
}
```

### Decay

Every `decayMs` (default 5 min) without a repeat failure, the counter halves (exponential decay). This lets the model resume work after a pause.

### Reset

- **Failure breaker** resets on success in the same command category
- **Suspicious success breaker** does not auto-reset (the model must change approach)
- Manual reset: `node hooks/decision-log.js --reset`

## Tests

```bash
npm test                      # all tests
npm run test:base             # 13 base tests
npm run test:edge             # 29 edge cases
npm run test:regression       # 17 regression tests
npm run test:sm               # 13 state machine tests
```

Tests are isolated — each suite creates a temp directory via `CB_STATE_DIR` and cleans up after itself.

### Coverage

| Category | Tests | What it covers |
|----------|-------|----------------|
| Base | 13 | Failure loop, suspicious success, resets, skip patterns |
| Edge cases | 29 | False positives/negatives, fingerprinting, Java/Maven, rimCoop, state resilience, interleaved |
| Regression | 17 | Single decay, rotation, atomic write, graceful errors, consistency |
| State machine | 13 | CLOSED→OPEN, OPEN→block, OPEN→HALF-OPEN, HALF-OPEN→CLOSED, HALF-OPEN→OPEN, full cycles |

## File Locking

Each hook invocation is a separate Node.js process. To prevent race conditions on concurrent access to `breaker-state.json`, advisory file locking is used:

- Lock file: `breaker-state.json.lock`
- Atomic creation via `O_EXCL | O_CREAT`
- Stale lock detection: PID check + 10s timeout
- Retry with 50ms pause, max 3s wait

## Limitations

1. **Bash tool only** — only monitors Bash commands. Read, Write, Edit are not logged.
2. **Heuristic failure detection** — detects failures via text patterns (exit code, ERROR, failed). False positives/negatives are possible.
3. **Persistent state** — breaker state persists between sessions. Use `--reset` when starting a new task.
4. **Suspicious success does not auto-reset** — the model must consciously change its approach.

## Roadmap

- [ ] Non-Bash tool support (Write, Edit)
- [x] Configuration via env vars
- [ ] Configuration via config file
- [ ] Smarter failure detection (context-aware, not just regex)
- [ ] SQLite persistence via external CLI

## License

MIT
