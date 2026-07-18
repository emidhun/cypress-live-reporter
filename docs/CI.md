# CI/CD integration

How to run cypress-live-reporter in CI, where the PR / commit / triggerer come
from, and how to handle parallel runs.

- [The one thing you add](#the-one-thing-you-add)
- [GitHub Actions](#github-actions)
- [GitLab CI](#gitlab-ci)
- [What CI metadata is captured](#what-ci-metadata-is-captured)
- [Parallel runs](#parallel-runs)
- [Running Postgres in CI](#running-postgres-in-ci)

---

## The one thing you add

The plugin is already wired into your `cypress.config.js` and `support/e2e.js`
(see the [Quickstart](../README.md#quickstart)). In CI, the **only** extra step
is making a sink env var available to the Cypress job:

```yaml
env:
  CLR_PG_URL: ${{ secrets.CLR_PG_URL }}          # postgres mode
  # or
  CLR_WEBHOOK_URL: ${{ secrets.CLR_WEBHOOK_URL }} # webhook mode
```

Everything else — branch, commit, PR, triggerer, build URL — the plugin reads
from environment variables the CI platform already sets. **No tokens, no API
calls, no network** beyond writing to your sink.

If the env var is absent (e.g. a fork PR with no secret access), the plugin
prints one warning and self-disables — the run is unaffected.

## GitHub Actions

```yaml
name: e2e
on: [push, pull_request]

jobs:
  cypress:
    runs-on: ubuntu-latest
    env:
      CLR_PG_URL: ${{ secrets.CLR_PG_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx cypress run          # the plugin streams automatically
```

On a `pull_request` event, GitHub sets `GITHUB_REF` to `refs/pull/<n>/merge`, so
the PR number is captured automatically. On a `push` event there is no PR, and
`pr` is correctly `null`.

## GitLab CI

```yaml
e2e:
  image: cypress/browsers:node-20
  variables:
    CLR_PG_URL: $CLR_PG_URL          # set as a CI/CD variable
  script:
    - npm ci
    - npx cypress run
```

## What CI metadata is captured

`ciMetadata()` (in `plugin.js`) reads these at `before:run` and ships them in
`run:start.ci`; they surface on the `clr_runs` view.

| Field | GitHub Actions | GitLab CI |
|---|---|---|
| `pr` | `GITHUB_REF` → `refs/pull/`**`<n>`**`/merge` | `CI_MERGE_REQUEST_IID` |
| `triggeredBy` | `GITHUB_ACTOR` | `GITLAB_USER_LOGIN` / `CI_COMMIT_AUTHOR` |
| `branch` | `GITHUB_REF_NAME` | `CI_COMMIT_REF_NAME` |
| `commit` | `GITHUB_SHA` | `CI_COMMIT_SHA` |
| `buildUrl` | built from `GITHUB_SERVER_URL` + `GITHUB_REPOSITORY` + `GITHUB_RUN_ID` | `CI_JOB_URL` |
| `provider` | `github` (via `GITHUB_ACTIONS`) | `gitlab` (via `GITLAB_CI`) |
| `machine` | `os.hostname()` | `os.hostname()` |

### Testing it locally

These vars only exist in CI, so to verify the plumbing on your machine, set them
by hand for one run:

```bash
CLR_PG_URL='postgres://postgres@localhost:5432/clr_demo' \
GITHUB_ACTOR=your-name \
GITHUB_REF=refs/pull/1778/merge \
GITHUB_REF_NAME=my-branch \
GITHUB_SHA=deadbeef \
GITHUB_SERVER_URL=https://github.com \
GITHUB_REPOSITORY=org/repo \
GITHUB_RUN_ID=123 \
npx cypress run --spec cypress/e2e/login.cy.js

psql "$CLR_PG_URL" -c \
  "SELECT pr, triggered_by, branch FROM clr_runs ORDER BY started_at DESC LIMIT 1"
```

## Parallel runs

`runId` defaults to a fresh UUID per Cypress process. To make several machines
report into **one** dashboard run, set the same id on all of them:

```yaml
env:
  CLR_RUN_ID: ${{ github.run_id }}    # must be a valid UUID in postgres mode
```

> ⚠️ **Known limitation.** `seq` is a per-process counter. If two machines share
> a `CLR_RUN_ID`, they both start at `seq = 1` and their inserts collide on
> `(run_id, seq)` — `ON CONFLICT DO NOTHING` silently drops the second writer's
> events. Until a per-machine key lands, prefer **one `runId` per machine** (the
> default) and group runs in the dashboard by `commit` / `branch`. Also note the
> `run_id` column is `uuid` in postgres mode, so `CLR_RUN_ID` must be UUID-shaped
> there (hash your build id into UUID form if needed).

## Running Postgres in CI

You don't need a hosted database — a service container works. This is exactly
what this repo's own test workflow does
([.github/workflows/test.yml](../.github/workflows/test.yml)):

```yaml
services:
  postgres:
    image: postgres:16
    env: { POSTGRES_PASSWORD: clr, POSTGRES_DB: clr }
    ports: ['5432:5432']
    options: >-
      --health-cmd "pg_isready -U postgres" --health-interval 5s
      --health-timeout 5s --health-retries 10
env:
  CLR_PG_URL: postgres://postgres:clr@localhost:5432/clr
steps:
  - uses: actions/checkout@v4
  - run: psql "$CLR_PG_URL" -f tools/cypress-live-reporter/schema.sql
  - run: npx cypress run
```

For a persistent dashboard, point `CLR_PG_URL` at a long-lived database instead,
apply `schema.sql` once, and schedule the retention `DELETE` from `schema.sql`
(e.g. via `pg_cron`) so the table doesn't grow forever.
