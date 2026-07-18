# Architecture & data model

This is the mental model for cypress-live-reporter: how an event travels from a
running test into your database, how everything is identified, where it's
stored, and why it can never break your run.

- [The big picture](#the-big-picture)
- [How events travel](#how-events-travel)
- [The identifier hierarchy](#the-identifier-hierarchy)
- [The event envelope: runId, seq, ts](#the-event-envelope)
- [Storage model](#storage-model)
- [The four views](#the-four-views)
- [Reliability guarantees](#reliability-guarantees)

---

## The big picture

There are two sources of events and one destination.

```
BROWSER (test iframe)                 NODE (Cypress plugin process)          SINK
─────────────────────                 ────────────────────────────          ────
support.js                            plugin.js
  beforeEach → test:start                before:run  → run:start
  afterEach  → test:attempt:end          before:spec → spec:start
  on('fail') → artifact:dom              after:spec  → spec:end
             → artifact:commands         after:run   → run:end  (+ final flush)
  before()   → spec:tests                after:screenshot → artifact:screenshot
     │                                       │
     │  buffered, then                       │  emit(): stamp runId + seq + ts
     └── cy.task('clr:events', batch) ──▶ task handler ──▶ emit() ──▶ sinks.js ──▶ Postgres
                                                                                   or webhook
```

- **Browser-side events** can't reach the database directly (the test runs in a
  sandboxed iframe), so they ride Cypress's one bridge to Node: **`cy.task`**.
- **Node-side events** already run in the plugin process, so they go straight to
  `emit()`.
- Both funnel through the same `emit()` → sink path, so both get the same
  envelope and ordering.

## How events travel

**Browser → Node (the `cy.task` path).** The browser side keeps an in-memory
`buffer`. Hooks `push()` events onto it and `flush()` ships the batch with
`cy.task('clr:events', batch, { log: false })`. `test:start` flushes immediately
(that's what makes the dashboard live per it-block); other events can share a
flush. Whatever crosses `cy.task` must be JSON-serializable, which is why the
browser only ever sends plain objects — never DOM nodes.

**Node stamps and forwards.** The `clr:events` task loops the batch, and for
each event calls `emit(type, payload)`, which:

1. assigns the next `seq` (a single per-run counter — see below),
2. stamps `runId` and `ts`,
3. hands it to the sink **fire-and-forget** (never awaited here).

DOM HTML is gzipped at this step (`htmlGzipBase64`) before it's forwarded, and
the raw `html` is dropped.

**The sink writes it** (`sinks.js`). A concurrency gate runs at most
`maxParallelUploads` sends at once; the rest queue FIFO. Every failure is
swallowed (logged only with `debug`/`CLR_DEBUG=1`). In Postgres mode it's an
`INSERT ... ON CONFLICT (run_id, seq) DO NOTHING`; in webhook mode a JSON `POST`
with an `AbortController` timeout.

Because sends are fire-and-forget, **a slow or unreachable sink never blocks a
test**. The only place the plugin ever waits is the bounded final flush in
`after:run`.

## The identifier hierarchy

Four levels, each a *different kind* of identifier — this matters for how you
join and de-duplicate.

```
run_id (uuid)                         random per run, or CLR_RUN_ID override
  └─ spec (file path)                 no id — identified by its relative path
       └─ test_id (title chain)       the "describe > … > it" titles joined by " > "
            └─ attempt (1, 2, 3…)     one test can run several times on retry
                 └─ artifact          located by (run_id, test_id, attempt, type) + seq
```

| Level | Identifier | Nature | Example |
|---|---|---|---|
| Run | `run_id` | a real UUID | `a3bb189e-8bf9-4888-…` |
| Spec | `spec` | a file path | `cypress/e2e/login.cy.js` |
| Test (it-block) | `test_id` | the full title chain (**not** a path or number) | `login > shows an error on bad password` |
| Attempt | `attempt` | integer, `_currentRetry + 1` | `2` |
| Artifact | — | no own id; `seq` is its unique handle | screenshot at `seq 8` |

**Consequences of `test_id` being the title chain:**

- **Uniqueness is per run, and only if titles are unique.** Ten identical
  `it('adds a task')` blocks would collapse into one row in `clr_tests_live`.
  Keep titles unique (the demo numbers its duplicates `copy 1 of 10` …).
- **Everything joins on `(run_id, test_id)`** — that's the key of
  `clr_tests_live`. A `test_id` recurs across runs by design.
- **Renaming an `it()` creates a "new" test** — identity is the title, so there's
  no history link across a rename.
- **Artifacts key on `(run_id, test_id, attempt)`** — each retry produces its own
  screenshot / DOM / command log, so you can inspect each failed attempt
  independently.

> Why aren't it-blocks known at `spec:start`? Because at that Node-side moment the
> spec file hasn't executed — `it()` blocks (which can be generated in loops)
> don't exist yet. They're discovered in the browser once Mocha parses the file,
> which is why every test event originates browser-side. The `spec:tests` event
> announces the full roster the instant that parse completes. See
> [EVENTS.md](./EVENTS.md).

## The event envelope

Every event, regardless of origin, carries four envelope fields on top of its
own payload:

| Field | Meaning |
|---|---|
| `runId` | the run's UUID |
| `seq` | a **monotonic per-run counter**, assigned on the Node side |
| `ts` | ISO timestamp |
| `type` | the event type (`run:start`, `test:start`, …) |

**Why `seq` is assigned on Node, for every event.** Browser events arrive in
batches and Node events fire independently; assigning `seq` in one place gives a
single total order across both, and makes `UNIQUE (run_id, seq)` the basis for
idempotency — a re-sent event hits `ON CONFLICT DO NOTHING` and is skipped. The
views rely on this: they pick the latest state per entity with
`DISTINCT ON (…) ORDER BY seq DESC`.

> ⚠️ **Parallel-CI caveat.** `seq` is a per-*process* counter. If several
> machines share one `CLR_RUN_ID` (parallel CI), they each start at `seq = 1`
> and their inserts collide on `(run_id, seq)` — the second writer's events are
> silently dropped by `ON CONFLICT DO NOTHING`. Today, use a distinct `runId`
> per machine (the default) and group them in the dashboard by branch/commit, or
> treat "one run = one machine". A per-machine key is a known future fix.

## Storage model

**One append-only table holds everything:**

```sql
clr_events(id bigserial, run_id uuid, seq int, type text,
           ts timestamptz, payload jsonb, UNIQUE(run_id, seq))
```

Every event — lifecycle, test, screenshot, DOM, command log — is one row. The
event's data lives in the `payload` jsonb column; the top-level columns exist
for indexing and idempotency. The dashboard never reads this table directly — it
reads the [views](#the-four-views), which compute current state from the raw log.

**Artifacts — where the bytes go:**

| Kind | Size | Default storage | Alternative |
|---|---|---|---|
| Command log | ~1 KB text | inline in `payload` (always) | — |
| Screenshot | 100 KB – few MB | `payload.base64` (`"db"`) | S3 `url` (`"s3"`) |
| DOM snapshot | KBs – ~2 MB gzipped | `payload.htmlGzipBase64` (`"db"`) | S3 `.html.gz` (`"s3"`) |

In **`"db"` mode** (default) the base64 stays in the payload and lands in
Postgres — simplest, but grows the table. In **`"s3"` mode** the blob is
uploaded on the async send path (S3 / R2 / MinIO), the base64 is replaced by a
`url`, and the payload shrinks. Screenshots and DOM can use different modes. DOM
HTML is always gzipped on the Node side before storage. See the
[configuration reference](../tools/cypress-live-reporter/README.md).

## The four views

Each view answers "what is the current state?" by taking the newest event per
entity (`DISTINCT ON … ORDER BY seq DESC`). Full column lists in
[EVENTS.md](./EVENTS.md#the-views).

- **`clr_runs`** — `run:start` joined to `run:end`. Status is the end status if
  present, else **`stale`** when the newest event for the run is older than 3
  minutes (crash detection), else `running`. Carries branch / commit / pr /
  triggered_by / browser / totals / duration.
- **`clr_tests_live`** — latest of `test:start` / `test:attempt:end` per
  `(run_id, test_id)`. State is `running`, `retrying` (last attempt ended with
  `willRetry=true`), or the final `passed` / `failed` / `pending`.
- **`clr_specs`** — latest of `spec:start` / `spec:end`, **left-joined to
  `spec:tests`** for `planned_tests` / `planned_test_ids`, so you can show
  "3 / 14 done" the instant a spec starts.
- **`clr_artifacts`** — every `artifact:*` event, columns for
  `screenshot_base64`, `dom_gzip_base64`, `artifact_url`, `commands`, `page_url`,
  `steps_before_failure`, `command`, `error`.

## Reliability guarantees

The hard rules the plugin is built to keep:

1. **Nothing may fail a test, fail a run, or block the runner.** Every event
   handler body is wrapped in try/catch — an error degrades to a dropped event.
2. **No handler awaits network I/O**, except the single bounded flush in
   `after:run` (hard-capped by `finalFlushMs`).
3. **An unreachable sink can't hang the run.** Webhook sends abort at
   `timeoutMs`; the Postgres pool uses `connectionTimeoutMillis: 3000` and
   statement timeouts.
4. **`Cypress.on('fail')` always rethrows** — the reporter records evidence but
   never swallows the real failure.
5. **Idempotent in Postgres** — `ON CONFLICT (run_id, seq) DO NOTHING`, so a
   re-sent batch can't duplicate rows.
6. **Self-disables cleanly** — no sink env var → one warning, `enabled:false`
   injected so the browser side stays inert, run proceeds untouched.
