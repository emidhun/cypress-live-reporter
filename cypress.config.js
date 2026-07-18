'use strict';

const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:4477',
    video: false,
    // retries make the live "retrying" state visible on the dashboard
    retries: { runMode: 2, openMode: 0 },
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
