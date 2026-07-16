'use strict';

/**
 * support.js — browser side of cypress-live-reporter.
 *
 * Usage (cypress/support/e2e.js):
 *   require('../../tools/cypress-live-reporter/support');
 *
 * Reads its entire configuration from Cypress.env('clr'), which the Node
 * plugin injects — zero configuration of its own. Every hook is wrapped so
 * a reporter error can never fail a test.
 */

(function () {
  var cfg;
  try {
    cfg = typeof Cypress !== 'undefined' && Cypress.env && Cypress.env('clr');
  } catch (e) {
    cfg = null;
  }
  if (!cfg || cfg.enabled === false) return;

  var liveTests = !cfg.events || cfg.events.liveTests !== false;
  var domEnabled = !cfg.dom || cfg.dom.enabled !== false;
  var backtrackDepth = Math.min(Math.max(0, (cfg.dom && cfg.dom.backtrackDepth) || 0), 5);
  // commands that never change the AUT — not worth a snapshot
  var BACKTRACK_SKIP = { task: 1, log: 1, wrap: 1, then: 1, wait: 1 };

  var buffer = [];
  var ring = [];

  function push(type, payload) {
    try {
      buffer.push(Object.assign({ type: type, ts: new Date().toISOString() }, payload));
    } catch (e) {
      /* dropped event, never an error */
    }
  }

  function flush() {
    try {
      if (!buffer.length) return;
      var batch = buffer.splice(0, buffer.length);
      cy.task('clr:events', batch, { log: false });
    } catch (e) {
      /* dropped batch */
    }
  }

  function testIdFor(runnable) {
    try {
      var parts = [];
      var node = runnable;
      while (node && node.title) {
        parts.unshift(node.title);
        node = node.parent;
      }
      return parts.join(' > ') || 'unknown';
    } catch (e) {
      return (runnable && runnable.title) || 'unknown';
    }
  }

  function attemptOf(runnable) {
    try {
      return ((runnable && runnable._currentRetry) || 0) + 1;
    } catch (e) {
      return 1;
    }
  }

  function specRelative() {
    try {
      return (Cypress.spec && Cypress.spec.relative) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Snapshot of the AUT document. Clones documentElement (never mutates the
   * AUT) and copies live form state onto the clone so the saved HTML shows
   * what the user actually saw. Returns null on any failure.
   */
  function serializeDom() {
    try {
      var win = cy.state('window');
      var doc = win && win.document;
      if (!doc || !doc.documentElement) return null;

      var clone = doc.documentElement.cloneNode(true);

      var live = doc.querySelectorAll('input, textarea, select');
      var copies = clone.querySelectorAll('input, textarea, select');
      for (var i = 0; i < live.length && i < copies.length; i++) {
        var el = live[i];
        var copy = copies[i];
        if (el.tagName === 'INPUT') {
          copy.setAttribute('value', el.value == null ? '' : el.value);
          if (el.checked) copy.setAttribute('checked', '');
          else copy.removeAttribute('checked');
        } else if (el.tagName === 'TEXTAREA') {
          copy.textContent = el.value == null ? '' : el.value;
        } else if (el.tagName === 'SELECT') {
          for (var j = 0; j < el.options.length && j < copy.options.length; j++) {
            if (el.options[j].selected) copy.options[j].setAttribute('selected', '');
            else copy.options[j].removeAttribute('selected');
          }
        }
      }

      var doctype = doc.doctype ? '<!DOCTYPE ' + doc.doctype.name + '>' : '<!DOCTYPE html>';
      return {
        html: doctype + '\n' + clone.outerHTML,
        // page address is `pageUrl` — `url` is reserved for the S3 artifact link
        pageUrl: (win.location && win.location.href) || null,
        viewportWidth: win.innerWidth,
        viewportHeight: win.innerHeight,
      };
    } catch (e) {
      return null;
    }
  }

  /* ---- live per-test events ------------------------------------------- */

  beforeEach(function () {
    try {
      ring = [];
      if (!liveTests) return;
      var t = this.currentTest;
      if (!t) return;
      push('test:start', {
        testId: testIdFor(t),
        title: t.title,
        attempt: attemptOf(t),
        state: 'running',
        spec: specRelative(),
      });
      // immediate flush — this is what makes the dashboard live per it-block
      flush();
    } catch (e) {
      /* never fail the test */
    }
  });

  afterEach(function () {
    try {
      if (!liveTests) return;
      var t = this.currentTest;
      if (!t) return;
      var failed = t.state === 'failed';
      var maxRetries = typeof t.retries === 'function' ? t.retries() : 0;
      push('test:attempt:end', {
        testId: testIdFor(t),
        title: t.title,
        state: t.state,
        attempt: attemptOf(t),
        willRetry: !!(failed && ((t._currentRetry || 0) < maxRetries)),
        duration: t.duration,
        error: (t.err && t.err.message) || null,
        spec: specRelative(),
      });
      flush();
    } catch (e) {
      /* never fail the test */
    }
  });

  /* ---- failure evidence: DOM snapshot (+ optional backtrack ring) ------ */

  if (domEnabled) {
    Cypress.on('fail', function (err, runnable) {
      try {
        var testId = testIdFor(runnable);
        var attempt = attemptOf(runnable);

        var snap = serializeDom();
        if (snap) {
          push(
            'artifact:dom',
            Object.assign(
              { testId: testId, attempt: attempt, error: (err && err.message) || null, spec: specRelative() },
              snap
            )
          );
        }

        if (backtrackDepth > 0 && ring.length) {
          var total = ring.length;
          for (var i = 0; i < ring.length; i++) {
            push(
              'artifact:dom-backtrack',
              Object.assign(
                {
                  testId: testId,
                  attempt: attempt,
                  command: ring[i].command,
                  stepsBeforeFailure: total - i,
                  spec: specRelative(),
                },
                ring[i].snap
              )
            );
          }
          ring = [];
        }
      } catch (e) {
        /* evidence collection must never mask the real failure */
      }
      // ALWAYS rethrow — this reporter never swallows failures
      throw err;
    });

    if (backtrackDepth > 0) {
      Cypress.on('command:end', function (command) {
        try {
          var name =
            command && typeof command.get === 'function'
              ? command.get('name')
              : command && command.attributes && command.attributes.name;
          if (!name || BACKTRACK_SKIP[name]) return;
          var snap = serializeDom();
          if (!snap) return;
          ring.push({ command: name, snap: snap });
          if (ring.length > backtrackDepth) ring.shift();
        } catch (e) {
          /* skipped snapshot */
        }
      });
    }
  }

  /* ---- end-of-spec flush ------------------------------------------------ */

  after(function () {
    try {
      flush();
    } catch (e) {
      /* noop */
    }
  });
})();
