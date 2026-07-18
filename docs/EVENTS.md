# Event reference

Every event, when it fires, and what it carries. All events share the
[envelope](./ARCHITECTURE.md#the-event-envelope) — `runId`, `seq`, `ts`, `type` —
on top of the fields below.

- [The timeline](#the-timeline)
- [When each event fires](#when-each-event-fires)
- [Payloads](#payloads)
- [The views](#the-views)

---

## The timeline

A run with one spec, one passing + one failing test (retried once):

```
run:start                              once — the manifest (all spec paths)
│
├─ spec:tests        (spec A)          roster: every it-block, announced up front
├─ spec:start        (spec A)          spec A is now running
│  │
│  ├─ test:start          (test 1, attempt 1)          running
│  ├─ test:attempt:end    (test 1, passed)
│  │
│  ├─ test:start          (test 2, attempt 1)          running
│  ├─ artifact:commands   (test 2, attempt 1)   ┐
│  ├─ artifact:dom        (test 2, attempt 1)   │ fire together
│  ├─ artifact:screenshot (test 2, attempt 1)   ┘ on the failure
│  ├─ test:attempt:end    (test 2, failed, willRetry=true)
│  │
│  ├─ test:start          (test 2, attempt 2)          the retry
│  ├─ artifact:commands / dom / screenshot
│  └─ test:attempt:end    (test 2, failed, willRetry=false)
│
├─ spec:end          (spec A)          final stats + full per-test list
│
run:end                                once — totals + the bounded final flush
```

**Patterns to internalize:**

- **Once per run:** `run:start` (opens), `run:end` (closes, + the only wait).
- **Once per spec:** `spec:tests` → `spec:start` at the front, `spec:end` at the back.
- **Once per _attempt_, not per test:** `test:start` + `test:attempt:end`, and the
  failure artifacts, repeat for each retry.

## When each event fires

| # | Trigger (Cypress hook) | Event | Side | How often | Sent via |
|---|---|---|---|---|---|
| 1 | `before:run` | `run:start` | Node | once per run | direct `emit()` |
| 2 | root `before()` | `spec:tests` | Browser | once per spec | `cy.task` |
| 3 | `before:spec` | `spec:start` | Node | once per spec | direct `emit()` |
| 4 | `beforeEach` | `test:start` | Browser | per attempt | `cy.task` (flushed now) |
| 5 | `Cypress.on('fail')` | `artifact:console` | Browser | per failed attempt | `cy.task` |
| 6 | `Cypress.on('fail')` | `artifact:commands` | Browser | per failed attempt | `cy.task` |
| 7 | `Cypress.on('fail')` | `artifact:dom` | Browser | per failed attempt | `cy.task` |
| 8 | `Cypress.on('fail')` | `artifact:dom-backtrack` | Browser | N per failure (if `backtrackDepth>0`) | `cy.task` |
| 9 | `after:screenshot` | `artifact:screenshot` | Node | per screenshot | direct `emit()` |
| 10 | `afterEach` | `test:attempt:end` | Browser | per attempt | `cy.task` |
| 11 | `after:spec` | `spec:end` | Node | once per spec | direct `emit()` |
| 12 | `after:spec` | `artifact:stdout` | Node | once per **failing** spec | direct `emit()` |
| 13 | `after:run` | `run:end` | Node | once per run | direct `emit()` + **final flush** |

## Payloads

### `run:start`
The run manifest. Announces the full spec list before anything executes.
```jsonc
{
  "specs": ["cypress/e2e/login.cy.js", "…"],   // all spec paths, in run order
  "totalSpecs": 2,
  "browser": { "name": "electron", "version": "138.0" },
  "cypressVersion": "15.18.1",
  "ci": {
    "branch": "fix/login",         // GITHUB_REF_NAME / CI_COMMIT_REF_NAME
    "commit": "9f3c1a2",           // GITHUB_SHA / CI_COMMIT_SHA
    "pr": "1778",                  // parsed from GITHUB_REF, or CI_MERGE_REQUEST_IID
    "triggeredBy": "octocat",      // GITHUB_ACTOR / GITLAB_USER_LOGIN
    "buildUrl": "https://github.com/org/repo/actions/runs/123",
    "provider": "github",          // "gitlab" | null
    "machine": "runner-1"          // os.hostname()
  }
}
```
> `ci.*` fields are `null` on local runs (no CI env vars). See [CI.md](./CI.md).

### `spec:tests`
The it-block roster for a spec, read from Mocha's parsed suite tree.
```jsonc
{
  "spec": "cypress/e2e/todos.cy.js",
  "totalTests": 14,
  "tests": [ { "testId": "todos > adds a task", "title": "adds a task" }, "…" ]
}
```

### `spec:start`
```jsonc
{ "spec": "cypress/e2e/login.cy.js" }
```

### `test:start`
Flushed immediately — the live per-it-block signal.
```jsonc
{ "testId": "login > shows an error", "title": "shows an error",
  "attempt": 1, "state": "running", "spec": "cypress/e2e/login.cy.js" }
```

### `test:attempt:end`
```jsonc
{ "testId": "login > shows an error", "state": "failed", "attempt": 1,
  "willRetry": true, "duration": 137, "error": "expected banner", "spec": "…" }
```

### `artifact:screenshot`
`testId` is taken from the running test even when Cypress sends empty titles, so
it always maps to an it-block + attempt.
```jsonc
{ "testId": "login > shows an error", "name": "…", "attempt": 2,
  "width": 1280, "height": 720, "takenAt": "…", "base64": "iVBOR…" }
```

### `artifact:dom`
The page's address is `pageUrl`; `url` is reserved for the S3 artifact link.
```jsonc
{ "testId": "login > shows an error", "attempt": 1, "error": "…",
  "pageUrl": "http://localhost:3000/login",
  "viewportWidth": 1280, "viewportHeight": 720,
  "htmlGzipBase64": "H4sIA…" }   // or "url" in s3 mode
```

### `artifact:dom-backtrack`
One event per ring snapshot (only when `dom.backtrackDepth > 0`).
```jsonc
{ "testId": "…", "attempt": 1, "command": "click",
  "stepsBeforeFailure": 1,       // 1 = the command right before failure
  "htmlGzipBase64": "H4sIA…", "pageUrl": "…" }
```

### `artifact:commands`
The command log — a Cypress Cloud-style timeline. Only the last `commands.depth`
commands are shipped, but `totalCommands` is the true count and each entry
carries its real ordinal `i` (so command #245 reads as #245, not #20).
`stepsBeforeFailure` (0 = the command that failed) lets each line up with the
DOM backtrack. The in-flight command at failure is the last entry,
`state: "failed"`.
```jsonc
{ "testId": "…", "attempt": 1, "error": "…",
  "totalCommands": 42,                 // full count for the attempt
  "commands": [                        // only the last N (commands.depth)
    { "i": 41, "name": "get", "args": "[data-cy=login-card]",
      "state": "passed", "ms": 1, "stepsBeforeFailure": 1 },
    { "i": 42, "name": "get", "args": "[data-cy=does-not-exist], {\"timeout\":500}",
      "state": "failed", "ms": 498, "stepsBeforeFailure": 0 }
  ] }
```

### `artifact:console`
The browser console lines the app logged before failing (last `console.depth`),
each with its true ordinal `i`.
```jsonc
{ "testId": "…", "attempt": 1, "error": "…",
  "totalLogs": 3,
  "logs": [
    { "i": 1, "level": "log",   "text": "[TaskBoard] app loaded" },
    { "i": 3, "level": "error", "text": "[TaskBoard] authentication failed for demo@example.com" }
  ] }
```

### `artifact:stdout`
Node-side terminal output for a **failing spec only** — whatever the Cypress
**plugin process** printed during the spec (your `cy.task` logs, plugin logs,
a server running in that process). **Not** the Cypress reporter block (test
tree + error stack): that runs in a separate process and is unreachable from
`setupNodeEvents` — but it's already captured structurally in `spec:end` and
the per-test `error` fields.
```jsonc
{ "spec": "cypress/e2e/login.cy.js", "failures": 1, "bytes": 141,
  "stdout": "[server] processing login for demo@example.com\n…" }
```

### `spec:end`
```jsonc
{ "spec": "cypress/e2e/login.cy.js",
  "stats": { "duration": 900, "tests": 3, "passes": 2,
             "failures": 1, "pending": 0, "skipped": 0 },
  "tests": [ { "testId": "…", "state": "failed", "duration": 2342,
               "attempts": 3, "displayError": "…" } ],
  "video": null }
```

### `run:end`
```jsonc
{ "status": "failed", "totalDuration": 9602,
  "totals": { "specs": 2, "tests": 6, "passed": 5,
              "failed": 1, "pending": 0, "skipped": 0 } }
```

## The views

Columns exposed by each dashboard view (see
[schema.sql](../tools/cypress-live-reporter/schema.sql)):

**`clr_runs`** — `run_id, status, branch, commit, pr, triggered_by, build_url,
machine, browser, browser_version, cypress_version, total_specs, total_tests,
passed, failed, pending, skipped, duration_ms, started_at, ended_at,
last_event_at`

**`clr_tests_live`** — `run_id, test_id, title, spec, state, attempt,
duration_ms, error, updated_at`

**`clr_specs`** — `run_id, spec, status, duration_ms, passes, failures, pending,
skipped, video, updated_at, planned_tests, planned_test_ids`

**`clr_artifacts`** — `run_id, seq, type, ts, test_id, attempt, name,
screenshot_base64, dom_gzip_base64, artifact_url, page_url, steps_before_failure,
command, width, height, commands, total_commands, console_logs, total_logs,
stdout, error, spec`

## Honest limitations

- **Tests skipped by a hook failure** don't emit `test:start`/`test:attempt:end`
  (Cypress never runs them). They still appear in the `spec:tests` roster and in
  `spec:end`'s per-test array as skipped.
- **DOM snapshots are static HTML** — selectors are queryable and styles mostly
  render, but there's no JS state, no shadow DOM contents, no cross-origin iframe
  contents.
- **A killed runner** never sends `run:end`; `clr_runs` marks it `stale` after 3
  minutes of silence.
