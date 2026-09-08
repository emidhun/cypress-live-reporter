# cypress-live-reporter

[![test](https://github.com/emidhun/cypress-live-reporter/actions/workflows/test.yml/badge.svg)](https://github.com/emidhun/cypress-live-reporter/actions/workflows/test.yml)

> **This is the package reference** (install, config, event & dashboard details). For the project overview and the concept guides, start at the [root README](../../README.md) and [docs/](../../docs/): [Architecture](../../docs/ARCHITECTURE.md) · [Events](../../docs/EVENTS.md) · [CI](../../docs/CI.md) · [Dashboard](../../docs/DASHBOARD.md).

Self-hosted live reporting for Cypress. Streams run/spec/test lifecycle events and failure evidence (screenshots + a serialized DOM snapshot) to **Postgres** or a **webhook**, so you can build a real-time dashboard (e.g. in Canopy) on a free stack — a replacement for Cypress Cloud's live status and failure artifacts.

- **Zero-config**: two `require` lines + one Cypress env value (`CLR_DB` or `CLR_WEBHOOK`). Every feature defaults to **ON**.
- **One config surface**: everything is read from Cypress `env` — `cypress.env.json`, the `env` block in `cypress.config.js`, or `CYPRESS_*` variables. No sidecar config file, no bespoke `process.env` contract.
- **Zero required dependencies**: `pg` and `@aws-sdk/client-s3` are lazy and optional. Node 18+.
- **Can never break your run**: every handler is wrapped; errors degrade to dropped events. No handler awaits network I/O (except one bounded flush at the very end of the run).

---

## Install

```bash
npm i -D cypress-live-reporter
```

> Prefer to vendor it? Copy `tools/cypress-live-reporter/` into your repo and use a relative `require('./tools/cypress-live-reporter/plugin')` instead of the package name below — everything else is identical.

**1. `cypress.config.js`**

```js
module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      return require('cypress-live-reporter/plugin').livePlugin(on, config);
    },
  },
});
```

**2. `cypress/support/e2e.js`**

```js
require('cypress-live-reporter/support');
```

**3. Point it at a sink — via Cypress `env`.** The simplest is `cypress.env.json` in your project root:

```json
{
  "CLR_DB": "postgres://user:pass@host:5432/db"
}
```

That's the entire configuration for **postgres mode** (auto-selected when `CLR_DB` is set). For **webhook mode** instead:

```json
{
  "CLR_WEBHOOK": "https://your-endpoint.example.com/hook",
  "CLR_WEBHOOK_TOKEN": "optional-bearer-token"
}
```

In CI, prefer real environment variables: Cypress folds any `CYPRESS_`-prefixed var into `env`, so `CYPRESS_CLR_DB=…` sets `CLR_DB` (see [CI](../../docs/CI.md)). If **neither** `CLR_DB` nor `CLR_WEBHOOK` is set, the plugin prints one warning and self-disables — it never throws and never breaks the run.

> Postgres mode needs the `pg` package (`npm i -D pg`) and the schema applied once — the next step.

**4. Postgres only — create the schema (required).** The plugin does not create tables. Sink errors are swallowed, so a missing table means every insert is silently dropped (empty dashboard, no error). Run this once before your first run:

```bash
psql "postgres://user:pass@host:5432/db" -f node_modules/cypress-live-reporter/schema.sql
```

It creates the append-only `clr_events` table + indexes and the four dashboard views. The core table, if you prefer to run the DDL by hand:

```sql
CREATE TABLE IF NOT EXISTS clr_events (
  id      bigserial   PRIMARY KEY,
  run_id  uuid        NOT NULL,
  seq     int         NOT NULL,
  type    text        NOT NULL,
  ts      timestamptz NOT NULL DEFAULT now(),
  payload jsonb       NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS clr_events_run_type_idx ON clr_events (run_id, type);
CREATE INDEX IF NOT EXISTS clr_events_ts_idx       ON clr_events (ts DESC);
```

The dashboard views live in [`schema.sql`](./schema.sql) — running that file is the simplest path. (Webhook mode needs no schema.)

---

## Configuration (Cypress `env`)

Everything is **ON by default** — you only set keys to point at a sink or turn features off. There is **one** place to set them: the Cypress `env`. You can populate it three ways, in ascending precedence:

```jsonc
// 1. cypress.env.json — best for local, per-developer settings
{ "CLR_DB": "postgres://…", "CLR_PROJECT_ID": "todos-web", "CLR_DOM_BACKTRACK": 2 }
```
```js
// 2. the env block in cypress.config.js — checked-in project defaults
module.exports = defineConfig({ e2e: { env: { CLR_PROJECT_ID: 'todos-web' } } });
```
```bash
# 3. CYPRESS_-prefixed variables — best for CI (overrides the above)
CYPRESS_CLR_DB=postgres://…  CYPRESS_CLR_PROJECT_ID=todos-web
```

Values may be JSON types (in `cypress.env.json`) or strings (from `CYPRESS_*` / `--env`); booleans and numbers are coerced either way.

**Required:** exactly one sink — `CLR_DB` (Postgres) **or** `CLR_WEBHOOK`. Everything else is optional and on by default. A minimal and a typical `cypress.env.json`:

```json
// minimal — required only
{ "CLR_DB": "postgres://user:pass@host:5432/db" }
```
```json
// typical
{
  "CLR_DB": "postgres://user:pass@host:5432/db",
  "CLR_PROJECT_ID": "todos-web",
  "CLR_DOM_BACKTRACK": 2,
  "CLR_CONSOLE_DEPTH": 12
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| **Connection & identity** | | |
| `CLR_DB` | — | **Required (one of).** Postgres connection string → **postgres mode**. |
| `CLR_WEBHOOK` | — | **Required (one of).** Webhook URL → **webhook mode** (used only when `CLR_DB` is unset). |
| `CLR_WEBHOOK_TOKEN` | — | Bearer token sent as `Authorization` on webhook requests. |
| `CLR_RUN_ID` | random UUID | Override the run id. The **same** value across parallel machines merges them into one run (must be UUID-shaped in postgres mode). |
| `CLR_PROJECT_ID` | — | Free-form id grouping many runs under one project (e.g. `todos-web`). See [Grouping runs by project](#grouping-runs-by-project). |
| **Master** | | |
| `CLR_ENABLED` | `true` | Master switch; `false` disables everything silently. |
| `CLR_DEBUG` | `false` | Log every send + swallowed error to the console. |
| **Events** | | |
| `CLR_RUN_LIFECYCLE` | `true` | `run:start` / `spec:start` / `spec:end` / `run:end` (Node side). |
| `CLR_LIVE_TESTS` | `true` | `test:start` / `test:attempt:end` (browser side, live per it-block). |
| **Failure evidence** | | |
| `CLR_SCREENSHOTS` | `true` | Ship failure screenshots. |
| `CLR_SCREENSHOTS_STORAGE` | `db` | `db` = base64 in payload · `s3` = upload, payload carries `url`. |
| `CLR_COMMANDS` | `true` | On failure, ship the last N commands (name + args + state + ms) — a command log like Cypress Cloud. Cheap (no DOM). |
| `CLR_COMMANDS_DEPTH` | `20` | How many commands to keep before failure (1–50). |
| `CLR_CONSOLE` | `true` | On failure, ship the last N browser console lines (the app's `console.*`). |
| `CLR_CONSOLE_DEPTH` | `8` | How many console lines to keep (1–200). Default 8 = the sweet spot. |
| `CLR_STDOUT` | `true` | For failing specs, ship node/task terminal output (plugin-process stdout). |
| `CLR_STDOUT_MAX_BYTES` | `65536` | Cap on captured stdout per spec (keeps the tail). |
| `CLR_DOM` | `true` | Serialize the DOM at the moment of failure. |
| `CLR_DOM_STORAGE` | `db` | `db` or `s3` — independent of `CLR_SCREENSHOTS_STORAGE`. |
| `CLR_DOM_BACKTRACK` | `0` | 1–5: also snapshot the DOM of the last N commands before failure. **Keep 0 in CI gates** (see Performance). |
| **S3 (only for `s3` storage)** | | |
| `CLR_S3_BUCKET` | — | Required for any `s3` mode. Missing → warn once, fall back to db. |
| `CLR_S3_REGION` | `ap-south-1` | |
| `CLR_S3_PREFIX` | `clr/` | Key layout: `{prefix}{runId}/{sanitized testId}/attempt-N/{name}`. |
| `CLR_S3_ENDPOINT` | — | Set for R2 / MinIO (enables path-style). Creds from standard AWS env. |
| `CLR_S3_PUBLIC_BASE_URL` | — | Optional CDN base for artifact links. |
| **Performance** | | |
| `CLR_MAX_PARALLEL_UPLOADS` | `3` | Concurrency gate for in-flight sends; overflow queues FIFO. |
| `CLR_TIMEOUT_MS` | `4000` | Per-send timeout (webhook abort / pg statement timeout). |
| `CLR_FINAL_FLUSH_MS` | `10000` | Hard cap on the single end-of-run drain. |

See [`cypress.env.example.json`](./cypress.env.example.json) for a copy-paste starting point. The Node plugin injects the browser-relevant slice into `Cypress.env('clr')` automatically — `support.js` needs no configuration of its own.

> **Note on CI provenance.** Branch, commit, PR, build URL and actor are *not* `CLR_*` keys — they're read from the CI runner's own OS env (`GITHUB_*`, `CI_*`) automatically. You never set those; see [CI](../../docs/CI.md).

---

## The image / DOM flow: `db` vs `s3`

```
                         ┌──────────────────────────────────────────────┐
  browser (support.js)   │  Node (plugin.js)          async send path   │
  ─────────────────────  │  ───────────────────────   ────────────────  │
  fail → serialize DOM ──┼─▶ cy.task batch                              │
                         │   gzip html →              storage: "db"     │
  Cypress screenshot ────┼─▶ htmlGzipBase64   ──▶  ┌──────────────────┐ │
  (after:screenshot,     │   read file →            │ base64 stays in  │ │
   read + base64)        │   base64                 │ payload → lands  │ │
                         │        │                 │ in Postgres /    │ │
                         │        ▼                 │ webhook body     │ │
                         │   FIFO queue,            └──────────────────┘ │
                         │   ≤ maxParallelUploads   storage: "s3"        │
                         │   in flight          ──▶ ┌──────────────────┐ │
                         │                          │ upload blob to   │ │
                         │                          │ S3/R2/MinIO,     │ │
                         │                          │ payload gets     │ │
                         │                          │ `url`, base64    │ │
                         │                          │ deleted          │ │
                         │                          └──────────────────┘ │
                         └──────────────────────────────────────────────┘
```

- `"db"` (default): the dashboard renders screenshots as `data:image/png;base64,...` straight from the `clr_artifacts` view. Simplest; grows your DB.
- `"s3"`: the blob is offloaded on the async path; the event carries `url` instead. DOM snapshots are uploaded as `.html.gz` with `ContentEncoding: gzip`, so browsers auto-decompress when you open the link. Screenshots and DOM can use different modes.
- A DOM event's page address is always in `pageUrl`; `url` is exclusively the artifact link — they never collide.

---

## Event reference

Every event carries `runId` (uuid), a **monotonic per-run `seq`** (assigned on the Node side, so browser and Node events share one ordering), an ISO `ts`, and `type`. When a project id is configured it also carries `projectId` (see [Grouping runs by project](#grouping-runs-by-project)).

| Event | Origin | Fired on | Payload highlights |
| --- | --- | --- | --- |
| `run:start` | Node | `before:run` | `specs[]`, `totalSpecs`, `browser{name,version}`, `cypressVersion`, `ci{branch,commit,pr,triggeredBy,buildUrl,provider,machine}` |
| `spec:start` | Node | `before:spec` | `spec` (relative path) |
| `spec:tests` | browser | root `before()` | `spec`, `totalTests`, `tests[]` (`{ testId, title }` for every it-block) — the roster announced up front, before any test runs, so a dashboard can show "0 / N done" immediately. Surfaced as `clr_specs.planned_tests` / `planned_test_ids`. |
| `spec:end` | Node | `after:spec` | `stats{duration,tests,passes,failures,pending,skipped}`, `tests[]{testId,state,duration,attempts,displayError}`, `video` |
| `run:end` | Node | `after:run` | `status` passed/failed, `totalDuration`, `totals{specs,tests,passed,failed,pending,skipped}` |
| `test:start` | browser | global `beforeEach` | `testId` (full title chain, `" > "`-joined), `title`, `attempt`, `state:"running"`, `spec`. Flushed immediately — this is the live per-it-block signal. |
| `test:attempt:end` | browser | global `afterEach` | `state`, `attempt`, `willRetry`, `duration`, `error`, `spec` |
| `artifact:screenshot` | Node | `after:screenshot` | `testId` (from the running test — reliable even when Cypress sends empty titles), `name`, `attempt`, `width`, `height`, `takenAt`, `base64` **or** `url` |
| `artifact:dom` | browser | `Cypress.on('fail')` | `testId`, `attempt`, `error`, `pageUrl`, `viewportWidth/Height`, `htmlGzipBase64` **or** `url`. The failure is always rethrown — never swallowed. |
| `artifact:dom-backtrack` | browser | on fail, if `backtrackDepth > 0` | One event per ring snapshot: `command`, `stepsBeforeFailure` (1 = last command before failure), plus the DOM fields above |
| `artifact:commands` | browser | `Cypress.on('fail')` | `testId`, `attempt`, `error`, `totalCommands`, and `commands[]` — the last N commands, each `{ i, name, args, state, ms, stepsBeforeFailure }`. The in-flight command at failure is the final entry with `state: "failed"`. |
| `artifact:console` | browser | `Cypress.on('fail')` | `testId`, `attempt`, `totalLogs`, and `logs[]` — the last N browser console lines, each `{ i, level, text }`. |
| `artifact:stdout` | Node | `after:spec` (failing specs) | `spec`, `failures`, `bytes`, `stdout` — node/plugin-process terminal output during the spec. |

CI metadata is read from GitHub Actions (`GITHUB_REF_NAME`, `GITHUB_SHA`, `GITHUB_ACTOR`, PR number from `GITHUB_REF` = `refs/pull/<n>/merge`, run URL) and GitLab CI (`CI_COMMIT_REF_NAME`, `CI_COMMIT_SHA`, `GITLAB_USER_LOGIN`, `CI_MERGE_REQUEST_IID`, `CI_JOB_URL`) env vars, plus the machine hostname. Surfaced on `clr_runs` as `pr` / `triggered_by`.

### Parallel CI machines

`runId` defaults to a fresh UUID per Cypress process, so N machines report as N runs. To merge them into **one** run, give them all the same id — set it as a `CYPRESS_`-prefixed variable so Cypress folds it into `env`:

```yaml
env:
  CYPRESS_CLR_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}
```

Note: in postgres mode the `run_id` column is `uuid`, so the value must be UUID-shaped — derive one with `uuidgen` or hash your build id. There is also a `seq`-collision caveat when merging; the reliable alternative is to keep runs separate and group them by `project_id` or `build_url`. See [CI](../../docs/CI.md) for the full recipe.

### Grouping runs by project

`runId` is unique per run; `projectId` groups many runs under one human-readable project (e.g. `todos-web`, `canopy-ce`). Set `CLR_PROJECT_ID` in the Cypress env — `cypress.env.json` locally, or `CYPRESS_CLR_PROJECT_ID` in CI:

```json
// cypress.env.json
{ "CLR_PROJECT_ID": "todos-web" }
```

Unlike `CLR_RUN_ID`, `projectId` is a **free-form string** — no UUID constraint. It's stamped onto every event envelope, so the mapping survives even if run-lifecycle events are disabled. Query it via the `clr_run_projects` view (`run_id, project_id`, one row per run) or the `project_id` column on `clr_runs`. Runs with no `CLR_PROJECT_ID` set are simply absent from `clr_run_projects`.

### Already have an `on('task')`? (`registerTask`)

Cypress allows only **one** `on('task')` listener. By default the plugin registers its own. If you already register tasks, opt out and spread the exposed map into yours:

```js
setupNodeEvents(on, config) {
  config = require('./tools/cypress-live-reporter/plugin')
    .livePlugin(on, config, { registerTask: false });

  on('task', {
    ...config.__clrTasks,        // the reporter's 'clr:events' task
    myOwnTask() { /* ... */ },
  });
  return config;
}
```

---

## Performance notes

- The live per-test feed costs **~2 `cy.task` round-trips per test ≈ 10–30 ms** — negligible for most suites; set `events.liveTests: false` if you're counting milliseconds.
- **The command log is cheap** (`commands.enabled`): capturing command name + args on `command:start`/`command:end` is microseconds — no DOM work — so it stays on in CI. It's the low-cost alternative to backtracking when you just want "what ran before it broke".
- **DOM backtracking is the expensive feature**: serializing the DOM on every command costs **10–50 ms per command** depending on page size. Keep `backtrackDepth: 0` in CI gates; turn it on (max 5) when actively debugging a flaky test.
- All delivery is fire-and-forget behind a concurrency gate (`maxParallelUploads`, FIFO overflow). The only wait in the whole plugin is the end-of-run drain, hard-capped at `finalFlushMs`.
- An unreachable sink cannot hang the run: webhook sends abort at `timeoutMs`; the pg pool uses `connectionTimeoutMillis: 3000` + statement timeouts.

## Honest limitations

- **Tests skipped by a hook failure** don't emit `test:start`/`test:attempt:end` (Cypress never runs them). They still appear up front in the `spec:tests` roster (so the dashboard can show them as never-started) and in the `spec:end` per-test array as skipped.
- **The DOM snapshot is static HTML.** Selectors are queryable and styles mostly render, but there's no JavaScript state, no shadow DOM contents, and no cross-origin iframe contents.
- **A killed runner** (OOM, cancelled job) never sends `run:end`. The `clr_runs` view marks such runs `stale` once no event has arrived for 3 minutes.
- Webhook mode has no ordering/dedup guarantees on your receiver — use `(runId, seq)` yourself; postgres mode is idempotent via `ON CONFLICT (run_id, seq) DO NOTHING`.
- Base64 screenshots in db mode grow the table quickly; use the commented 30-day cleanup in `schema.sql` or switch to s3 storage.

---

## Canopy dashboard guide

Apply [`schema.sql`](./schema.sql), add your Postgres as a Canopy datasource, and build one page with four queries — set each to **auto-refresh every 2–3 s**.

**Query 1 — runs list** (bind to a Table; `{{ }}` are Canopy bindings):

```sql
SELECT run_id, status, branch, commit, machine, browser,
       passed, failed, total_specs, duration_ms, started_at
FROM clr_runs
ORDER BY started_at DESC
LIMIT 25;
```

**Query 2 — live tests for the selected run** (Table with row highlighting on `state`):

```sql
SELECT test_id, state, attempt, duration_ms, error, updated_at
FROM clr_tests_live
WHERE run_id = {{ components.runsTable.selectedRow.run_id }}::uuid
ORDER BY updated_at DESC;
```

**Query 3 — spec progress for the selected run**:

```sql
SELECT spec, status, passes, failures, duration_ms, video
FROM clr_specs
WHERE run_id = {{ components.runsTable.selectedRow.run_id }}::uuid
ORDER BY spec;
```

**Query 4 — artifacts for the selected test**:

```sql
SELECT type, attempt, screenshot_base64, dom_gzip_base64, artifact_url,
       page_url, steps_before_failure, command, ts
FROM clr_artifacts
WHERE run_id = {{ components.runsTable.selectedRow.run_id }}::uuid
  AND test_id = {{ components.testsTable.selectedRow.test_id }}
ORDER BY seq;
```

**Screenshot viewer** — an Image widget with its URL bound to either storage mode:

```
{{ queries.artifacts.data[0].artifact_url ?? 'data:image/png;base64,' + queries.artifacts.data[0].screenshot_base64 }}
```

**DOM viewer + selector tester** — a Custom Component that gunzips the snapshot with `pako`, renders it in a sandboxed iframe, and lets you test selectors against the failure DOM. Pass `data` as:

```
{{ { domGzipBase64: queries.artifacts.data.find(a => a.type === 'artifact:dom')?.dom_gzip_base64 } }}
```

```jsx
import React, { useMemo, useRef, useState } from 'https://esm.sh/react@18';
import pako from 'https://esm.sh/pako@2';

export default function DomViewer({ data }) {
  const frame = useRef(null);
  const [selector, setSelector] = useState('');
  const [matches, setMatches] = useState(null);

  const html = useMemo(() => {
    try {
      if (!data?.domGzipBase64) return null;
      const bytes = Uint8Array.from(atob(data.domGzipBase64), (c) => c.charCodeAt(0));
      return pako.ungzip(bytes, { to: 'string' });
    } catch { return null; }
  }, [data?.domGzipBase64]);

  const test = () => {
    try {
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      doc.querySelectorAll('[data-clr-hit]').forEach((el) => {
        el.style.outline = ''; el.removeAttribute('data-clr-hit');
      });
      const hits = doc.querySelectorAll(selector);
      hits.forEach((el) => {
        el.style.outline = '2px solid #e5484d'; el.setAttribute('data-clr-hit', '1');
      });
      setMatches(hits.length);
    } catch { setMatches(-1); }
  };

  if (!html) return <div>No DOM snapshot for this test.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ flex: 1, padding: 6 }}
          placeholder="Test a selector, e.g. [data-cy=submit]"
          value={selector}
          onChange={(e) => setSelector(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && test()}
        />
        <button onClick={test}>Query</button>
        <span>{matches === null ? '' : matches === -1 ? 'invalid selector' : `${matches} match(es)`}</span>
      </div>
      <iframe
        ref={frame}
        sandbox="allow-same-origin"
        srcDoc={html}
        style={{ flex: 1, width: '100%', border: '1px solid #ddd', background: '#fff' }}
        title="failure DOM"
      />
    </div>
  );
}
```

`sandbox="allow-same-origin"` (without `allow-scripts`) keeps the snapshot inert — no JS runs — while still letting the component query and highlight nodes inside it. If your DOM artifacts use s3 storage, fetch `artifact_url` instead (the `.html.gz` is served with `Content-Encoding: gzip`, so `fetch(...).then(r => r.text())` gives you plain HTML).

---

## Verifying the install

```bash
node tools/cypress-live-reporter/test/smoke.js
```

Runs the full lifecycle against a local capture server (asserts payload shape, seq ordering, DOM gzip round-trip), then against an unreachable webhook (asserts the run can't crash or hang), then the no-sink self-disable path.

## License

[MIT](../../LICENSE)
