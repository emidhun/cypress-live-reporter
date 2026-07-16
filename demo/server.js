'use strict';

// Tiny zero-dependency static server for the demo app.
// Run: node demo/server.js   (PORT env to override, default 4477)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4477;
const page = fs.readFileSync(path.join(__dirname, 'app', 'index.html'));

http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  })
  .listen(PORT, () => {
    console.log(`demo app on http://localhost:${PORT}`);
  });
