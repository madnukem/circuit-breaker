---
name: circuit-breaker
description: Use when the model is stuck in a retry loop or rerunning "successful" commands without verifying results — the breaker detects repeated failures and suspicious successes, forcing a step-back
---

# Circuit Breaker

## When to Use

- The model runs the same failing command multiple times without changing approach
- The model reruns a "successful" command (exit 0) but doesn't verify the actual result
- You see the model in a "hope loop" — trying again hoping for different behavior
- The model skips prerequisite verification before running build/test/deploy

## When NOT to Use

- Read-only commands (git status, ls, cat)
- File edits, package installs, git operations
- First-time command execution — the breaker only activates after repeated patterns

## The Problem

Models confuse "no errors" with "working correctly." Two failure patterns:

**Failure loop** — same command fails, model "fixes" and retries without checking prerequisites.
**Suspicious success** — command passes (exit 0) but behavior is wrong. Model keeps rerunning instead of adding observability.

## Red Flags

| Behavior | What's happening |
|----------|-----------------|
| "It should work now" | Guessing, no evidence |
| Rerunning a "successful" command | Don't trust own success criteria |
| "Let me try again" | No new information = insanity |
| "The test passes but..." | Test is wrong, not the code |

## The Circuit Breaker Hook

A PostToolUse hook that automatically detects both patterns:

1. **Failure loop**: Same command fails 3+ times → BREAKER TRIPS → forced step-back
2. **Suspicious success**: Same consequential command succeeds 3+ times → BREAKER TRIPS → "add observability"

### Thresholds

| Pattern | Threshold | Decay |
|---------|-----------|-------|
| Failure loop | 3 consecutive same-fingerprint failures | Exponential (5 min half-life) |
| Suspicious success | 3 consecutive runs of consequential command | Exponential (5 min half-life) |
| TTL | 30 min — stale entries pruned | On every load |

### Consequential Commands

Build, test, deploy, docker, kubectl, mvn, gradle, cargo, npm run — commands where "exit 0" doesn't guarantee correctness.

## Pre-Flight Check

Before any consequential action, articulate:

```
[PRE-FLIGHT]
Action: <what I'm about to run>
Success: <specific observable outcome>
Failure: <specific wrong behavior>
Verify: <how I'll confirm after>
```

**No feedback = flying blind.** If you can't observe the result, add logging first.

## Verification

- [ ] Before running a build/test — did I define what success looks like?
- [ ] After running — did I verify the actual result, not just exit code?
- [ ] If I'm rerunning — do I have NEW information since last time?
