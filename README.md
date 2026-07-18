# cypress-live-reporter

[![test](https://github.com/emidhun/cypress-live-reporter/actions/workflows/test.yml/badge.svg)](https://github.com/emidhun/cypress-live-reporter/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

**A free, self-hosted replacement for Cypress Cloud's live status and failure evidence.** Streams run / spec / test lifecycle events, a command log, screenshots, and DOM snapshots to **Postgres** or a **webhook** — so you can build a real-time test dashboard (e.g. in [ToolJet](https://tooljet.com)) on a stack you own.

```
   Cypress run  ──▶  cypress-live-reporter  ──▶  Postgres / webhook  ──▶  your dashboard
   (any suite)       (this plugin)               (clr_events + views)     (live, 2s refresh)
```

- **Zero-config** — two `require` lines and one env var. Every feature defaults **on**.
- **Zero required dependencies** — `pg`, `dotenv`, `@aws-sdk/client-s3` are all lazy/optional. Node 18+.
- **Can never break your run** — every handler is wrapped; a reporter error degrades to a dropped event, never a failed test. No handler awaits network I/O except one bounded flush at the very end.
- **Live per it-block** — tests light up as `running → retrying → passed/failed` in real time, with the roster known up front.
- **Failure evidence** — screenshot, DOM snapshot (queryable static HTML), and a Cypress Cloud-style command log for every failed attempt.

---

## Quickstart

**1. Wire the Node plugin** — `cypress.config.js`:

```js
setupNodeEvents(on, config) {
  return require('./tools/cypress-live-reporter/plugin').livePlugin(on, config);
}
```

**2. Wire the browser side** — `cypress/support/e2e.js`:

```js
require('../../tools/cypress-live-reporter/support');
```

**3. Point it at a sink** — `.env` (auto-detected):

```bash
CLR_PG_URL=postgres://user:pass@host:5432/db      # postgres mode  (npm i -D pg)
# — or —
CLR_WEBHOOK_URL=https://your-endpoint/hook        # webhook mode
```

For Postgres, apply the schema once:

```bash
psql "$CLR_PG_URL" -f tools/cypress-live-reporter/schema.sql
```

Run your suite as normal (`npx cypress run`). If neither env var is set, the plugin prints **one** warning and self-disables — it never throws.

> Try it end-to-end in 60 seconds with the bundled demo app + dashboard: see **[demo/README.md](./demo/README.md)**.

---

## Documentation

| Guide | What's in it |
|---|---|
| **[Architecture & data model](./docs/ARCHITECTURE.md)** | How events flow browser → Node → sink, the identifier hierarchy (run / spec / test / attempt / artifact), the storage model, and reliability guarantees. **Start here to understand the system.** |
| **[Event reference](./docs/EVENTS.md)** | Every event, exactly when it fires, and its payload — with a chronological timeline. |
| **[CI/CD integration](./docs/CI.md)** | GitHub Actions / GitLab setup, how PR number + triggerer are captured, parallel runs, and the Postgres-in-CI recipe. |
| **[Building the dashboard](./docs/DASHBOARD.md)** | The SQL views, the four dashboard queries, image + DOM widgets, the command-log panel, and the ToolJet AI prompt. |
| **[Configuration reference](./tools/cypress-live-reporter/README.md)** | Every config key, the everything-on-by-default rule, storage modes, and performance notes. |

---

## What you get

Once running, four SQL views give you everything a dashboard needs:

- **`clr_runs`** — one row per run: status (`running` / `passed` / `failed` / `stale`), branch, commit, **PR**, **triggered_by**, browser, totals, duration.
- **`clr_tests_live`** — current state of every it-block: `running` / `retrying` / `passed` / `failed`, attempt, duration, error.
- **`clr_specs`** — per-spec progress, including **planned vs actual** test counts (the roster is announced before any test runs).
- **`clr_artifacts`** — screenshots, DOM snapshots, and command logs, each mapped to its it-block and attempt.

A killed runner is detected automatically: with no `run:end`, `clr_runs` marks the run `stale` after 3 minutes of silence.

---

## Repository layout

```
tools/cypress-live-reporter/   the plugin (vendor this into your project)
  plugin.js        Node side — setupNodeEvents, lifecycle events, screenshots, task
  support.js       browser side — live tests, command log, DOM snapshots
  sinks.js         delivery — webhook + postgres, concurrency gate, bounded flush
  storage.js       artifact offload — db (base64) vs s3/R2/MinIO
  schema.sql       Postgres table + the four dashboard views
  README.md        configuration & event reference
  test/            smoke + postgres integration tests
docs/              the guides linked above
demo/              a runnable demo app, Cypress suite, and a live dashboard
```

## Requirements

- **Node 18+** (uses built-in `fetch`, `AbortController`, `node:zlib`, `crypto.randomUUID`).
- **Cypress 10+** (uses `setupNodeEvents`).
- A **Postgres** database *or* a **webhook** receiver.

## License

[MIT](./LICENSE)
