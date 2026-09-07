'use strict';

const { defineConfig } = require('cypress');

// This repo keeps its connection string in .env (also used by the demo
// dashboard server). Load it and bridge it into the Cypress `env` surface the
// plugin reads. In a real project you'd instead put these keys straight into
// cypress.env.json, the `env` block below, or CYPRESS_* env vars in CI.
require('dotenv').config();

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:4477',
    video: false,
    // retries make the live "retrying" state visible on the dashboard
    retries: { runMode: 2, openMode: 0 },
    env: {
      CLR_DB: process.env.CLR_PG_URL,
      CLR_PROJECT_ID: process.env.CLR_PROJECT_ID || 'cypress-live-reporter',
      // the demo shows off DOM backtracking — keep a couple of pre-failure
      // snapshots (off by default; see the config reference)
      CLR_DOM_BACKTRACK: 2,
    },
    setupNodeEvents(on, config) {
      // merge pattern: keep the reporter's task and add our own. Anything these
      // tasks print to the node console is captured as artifact:stdout on a
      // failing spec.
      config = require('./tools/cypress-live-reporter/plugin').livePlugin(on, config, {
        registerTask: false,
      });
      on('task', {
        ...config.__clrTasks,
        serverLog(msg) {
          console.log('[server]', msg);
          return null;
        },
      });
      return config;
    },
  },
});
