# Live demo — test the reporter locally

A tiny todo app + a real Cypress suite wired to cypress-live-reporter. The
suite has 5 passing tests and one **intentional failure** (which retries once)
so every event type gets exercised: lifecycle, live tests, retry, screenshot,
DOM snapshot, and DOM backtrack (`clr.config.json` sets `backtrackDepth: 2`).

## Run it

```bash
npm install                          # cypress + pg + dotenv (dev-only)

# 1. database
createdb clr_demo                    # or: psql -U postgres -c 'CREATE DATABASE clr_demo'
psql -d clr_demo -f tools/cypress-live-reporter/schema.sql
echo 'CLR_PG_URL=postgres://postgres@localhost:5432/clr_demo' > .env

# 2. the live app
node demo/server.js                  # http://localhost:4477  (demo@example.com / secret123)

# 3. the suite (second terminal)
npx cypress run
```

## Watch it live

While the run is going (or after), poll the views — this is exactly what a
ToolJet dashboard would do on a 2–3s refresh:

```sql
SELECT * FROM clr_runs;
SELECT test_id, state, attempt, error FROM clr_tests_live ORDER BY updated_at DESC;
SELECT spec, status, passes, failures FROM clr_specs;
SELECT type, attempt, steps_before_failure, command,
       length(screenshot_base64) AS shot, length(dom_gzip_base64) AS dom
FROM clr_artifacts ORDER BY seq;
```

Expected end state: run `failed`, 6 tests (5 passed / 1 failed on attempt 2),
`login.cy.js` failed + `todos.cy.js` passed, and 8 artifacts — a screenshot,
a DOM snapshot, and 2 backtrack snapshots per failed attempt. The DOM snapshot
preserves live form state (the typed email, the visible error banner).
