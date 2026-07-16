'use strict';

const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:4477',
    video: false,
    // retries make the live "retrying" state visible on the dashboard
    retries: { runMode: 2, openMode: 0 },
    setupNodeEvents(on, config) {
      return require('./tools/cypress-live-reporter/plugin').livePlugin(on, config);
    },
  },
});
