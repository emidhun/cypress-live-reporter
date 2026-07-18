Build a real-time Cypress test-run dashboard. Data source: my PostgreSQL database
(connect the "clr_demo" postgres datasource). The DB is populated live by a Cypress
reporter plugin; this app only READS from 4 views. All queries auto-refresh every 2-3s.

========================= VIEWS (read-only) =========================

clr_runs        — one row per run
  run_id uuid · status text ('running'|'passed'|'failed'|'stale') · branch · commit ·
  build_url · machine · browser · browser_version · total_specs int · total_tests int ·
  passed int · failed int · pending int · skipped int · duration_ms bigint ·
  started_at timestamptz · ended_at timestamptz · last_event_at timestamptz
  NOTE: 'stale' = runner crashed/killed mid-run; totals are NULL until a run ends.

clr_tests_live  — current state of every test, one row per (run_id, test_id)
  run_id · test_id text (full title chain "suite > test") · title · spec ·
  state ('running'|'retrying'|'passed'|'failed'|'pending') · attempt int ·
  duration_ms bigint · error text · updated_at timestamptz

clr_specs       — progress per spec file
  run_id · spec text · status ('running'|'passed'|'failed') · passes int ·
  failures int · pending int · skipped int · duration_ms bigint · video text ·
  updated_at timestamptz

clr_artifacts   — failure evidence
  run_id · seq int · type ('artifact:screenshot'|'artifact:dom'|'artifact:dom-backtrack') ·
  test_id · attempt int · name · screenshot_base64 text · dom_gzip_base64 text ·
  artifact_url text · page_url text · steps_before_failure int · command text ·
  width int · height int
  NOTE: exactly ONE of screenshot_base64 / dom_gzip_base64 / artifact_url is set per row.

========================= APP SPEC =========================

Single page, dark theme, three zones:

1. LEFT — runs list (List/Table widget)
   Query runsQuery: SELECT * FROM clr_runs ORDER BY started_at DESC LIMIT 25;
   Card per run: status pill (running=blue, passed=green, failed=red, stale=gray),
   branch (fallback "local"), "{passed} passed · {failed} failed" (show "—" when NULL),
   machine + browser, relative started_at. Selecting a run drives every other query.
   Default selection: newest run.

2. CENTER — for the selected run:
   a. Header: status pill, chips for total_specs / passed / failed / pending / skipped,
      duration formatted (ms → "23.4s" / "3m 42s").
   b. specsQuery: SELECT * FROM clr_specs WHERE run_id = {{selected}}::uuid ORDER BY spec;
      Table: spec basename, status pill, passes, failures, duration.
   c. testsQuery: SELECT * FROM clr_tests_live WHERE run_id = {{selected}}::uuid
      ORDER BY updated_at DESC;
      Table: test_id, state pill (retrying=amber), attempt, duration, error
      (truncated, expand on click). Row click selects a test.
   d. artifactsQuery: SELECT * FROM clr_artifacts WHERE run_id = {{selected}}::uuid
      AND test_id = {{selectedTest}} ORDER BY seq;
      - screenshots → Image widget:
        {{ row.artifact_url ?? 'data:image/png;base64,' + row.screenshot_base64 }}
      - DOM rows → Custom Component: gunzip dom_gzip_base64 with pako
        (base64-decode → pako.ungzip → string; if artifact_url is set, fetch it
        instead — it returns plain HTML), render in
        <iframe sandbox="allow-same-origin" srcDoc={html}> (no allow-scripts),
        plus a selector-tester input: querySelectorAll(selector) inside the iframe,
        show match count, outline matches red.
        Label backtrack rows "N step(s) before failure ({command})".

3. RIGHT (optional) — raw event tail, monospace:
   SELECT seq, type, ts, payload->>'testId' AS test_id FROM clr_events
   WHERE run_id = {{selected}}::uuid ORDER BY seq DESC LIMIT 80;

========================= REAL SAMPLE DATA =========================

clr_runs:
[
  {"run_id":"db060020-1d69-4774-8304-75cb7a55a0f4","status":"stale","branch":null,
   "machine":"MacBookPro.lan","browser":"electron","total_specs":119,"total_tests":null,
   "passed":null,"failed":null,"duration_ms":null,
   "started_at":"2026-07-16T23:51:06+05:30","last_event_at":"2026-07-17T00:13:17+05:30"},
  {"run_id":"021602aa-e35d-4520-81f6-0ec6c3e07f4b","status":"passed","branch":null,
   "machine":"MacBookPro.lan","browser":"electron","total_specs":1,"total_tests":1,
   "passed":1,"failed":0,"duration_ms":31661,"started_at":"2026-07-16T23:47:07+05:30"},
  {"run_id":"6915cef9-5926-4998-b916-b54fa0896999","status":"failed","branch":null,
   "machine":"MacBookPro.lan","browser":"electron","total_specs":1,"total_tests":1,
   "passed":0,"failed":1,"duration_ms":9147,"started_at":"2026-07-16T23:34:34+05:30"}
]

clr_tests_live:
[
  {"test_id":"Workflows Export/Import Sanity > Postgres workflow - execute, export/import, re-execute",
   "state":"running","attempt":3,"duration_ms":null,"error":null},
  {"test_id":"Workflows Export/Import Sanity > RunJS workflow - execute, export/import, re-execute",
   "state":"failed","attempt":3,"duration_ms":37719,
   "error":"Timed out retrying after 30000ms: Expected to find element: `[data-cy=\"start-node\"]`…"},
  {"test_id":"Workflows with Datasource > REST API workflow - execute and validate",
   "state":"passed","attempt":2,"duration_ms":30263,"error":null}
]

clr_specs:
[
  {"spec":"cypress/e2e/happyPath/pr16778/buildCoverageApp.cy.js","status":"passed",
   "passes":7,"failures":0,"duration_ms":260863},
  {"spec":"cypress/e2e/happyPath/workflows/WorkflowWithDataSource.cy.js","status":"failed",
   "passes":0,"failures":4,"duration_ms":37955}
]

clr_artifacts:
[
  {"seq":8,"type":"artifact:screenshot","test_id":"login > INTENTIONAL FAILURE: …","attempt":1,
   "screenshot_base64":"iVBORw0KGgoAAAANSUhEUgAACgAAAAWgCAIAAAAd…(≈240KB)","artifact_url":null},
  {"seq":9,"type":"artifact:dom","test_id":"login > INTENTIONAL FAILURE: …","attempt":1,
   "dom_gzip_base64":"H4sIAAAAAAAAE41Z/W7bOBL/v0/BqLhYAmTFTrLZ…(gzipped html)",
   "page_url":"http://localhost:4477/"},
  {"seq":10,"type":"artifact:dom-backtrack","test_id":"login > INTENTIONAL FAILURE: …","attempt":1,
   "command":"get","steps_before_failure":2,"dom_gzip_base64":"H4sIAAAA…","page_url":"http://localhost:4477/"}
]
