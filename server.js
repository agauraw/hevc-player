#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT    = parseInt(process.env.PORT || '8080', 10);
const ROOT    = path.join(__dirname, 'dist');   // built output; fallback to renderer/
const DOCROOT = fs.existsSync(ROOT) ? ROOT : path.join(__dirname, 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd':  'application/dash+xml',
  '.mp4':  'video/mp4',
  '.ts':   'video/mp2t',
  '.vtt':  'text/vtt; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

const server = http.createServer((req, res) => {
  // Strip query string and sanitise path
  let urlPath = req.url.split('?')[0].split('#')[0];
  if (!urlPath || urlPath === '/') urlPath = '/index.html';

  // Security: prevent directory traversal
  const absPath = path.normalize(path.join(DOCROOT, urlPath));
  if (!absPath.startsWith(DOCROOT + path.sep) && absPath !== DOCROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(absPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not found'); }
      else                       { res.writeHead(500); res.end('Server error'); }
      return;
    }
    const ext  = path.extname(absPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type':  mime,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      // Permissive CSP — mirrors the meta tag in index.html
      'Content-Security-Policy':
        "default-src 'self' blob: data:; " +
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
        "style-src 'self' 'unsafe-inline'; " +
        "media-src * blob: data:; " +
        "connect-src * blob: data:",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Stream Analyser running at http://localhost:${PORT}`);
  console.log(`Serving: ${DOCROOT}`);
});
