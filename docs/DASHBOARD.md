# Building the dashboard

cypress-live-reporter fills a database; the dashboard is yours to build. This
guide covers the queries and widgets for a live view — whether you build it in
ToolJet, Grafana, Retool, or plain HTML.

- [Two working references](#two-working-references)
- [The queries](#the-queries)
- [Rendering artifacts](#rendering-artifacts)
- [Building it in ToolJet](#building-it-in-tooljet)
- [Design notes](#design-notes)

---

## Two working references

You don't have to start from scratch:

1. **`demo/dashboard.js`** — a complete, single-file live dashboard (Node + vanilla
   JS, ~250 lines). Runs, live tests with queued rows, spec progress, the command
   log, and screenshot/DOM evidence, polling every 2s. Run it against the demo:
   ```bash
   node demo/dashboard.js      # http://localhost:4488
   ```
   Read it as the canonical example of how to consume every view.

2. **`demo/tjai-dashboard-prompt.md`** — a self-contained prompt (schema + real
   sample rows) you can paste into ToolJet's AI app builder to scaffold the app.

## The queries

All four auto-refresh every **2–3 seconds**. `{{selected}}` is the `run_id` of the
run the user picked (default: the newest).

**Runs list** — the sidebar:
```sql
SELECT run_id, status, branch, commit, pr, triggered_by,
       passed, failed, total_specs, duration_ms, started_at
FROM clr_runs
ORDER BY started_at DESC
LIMIT 25;
```

**Live tests** for the selected run — the heartbeat:
```sql
SELECT test_id, state, attempt, duration_ms, error, updated_at
FROM clr_tests_live
WHERE run_id = {{selected}}::uuid
ORDER BY updated_at DESC;
```

**Spec progress** — including planned vs actual:
```sql
SELECT spec, status, passes, failures, planned_tests, duration_ms
FROM clr_specs
WHERE run_id = {{selected}}::uuid
ORDER BY spec;
```

**Artifacts** for the selected test:
```sql
SELECT type, attempt, screenshot_base64, dom_gzip_base64, artifact_url,
       page_url, commands, error, steps_before_failure, command, seq
FROM clr_artifacts
WHERE run_id = {{selected}}::uuid
  AND test_id = {{selectedTest}}
ORDER BY seq;
```

**Queued tests** (roster minus started) — for the "0 / N done" experience: take
`clr_specs.planned_test_ids` and subtract the `test_id`s already in
`clr_tests_live`. See the merge in `demo/dashboard.js`.

## Rendering artifacts

**Screenshots** — bind an Image widget to either storage mode:
```
{{ row.artifact_url ?? 'data:image/png;base64,' + row.screenshot_base64 }}
```

**Command log** — `commands` is a JSON array; render it as a timeline, one row per
`{ name, args, state, ms }`, and highlight the final `state: "failed"` entry. This
is the "what ran before it broke" view.

**DOM snapshots** — `dom_gzip_base64` is gzipped HTML. Gunzip it (with
[pako](https://github.com/nodeca/pako) in the browser, or server-side) and render
in a **sandboxed iframe** so it stays inert:
```html
<iframe sandbox="allow-same-origin" srcDoc={html}></iframe>
```
`allow-same-origin` without `allow-scripts` lets you query and highlight nodes
inside the snapshot without running its JavaScript. Add a selector-tester input
that runs `querySelectorAll` against the iframe and outlines matches — that turns
the snapshot into a poor-man's Test Replay. (In s3 mode, `fetch(artifact_url)`
returns plain HTML — the `.html.gz` is served with `Content-Encoding: gzip`.)

## Building it in ToolJet

1. Connect your Postgres (`CLR_PG_URL`'s database) as a ToolJet datasource.
2. Add the four queries above; set each to auto-refresh (2–3s).
3. Lay out:
   - **Table** bound to the runs query (left). Its `selectedRow.run_id` feeds the others.
   - **Table** for live tests, with row styling on `state`.
   - **Table** for specs, showing `passes+failures / planned_tests`.
   - **Image** widget bound to the screenshot expression above.
   - **Custom Component** for the DOM viewer (pako + sandboxed iframe + selector tester).
   - **Custom Component** (or a styled table) for the command-log timeline.

The full ToolJet walkthrough — with the exact widget bindings and the DOM-viewer
component source — lives in the
[configuration reference](../tools/cypress-live-reporter/README.md#tooljet-dashboard-guide),
and the paste-ready AI prompt is in
[demo/tjai-dashboard-prompt.md](../demo/tjai-dashboard-prompt.md).

> Hosted ToolJet Cloud can't reach a `localhost` Postgres — use self-hosted
> ToolJet or a tunnel when developing against the demo database.

## Design notes

- **Status colors:** `running` = blue (pulse), `passed` = green, `failed` = red,
  `retrying` = amber, `stale`/`queued`/`pending` = gray.
- **`stale` runs** have NULL totals — render them as "—", but keep the last-known
  spec/test rows (they show where the run died).
- **Sort live tests by `updated_at DESC`** so the action is always on top.
- **Don't render `dom_gzip_base64` raw** — it's gzipped bytes, not text.
- The whole thing is **read-only** over the views; the dashboard never writes to
  `clr_events`.
