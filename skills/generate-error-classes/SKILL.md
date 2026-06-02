# Generate Error Classes

Generate a project-specific error classification file for the circuit breaker.

## When to use

User invokes `/generate-error-classes` to create a custom error classification tuned to their project's toolchain, language, and common failure patterns.

## Instructions

1. **Analyze the project** — identify:
   - Primary language(s) and frameworks
   - Build tools (npm, mvn, gradle, cargo, etc.)
   - Test frameworks (jest, pytest, junit, etc.)
   - Deployment tools (docker, kubectl, etc.)
   - Common error patterns from logs or CI output

2. **Review the default 16 classes** in `hooks/lib/common.js` (search for `DEFAULT_ERROR_CLASSES`):
   - DEPENDENCY_MISSING, DEPENDENCY_VERSION, TYPE_ERROR, SYNTAX_ERROR
   - PERMISSION_DENIED, FILE_NOT_FOUND, NETWORK_ERROR, BUILD_FAILED
   - TEST_FAILED, CONFIG_ERROR, RESOURCE_EXHAUSTED, RUNTIME_CRASH
   - AUTH_ERROR, RATE_LIMIT, TIMEOUT, PORT_CONFLICT

3. **Decide what to customize:**
   - **Disable** a class that's irrelevant (e.g., PORT_CONFLICT for a non-server project)
   - **Override** a class with project-specific regex patterns
   - **Add** new classes for domain-specific errors

4. **Generate `.claude/error-classes.json`** in the project root with this format:

```json
{
  "CLASS_NAME": {
    "disabled": true
  },
  "EXISTING_CLASS": {
    "override": true,
    "patterns": ["regex-pattern-1", "regex-pattern-2"]
  },
  "NEW_CLASS": {
    "patterns": ["regex-pattern-1"]
  }
}
```

5. **Rules for regex patterns:**
   - Each pattern is a JavaScript regex string (case-insensitive by default)
   - Test patterns against real error output from the project
   - Keep patterns specific — avoid overly broad matches
   - Order matters: the first matching class wins

6. **After generating**, verify:
   - The file is valid JSON
   - At least 3 real error outputs from the project match the new patterns
   - No pattern matches success output (false positives)

## Example output for a Node.js + Docker project

```json
{
  "PORT_CONFLICT": { "disabled": true },
  "DEPENDENCY_MISSING": {
    "override": true,
    "patterns": [
      "\\bCannot find module\\b",
      "\\bMODULE_NOT_FOUND\\b",
      "\\bnpm ERR! 404\\b",
      "\\bERR_MODULE_NOT_FOUND\\b"
    ]
  },
  "PRISMA_ERROR": {
    "patterns": [
      "\\bPrismaClient\\b.*\\berror\\b",
      "\\bP\\d{4}\\b.*\\bprisma\\b",
      "\\bprisma migrate.*failed\\b"
    ]
  },
  "NEXTJS_ERROR": {
    "patterns": [
      "\\bNext\\.js.*error\\b",
      "\\bModule build failed.*next\\b"
    ]
  }
}
```
