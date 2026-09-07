# CI/CD integration

How to run cypress-live-reporter in CI, where the PR / commit / triggerer come
from, and how to handle parallel runs.

- [Two kinds of env, kept separate](#two-kinds-of-env-kept-separate)
- [The one thing you add](#the-one-thing-you-add)
- [GitHub Actions](#github-actions)
- [GitLab CI](#gitlab-ci)
- [What CI metadata is captured](#what-ci-metadata-is-captured)
- [Parallel runs](#parallel-runs)
- [Running Postgres in CI](#running-postgres-in-ci)

---

## Two kinds of env, kept separate

The plugin reads from two distinct sources, and the distinction matters in CI:

| What | Where it comes from | How you set it |
|---|---|---|
| **Plugin config** (`CLR_DB`, `CLR_PROJECT_ID`, feature toggles…) | Cypress `env` (`config.env`) | a `CYPRESS_`-prefixed variable — Cypress folds `CYPRESS_CLR_DB` into `env` as `CLR_DB` |
| **CI provenance** (branch, commit, PR, build URL, actor) | the runner's own OS env (`GITHUB_*`, `CI_*`) | nothing — the CI platform already sets these |

So the golden rule: **prefix your `CLR_*` settings with `CYPRESS_` in CI.** A bare
`CLR_DB` env var is *not* seen by the plugin — only `CYPRESS_CLR_DB` is.

## The one thing you add

The plugin is already wired into your `cypress.config.js` and `support/e2e.js`
(see the [Quickstart](../README.md#quickstart)). In CI, the **only** extra step
is exposing a sink to the Cypress job as a `CYPRESS_`-prefixed variable:

```yaml
env:
  CYPRESS_CLR_DB: ${{ secrets.CLR_DB }}            # postgres mode
  # or
  CYPRESS_CLR_WEBHOOK: ${{ secrets.CLR_WEBHOOK }}  # webhook mode
```

Everything else — branch, commit, PR, triggerer, build URL — the plugin reads
from OS environment variables the CI platform already sets. **No tokens, no API
calls, no network** beyond writing to your sink.

If the sink var is absent (e.g. a fork PR with no secret access), the plugin
prints one warning and self-disables — the run is unaffected.

## GitHub Actions

```yaml
name: e2e
on: [push, pull_request]

jobs:
  cypress:
    runs-on: ubuntu-latest
    env:
      CYPRESS_CLR_DB: ${{ secrets.CLR_DB }}
      CYPRESS_CLR_PROJECT_ID: todos-web        # optional: group runs by project
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
    CYPRESS_CLR_DB: $CLR_DB                # set CLR_DB as a masked CI/CD variable
    CYPRESS_CLR_PROJECT_ID: todos-web
  script:
    - npm ci
    - npx cypress run
```

## What CI metadata is captured

`ciMetadata()` (in `plugin.js`) reads these from the **OS env** at `before:run`
and ships them in `run:start.ci`; they surface on the `clr_runs` view. You set
none of these — the platform does.

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
by hand for one run. Note the split: `CYPRESS_CLR_DB` is plugin config; the
`GITHUB_*` vars are simulated provenance (plain OS env):

```bash
DB='postgres://postgres@localhost:5432/clr_demo'

CYPRESS_CLR_DB="$DB" \
GITHUB_ACTOR=your-name \
GITHUB_REF=refs/pull/1778/merge \
GITHUB_REF_NAME=my-branch \
GITHUB_SHA=deadbeef \
GITHUB_SERVER_URL=https://github.com \
GITHUB_REPOSITORY=org/repo \
GITHUB_RUN_ID=123 \
npx cypress run --spec cypress/e2e/login.cy.js

psql "$DB" -c \
  "SELECT pr, triggered_by, branch FROM clr_runs ORDER BY started_at DESC LIMIT 1"
```

## Parallel runs

`runId` defaults to a fresh UUID per Cypress process, so N sharded machines
report as **N separate runs**. Two strategies:

**A. Keep them separate (recommended)** and group in the dashboard. Set a shared
`CYPRESS_CLR_PROJECT_ID` on every machine, then aggregate by `project_id` — or,
for a single CI build, by the shared `build_url` (all matrix jobs share one
`GITHUB_RUN_ID`):

```sql
SELECT sum(total_tests) FROM clr_runs
WHERE build_url = 'https://github.com/org/repo/actions/runs/17542288317';
```

Because sharding never overlaps specs, the per-shard totals add up exactly.

**B. Merge into one run** by giving every machine the same id:

```yaml
env:
  CYPRESS_CLR_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}
```

> ⚠️ **Caveat.** `seq` is a per-process counter. If two machines share a
> `CLR_RUN_ID`, they both start at `seq = 1` and their inserts collide on
> `(run_id, seq)` — `ON CONFLICT DO NOTHING` silently drops the second writer's
> events, and the run-level totals reflect only one shard. Until a per-machine
> `seq` namespace lands, prefer **strategy A**. Also note the `run_id` column is
> `uuid` in postgres mode, so the value must be UUID-shaped (hash your build id
> if needed).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the `runId` / `projectId` model.

## Running Postgres in CI

You don't need a hosted database — a service container works. This is exactly
what this repo's own test workflow does
([.github/workflows/test.yml](../.github/workflows/test.yml)). Note the two uses
of the URL: the raw string for the one-time `psql` schema step, and the
`CYPRESS_`-prefixed form for the plugin:

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
  DATABASE_URL: postgres://postgres:clr@localhost:5432/clr   # for psql
  CYPRESS_CLR_DB: postgres://postgres:clr@localhost:5432/clr # for the plugin
steps:
  - uses: actions/checkout@v4
  - run: psql "$DATABASE_URL" -f tools/cypress-live-reporter/schema.sql
  - run: npx cypress run
```

For a persistent dashboard, point `CYPRESS_CLR_DB` at a long-lived database
instead, apply `schema.sql` once, and schedule the retention `DELETE` from
`schema.sql` (e.g. via `pg_cron`) so the table doesn't grow forever.
