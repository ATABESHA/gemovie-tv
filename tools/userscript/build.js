#!/usr/bin/env node
/*
 * Builds web/mymovie.user.js: MyMovie for iPhone/iPad Safari (or any browser) through the
 * free "Userscripts" app. It packs the same screens (tvui.html) and player script (tvnav.js)
 * the Android apps use.
 *
 *   https://ge.movie/tv-app   -> becomes the MyMovie app (that page is a tiny "not found"
 *                                page on the site, so nothing heavy loads first)
 *   the video player frame    -> gets the player script (resume, movie language, progress)
 *   the rest of ge.movie      -> left alone
 *
 * Run: node tools/userscript/build.js   (GitHub runs it after every change to the screens)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const OUT = path.join(ROOT, 'web', 'mymovie.user.js');
const RAW = 'https://raw.githubusercontent.com/ATABESHA/gemovie-tv/main/web/mymovie.user.js';
// Where the video player is loaded from (ge.movie has changed it before: add new ones here).
const PLAYER_HOSTS = ['em.kinoflix.tv', '*.kinoflix.tv', '*.filmx.cc'];

const read = (f) => fs.readFileSync(path.join(ASSETS, f), 'utf8');
const dataUri = (f, mime) => 'data:' + mime + ';base64,' + fs.readFileSync(path.join(ASSETS, f)).toString('base64');

const ui = read('tvui.html')
  .split('__LOGO__').join(dataUri('logo.png', 'image/png'))
  .split('__AV_PARENTS__').join(dataUri('av_parents.jpg', 'image/jpeg'))
  .split('__AV_SON__').join(dataUri('av_son.jpg', 'image/jpeg'))
  .split('__MODE__').join('touch')
  .split('__VIEWPORT__').join('width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no');

const nav = read('tvnav.js')
  .split('__VIEWPORT_WIDTH__').join('0')
  .split('__MODE__').join('touch');

// Version from the time of the build, so the Userscripts app sees every new one as newer.
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const version = '1.' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + '.' + p2(d.getUTCHours()) + p2(d.getUTCMinutes());

const header = [
  '// ==UserScript==',
  '// @name         MyMovie',
  '// @namespace    https://github.com/ATABESHA/gemovie-tv',
  '// @version      ' + version,
  '// @description  MyMovie for gemovie.tv on iPhone/iPad: open https://gemovie.tv/tv-app',
  '// @match        https://gemovie.tv/*',
  '// @match        https://ge.movie/*',
  ...PLAYER_HOSTS.map((h) => '// @match        https://' + h + '/*'),
  '// @run-at       document-start',
  '// @inject-into  auto',
  '// @updateURL    ' + RAW,
  '// @downloadURL  ' + RAW,
  '// ==/UserScript==',
  '// Built by tools/userscript/build.js from app/src/main/assets. Do not edit by hand.',
].join('\n');

const body = `
(function () {
  'use strict';
  var UI = ${JSON.stringify(ui)};
  var NAV = ${JSON.stringify(nav)};

  if (window.top === window) {
    // The app's own address: replace that small page with MyMovie. The page keeps
    // site's address (gemovie.tv, formerly ge.movie), so MyMovie may read the site's pages.
    if (/(^|\\.)(gemovie\\.tv|ge\\.movie)$/.test(location.hostname) &&/^\\/tv-app\\/?$/.test(location.pathname)) {
      try { window.stop(); } catch (e) {}
      document.open();
      document.write(UI);
      document.close();
    }
    return;
  }

  // Inside the video player frame: the player script must run in the page itself
  // to reach the player (window.player).
  if (window.__tvInit) return;
  try {
    var s = document.createElement('script');
    s.textContent = NAV;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) {}
})();
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + '\n' + body);
console.log('Wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB, version ' + version + ')');
