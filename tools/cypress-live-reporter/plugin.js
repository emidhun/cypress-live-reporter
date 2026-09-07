'use strict';

/**
 * plugin.js — Node side of cypress-live-reporter.
 *
 * Usage (cypress.config.js):
 *   setupNodeEvents(on, config) {
 *     return require('./tools/cypress-live-reporter/plugin').livePlugin(on, config);
 *   }
 *
 * Hard rules:
 *  - nothing here may ever fail a test, fail a run, or block the runner;
 *  - no event handler awaits network I/O — the single exception is the
 *    bounded final flush in after:run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { randomUUID } = require('crypto');
const { createSink, createLogger } = require('./sinks');

const TAG = '[cypress-live-reporter]';

// ---------------------------------------------------------------------------
// Configuration — one surface: Cypress `env`.
//
// Every setting is read from `config.env`, which Cypress populates from
// (lowest → highest precedence): cypress.env.json → the `env` block in
// cypress.config.js → `CYPRESS_*` OS env vars → `--env` on the CLI. That is the
// same place Cypress keeps all other plugin config, so there is no sidecar file
// and no bespoke `process.env` contract to remember.
//
// The one thing NOT read here is CI provenance (branch, commit, PR, build URL):
// that comes from the runner's own OS env (GITHUB_*, CI_*) in ciMetadata(),
// because that is where CI systems put it.
// ---------------------------------------------------------------------------

function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

function envInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

// The resolved default configuration — the exact shape the rest of the plugin
// consumes. readConfig() overlays Cypress env on top of these.
const DEFAULTS = {
  enabled: true,
  debug: false,
  runId: null,
  projectId: null,
  db: null,
  webhook: null,
  webhookToken: null,
  events: { runLifecycle: true, liveTests: true },
  screenshots: { enabled: true, storage: 'db' },
  commands: { enabled: true, depth: 20 },
  console: { enabled: true, depth: 8 },
  stdout: { enabled: true, maxBytes: 65536 },
  dom: { enabled: true, storage: 'db', backtrackDepth: 0 },
  s3: { bucket: null, region: 'ap-south-1', prefix: 'clr/', endpoint: null, publicBaseUrl: null },
  performance: { maxParallelUploads: 3, timeoutMs: 4000, finalFlushMs: 10000 },
};

// Resolve the effective config from Cypress env (config.env). Keys are the
// documented CLR_* names; unknown keys are ignored and missing keys fall back
// to DEFAULTS. Values arriving as strings (CYPRESS_* / --env) are coerced.
function readConfig(config) {
  const e = (config && config.env) || {};
  const d = DEFAULTS;
  return {
    enabled: envBool(e.CLR_ENABLED, d.enabled),
    debug: envBool(e.CLR_DEBUG, d.debug),
    runId: envStr(e.CLR_RUN_ID, d.runId),
    projectId: envStr(e.CLR_PROJECT_ID, d.projectId),
    db: envStr(e.CLR_DB, d.db),
    webhook: envStr(e.CLR_WEBHOOK, d.webhook),
    webhookToken: envStr(e.CLR_WEBHOOK_TOKEN, d.webhookToken),
    events: {
      runLifecycle: envBool(e.CLR_RUN_LIFECYCLE, d.events.runLifecycle),
      liveTests: envBool(e.CLR_LIVE_TESTS, d.events.liveTests),
    },
    screenshots: {
      enabled: envBool(e.CLR_SCREENSHOTS, d.screenshots.enabled),
      storage: envStr(e.CLR_SCREENSHOTS_STORAGE, d.screenshots.storage),
    },
    commands: {
      enabled: envBool(e.CLR_COMMANDS, d.commands.enabled),
      depth: envInt(e.CLR_COMMANDS_DEPTH, d.commands.depth),
    },
    console: {
      enabled: envBool(e.CLR_CONSOLE, d.console.enabled),
      depth: envInt(e.CLR_CONSOLE_DEPTH, d.console.depth),
    },
    stdout: {
      enabled: envBool(e.CLR_STDOUT, d.stdout.enabled),
      maxBytes: envInt(e.CLR_STDOUT_MAX_BYTES, d.stdout.maxBytes),
    },
    dom: {
      enabled: envBool(e.CLR_DOM, d.dom.enabled),
      storage: envStr(e.CLR_DOM_STORAGE, d.dom.storage),
      backtrackDepth: envInt(e.CLR_DOM_BACKTRACK, d.dom.backtrackDepth),
    },
    s3: {
      bucket: envStr(e.CLR_S3_BUCKET, d.s3.bucket),
      region: envStr(e.CLR_S3_REGION, d.s3.region),
      prefix: envStr(e.CLR_S3_PREFIX, d.s3.prefix),
      endpoint: envStr(e.CLR_S3_ENDPOINT, d.s3.endpoint),
      publicBaseUrl: envStr(e.CLR_S3_PUBLIC_BASE_URL, d.s3.publicBaseUrl),
    },
    performance: {
      maxParallelUploads: envInt(e.CLR_MAX_PARALLEL_UPLOADS, d.performance.maxParallelUploads),
      timeoutMs: envInt(e.CLR_TIMEOUT_MS, d.performance.timeoutMs),
      finalFlushMs: envInt(e.CLR_FINAL_FLUSH_MS, d.performance.finalFlushMs),
    },
  };
}

function ciMetadata() {
  const env = process.env;
  let buildUrl = null;
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    buildUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  } else if (env.CI_JOB_URL) {
    buildUrl = env.CI_JOB_URL;
  }
  // GitHub exposes the PR number only inside GITHUB_REF (refs/pull/<n>/merge)
  // on pull_request events; GitLab has a dedicated var.
  let pr = null;
  const ghPr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF || '');
  if (ghPr) pr = ghPr[1];
  else if (env.CI_MERGE_REQUEST_IID) pr = env.CI_MERGE_REQUEST_IID;
  return {
    branch: env.GITHUB_REF_NAME || env.CI_COMMIT_REF_NAME || null,
    commit: env.GITHUB_SHA || env.CI_COMMIT_SHA || null,
    buildUrl,
    pr,
    triggeredBy:
      env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN || env.CI_COMMIT_AUTHOR || null,
    provider: env.GITHUB_ACTIONS ? 'github' : env.GITLAB_CI ? 'gitlab' : null,
    machine: os.hostname(),
  };
}

function disable(config, tasks) {
  try {
    config.env = config.env || {};
    config.env.clr = { enabled: false };
    config.__clrTasks = tasks || { 'clr:events': () => null };
  } catch (err) {
    /* even disabling must not throw */
  }
  return config;
}

function livePlugin(on, config, opts) {
  try {
    return setup(on, config, opts || {});
  } catch (err) {
    try {
      console.warn(`${TAG} disabled due to init error:`, err && err.message);
    } catch (ignored) {
      /* noop */
    }
    return disable(config);
  }
}

function setup(on, config, opts) {
  const cfg = readConfig(config);
  const debug = cfg.debug;
  const log = createLogger({ debug });

  if (cfg.enabled === false) {
    return disable(config);
  }

  // ---- sink autodetect -------------------------------------------------
  const pgUrl = cfg.db;
  const webhookUrl = cfg.webhook;
  if (!pgUrl && !webhookUrl) {
    console.warn(`${TAG} no CLR_DB or CLR_WEBHOOK set in Cypress env — live reporting disabled`);
    return disable(config);
  }

  const sink = createSink({
    mode: pgUrl ? 'pg' : 'webhook',
    url: pgUrl || webhookUrl,
    token: cfg.webhookToken,
    config: cfg,
  });

  // CLR_RUN_ID override lets parallel CI machines report into one shared run;
  // otherwise each run gets a fresh UUID.
  const runId = cfg.runId || randomUUID();
  // Project grouping: many runs roll up under one human-readable project id
  // (e.g. "todos-web"). Null when unset — runs still work, just unmapped.
  const projectId = cfg.projectId || null;
  let seq = 0;
  // the test currently executing, learned from the browser's test:start
  // stream — Cypress runs one test at a time per process, so this reliably
  // tells after:screenshot which it-block + attempt a screenshot belongs to
  // even when Cypress hands us empty titles.
  let lastTest = { testId: null, attempt: 1 };

  // ---- terminal stdout capture (spec-level, failures only, like Cloud) ----
  // Tee process.stdout/stderr into a per-spec ring; on a failing spec, ship
  // the tail as artifact:stdout. Teeing always calls the original write, so
  // the terminal output is never suppressed, and it can never throw.
  const stdoutEnabled = cfg.stdout.enabled !== false;
  const stdoutMaxBytes = Math.max(4096, cfg.stdout.maxBytes || 65536);
  let specStdout = [];
  let specStdoutBytes = 0;
  let stdoutCapturing = false;
  if (stdoutEnabled) {
    for (const streamName of ['stdout', 'stderr']) {
      try {
        const stream = process[streamName];
        const orig = stream.write.bind(stream);
        stream.write = function (chunk, enc, cb) {
          try {
            if (stdoutCapturing && chunk) {
              const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
              // don't capture our own debug lines — that would be self-noise
              if (str.indexOf(TAG) === -1) {
                specStdout.push(str);
                specStdoutBytes += str.length;
                while (specStdoutBytes > stdoutMaxBytes && specStdout.length > 1) {
                  specStdoutBytes -= specStdout.shift().length;
                }
              }
            }
          } catch (e) {
            /* never break terminal output */
          }
          return orig(chunk, enc, cb);
        };
      } catch (e) {
        /* leave the stream untouched */
      }
    }
  }

  // seq is assigned here, on the Node side, for every event — including
  // browser-originated ones — so (run_id, seq) is a true monotonic order.
  function emit(type, payload) {
    try {
      const event = Object.assign(
        { runId, seq: ++seq, ts: new Date().toISOString(), type },
        projectId ? { projectId } : null,
        payload
      );
      sink.send(event);
    } catch (err) {
      log('emit failed:', err && err.message);
    }
  }

  const runLifecycle = cfg.events.runLifecycle !== false;

  // ---- run / spec lifecycle (Node events) ------------------------------
  if (runLifecycle) {
    on('before:run', (details) => {
      try {
        const specs = ((details && details.specs) || []).map(
          (s) => s.relative || s.name || s.absolute
        );
        emit('run:start', {
          specs,
          totalSpecs: specs.length,
          browser:
            details && details.browser
              ? { name: details.browser.name, version: details.browser.version }
              : null,
          cypressVersion: details && details.cypressVersion,
          ci: ciMetadata(),
        });
      } catch (err) {
        log('before:run failed:', err && err.message);
      }
    });

    on('before:spec', (spec) => {
      try {
        // start a fresh stdout capture window for this spec
        specStdout = [];
        specStdoutBytes = 0;
        stdoutCapturing = stdoutEnabled;
        emit('spec:start', { spec: (spec && spec.relative) || null });
      } catch (err) {
        log('before:spec failed:', err && err.message);
      }
    });

    on('after:spec', (spec, results) => {
      try {
        const stats = (results && results.stats) || {};
        const tests = ((results && results.tests) || []).map((t) => ({
          testId: (t.title || []).join(' > '),
          state: t.state,
          duration:
            t.duration != null
              ? t.duration
              : (t.attempts || []).reduce((sum, a) => sum + (a.duration || 0), 0),
          attempts: (t.attempts || []).length,
          displayError: t.displayError || null,
        }));
        emit('spec:end', {
          spec: (spec && spec.relative) || null,
          stats: {
            duration: stats.duration,
            tests: stats.tests,
            passes: stats.passes,
            failures: stats.failures,
            pending: stats.pending,
            skipped: stats.skipped,
          },
          tests,
          video: (results && results.video) || null,
        });

        // terminal stdout — only for failing specs, like Cypress Cloud
        if (stdoutEnabled) {
          stdoutCapturing = false;
          if ((stats.failures || 0) > 0 && specStdout.length) {
            emit('artifact:stdout', {
              spec: (spec && spec.relative) || null,
              failures: stats.failures,
              bytes: specStdoutBytes,
              stdout: specStdout.join('').slice(-stdoutMaxBytes),
            });
          }
          specStdout = [];
          specStdoutBytes = 0;
        }
      } catch (err) {
        log('after:spec failed:', err && err.message);
      }
    });
  }

  // after:run is registered unconditionally: even with runLifecycle off,
  // queued artifacts still need the bounded final flush.
  on('after:run', async (results) => {
    try {
      if (runLifecycle) {
        const failed = !!(results && results.totalFailed > 0);
        emit('run:end', {
          status: failed ? 'failed' : 'passed',
          totalDuration: results && results.totalDuration,
          totals: {
            specs: results && results.runs ? results.runs.length : null,
            tests: results && results.totalTests,
            passed: results && results.totalPassed,
            failed: results && results.totalFailed,
            pending: results && results.totalPending,
            skipped: results && results.totalSkipped,
          },
        });
      }
    } catch (err) {
      log('after:run emit failed:', err && err.message);
    }
    // the ONLY place the plugin is allowed to wait
    try {
      await sink.flush(cfg.performance.finalFlushMs);
    } catch (err) {
      log('final flush failed:', err && err.message);
    }
  });

  // ---- screenshots ------------------------------------------------------
  if (cfg.screenshots.enabled !== false) {
    on('after:screenshot', (details) => {
      try {
        const filePath = details && details.path;
        if (filePath) {
          const buf = fs.readFileSync(filePath);
          const titles = (details && details.titles) || [];
          // Cypress often hands failure screenshots empty titles — fall back
          // to the currently-running test so a screenshot always maps to its
          // it-block. Prefer the exact attempt from the filename, else the
          // running test's attempt.
          const testId = titles.length ? titles.join(' > ') : lastTest.testId || '';
          const attemptMatch = /\(attempt (\d+)\)/.exec(filePath);
          const attempt = attemptMatch ? parseInt(attemptMatch[1], 10) : lastTest.attempt || 1;
          emit('artifact:screenshot', {
            testId: testId,
            name: (details && details.name) || path.basename(filePath, path.extname(filePath)),
            attempt: attempt,
            width: details && details.dimensions && details.dimensions.width,
            height: details && details.dimensions && details.dimensions.height,
            takenAt: details && details.takenAt,
            specName: details && details.specName,
            base64: buf.toString('base64'),
          });
        }
      } catch (err) {
        log('after:screenshot failed:', err && err.message);
      }
      // must hand Cypress back its details untouched
      return details;
    });
  }

  // ---- browser event ingestion (cy.task) --------------------------------
  const tasks = {
    'clr:events': (batch) => {
      try {
        const events = Array.isArray(batch) ? batch : [];
        for (const ev of events) {
          if (!ev || typeof ev.type !== 'string') continue;
          // track the running test so after:screenshot can attribute correctly
          if (ev.type === 'test:start' && ev.testId) {
            lastTest = { testId: ev.testId, attempt: ev.attempt || 1 };
          }
          if (
            (ev.type === 'artifact:dom' || ev.type === 'artifact:dom-backtrack') &&
            typeof ev.html === 'string'
          ) {
            try {
              ev.htmlGzipBase64 = zlib.gzipSync(Buffer.from(ev.html, 'utf8')).toString('base64');
            } catch (gzErr) {
              log('dom gzip failed:', gzErr && gzErr.message);
            }
            delete ev.html;
          }
          emit(ev.type, ev);
        }
      } catch (err) {
        log('clr:events task failed:', err && err.message);
      }
      return null;
    },
  };

  // Cypress allows a single on('task') listener. Pass { registerTask: false }
  // and spread config.__clrTasks into your own task map if you already have one.
  if (opts.registerTask !== false) {
    on('task', tasks);
  }
  config.__clrTasks = tasks;

  // ---- browser config slice ---------------------------------------------
  config.env = config.env || {};
  config.env.clr = {
    enabled: true,
    debug,
    events: { liveTests: cfg.events.liveTests !== false },
    commands: {
      enabled: cfg.commands.enabled !== false,
      depth: Math.min(Math.max(1, Math.floor(cfg.commands.depth || 20)), 50),
    },
    console: {
      enabled: cfg.console.enabled !== false,
      depth: Math.min(Math.max(1, Math.floor(cfg.console.depth || 8)), 200),
    },
    dom: {
      enabled: cfg.dom.enabled !== false,
      backtrackDepth: Math.min(Math.max(0, Math.floor(cfg.dom.backtrackDepth || 0)), 5),
    },
  };

  log(
    'active — mode:',
    pgUrl ? 'postgres' : 'webhook',
    'runId:',
    runId,
    'projectId:',
    projectId || '(none)'
  );
  return config;
}

module.exports = { livePlugin, DEFAULTS, readConfig };
