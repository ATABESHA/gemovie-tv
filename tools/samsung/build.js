#!/usr/bin/env node
/*
 * Builds the Samsung TV app (Tizen web app) into samsung/build/ from the same screens the
 * Android TV app uses (app/src/main/assets/tvui.html) plus samsung/tizen.js.
 *
 * Samsung TVs from 2017 (Tizen 3.0) have a browser engine of about Chrome 47, so the
 * screens' newer styling is rewritten here into what that engine understands:
 *   - CSS variables      -> their values
 *   - inset: X           -> top/right/bottom/left
 *   - flex gap           -> margins on the items
 *   - grid (PIN keypad)  -> wrapping flex
 *   - ::placeholder      -> also ::-webkit-input-placeholder
 *   - the phone/tablet part of the styles is left out (a TV never uses it)
 * The build stops if anything newer is left, so a future change can't silently break it.
 *
 * Run:   node tools/samsung/build.js
 * Then:  package and install with Tizen Studio's CLI (see samsung/README.md).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const SRC = path.join(ROOT, 'samsung');
const OUT = path.join(SRC, 'build');

const read = (f) => fs.readFileSync(path.join(ASSETS, f), 'utf8');
const dataUri = (f, mime) => 'data:' + mime + ';base64,' + fs.readFileSync(path.join(ASSETS, f)).toString('base64');

let html = read('tvui.html')
  .split('__LOGO__').join(dataUri('logo.png', 'image/png'))
  .split('__AV_PARENTS__').join(dataUri('av_parents.jpg', 'image/jpeg'))
  .split('__AV_SON__').join(dataUri('av_son.jpg', 'image/jpeg'))
  .split('__MODE__').join('tv')
  .split('__VIEWPORT__').join('width=1280');

// ------------------------------------------------------------------ styles
const sStart = html.indexOf('<style>') + '<style>'.length;
const sEnd = html.indexOf('</style>');
let css = html.slice(sStart, sEnd);

// The phone/tablet part (html.touch …) is not needed on a TV.
const touchAt = css.indexOf('/* ================= phones and tablets');
if (touchAt < 0) throw new Error('phone/tablet styles marker not found in tvui.html');
css = css.slice(0, touchAt);

// CSS variables -> values
const vars = {};
const root = /:root\{([^}]*)\}/.exec(css);
if (root) root[1].split(';').forEach((d) => {
  const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(d);
  if (m) vars[m[1]] = m[2];
});
css = css.replace(/:root\{[^}]*\}\n?/, '');
css = css.replace(/var\((--[\w-]+)\)/g, (all, name) => {
  if (!(name in vars)) throw new Error('unknown CSS variable ' + name);
  return vars[name];
});

// inset -> four sides
css = css.replace(/\binset:([^;}]+)/g, (all, v) => {
  const p = v.trim().split(/\s+/);
  const [t, r = t, b = t, l = r] = p;
  return `top:${t};right:${r};bottom:${b};left:${l}`;
});

// ::placeholder -> also the old -webkit- name
css = css.replace(/([^{}]+)::placeholder\{([^}]*)\}/g, (all, sel, body) =>
  `${all}\n${sel.trim()}::-webkit-input-placeholder{${body}}`);

// grid and gap -> margins (the extra rules go first, so the screens' own margins win)
const extra = [];
// Containers that wrap, by their last class/id (".peditor .prow" is a ".prow", which wraps).
const wraps = new Set();
css.replace(/(?<=^|\})\s*([^{}@]+)\{([^{}]*)\}/g, (all, sel, body) => {
  if (/flex-wrap:wrap/.test(body)) sel.split(',').forEach((s) => wraps.add(s.trim().split(/\s+/).pop()));
  return all;
});
css = css.replace(/(?<=^|\})(\s*)([^{}@]+)\{([^{}]*)\}/g, (all, ws, sel, body) => {
  if (!/(^|;)\s*gap:/.test(body) && !/display:grid/.test(body)) return all;
  // A comment in front of the rule belongs to the page, not to the selector.
  const selector = sel.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (wraps.has(selector.split(/\s+/).pop()) && !/flex-wrap/.test(body)) body += ';flex-wrap:wrap';
  const g = /(?:^|;)\s*gap:\s*([^;]+)/.exec(body);
  const [rowGap, colGap] = g ? (g[1].trim().split(/\s+/).length > 1 ? g[1].trim().split(/\s+/) : [g[1].trim(), g[1].trim()]) : ['0', '0'];
  let b = body.replace(/(^|;)\s*gap:[^;]*/, '$1').replace(/^;/, '');
  if (/display:grid/.test(body)) {
    const cols = /grid-template-columns:\s*repeat\((\d+),\s*(\d+)px\)/.exec(body);
    if (!cols) throw new Error('unsupported grid in ' + selector);
    const n = +cols[1], w = +cols[2], gp = parseInt(colGap, 10);
    b = b.replace(/display:grid/, 'display:flex;flex-wrap:wrap')
      .replace(/grid-template-columns:[^;]*;?/, '')
      .replace(/justify-content:center;?/, '');
    b += `;width:${n * w + (n - 1) * gp}px;margin-left:auto;margin-right:auto`;
    extra.push(`${selector}>*{width:${w}px;margin:0 ${colGap} ${rowGap} 0}`,
      `${selector}>:nth-child(${n}n){margin-right:0}`);
  } else if (/flex-direction:column/.test(body)) {
    extra.push(`${selector}>*+*{margin-top:${rowGap}}`);
  } else if (/flex-wrap:wrap/.test(body)) {
    if (/justify-content:center/.test(body)) {
      const half = (parseFloat(colGap) / 2) + 'px';
      extra.push(`${selector}>*{margin:0 ${half} ${rowGap}}`);
    } else {
      extra.push(`${selector}>*{margin:0 ${colGap} ${rowGap} 0}`);
    }
  } else {
    extra.push(`${selector}>*+*{margin-left:${colGap}}`);
  }
  return `${ws}${sel}{${b}}`;
});

// The Georgian font travels with the app (2017 TVs sold outside Georgia have none).
const font = '@font-face{font-family:"Noto Sans Georgian";src:url(fonts/NotoSansGeorgian.woff2) format("woff2");' +
  'unicode-range:U+10A0-10FF,U+1C90-1CBF,U+2D00-2D2F}';
css = '\n' + font + '\n/* flex gap for the 2017 engine (made by tools/samsung/build.js) */\n' + extra.join('\n') + '\n' + css;

// Anything the 2017 engine doesn't understand must be gone now.
const left = [/var\(--/, /(^|[;{\s])gap:/, /\binset:/, /display:grid/, /\b(clamp|min|max)\(/, /\benv\(/, /aspect-ratio/]
  .filter((re) => re.test(css));
if (left.length) throw new Error('styles still use: ' + left.join(', '));

html = html.slice(0, sStart) + css + html.slice(sEnd);

// ------------------------------------------------------------------ script
// samsung/tizen.js runs first: it sets up window.TVApp, the remote and the player.
const scriptAt = html.indexOf('<script>', html.indexOf('<body>'));
if (scriptAt < 0) throw new Error('screens script not found');
html = html.slice(0, scriptAt) + '<script src="tizen.js"></script>\n' + html.slice(scriptAt);

// The same check for the screens' script: nothing newer than the 2017 engine knows.
// (Text in quotes and // comments is ignored.)
const code = html.slice(scriptAt).replace(/'[^'\n]*'|"[^"\n]*"/g, "''").replace(/(^|[^:\\])\/\/.*$/gm, '$1');
for (const re of [/=>/, /\blet\s/, /\bconst\s/, /`/, /\?\./, /\?\?/, /\basync\s/, /\bawait\s/]) {
  const k = code.search(re);
  if (k >= 0) throw new Error('screens script uses newer JavaScript (' + re + ') near: ' + JSON.stringify(code.slice(Math.max(0, k - 80), k + 40)));
}

// ------------------------------------------------------------------ files
let count = '0';
try { count = execSync('git rev-list --count HEAD', { cwd: ROOT }).toString().trim(); } catch (e) {}
const version = '1.0.' + count;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.copyFileSync(path.join(SRC, 'tizen.js'), path.join(OUT, 'tizen.js'));
fs.copyFileSync(path.join(SRC, 'icon.png'), path.join(OUT, 'icon.png'));
fs.copyFileSync(path.join(SRC, 'fonts', 'NotoSansGeorgian.woff2'), path.join(OUT, 'fonts', 'NotoSansGeorgian.woff2'));
fs.writeFileSync(path.join(OUT, 'config.xml'),
  fs.readFileSync(path.join(SRC, 'config.xml'), 'utf8').split('__VERSION__').join(version));

console.log('Built samsung/build (version ' + version + ', ' + Math.round(html.length / 1024) + ' KB page, ' +
  extra.length + ' gap rules)');
