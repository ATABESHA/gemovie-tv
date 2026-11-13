#!/usr/bin/env node
/*
 * Look at the Samsung build on a PC: serves samsung/build and passes /site/... through to
 * the movie site (a normal browser won't let a page read another site; the TV app may).
 *
 *   node tools/samsung/build.js && node tools/samsung/preview.js
 *   open http://localhost:8790/  (Arrow keys, Enter, Backspace = Back)
 *
 * Only the layout and the site's pages can be checked this way: translations, trailers and
 * the TV's own browser engine (about Chrome 47 on 2017 models) need the real TV.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = +(process.argv[2] || 8790);
const SITE = process.argv[3] || 'gemovie.tv';
const DIR = path.join(__dirname, '..', '..', 'samsung', 'build');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };

http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(302, { Location: '/index.html?site=' + encodeURIComponent('http://localhost:' + PORT + '/site') });
    return res.end();
  }
  if (req.url.startsWith('/site/')) {
    const up = https.request({ host: SITE, path: req.url.slice(5), method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Tizen 3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0 TV Safari/537.36' } },
    (r) => { res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'text/html' }); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    return up.end();
  }
  const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('Samsung preview: http://localhost:' + PORT + '/'));
