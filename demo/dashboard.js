'use strict';

/**
 * demo/dashboard.js — a small live dashboard over the clr_* views.
 *
 * Serves a single self-refreshing page (2s poll) with the runs list, live
 * per-test states, spec progress, the raw event stream, and failure evidence
 * (screenshots + DOM snapshots gunzipped server-side).
 *
 * Run: node demo/dashboard.js        → http://localhost:4488
 * Needs: CLR_PG_URL (reads .env)  +  the `pg` package (npm install).
 */

try {
  require('dotenv').config();
} catch (e) {
  /* optional */
}

const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const PG_URL = process.env.CLR_PG_URL;
if (!PG_URL) {
  console.error('CLR_PG_URL is required (put it in .env or the environment)');
  process.exit(1);
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: PG_URL, max: 5, connectionTimeoutMillis: 3000 });

const PORT = Number(process.env.PORT) || 4488;

async function stateFor(runId) {
  const runs = (
    await pool.query('SELECT * FROM clr_runs ORDER BY started_at DESC LIMIT 20')
  ).rows;
  const selected = runId || (runs[0] && runs[0].run_id);
  if (!selected) return { runs, selected: null, tests: [], specs: [], artifacts: [], events: [] };

  const [tests, specs, artifacts, events] = await Promise.all([
    pool.query(
      'SELECT * FROM clr_tests_live WHERE run_id = $1 ORDER BY updated_at DESC',
      [selected]
    ),
    pool.query('SELECT * FROM clr_specs WHERE run_id = $1 ORDER BY spec', [selected]),
    pool.query(
      `SELECT seq, type, attempt, test_id, name, command, steps_before_failure, page_url,
              artifact_url, commands, total_commands, error,
              (screenshot_base64 IS NOT NULL) AS has_screenshot,
              (dom_gzip_base64 IS NOT NULL)   AS has_dom
       FROM clr_artifacts WHERE run_id = $1 ORDER BY seq`,
      [selected]
    ),
    pool.query(
      `SELECT seq, type, ts, payload->>'testId' AS test_id, payload->>'spec' AS spec
       FROM clr_events WHERE run_id = $1 ORDER BY seq DESC LIMIT 80`,
      [selected]
    ),
  ]);
  return {
    runs,
    selected,
    tests: tests.rows,
    specs: specs.rows,
    artifacts: artifacts.rows,
    events: events.rows,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/state') {
    const state = await stateFor(url.searchParams.get('run_id'));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(state));
  }

  if (url.pathname === '/api/screenshot') {
    const { rows } = await pool.query(
      'SELECT screenshot_base64 FROM clr_artifacts WHERE run_id = $1 AND seq = $2',
      [url.searchParams.get('run_id'), url.searchParams.get('seq')]
    );
    const b64 = rows[0] && rows[0].screenshot_base64;
    if (!b64) {
      res.writeHead(404);
      return res.end('no screenshot');
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from(b64, 'base64'));
  }

  if (url.pathname === '/api/dom') {
    const { rows } = await pool.query(
      'SELECT dom_gzip_base64 FROM clr_artifacts WHERE run_id = $1 AND seq = $2',
      [url.searchParams.get('run_id'), url.searchParams.get('seq')]
    );
    const b64 = rows[0] && rows[0].dom_gzip_base64;
    if (!b64) {
      res.writeHead(404);
      return res.end('no dom snapshot');
    }
    const html = zlib.gunzipSync(Buffer.from(b64, 'base64'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>clr — live dashboard</title>
<style>
  :root {
    --bg: #0f1218; --panel: #171c26; --line: #232a38; --text: #d7dde8;
    --dim: #7d8799; --green: #3dd68c; --red: #f4636e; --amber: #f5b944;
    --blue: #5aa2f7; --mono: "SF Mono", ui-monospace, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.5 -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 15px; margin: 0; }
  header .hint { color: var(--dim); font-size: 12px; }
  .layout { display: grid; grid-template-columns: 280px 1fr 360px; gap: 14px; padding: 14px 20px; align-items: start; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .panel h2 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin: 0; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .panel .body { padding: 8px 12px 12px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 500; font-size: 11px; }
  tr:last-child td { border-bottom: 0; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .pill.passed { background: rgba(61,214,140,.15); color: var(--green); }
  .pill.failed { background: rgba(244,99,110,.15); color: var(--red); }
  .pill.running { background: rgba(90,162,247,.15); color: var(--blue); animation: pulse 1.2s infinite; }
  .pill.retrying { background: rgba(245,185,68,.15); color: var(--amber); }
  .pill.stale, .pill.unknown, .pill.pending, .pill.queued { background: rgba(125,135,153,.15); color: var(--dim); }
  @keyframes pulse { 50% { opacity: .45; } }
  .run { padding: 9px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .run:hover { background: rgba(255,255,255,.03); }
  .run.selected { background: rgba(90,162,247,.08); border-left: 3px solid var(--blue); padding-left: 9px; }
  .run .meta { color: var(--dim); font-size: 11px; font-family: var(--mono); }
  .err { color: var(--red); font-family: var(--mono); font-size: 11px; word-break: break-word; }
  .log { font-family: var(--mono); font-size: 11px; max-height: 320px; overflow-y: auto; }
  .log div { padding: 2px 12px; white-space: nowrap; }
  .log .seq { color: var(--dim); display: inline-block; width: 34px; }
  .log .t-test { color: var(--blue); } .log .t-artifact { color: var(--amber); }
  .log .t-run, .log .t-spec { color: var(--green); }
  .shots { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px; }
  .shot { width: 150px; }
  .shot img { width: 100%; border: 1px solid var(--line); border-radius: 4px; display: block; }
  .shot a, .domlink { color: var(--blue); text-decoration: none; font-size: 11px; }
  .shot .cap { color: var(--dim); font-size: 11px; margin-top: 3px; }
  .mid { display: flex; flex-direction: column; gap: 14px; }
  .totals { font-family: var(--mono); font-size: 12px; color: var(--dim); }
  .totals b.g { color: var(--green); } .totals b.r { color: var(--red); }
  .cmdgroup { padding: 8px 12px; border-bottom: 1px solid var(--line); }
  .cmdgroup:last-child { border-bottom: 0; }
  .cmdgroup .who { font-size: 11px; color: var(--dim); margin-bottom: 6px; }
  .cmdgroup .who b { color: var(--text); }
  .cmd { display: flex; align-items: baseline; gap: 8px; font-family: var(--mono); font-size: 12px; padding: 2px 0; }
  .cmd .idx { color: var(--dim); width: 20px; text-align: right; flex: none; }
  .cmd .nm { color: var(--blue); min-width: 58px; flex: none; }
  .cmd.failed .nm { color: var(--red); }
  .cmd.pending .nm, .cmd.queued .nm { color: var(--amber); }
  .cmd .ar { color: var(--text); word-break: break-all; flex: 1; }
  .cmd .dur { color: var(--dim); flex: none; }
  .cmd.failed { background: rgba(244,99,110,.08); border-radius: 4px; padding: 2px 4px; margin: 0 -4px; }
  .cmd .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--green); align-self: center; }
  .cmd.failed .dot { background: var(--red); }
  .cmd.pending .dot, .cmd.queued .dot { background: var(--amber); }
</style>
</head>
<body>
<header>
  <h1>cypress-live-reporter</h1>
  <span class="hint">polling every 2s — run <code>npx cypress run</code> and watch</span>
  <span class="hint" id="updated" style="margin-left:auto"></span>
</header>
<div class="layout">
  <div class="panel"><h2>Runs</h2><div id="runs"></div></div>
  <div class="mid">
    <div class="panel"><h2>Tests (live)</h2><div class="body"><table id="tests"></table></div></div>
    <div class="panel"><h2>Specs</h2><div class="body"><table id="specs"></table></div></div>
    <div class="panel"><h2>Command log (last commands before each failure)</h2><div id="commands"></div></div>
    <div class="panel"><h2>Failure evidence</h2><div class="shots" id="artifacts"></div></div>
  </div>
  <div class="panel"><h2>Event stream</h2><div class="log" id="log"></div></div>
</div>
<script>
  var selectedRun = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  }); }
  function pill(s) { return '<span class="pill ' + esc(s) + '">' + esc(s) + '</span>'; }
  function ms(v) { return v == null ? '' : (v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms'); }

  function render(st) {
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
    document.getElementById('runs').innerHTML = st.runs.map(function (r) {
      var sel = r.run_id === st.selected ? ' selected' : '';
      return '<div class="run' + sel + '" onclick="selectedRun=\\'' + r.run_id + '\\';tick()">'
        + pill(r.status) + ' <b>' + esc((r.branch || 'local')) + '</b>'
        + '<div class="totals">' + (r.passed != null
            ? '<b class="g">' + r.passed + ' passed</b> · <b class="r">' + r.failed + ' failed</b> · ' + ms(r.duration_ms)
            : (r.total_specs || '?') + ' specs') + '</div>'
        + '<div class="meta">' + esc(r.run_id.slice(0, 8)) + ' · ' + esc(r.machine || '') + ' · '
        + esc(r.browser || '') + ' · ' + new Date(r.started_at).toLocaleTimeString() + '</div>'
        + (r.pr || r.triggered_by ? '<div class="meta">'
            + (r.pr ? 'PR #' + esc(r.pr) + ' ' : '') + (r.triggered_by ? '· by ' + esc(r.triggered_by) : '')
            + '</div>' : '') + '</div>';
    }).join('') || '<div class="run">no runs yet</div>';

    // tests that have started (from clr_tests_live)
    var startedIds = {};
    st.tests.forEach(function (t) { startedIds[t.test_id] = 1; });
    // roster announced by spec:tests minus the ones already started = queued
    var queued = [];
    st.specs.forEach(function (s) {
      (s.planned_test_ids || []).forEach(function (pt) {
        if (!startedIds[pt.testId]) queued.push({ test_id: pt.testId });
      });
    });
    var startedRows = st.tests.map(function (t) {
      return '<tr><td>' + esc(t.test_id)
        + (t.error ? '<div class="err">' + esc(t.error.slice(0, 160)) + '</div>' : '')
        + '</td><td>' + pill(t.state) + '</td><td>' + esc(t.attempt) + '</td><td>' + ms(t.duration_ms) + '</td></tr>';
    }).join('');
    var queuedRows = queued.map(function (q) {
      return '<tr style="opacity:.6"><td>' + esc(q.test_id)
        + '</td><td>' + pill('queued') + '</td><td></td><td></td></tr>';
    }).join('');
    document.getElementById('tests').innerHTML =
      '<tr><th>test (' + st.tests.length + ' run · ' + queued.length + ' queued)</th><th>state</th><th>att</th><th>time</th></tr>'
      + startedRows + queuedRows;

    document.getElementById('specs').innerHTML =
      '<tr><th>spec</th><th>status</th><th>done/planned</th><th>pass</th><th>fail</th><th>time</th></tr>' +
      st.specs.map(function (s) {
        var done = (s.passes || 0) + (s.failures || 0);
        var planned = s.planned_tests == null ? '?' : s.planned_tests;
        return '<tr><td>' + esc(s.spec) + '</td><td>' + pill(s.status) + '</td>'
          + '<td>' + done + ' / ' + planned + '</td><td>'
          + (s.passes == null ? '' : s.passes) + '</td><td>' + (s.failures == null ? '' : s.failures)
          + '</td><td>' + ms(s.duration_ms) + '</td></tr>';
      }).join('');

    var cmdArts = st.artifacts.filter(function (a) { return a.type === 'artifact:commands'; });
    document.getElementById('commands').innerHTML = cmdArts.map(function (a) {
      var cmds = a.commands || [];
      var total = a.total_commands || (cmds.length ? cmds[cmds.length - 1].i : 0);
      var rows = cmds.map(function (c) {
        var state = c.state || 'passed';
        return '<div class="cmd ' + esc(state) + '"><span class="dot"></span>'
          + '<span class="idx">#' + esc(c.i) + '</span>'
          + '<span class="nm">' + esc(c.name) + '</span>'
          + '<span class="ar">' + esc(c.args || '') + '</span>'
          + '<span class="dur">' + (c.ms == null ? '' : c.ms + 'ms') + '</span></div>';
      }).join('');
      var truncated = total > cmds.length ? ' · showing last ' + cmds.length + ' of ' + total : '';
      return '<div class="cmdgroup"><div class="who"><b>' + esc(a.test_id || '(unknown test)')
        + '</b> · attempt ' + esc(a.attempt) + ' · ' + total + ' commands' + truncated
        + (a.error ? ' · <span style="color:var(--red)">' + esc(a.error.slice(0, 90)) + '</span>' : '')
        + '</div>' + rows + '</div>';
    }).join('') || '<div class="cmdgroup" style="color:var(--dim)">no command logs — nothing has failed in this run</div>';

    document.getElementById('artifacts').innerHTML = st.artifacts.filter(function (a) {
      return a.type !== 'artifact:commands';
    }).map(function (a) {
      var q = 'run_id=' + st.selected + '&seq=' + a.seq;
      if (a.type === 'artifact:screenshot') {
        var src = a.artifact_url || ('/api/screenshot?' + q);
        var who = a.test_id ? esc(a.test_id.split(' > ').pop()) : '(unmapped)';
        return '<div class="shot"><a href="' + src + '" target="_blank"><img src="' + src + '"></a>'
          + '<div class="cap">' + who + ' · attempt ' + esc(a.attempt) + '</div></div>';
      }
      var href = a.artifact_url || ('/api/dom?' + q);
      var label = a.type === 'artifact:dom-backtrack'
        ? 'DOM ' + esc(a.steps_before_failure) + ' step(s) before fail (' + esc(a.command) + ')'
        : 'DOM at failure';
      return '<div class="shot"><a class="domlink" href="' + href + '" target="_blank">▸ ' + label + '</a>'
        + '<div class="cap">attempt ' + esc(a.attempt) + '</div></div>';
    }).join('') || '<div class="cap" style="color:var(--dim)">no artifacts for this run</div>';

    document.getElementById('log').innerHTML = st.events.map(function (e) {
      var cls = 't-' + e.type.split(':')[0].replace('artifact', 'artifact');
      return '<div><span class="seq">' + e.seq + '</span><span class="' + cls + '">' + esc(e.type)
        + '</span> ' + esc(e.test_id || e.spec || '') + '</div>';
    }).join('');
  }

  function tick() {
    fetch('/api/state' + (selectedRun ? '?run_id=' + selectedRun : ''))
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {});
  }
  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String((err && err.message) || err));
    });
  })
  .listen(PORT, () => {
    console.log(`clr dashboard on http://localhost:${PORT}`);
  });
