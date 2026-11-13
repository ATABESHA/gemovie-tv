/*
 * MyMovie for Samsung TVs (Tizen 3.0 and newer, e.g. a 2017 UE55MU6255).
 *
 * The same screens as the Android app (app/src/main/assets/tvui.html) run here; this
 * file is what the Android app's Java code does there:
 *   - window.TVApp: the calls the screens make (texts in other languages, trailers…)
 *   - the remote control: keys -> the screens, Back, exit
 *   - the video player: the site's player (Playerjs) is driven through its own message
 *     interface ({api:"play"}, {api:"seek",set:…}); it reports its time back, which keeps
 *     "Continue watching" up to date. Nothing is injected into the player.
 *   - small additions the 2017 browser engine (about Chrome 47) lacks.
 *
 * Plain ES5 on purpose: the 2017 engine doesn't know newer JavaScript.
 * tools/samsung/build.js puts this file in front of the screens' own script.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ old engine additions
  if (!('isConnected' in Node.prototype)) {
    Object.defineProperty(Node.prototype, 'isConnected', {
      get: function () { return document.documentElement.contains(this); }
    });
  }
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function (a, b) {
      if (a && typeof a === 'object') {
        if (a.top != null) this.scrollTop = a.top;
        if (a.left != null) this.scrollLeft = a.left;
      } else { this.scrollLeft = a; this.scrollTop = b; }
    };
  }
  // KeyboardEvent.key arrived in Chrome 51; the screens check it for Enter and digits.
  if (!('key' in KeyboardEvent.prototype)) {
    Object.defineProperty(KeyboardEvent.prototype, 'key', {
      configurable: true,
      get: function () {
        var c = this.keyCode;
        if (c === 13) return 'Enter';
        if (c >= 48 && c <= 57) return String(c - 48);
        if (c === 8) return 'Backspace';
        if (c === 27) return 'Escape';
        return '';
      }
    });
  }

  // ------------------------------------------------------------ the site's address
  // The site has moved before (ge.movie -> gemovie.tv). A move found once is remembered.
  var HOST_KEY = 'tv_site_host';
  var host = 'gemovie.tv';
  try { host = localStorage.getItem(HOST_KEY) || host; } catch (e) {}
  window.__SITE__ = 'https://' + host;
  // Preview on a PC (tools/samsung/preview.js): the site comes through the preview server.
  // On the TV the page is a local file, so this never applies there.
  var pv = /^http/.test(location.protocol) && /[?&]site=([^&]+)/.exec(location.search);
  if (pv) window.__SITE__ = decodeURIComponent(pv[1]);

  var lang = 'ka';
  function t(ka, ru, en) { return lang === 'ru' ? ru : lang === 'en' ? en : ka; }

  // ------------------------------------------------------------ short messages
  var toastEl = null, toastTimer = 0;
  function toast(text, ms) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:60px;-webkit-transform:translateX(-50%);transform:translateX(-50%);' +
        'max-width:900px;padding:14px 26px;border-radius:12px;background:rgba(20,20,26,.94);color:#fff;font-size:20px;' +
        'z-index:60;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.6);display:none';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, ms || 3500);
  }

  // ------------------------------------------------------------ downloads
  // A Samsung app may read other sites (config.xml: <access origin="*">).
  function getText(url, maxChars) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (s) { return maxChars && s.length > maxChars ? s.slice(0, maxChars) : s; });
  }
  function unescapeHtml(s) {
    return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  function metaContent(html, prop) {
    var m = new RegExp('<meta[^>]+(?:property|name)="' + prop.replace(/[.:]/g, '\\$&') + '"[^>]+content="([^"]*)"').exec(html);
    return m ? unescapeHtml(m[1]).trim() : '';
  }
  function ui() { return window.__tvui; }

  // TMDB's page in the wanted language: { title, plot } (as the Android app does).
  function tmdbTexts(kind, id, lg) {
    var loc = lg === 'ru' ? 'ru-RU' : 'en-US';
    return getText('https://www.themoviedb.org/' + kind + '/' + id + '?language=' + loc, 1500000).then(function (html) {
      var title = metaContent(html, 'og:title').replace(/\s*\(\d{4}\)\s*$/, '');
      var m = /<div class="overview"[^>]*>\s*<p>([\s\S]*?)<\/p>/.exec(html);
      var plot = m ? unescapeHtml(m[1].replace(/<[^>]+>/g, '')).trim() : '';
      if (!plot) plot = metaContent(html, 'og:description');
      if (/We don't have an overview|нет описания|нет перевода/.test(plot)) plot = '';
      return { title: title, plot: plot };
    }, function () { return { title: '', plot: '' }; });
  }
  // Machine translation from Georgian. '' if it fails.
  function translate(text, lg) {
    if (!text) return Promise.resolve('');
    var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ka&tl=' + (lg === 'ru' ? 'ru' : 'en') +
      '&dt=t&q=' + encodeURIComponent(text);
    return getText(url, 200000).then(function (body) {
      var parts = JSON.parse(body)[0] || [], out = '';
      for (var i = 0; i < parts.length; i++) if (parts[i] && parts[i][0]) out += parts[i][0];
      return out.trim();
    }, function () { return ''; });
  }
  // YouTube search page: the first video. ucbcb=1 skips Europe's cookie question.
  function youtubeSearch(q) {
    return getText('https://www.youtube.com/results?ucbcb=1&hl=en&search_query=' + encodeURIComponent(q), 2000000)
      .then(function (s) {
        var m = /"videoRenderer":\{"videoId":"([\w-]{11})"/.exec(s) || /"videoId":"([\w-]{11})"/.exec(s);
        return m ? m[1] : null;
      }, function () { return null; });
  }

  // ------------------------------------------------------------ calls from the screens
  var lastSiteCheck = 0, lastCf = 0;
  window.TVApp = {
    setLang: function (l) { lang = l || 'ka'; },
    appVersion: function () {
      try { return tizen.application.getCurrentApplication().appInfo.version; } catch (e) { return ''; }
    },
    checkUpdate: function () {
      toast(t('ახალი ვერსია კომპიუტერიდან დგება (README, Samsung).',
        'Новая версия ставится с компьютера (README, Samsung).',
        'New versions are installed from the PC (see the README, Samsung).'), 6000);
    },
    localize: function (key, kind, tmdbId, lg, geoPlot, geoFacts) {
      var tp = tmdbId ? tmdbTexts(kind === 'tv' ? 'tv' : 'movie', tmdbId, lg) : Promise.resolve({ title: '', plot: '' });
      tp.then(function (r) {
        var plotP = !r.plot && geoPlot ? translate(geoPlot, lg) : Promise.resolve(r.plot);
        var factsP = geoFacts ? translate(geoFacts, lg) : Promise.resolve('');
        return Promise.all([plotP, factsP]).then(function (x) {
          var facts = x[1] ? x[1].split('\n').map(function (f) { return f.trim(); }) : [];
          var u = ui();
          if (u && u.onLocal) u.onLocal(key, { title: r.title, plot: x[0], facts: facts });
        });
      });
    },
    findTrailer: function (query, key) {
      youtubeSearch(query).then(function (id) {
        var u = ui();
        if (id && u && u.onTrailer) u.onTrailer(key, id);
      });
    },
    // Cloudflare's browser check: it needs a newer browser than this TV has.
    cfCheck: function () {
      var now = Date.now();
      if (now - lastCf < 60000) return;
      lastCf = now;
      toast(t(host + ' ახლა ბრაუზერს ამოწმებს (Cloudflare) — ამ ტელევიზორს ეს შემოწმება ვერ გაივლის. სცადეთ მოგვიანებით.',
        host + ' сейчас проверяет браузер (Cloudflare) — этот телевизор её не пройдёт. Попробуйте позже.',
        host + ' is checking browsers right now (Cloudflare); this TV can\'t pass that check. Try again later.'), 9000);
    },
    // The site couldn't be reached at all: maybe it moved. Follow its redirect.
    recheckSite: function () {
      var now = Date.now();
      if (now - lastSiteCheck < 60000) return;
      lastSiteCheck = now;
      fetch('https://' + host + '/', { credentials: 'omit' }).then(function (r) {
        var m = /^https:\/\/([^\/?#]+)/.exec(r.url || '');
        var to = m && m[1].toLowerCase();
        if (r.ok && to && to !== host) {
          try { localStorage.setItem(HOST_KEY, to); } catch (e) {}
          toast(t('საიტი გადავიდა: ', 'Сайт переехал: ', 'The site moved to ') + to);
          setTimeout(function () { location.reload(); }, 1500);
        }
      }).catch(function () {});
    }
  };

  // ------------------------------------------------------------ the video player
  // Playerjs on the site answers {api:…} messages and reports {event:"time", time, duration}.
  var PL = null;            // the open player: { frame, start, t, d, playing, ... }
  var osd = null, osdTimer = 0;

  function playerNow() {
    var u = ui(), p = u && u.player ? u.player() : null;
    if (!p) { if (PL) playerClosed(); return null; }
    if (!PL || PL.frame !== p.frame) playerOpened(p);
    return PL;
  }
  function send(api, set) {
    if (!PL) return;
    var m = { api: api };
    if (set !== undefined) m.set = set;
    try { PL.frame.contentWindow.postMessage(m, '*'); } catch (e) {}
  }
  function playerOpened(p) {
    PL = { frame: p.frame, start: p.start || {}, t: 0, d: 0, playing: false, resumed: false, ep: '',
      seekTo: null, seekTimer: 0, lastSave: 0, tries: 0 };
    // Start playing: the player may need a moment after its page loads; ask a few times.
    var me = PL;
    (function kick() {
      if (PL !== me || me.playing || me.tries++ > 12) return;
      send('play');
      setTimeout(kick, 1200);
    })();
    showOsd(t('იტვირთება…', 'Загрузка…', 'Loading…'));
  }
  function playerClosed() {
    if (PL) save(true);
    PL = null;
    if (osd) osd.style.display = 'none';
  }
  function save(force) {
    var now = Date.now();
    if (!PL || !(PL.d > 0) || (!force && now - PL.lastSave < 5000)) return;
    PL.lastSave = now;
    var u = ui();
    if (u && u.progress) u.progress({ t: PL.t, d: PL.d, ep: PL.ep });
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!PL || !d || typeof d !== 'object' || !d.event) return;
    if (ev.source !== PL.frame.contentWindow) return;
    if (typeof d.time === 'number' && d.event !== 'seek') PL.t = d.time;
    if (typeof d.duration === 'number' && d.duration > 0) PL.d = d.duration;
    if (d.season != null && d.episode != null) PL.ep = d.season + '-' + d.episode;
    switch (d.event) {
      case 'play': case 'resumed': case 'start': case 'started':
        PL.playing = true; break;
      case 'pause': case 'paused': case 'end': case 'ended':
        PL.playing = false; save(true); break;
      case 'time':
        PL.playing = true;
        // Continue watching: jump to where this was left (movies; series open at the episode).
        var r = PL.start.resume;
        if (!PL.resumed && PL.d > 0) {
          PL.resumed = true;
          if (r && r.t > 10 && r.t < PL.d - 30) { send('seek', r.t); showOsd(); }
        }
        save(false);
        if (osd && osd.style.display === 'block') drawOsd();
        break;
    }
  });

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (s < 10 ? '0' : '') + s;
  }
  function showOsd(text) {
    if (!osd) {
      osd = document.createElement('div');
      osd.style.cssText = 'position:fixed;left:60px;right:60px;bottom:40px;z-index:40;padding:16px 24px;border-radius:14px;' +
        'background:rgba(0,0,0,.72);color:#fff;font-size:22px;display:none';
      osd.innerHTML = '<div class="l" style="display:-webkit-box;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center">' +
        '<span class="s" style="width:40px"></span><span class="tm" style="margin-left:auto"></span></div>' +
        '<div style="height:6px;border-radius:3px;background:rgba(255,255,255,.3);margin-top:12px;overflow:hidden">' +
        '<i style="display:block;height:100%;width:0;background:#e50914"></i></div>';
      document.body.appendChild(osd);
    }
    osd.__text = text || '';
    osd.style.display = 'block';
    drawOsd();
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { osd.style.display = 'none'; }, 3500);
  }
  function drawOsd() {
    if (!osd || !PL) return;
    var at = PL.seekTo != null ? PL.seekTo : PL.t;
    osd.querySelector('.s').textContent = PL.seekTo != null ? (PL.seekTo < PL.t ? '«' : '»') : PL.playing ? '▶' : '❚❚';
    osd.querySelector('.tm').textContent = osd.__text || (fmt(at) + (PL.d ? ' / ' + fmt(PL.d) : ''));
    osd.querySelector('i').style.width = (PL.d ? Math.min(100, at / PL.d * 100) : 0) + '%';
  }
  // Holding Left/Right adds up; the jump happens when the key is let go for a moment.
  function seekBy(sec) {
    if (!(PL.d > 0)) return;
    var from = PL.seekTo != null ? PL.seekTo : PL.t;
    PL.seekTo = Math.max(0, Math.min(PL.d - 5, from + sec));
    showOsd();
    clearTimeout(PL.seekTimer);
    var me = PL;
    PL.seekTimer = setTimeout(function () {
      if (PL !== me || me.seekTo == null) return;
      send('seek', me.seekTo);
      me.t = me.seekTo;
      me.seekTo = null;
      if (!me.playing) send('play');
      showOsd();
    }, 600);
  }
  // true = the key was used by the player
  function playerKey(cmd, repeat) {
    switch (cmd) {
      case 'ok': case 'playpause':
        if (repeat) return true;
        send(PL.playing ? 'pause' : 'play');
        PL.playing = !PL.playing;
        showOsd();
        return true;
      case 'play': send('play'); PL.playing = true; showOsd(); return true;
      case 'pause': send('pause'); PL.playing = false; showOsd(); return true;
      case 'left': seekBy(repeat > 8 ? -60 : -10); return true;
      case 'right': seekBy(repeat > 8 ? 60 : 10); return true;
      case 'rw': seekBy(-60); return true;
      case 'ff': seekBy(60); return true;
      case 'up': case 'down': case 'info': showOsd(); return true;
      case 'stop': save(true); ui().back(); return true;
    }
    return false;   // back and anything else: the screens
  }
  // The TV's Home key or another app: pause.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && playerNow() && PL.playing) { send('pause'); PL.playing = false; save(true); }
  });

  // ------------------------------------------------------------ remote control
  var KEYS = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 10009: 'back',
    10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 417: 'ff', 412: 'rw',
    403: 'info', 457: 'info', 427: 'pageup', 428: 'pagedown',
    8: 'back', 27: 'back'              // a PC keyboard (preview, or a keyboard on the TV)
  };
  function registerKeys() {
    if (!window.tizen || !tizen.tvinputdevice) return;
    ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      'ColorF0Red', 'ChannelUp', 'ChannelDown', 'Info', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
      .forEach(function (k) { try { tizen.tvinputdevice.registerKey(k); } catch (e) {} });
  }
  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
  }
  function typing() {
    var a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }
  var held = {}, lastBack = 0;
  window.addEventListener('keyup', function (e) { held[e.keyCode] = 0; }, true);
  window.addEventListener('keydown', function (e) {
    var code = e.keyCode;
    // Typing with the TV's on-screen keyboard: it handles everything but leaving.
    if (typing()) {
      var inp = document.activeElement;
      if (code === 10009 || code === 65385) { e.preventDefault(); e.stopPropagation(); inp.blur(); return; }
      if (code === 65376) {             // the keyboard's Done: same as Enter
        e.preventDefault(); e.stopPropagation();
        var en = document.createEvent('Event');
        en.initEvent('keydown', true, true);
        Object.defineProperty(en, 'key', { value: 'Enter' });
        Object.defineProperty(en, 'keyCode', { value: 13 });
        inp.dispatchEvent(en);
        if (document.activeElement === inp) inp.blur();
        return;
      }
      return;
    }
    var cmd = KEYS[code];
    if (!cmd) return;                   // digits etc.: the screens' own handlers (PIN)
    e.preventDefault();
    e.stopPropagation();
    var repeat = held[code] || 0;
    held[code] = repeat + 1;
    var u = ui();
    if (!u) return;

    if (playerNow() && playerKey(cmd, repeat)) return;

    if (cmd === 'back') {
      if (repeat) return;
      if (u.back()) return;
      // Nothing left to close: Back twice leaves the app.
      var now = Date.now();
      if (now - lastBack < 2000) exitApp();
      else { lastBack = now; toast(t('გასასვლელად კიდევ ერთხელ დააჭირეთ „უკან“', 'Нажмите «Назад» ещё раз, чтобы выйти', 'Press Back again to exit'), 2000); }
      return;
    }
    u.key(cmd, false, repeat);
  }, true);

  // ------------------------------------------------------------ start
  // The screens are laid out for a 1280 px wide page; fill a 1920 px TV picture.
  // (When the TV honours the page's viewport of 1280, nothing needs doing.)
  function fit() {
    var de = document.documentElement;
    de.style.zoom = '';
    var z = window.innerWidth / 1280;
    if (z > 1.05 || z < 0.95) de.style.zoom = z;
  }
  document.addEventListener('DOMContentLoaded', function () {
    registerKeys();
    fit();
  });
  window.addEventListener('resize', fit);
})();
