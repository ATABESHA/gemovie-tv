/*
 * TV remote navigation for a web page inside the app's WebView.
 * Runs in every frame (the video player lives in an iframe from another site):
 *  - top page:   arrow-key highlight, OK = real tap; ge.movie rules (menu zone,
 *                whole-card highlight, carousels, automatic full-screen player)
 *  - player:     Playerjs frames get a TV panel (audio, quality, subtitles,
 *                speed, volume, episodes) driven through the player's own API
 *  - any frame:  generic video control for other players
 */
(function () {
  'use strict';
  if (window.__tvInit) return;
  window.__tvInit = true;

  var App = window.TVApp;
  var TOP = window.top === window;

  function call(name, arg) {
    try { if (App && App[name]) App[name](arg); } catch (e) {}
  }

  // ======================================================== site rules
  // Rules for ge.movie. Other sites get the generic behaviour.
  var SITE = null;
  if (/(^|\.)ge\.movie$/.test(location.hostname)) {
    SITE = {
      sideZone: 'nav.sidebar',                                   // left menu: its own zone
      card: '.movie-card',                                       // one item, whole card framed
      playerFrame: 'iframe#movie_embed, iframe#serial_embed',    // the video player
      autoPlay: /^\/(movie|serial)\/\d+/                         // pages that open the player
    };
  }

  // ============================================================== media
  function playSafe(v) {
    try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }

  function mainVideo() {
    var best = null, bestScore = 0;
    var vs = document.querySelectorAll('video');
    for (var i = 0; i < vs.length; i++) {
      var r = vs[i].getBoundingClientRect();
      var s = r.width * r.height + 1;
      if (!vs[i].paused) s *= 10;
      if (s > bestScore) { bestScore = s; best = vs[i]; }
    }
    return best;
  }

  function mediaLocal(cmd, arg) {
    if (pjs()) {
      if (cmd === 'seek') seekBy(arg);
      else if (cmd === 'playpause') togglePlay();
      else if (cmd === 'play') { api('play'); showBar(); }
      else if (cmd === 'pause' || cmd === 'stop') { api('pause'); showBar(); }
      return true;
    }
    var v = mainVideo();
    if (!v) return false;
    if (cmd === 'playpause') { if (v.paused) playSafe(v); else v.pause(); }
    else if (cmd === 'play') playSafe(v);
    else if (cmd === 'pause' || cmd === 'stop') v.pause();
    else if (cmd === 'seek') {
      var d = isFinite(v.duration) ? v.duration : 1e9;
      v.currentTime = Math.max(0, Math.min(d - 1, v.currentTime + arg));
    }
    osd(cmd === 'seek' ? (arg > 0 ? '+' : '−') + Math.abs(arg) + 's'
      : (v.paused ? '❚❚' : '▶'));
    return true;
  }

  function sendToFrames(msg) {
    var fs = document.querySelectorAll('iframe');
    for (var i = 0; i < fs.length; i++) {
      try { fs[i].contentWindow.postMessage({ __tv: msg }, '*'); } catch (e) {}
    }
    return fs.length > 0;
  }

  function clickCenter() {
    var el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    if (el) syntheticClick(el);
  }

  function media(cmd, arg) {
    if (mediaLocal(cmd, arg)) return;
    if (sendToFrames({ media: cmd, arg: arg })) return;
    // A player that has no <video> yet usually starts with a click on its poster.
    if (!TOP && (cmd === 'playpause' || cmd === 'play')) clickCenter();
  }

  function reportPlaying() {
    var v = mainVideo();
    call('setPlaying', !!(v && !v.paused && !v.ended));
  }
  ['playing', 'pause', 'ended'].forEach(function (t) {
    document.addEventListener(t, reportPlaying, true);
  });

  function fsEl() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function overlayHost() {
    var host = fsEl();
    if (!host || host.tagName === 'VIDEO' || host.tagName === 'IFRAME') host = document.body;
    return host;
  }

  function byId(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(s) {
    s = Math.max(0, Math.floor(+s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(x);
  }

  var osdTimer = null;
  function osd(text) {
    var host = overlayHost();
    if (!host) return;
    var el = byId('__tvosd');
    if (!el) {
      el = document.createElement('div');
      el.id = '__tvosd';
      el.style.cssText = 'position:fixed;left:50%;top:10%;transform:translateX(-50%);' +
        'background:rgba(0,0,0,.75);color:#fff;font:600 30px sans-serif;padding:12px 28px;' +
        'border-radius:12px;z-index:2147483647;pointer-events:none;transition:opacity .3s';
    }
    if (el.parentNode !== host) host.appendChild(el);
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { el.style.opacity = '0'; }, 900);
  }

  function syntheticClick(el) {
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
    } catch (e) {}
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', o));
  }

  // ===================================================== Playerjs panel
  // ge.movie's player (embed.filmx.cc) is Playerjs: window.player.api(...)
  // gives audio tracks, qualities, subtitles, speeds, volume and episodes.
  function pjs() {
    var p = window.player;
    return p && typeof p.api === 'function' ? p : null;
  }
  function api(k, v) {
    var p = pjs();
    if (!p) return undefined;
    try { return v === undefined ? p.api(k) : p.api(k, v); } catch (e) { return undefined; }
  }
  function arr(x) {
    if (Array.isArray(x)) return x;
    if (typeof x === 'string' && x.charAt(0) === '[') { try { return JSON.parse(x); } catch (e) {} }
    return [];
  }
  function pref(k, v) {
    try {
      if (v === undefined) return localStorage.getItem('__tv_' + k);
      localStorage.setItem('__tv_' + k, v);
    } catch (e) {}
    return null;
  }

  var PL = { open: false, tile: 0, tiles: [], list: null, idle: null, tick: null,
    plist: null, plistFile: null, started: false, audio: null };

  function loadPlaylist() {
    var file = api('file');
    if (typeof file !== 'string' || !file || file === PL.plistFile) return;
    PL.plistFile = file;
    PL.plist = null;
    fetch(file).then(function (r) { return r.json(); }).then(function (j) {
      PL.plist = Array.isArray(j) ? j : null;
      if (PL.open && !PL.list) renderPanel();
    }).catch(function () {});
  }

  function seasons() {
    if (!PL.plist) return null;
    var s = PL.plist.filter(function (x) { return x && Array.isArray(x.folder) && x.folder.length; });
    return s.length ? s : null;
  }
  function allEpisodes() {
    var out = [];
    (seasons() || []).forEach(function (s) {
      s.folder.forEach(function (e) { out.push({ id: e.id, title: e.title, season: s.title }); });
    });
    return out;
  }
  function currentEpisode() {
    var id = api('playlist_id'), eps = allEpisodes();
    for (var i = 0; i < eps.length; i++) if (eps[i].id === id) return { i: i, e: eps[i], all: eps };
    return null;
  }

  function setAudio(i, label) {
    PL.audio = label;
    pref('a', label);
    var p = pjs();
    try { p.api('audiotrack', i); } catch (e) {
      // The player throws if its audio list is still loading: try once more.
      setTimeout(function () { try { p.api('audiotrack', i); } catch (e2) {} }, 1500);
    }
  }

  function togglePlay() {
    if (api('playing')) api('pause'); else api('play');
    setTimeout(function () { showBar(api('playing') ? '▶' : '❚❚'); }, 150);
  }

  function tiles() {
    var t = [], playing = !!api('playing');
    t.push({ name: playing ? '❚❚' : '▶', value: playing ? 'პაუზა' : 'დაკვრა', run: togglePlay });

    var ce = currentEpisode();
    if (ce) {
      var nx = ce.all[ce.i + 1];
      if (nx) t.push({ name: 'შემდეგი', value: nx.season + ' · ' + nx.title,
        run: function () { api('play', 'id:' + nx.id); } });
      t.push({ name: 'ეპიზოდები', value: ce.e.season + ' · ' + ce.e.title, list: episodesList });
    }

    var au = arr(api('audiotracks'));
    if (au.length > 1) {
      var ca = api('audiotrack') || PL.audio || pref('a') || '';
      t.push({ name: 'აუდიო', value: ca, list: function () {
        return au.map(function (x, i) {
          return { label: x, cur: x === ca, run: function () { setAudio(i, x); } };
        });
      } });
    }

    var q = arr(api('qualities'));
    if (q.length > 1) {
      var cq = api('quality');
      t.push({ name: 'ხარისხი', value: cq || '', list: function () {
        return q.map(function (x, i) {
          return { label: x, cur: x === cq, run: function () { api('quality', i); pref('q', x); } };
        }).reverse();
      } });
    }

    var su = arr(api('subtitles'));
    if (su.length) {
      var cs = api('subtitle'), on = su.indexOf(cs) >= 0;
      t.push({ name: 'სუბტიტრები', value: on ? cs : 'გამორთული', list: function () {
        return [{ label: 'გამორთული', cur: !on, run: function () { api('subtitle', -1); pref('s', ''); } }]
          .concat(su.map(function (x, i) {
            return { label: x, cur: x === cs, run: function () { api('subtitle', i); pref('s', x); } };
          }));
      } });
    }

    var sp = arr(api('speeds'));
    if (sp.length > 1) {
      var csp = +api('speed') || 1;
      t.push({ name: 'სიჩქარე', value: csp + 'x', list: function () {
        return sp.map(function (x) {
          return { label: x + 'x', cur: +x === csp, run: function () { api('speed', x); } };
        });
      } });
    }

    var vol = api('muted') ? 0 : Math.round((+api('volume') || 0) * 10) * 10;
    t.push({ name: 'ხმა', value: vol ? vol + '%' : 'ხმის გარეშე', list: function () {
      var out = [];
      [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0].forEach(function (v) {
        out.push({ label: v ? v + '%' : 'ხმის გარეშე', cur: v === vol, run: function () {
          if (v) { api('volume', v / 100); if (api('muted')) api('unmute'); } else api('mute');
        } });
      });
      return out;
    } });
    return t;
  }

  function episodesList() {
    var ss = seasons() || [], id = api('playlist_id');
    function eps(s) {
      return s.folder.map(function (e) {
        return { label: e.title, cur: e.id === id, run: function () { api('play', 'id:' + e.id); } };
      });
    }
    if (ss.length === 1) return eps(ss[0]);
    return ss.map(function (s) {
      return { label: s.title, cur: s.folder.some(function (e) { return e.id === id; }),
        children: function () { return eps(s); } };
    });
  }

  function addPanelStyle() {
    if (byId('__tvpstyle') || !document.head) return;
    var st = document.createElement('style');
    st.id = '__tvpstyle';
    st.textContent =
      '#__tvpanel{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:140px 56px 44px;' +
      'background:linear-gradient(to bottom,rgba(0,0,0,0),rgba(0,0,0,.85) 45%,rgba(0,0,0,.96));' +
      'color:#fff;font-family:sans-serif;pointer-events:none;box-sizing:border-box}' +
      '#__tvpanel .tvp-time{display:flex;align-items:center;gap:18px;font:600 20px sans-serif;margin-bottom:22px}' +
      '#__tvpanel .tvp-bar{flex:1;height:6px;background:rgba(255,255,255,.25);border-radius:3px;overflow:hidden}' +
      '#__tvpanel .tvp-bar i{display:block;height:100%;background:#e50914}' +
      '#__tvpanel .tvp-tiles{display:flex;gap:14px}' +
      '#__tvpanel .tvp-tile{background:rgba(255,255,255,.12);border-radius:12px;padding:12px 20px;' +
      'min-width:96px;transition:transform .12s,background .12s}' +
      '#__tvpanel .tvp-tile b{display:block;font-size:20px;font-weight:700;white-space:nowrap}' +
      '#__tvpanel .tvp-tile span{display:block;font-size:15px;opacity:.8;margin-top:4px;white-space:nowrap;' +
      'max-width:230px;overflow:hidden;text-overflow:ellipsis}' +
      '#__tvpanel .tvp-tile.on{background:rgba(255,255,255,.24)}' +
      '#__tvpanel .tvp-tile.sel{background:#e50914;transform:scale(1.06)}' +
      '#__tvpanel .tvp-list{position:absolute;min-width:260px;max-height:58vh;overflow:hidden;' +
      'background:rgba(22,22,22,.97);border-radius:12px;padding:8px 0;box-shadow:0 10px 40px rgba(0,0,0,.6)}' +
      '#__tvpanel .tvp-lt{font-size:15px;opacity:.6;padding:6px 22px 10px}' +
      '#__tvpanel .tvp-it{font-size:20px;padding:11px 22px;white-space:nowrap}' +
      '#__tvpanel .tvp-it.sel{background:#fff;color:#000}' +
      '#__tvbar{position:fixed;left:56px;right:56px;bottom:40px;z-index:2147483647;color:#fff;' +
      'font:600 22px sans-serif;text-shadow:0 1px 4px #000;pointer-events:none;transition:opacity .3s}' +
      '#__tvbar .tvb-top{display:flex;justify-content:space-between;margin-bottom:10px}' +
      '#__tvbar .tvb-line{height:6px;background:rgba(255,255,255,.3);border-radius:3px;overflow:hidden}' +
      '#__tvbar .tvb-line i{display:block;height:100%;background:#e50914}';
    document.head.appendChild(st);
  }

  // Time bar shown after play/pause and while seeking with the arrows.
  var barTimer = null;
  function showBar(label, at) {
    if (PL.open) return;
    addPanelStyle();
    var host = overlayHost();
    if (!host) return;
    var el = byId('__tvbar');
    if (!el) { el = document.createElement('div'); el.id = '__tvbar'; }
    if (el.parentNode !== host) host.appendChild(el);
    var d = +api('duration') || 0, t = at != null ? at : (+api('time') || 0);
    el.innerHTML = '<div class="tvb-top"><span>' + esc(label || '') + '</span><span>' +
      fmt(t) + ' / ' + fmt(d) + '</span></div><div class="tvb-line"><i style="width:' +
      (d ? Math.min(100, t * 100 / d) : 0) + '%"></i></div>';
    el.style.opacity = '1';
    clearTimeout(barTimer);
    barTimer = setTimeout(function () { el.style.opacity = '0'; }, 2500);
  }
  function hideBar() {
    var el = byId('__tvbar');
    if (el) el.style.opacity = '0';
  }

  // Holding an arrow adds up the jump and seeks once you let go.
  var seekTarget = null, seekTimer = null;
  function seekBy(delta) {
    var d = +api('duration') || 0;
    var t = seekTarget != null ? seekTarget : (+api('time') || 0);
    seekTarget = Math.max(0, d ? Math.min(d - 2, t + delta) : t + delta);
    var diff = Math.round(seekTarget - (+api('time') || 0));
    showBar((diff >= 0 ? '⏩ +' : '⏪ −') + fmt(Math.abs(diff)), seekTarget);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(function () { api('seek', seekTarget); seekTarget = null; }, 450);
  }
  function seekStep(repeat) {
    return repeat >= 10 ? 60 : repeat >= 3 ? 30 : 10;
  }

  function renderPanel() {
    if (!PL.open) return;
    addPanelStyle();
    var host = overlayHost();
    if (!host) return;
    var el = byId('__tvpanel');
    if (!el) { el = document.createElement('div'); el.id = '__tvpanel'; }
    if (el.parentNode !== host) host.appendChild(el);
    var t = PL.tiles = tiles();
    if (PL.tile >= t.length) PL.tile = t.length - 1;
    var time = +api('time') || 0, dur = +api('duration') || 0;
    var h = '<div class="tvp-time"><span>' + fmt(time) + '</span><div class="tvp-bar"><i style="width:' +
      (dur ? Math.min(100, time * 100 / dur) : 0) + '%"></i></div><span>' + fmt(dur) + '</span></div>' +
      '<div class="tvp-tiles">';
    t.forEach(function (x, i) {
      h += '<div class="tvp-tile' + (i === PL.tile ? (PL.list ? ' on' : ' sel') : '') + '"><b>' +
        esc(x.name) + '</b>' + (x.value ? '<span>' + esc(x.value) + '</span>' : '') + '</div>';
    });
    h += '</div>';
    if (PL.list) {
      h += '<div class="tvp-list"><div class="tvp-lt">' + esc(PL.list.title) + '</div>';
      PL.list.items.forEach(function (it, i) {
        h += '<div class="tvp-it' + (i === PL.list.sel ? ' sel' : '') + '">' + (it.cur ? '✓ ' : '') +
          esc(it.label) + (it.children ? ' ›' : '') + '</div>';
      });
      h += '</div>';
    }
    el.innerHTML = h;
    if (PL.list) {
      var tileEl = el.querySelectorAll('.tvp-tile')[PL.tile];
      var lst = el.querySelector('.tvp-list');
      lst.style.bottom = (el.clientHeight - tileEl.offsetTop + 14) + 'px';
      lst.style.left = Math.max(20, Math.min(tileEl.offsetLeft, el.clientWidth - lst.offsetWidth - 20)) + 'px';
      var s = lst.querySelector('.sel');
      if (s) lst.scrollTop = s.offsetTop - lst.clientHeight / 2 + s.offsetHeight / 2;
    }
  }

  function openList(title, items, parent) {
    var sel = 0;
    for (var i = 0; i < items.length; i++) if (items[i].cur) { sel = i; break; }
    PL.list = { title: title, items: items, sel: sel, parent: parent || null };
  }

  function bump() {
    clearTimeout(PL.idle);
    PL.idle = setTimeout(closePanel, 10000);
  }

  function openPanel() {
    PL.open = true;
    PL.list = null;
    PL.tile = 0;
    loadPlaylist();
    hideBar();
    renderPanel();
    clearInterval(PL.tick);
    PL.tick = setInterval(function () { if (!PL.list) renderPanel(); }, 1000);
    bump();
    call('setFsControls', true);
  }

  function closePanel() {
    PL.open = false;
    PL.list = null;
    clearInterval(PL.tick);
    clearTimeout(PL.idle);
    var el = byId('__tvpanel');
    if (el) el.remove();
    call('setFsControls', false);
  }

  // A remote key for the Playerjs player. Returns false when there is no Playerjs here.
  function playerKey(cmd, repeat) {
    if (!pjs()) return false;
    if (PL.open) {
      bump();
      var L = PL.list;
      if (L) {
        if (cmd === 'up') { if (L.sel > 0) L.sel--; }
        else if (cmd === 'down') { if (L.sel < L.items.length - 1) L.sel++; }
        else if (cmd === 'ok') {
          if (repeat) return true;
          var it = L.items[L.sel];
          if (it.children) openList(it.label, it.children(), L);
          else { it.run(); PL.list = null; setTimeout(renderPanel, 700); }
        }
        else if (cmd === 'back') PL.list = L.parent;
        else if (cmd === 'left' || cmd === 'right') PL.list = null;
        else if (cmd === 'playpause' || cmd === 'play' || cmd === 'pause') togglePlay();
        renderPanel();
        call('setFsControls', true);
        return true;
      }
      if (cmd === 'left') { if (PL.tile > 0) PL.tile--; }
      else if (cmd === 'right') { if (PL.tile < PL.tiles.length - 1) PL.tile++; }
      else if (cmd === 'ok' || cmd === 'up') {
        if (repeat) return true;
        var tl = PL.tiles[PL.tile];
        if (tl && tl.list) openList(tl.name, tl.list());
        else if (tl && tl.run && cmd === 'ok') { tl.run(); setTimeout(renderPanel, 500); }
      }
      else if (cmd === 'down' || cmd === 'back') { closePanel(); return true; }
      else if (cmd === 'playpause' || cmd === 'play' || cmd === 'pause') togglePlay();
      else if (cmd === 'ff') seekBy(10);
      else if (cmd === 'rw') seekBy(-10);
      renderPanel();
      call('setFsControls', true);
      return true;
    }
    switch (cmd) {
      case 'left': case 'rw': seekBy(-seekStep(repeat)); break;
      case 'right': case 'ff': seekBy(seekStep(repeat)); break;
      case 'ok': case 'playpause': if (!repeat) togglePlay(); break;
      case 'play': api('play'); showBar('▶'); break;
      case 'pause': case 'stop': api('pause'); showBar('❚❚'); break;
      case 'up': case 'down': if (!repeat) openPanel(); break;
    }
    return true;
  }

  // Start playing with the remembered choices (quality 1080p unless you picked another).
  function playerStart() {
    if (PL.started) return;
    PL.started = true;
    var tries = 0;
    (function wait() {
      if (!PL.started) return;
      if (!pjs()) { if (++tries < 60) setTimeout(wait, 300); else PL.started = false; return; }
      api('play');
      loadPlaylist();
      applyPrefs();
    })();
  }

  function applyPrefs() {
    var n = 0;
    (function attempt() {
      var q = arr(api('qualities'));
      if (!q.length || !(+api('duration'))) { if (++n < 40) setTimeout(attempt, 500); return; }
      var want = pref('q') || '1080p', qi = q.indexOf(want);
      if (qi < 0) {
        var bh = 0;
        q.forEach(function (x, j) { var h = parseInt(x, 10); if (h <= 1080 && h > bh) { bh = h; qi = j; } });
      }
      if (qi >= 0 && api('quality') !== q[qi]) api('quality', qi);
      var a = pref('a'), ai = a ? arr(api('audiotracks')).indexOf(a) : -1;
      if (ai >= 0 && api('audiotrack') !== a) setTimeout(function () { setAudio(ai, a); }, 1500);
      var s = pref('s'), si = s ? arr(api('subtitles')).indexOf(s) : -1;
      if (si >= 0) api('subtitle', si);
    })();
  }

  function playerStop() {
    PL.started = false;
    closePanel();
    hideBar();
    api('pause');
  }

  // ========================================== navigation engine (any frame)
  var NATIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,' +
    '[onclick],[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemradio],' +
    '[role=menuitemcheckbox],[role=option],[role=radio],[role=switch],[role=slider],' +
    '[tabindex]:not([tabindex="-1"]),video,iframe';
  var LINKISH = 'a[href],button,[role=button],[role=link]';

  var cache = null;      // gathered candidates, re-read when older than CACHE_MS
  var cacheRoot = null;
  var cacheTime = 0;
  var cacheCount = -1;   // element count when gathered: a page change re-reads at once
  var CACHE_MS = 400;    // covers a burst of held-arrow repeats, then re-reads the page
  var cur = null;        // highlighted element
  var lastRect = null;   // where the highlight was, to recover if the element disappears
  var lastMain = null;   // last highlighted item outside the side menu
  var editing = false;
  var fsMode = false;    // navigating a (non-Playerjs) player's controls in full screen

  function addStyle() {
    if (!document.head || byId('__tvstyle')) return;
    var st = document.createElement('style');
    st.id = '__tvstyle';
    st.textContent =
      '*{-webkit-tap-highlight-color:transparent!important}' +
      '.__tvf{outline:4px solid #e50914!important;outline-offset:3px!important;' +
      'box-shadow:0 0 0 8px rgba(229,9,20,.35),0 10px 30px rgba(0,0,0,.6)!important;' +
      'transition:transform .15s ease!important}' +
      '.__tvs{transform:scale(1.07)!important}' +
      // A whole movie card: red frame drawn inside the card, so carousels don't cut it off.
      '.__tvcard{outline:5px solid #e50914!important;outline-offset:-5px!important;' +
      'border-radius:8px;filter:brightness(1.12)}' +
      // Full-screen player: only the player iframe stays visible, over the whole screen.
      'html.__tvplay,html.__tvplay body{overflow:hidden!important;background:#000!important}' +
      'html.__tvplay body *{visibility:hidden!important}' +
      'html.__tvplay iframe.__tvplayer{visibility:visible!important;position:fixed!important;' +
      'left:0!important;top:0!important;width:100vw!important;height:100vh!important;' +
      'max-width:none!important;max-height:none!important;margin:0!important;border:0!important;' +
      'transform:none!important;z-index:2147483647!important}';
    document.head.appendChild(st);
  }

  function scopeRoot() {
    return (fsMode && fsEl()) || document.body;
  }

  function cardOf(el) {
    return SITE && SITE.card ? el.closest(SITE.card) : null;
  }

  function zoneOf(el) {
    return SITE && SITE.sideZone && el.closest(SITE.sideZone) ? 'side' : 'main';
  }

  function gather() {
    var root = scopeRoot();
    var now = Date.now();
    var count = root ? root.getElementsByTagName('*').length : 0;
    if (cache && cacheRoot === root && cacheCount === count && now - cacheTime < CACHE_MS) return cache;
    cacheRoot = root;
    cacheTime = now;
    cacheCount = count;
    var found = [], set = new Set();
    function add(el) {
      var c = cardOf(el);          // anything inside a movie card counts as the card
      if (c) el = c;
      if (set.has(el)) return;
      if (fsMode && (el.tagName === 'VIDEO' || el.tagName === 'IFRAME')) return;
      set.add(el); found.push(el);
    }
    if (!root) return (cache = []);

    var nat = root.querySelectorAll(NATIVE);
    for (var i = 0; i < nat.length; i++) add(nat[i]);

    // Elements the site made clickable with JS: they show a pointer cursor.
    var all = root.getElementsByTagName('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (set.has(el)) continue;
      if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;
      var tn = el.tagName;
      if (tn === 'SCRIPT' || tn === 'STYLE' || tn === 'NOSCRIPT' || tn === 'BR') continue;
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      var p = el.parentElement;
      if (p && getComputedStyle(p).cursor === 'pointer') continue; // inherited, not its own
      if (el.closest(LINKISH)) continue;
      add(el);
    }

    // Keep the innermost item when one clickable sits inside another.
    var containers = new Set();
    found.forEach(function (el) {
      for (var a = el.parentElement; a; a = a.parentElement) {
        if (set.has(a)) containers.add(a);
      }
    });
    var kept = found.filter(function (el) {
      if (!containers.has(el)) return true;
      // A link wrapping only non-link children (e.g. a poster card) stays.
      return el.matches(LINKISH) && !el.querySelector(LINKISH + ',input,select,textarea');
    });
    var keep = new Set(kept);
    cache = kept.filter(function (el) {
      for (var a = el.parentElement; a; a = a.parentElement) {
        if (keep.has(a) && a.matches(LINKISH)) return false;
      }
      return true;
    });
    return cache;
  }

  // The carousel (Swiper) an element sits in, if any.
  function swiperOf(el) {
    var c = el.closest('.swiper-container,.swiper');
    return c && c.swiper && typeof c.swiper.slideTo === 'function' ? c : null;
  }

  function isShown(el, r) {
    if (!el.isConnected || r.width < 6 || r.height < 6) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) return false;
    if (r.right <= 0 && !swiperOf(el)) return false;
    if (r.bottom <= -innerHeight * 50) return false;
    var vw = innerWidth, vh = innerHeight;
    var inView = r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
    if (!inView) return !fsMode;
    // Slid out of its carousel: hidden now, but the carousel can bring it in.
    var sc = swiperOf(el);
    if (sc) {
      var cr = sc.getBoundingClientRect();
      if (r.left < cr.left - 1 || r.right > cr.right + 1) return true;
    }
    // On screen: make sure it is not covered or clipped away.
    var x = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
    var y = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
    var h = document.elementFromPoint(x, y);
    return !!h && (h === el || el.contains(h) || h.contains(el));
  }

  function items() {
    var list = gather(), out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (isShown(list[i], r)) out.push({ el: list[i], r: r });
    }
    return out;
  }

  function score(a, b, dir) {
    var acx = (a.left + a.right) / 2, acy = (a.top + a.bottom) / 2;
    var bcx = (b.left + b.right) / 2, bcy = (b.top + b.bottom) / 2;
    var primary, gap, align;
    if (dir === 'right' || dir === 'left') {
      if (dir === 'right' ? !(bcx > acx + 1 && b.left > a.left) : !(bcx < acx - 1 && b.right < a.right)) return null;
      primary = dir === 'right' ? Math.max(0, b.left - a.right) : Math.max(0, a.left - b.right);
      gap = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
      align = Math.abs(bcy - acy);
      // ge.movie: Left/Right never leave the row (Left at the row start opens the menu).
      if (gap > 0 && SITE) return null;
      // Other sites: stay in the same row when possible (like a TV app).
      return primary + align * 0.3 + (gap > 0 ? 100000 + gap * 4 : 0);
    }
    if (dir === 'down' ? !(bcy > acy + 1 && b.top > a.top) : !(bcy < acy - 1 && b.bottom < a.bottom)) return null;
    primary = dir === 'down' ? Math.max(0, b.top - a.bottom) : Math.max(0, a.top - b.bottom);
    gap = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
    align = Math.abs(bcx - acx);
    return primary + gap * 2 + align * 0.5;
  }

  function mainOnly(list) {
    if (!SITE || !SITE.sideZone) return list;
    var m = list.filter(function (o) { return zoneOf(o.el) === 'main'; });
    return m.length ? m : list;
  }

  function pickStart(list) {
    list = mainOnly(list);
    var vh = innerHeight, best = null, bs = Infinity;
    list.forEach(function (o) {
      var s;
      if (lastRect) {
        s = Math.abs(o.r.top - lastRect.top) + Math.abs(o.r.left - lastRect.left);
      } else {
        if (o.r.bottom < 0 || o.r.top > vh) return;
        s = o.r.top * 3 + o.r.left;
      }
      if (s < bs) { bs = s; best = o.el; }
    });
    return best || (list[0] && list[0].el);
  }

  // Player controls: start on the bottom row, leftmost (usually play/pause).
  function pickControlStart(list) {
    var best = null, bs = Infinity;
    list.forEach(function (o) {
      var s = (innerHeight - o.r.bottom) * 3 + o.r.left;
      if (s < bs) { bs = s; best = o.el; }
    });
    return best;
  }

  function nearestVertically(list, rect) {
    var cy = (rect.top + rect.bottom) / 2, best = null, bs = Infinity;
    list.forEach(function (o) {
      var s = Math.abs((o.r.top + o.r.bottom) / 2 - cy);
      if (s < bs) { bs = s; best = o.el; }
    });
    return best;
  }

  function clearFocus() {
    if (cur) cur.classList.remove('__tvf', '__tvs', '__tvcard');
    cur = null;
  }

  function focusEl(el, scroll) {
    if (cur) cur.classList.remove('__tvf', '__tvs', '__tvcard');
    cur = el;
    if (!el) return;
    if (zoneOf(el) === 'main') lastMain = el;
    var isCard = SITE && SITE.card && el.matches(SITE.card);
    var r = el.getBoundingClientRect();
    var tag = el.tagName;
    if (isCard) {
      el.classList.add('__tvcard');
    } else {
      el.classList.add('__tvf');
      var small = r.width * r.height < innerWidth * innerHeight * 0.2;
      if (small && tag !== 'INPUT' && tag !== 'IFRAME' && tag !== 'VIDEO' &&
          getComputedStyle(el).transform === 'none') {
        el.classList.add('__tvs');
      }
    }
    if (!fsMode && !isCard && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      try { el.focus({ preventScroll: true }); } catch (e) {}
    }
    if (scroll !== false && !fsMode) {
      // Carousel: slide it so the item is fully visible.
      var sc = swiperOf(el), slid = false;
      if (sc) {
        var slide = el.closest('.swiper-slide') || el;
        var idx = Array.prototype.indexOf.call(sc.swiper.slides, slide);
        var cr = sc.getBoundingClientRect(), sr = slide.getBoundingClientRect();
        if (idx >= 0 && sr.right > cr.right + 2) {
          var per = Math.max(1, Math.floor((cr.width + 10) / Math.max(1, sr.width)));
          sc.swiper.slideTo(Math.max(0, idx - per + 1), 250);
          slid = true;
        } else if (idx >= 0 && sr.left < cr.left - 2) {
          sc.swiper.slideTo(idx, 250);
          slid = true;
        }
      }
      // Page: scroll up/down so the item sits in the middle.
      if (r.top < 90 || r.bottom > innerHeight - 60) {
        window.scrollBy({ top: (r.top + r.height / 2) - innerHeight / 2, behavior: 'smooth' });
      }
      if (!sc && !slid && (r.left < 30 || r.right > innerWidth - 30)) {
        try { el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } catch (e) {}
      }
    }
    lastRect = el.getBoundingClientRect();
  }

  function move(dir, retried) {
    var list = items();
    if (!list.length) {
      if (!fsMode && (dir === 'down' || dir === 'up')) {
        window.scrollBy({ top: (dir === 'down' ? 1 : -1) * innerHeight * 0.6, behavior: 'smooth' });
      }
      return;
    }
    if (!cur || !cur.isConnected || gather().indexOf(cur) < 0) {
      focusEl(fsMode ? pickControlStart(list) : pickStart(list));
      return;
    }
    var zone = zoneOf(cur);
    var a = cur.getBoundingClientRect(), best = null, bs = Infinity;
    list.forEach(function (o) {
      if (o.el === cur || zoneOf(o.el) !== zone) return;   // stay in the menu or in the content
      var s = score(a, o.r, dir);
      if (s !== null && s < bs) { bs = s; best = o.el; }
    });
    if (best) { focusEl(best); return; }

    // Edge of a zone: Left from the content opens the menu, Right goes back.
    if (SITE && SITE.sideZone && !fsMode) {
      if (dir === 'left' && zone === 'main') {
        var side = list.filter(function (o) { return zoneOf(o.el) === 'side'; });
        if (side.length) {
          var active = side.filter(function (o) { return o.el.matches('.active'); })[0];
          focusEl(active ? active.el : nearestVertically(side, a));
          return;
        }
      }
      if (dir === 'right' && zone === 'side') {
        var main = list.filter(function (o) { return zoneOf(o.el) === 'main'; });
        var back = lastMain && main.filter(function (o) { return o.el === lastMain; })[0];
        if (back || main.length) { focusEl(back ? back.el : pickStart(main)); return; }
      }
    }
    // Nothing further: scroll so lazy-loaded rows can appear, then try once more.
    if (!fsMode && zone === 'main' && (dir === 'down' || dir === 'up') && !retried) {
      window.scrollBy({ top: (dir === 'down' ? 1 : -1) * innerHeight * 0.5, behavior: 'smooth' });
      setTimeout(function () { cache = null; move(dir, true); }, 500);
    }
  }

  function activate() {
    if (!cur || !cur.isConnected) { move('down'); return; }
    // ge.movie: OK on the player opens it full screen; OK on a card opens the movie.
    if (TOP && SITE && cur.matches(SITE.playerFrame)) { enterPlayerMode(cur); return; }
    if (SITE && SITE.card && cur.matches(SITE.card)) {
      var link = cur.querySelector('a[href]');
      if (link) { link.click(); return; }
    }
    var r = cur.getBoundingClientRect();
    if (!fsMode && (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)) {
      cur.scrollIntoView({ block: 'center', inline: 'center' });
      r = cur.getBoundingClientRect();
    }
    var x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    var y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    var h = document.elementFromPoint(x, y);
    var hitsIt = !!h && (h === cur || cur.contains(h) || h.contains(cur));
    if (hitsIt && App && App.tap) {
      // A real touch tap: counts as a user gesture, works inside player iframes.
      App.tap(x / innerWidth, y / innerHeight);
    } else {
      syntheticClick(cur);
    }
  }

  // No page watcher: during a movie the player changes its page many times a second,
  // and reacting to every change costs CPU for the whole film. Instead the item list
  // is re-read on key presses (gather() checks age and element count), so the
  // script does no work at all while you just watch.

  // ============ full screen of other players: navigate their own controls
  var revealTimer = null, idleTimer = null;
  var IDLE_MS = 10000;

  // Players show their control bar when the mouse moves over them.
  function reveal() {
    var f = fsEl() || document.body;
    if (!f) return;
    var r = f.getBoundingClientRect();
    var x = r.left + r.width / 2 + Math.random() * 6, y = r.top + r.height * 0.6;
    var target = document.elementFromPoint(x, y) || f;
    var o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    try {
      target.dispatchEvent(new PointerEvent('pointermove', o));
      target.dispatchEvent(new MouseEvent('mousemove', o));
      target.dispatchEvent(new MouseEvent('mouseover', o));
    } catch (e) {}
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(exitControls, IDLE_MS);
  }

  function enterControls() {
    fsMode = true;
    cache = null;
    lastRect = null;
    addStyle();
    call('setFsControls', true);
    reveal();
    clearInterval(revealTimer);
    revealTimer = setInterval(reveal, 1500);
    resetIdle();
    setTimeout(function () {
      if (!fsMode) return;
      var list = items();
      if (list.length) focusEl(pickControlStart(list), false);
    }, 300);
  }

  function exitControls() {
    if (!fsMode) return;
    fsMode = false;
    clearInterval(revealTimer);
    clearTimeout(idleTimer);
    clearFocus();
    cache = null;
    call('setFsControls', false);
  }

  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (t) {
    document.addEventListener(t, function () { if (!fsEl()) exitControls(); });
  });

  // A key while the app shows a full-screen video. The frame that owns the
  // full-screen element handles it; frames above just pass it down.
  function fsKey(cmd, repeat) {
    if (playerKey(cmd, repeat)) return;      // Playerjs: our own TV panel
    var f = fsEl();
    if (f && f.tagName === 'IFRAME') {
      try { f.contentWindow.postMessage({ __tv: { fskey: cmd, repeat: repeat } }, '*'); } catch (e) {}
      return;
    }
    if (!f) { legacyFsKey(cmd); return; }

    if (fsMode) {
      resetIdle();
      switch (cmd) {
        case 'back': exitControls(); return;
        case 'ok': activate(); setTimeout(function () { cache = null; }, 300); return;
        case 'up': case 'down': case 'left': case 'right':
          reveal(); cache = null; move(cmd); return;
        case 'playpause': case 'play': case 'pause': case 'stop': media(cmd); return;
        case 'ff': media('seek', 10); return;
        case 'rw': media('seek', -10); return;
      }
      return;
    }
    switch (cmd) {
      case 'ok': case 'playpause': media('playpause'); return;
      case 'right': case 'ff': media('seek', 10); return;
      case 'left': case 'rw': media('seek', -10); return;
      case 'up': case 'down': enterControls(); return;
      case 'play': case 'pause': case 'stop': media(cmd); return;
    }
  }

  // Full screen without the Fullscreen API (a bare <video>): no controls to navigate.
  function legacyFsKey(cmd) {
    if (cmd === 'ok' || cmd === 'playpause') media('playpause');
    else if (cmd === 'right' || cmd === 'ff') media('seek', 10);
    else if (cmd === 'left' || cmd === 'rw') media('seek', -10);
    else if (cmd === 'up') media('seek', 60);
    else if (cmd === 'down') media('seek', -60);
    else if (cmd === 'play' || cmd === 'pause' || cmd === 'stop') media(cmd);
  }

  // ================================ playback info overlay (red / Info button)
  // Shows whether the lag is the TV struggling to decode (dropped frames), the
  // network (buffer empty, stalls) or the page growing (memory, elements).
  var diagOn = false, diagTimer = null, diagStart = 0, diagHist = [], stalls = 0;
  document.addEventListener('waiting', function () { stalls++; }, true);

  function setDiag(on) {
    diagOn = on;
    clearInterval(diagTimer);
    diagTimer = null;
    var old = byId('__tvdiag');
    if (old) old.remove();
    if (on && mainVideo()) {
      diagStart = Date.now();
      diagHist = [];
      updateDiag();
      diagTimer = setInterval(updateDiag, 1000);
    }
    sendToFrames({ diag: on });
  }

  function updateDiag() {
    var v = mainVideo();
    if (!v) return;
    var host = overlayHost();
    var el = byId('__tvdiag');
    if (!el) {
      el = document.createElement('div');
      el.id = '__tvdiag';
      el.style.cssText = 'position:fixed;left:16px;top:16px;z-index:2147483647;' +
        'background:rgba(0,0,0,.82);color:#7CFC7C;font:18px/1.45 monospace;' +
        'padding:12px 16px;border-radius:8px;pointer-events:none;white-space:pre';
    }
    if (el.parentNode !== host) host.appendChild(el);

    var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    var dropped = q ? q.droppedVideoFrames : (v.webkitDroppedFrameCount || 0);
    var frames = q ? q.totalVideoFrames : (v.webkitDecodedFrameCount || 0);
    var now = Date.now();
    diagHist.push({ t: now, d: dropped, f: frames });
    while (diagHist.length > 11) diagHist.shift();
    var h0 = diagHist[0];
    var recentF = frames - h0.f, recentD = dropped - h0.d;
    var recentPct = recentF > 0 ? Math.round(recentD * 100 / recentF) : 0;

    var ahead = 0;
    for (var i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) {
        ahead = v.buffered.end(i) - v.currentTime;
      }
    }
    var state = v.paused ? 'paused' : (v.readyState < 3 ? 'BUFFERING' : 'playing');
    var mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB' : 'n/a';
    var wv = '';
    try { wv = App && App.webViewVersion ? App.webViewVersion() : ''; } catch (e) {}
    var mins = Math.floor((now - diagStart) / 60000);
    var ql = pjs() ? '  (' + (api('quality') || '?') + ')' : '';

    el.textContent =
      (wv ? 'WebView     ' + wv + '\n' : '') +
      'Video       ' + v.videoWidth + 'x' + v.videoHeight + ql + '  ' + state + '\n' +
      'Dropped     ' + dropped + ' of ' + frames + ' frames\n' +
      'Last 10 s   ' + recentD + ' dropped (' + recentPct + '%)\n' +
      'Buffer      ' + Math.round(ahead) + ' s ahead,  stalls: ' + stalls + '\n' +
      'Memory      ' + mem + ',  elements: ' + document.getElementsByTagName('*').length + '\n' +
      'Open for    ' + mins + ' min   (red / Info button to close)';
  }

  // ============================================================ messages
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !d.__tv) return;
    var m = d.__tv;
    if (m.media) media(m.media, m.arg);
    else if (m.fskey) fsKey(m.fskey, m.repeat);
    else if (m.pkey) { if (!playerKey(m.pkey, m.repeat)) sendToFrames(m); }
    else if (m.pstart) { playerStart(); sendToFrames(m); }
    else if (m.pstop) { playerStop(); sendToFrames(m); }
    else if (m.diag !== undefined) setDiag(m.diag);
    else if (m.hello && TOP) onFrameHello(ev.source);
  });

  if (!TOP) {
    // Tell the page this frame is ready (the player may have to start in it).
    try { window.parent.postMessage({ __tv: { hello: 1 } }, '*'); } catch (e) {}
    return;
  }

  // ======================================================= top page only
  var VIEWPORT = __VIEWPORT_WIDTH__;

  function fixViewport() {
    if (!VIEWPORT || !document.head) return;
    var want = 'width=' + VIEWPORT;
    var m = document.querySelector('meta[name=viewport]');
    if (!m) {
      m = document.createElement('meta');
      m.name = 'viewport';
      document.head.appendChild(m);
    }
    if (m.getAttribute('content') !== want) m.setAttribute('content', want);
  }

  // ---- full-screen player (ge.movie): the player iframe covers the screen
  var playerMode = false, playerFrame = null, autoDone = null;

  function postToPlayer(msg) {
    try { playerFrame.contentWindow.postMessage({ __tv: msg }, '*'); } catch (e) {}
  }

  function enterPlayerMode(f) {
    if (playerMode || !f) return;
    playerMode = true;
    playerFrame = f;
    addStyle();
    clearFocus();
    document.documentElement.classList.add('__tvplay');
    f.classList.add('__tvplayer');
    postToPlayer({ pstart: 1 });
  }

  function exitPlayerMode() {
    if (!playerMode) return;
    postToPlayer({ pstop: 1 });
    playerMode = false;
    document.documentElement.classList.remove('__tvplay');
    if (playerFrame) playerFrame.classList.remove('__tvplayer');
    call('setFsControls', false);
    var f = playerFrame;
    setTimeout(function () { if (f && f.isConnected) focusEl(f); }, 150);
  }

  // The player frame (re)loaded: if it should be playing, tell it again.
  function onFrameHello(src) {
    if (playerMode && playerFrame && src === playerFrame.contentWindow) postToPlayer({ pstart: 1 });
  }

  // Movie and series pages open straight into the full-screen player.
  function checkAutoPlay() {
    if (!SITE || !SITE.autoPlay || !SITE.autoPlay.test(location.pathname)) return;
    if (autoDone === location.href) return;
    autoDone = location.href;
    var n = 0;
    (function look() {
      var f = document.querySelector(SITE.playerFrame);
      if (f && f.getBoundingClientRect().width > 0) { enterPlayerMode(f); return; }
      if (++n < 40) setTimeout(look, 250);
    })();
  }

  function setEditing(v) {
    editing = v;
    call('setEditing', v);
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    var t = (el.type || 'text').toLowerCase();
    return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].indexOf(t) >= 0;
  }
  document.addEventListener('focusin', function (e) { setEditing(isTextField(e.target)); }, true);
  document.addEventListener('focusout', function () {
    setTimeout(function () { setEditing(isTextField(document.activeElement)); }, 0);
  }, true);

  function back() {
    if (playerMode) { exitPlayerMode(); return true; }
    var ae = document.activeElement;
    if (editing && ae) { ae.blur(); setEditing(false); return true; }
    var sel = '[role=dialog],[aria-modal=true],dialog[open],.modal.show,.modal.in,.modal.open,' +
      '.modal.active,.popup.open,.popup.active,.overlay.active';
    var open = Array.prototype.filter.call(document.querySelectorAll(sel), function (d) {
      var r = d.getBoundingClientRect();
      var cs = getComputedStyle(d);
      return r.width > 50 && r.height > 50 && cs.visibility !== 'hidden' && cs.display !== 'none';
    });
    if (!open.length) return false;
    var dlg = open[open.length - 1];
    var close = dlg.querySelector('[class*=close],[aria-label*=lose],[data-dismiss],[data-bs-dismiss]');
    if (close) syntheticClick(close);
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    cache = null;
    return true;
  }

  var lastMove = 0;
  function key(cmd, fullscreen, repeat) {
    if (cmd === 'info') { if (!repeat) setDiag(!diagOn); return; }
    if (playerMode) { postToPlayer({ pkey: cmd, repeat: repeat }); return; }
    fixViewport();
    addStyle();
    if (fullscreen) {
      if (cmd === 'ok' && repeat) return;
      fsKey(cmd, repeat);
      return;
    }
    switch (cmd) {
      case 'play': case 'pause': case 'playpause': case 'stop': media(cmd); return;
      case 'ff': media('seek', 10); return;
      case 'rw': media('seek', -10); return;
      case 'pageup': case 'pagedown':
        window.scrollBy({ top: (cmd === 'pagedown' ? 1 : -1) * innerHeight * 0.8, behavior: 'smooth' });
        setTimeout(function () { lastRect = null; focusEl(pickStart(items()), false); }, 450);
        return;
      case 'ok':
        if (!repeat) activate();
        return;
      case 'back':
        return;
    }
    var now = Date.now();
    if (repeat && now - lastMove < 90) return;   // holding an arrow scrolls fast but smoothly
    lastMove = now;
    if (editing && (cmd === 'up' || cmd === 'down')) {
      if (document.activeElement) document.activeElement.blur();
      setEditing(false);
    }
    move(cmd);
  }

  function pageReady() {
    fixViewport();
    addStyle();
    cache = null;
    checkAutoPlay();
    if (!cur || !cur.isConnected) {
      setTimeout(function () {
        if (fsEl() || playerMode) return;
        if (!cur || !cur.isConnected) {
          var list = items();
          if (list.length) focusEl(pickStart(list), false);
        }
      }, 700);
    }
  }

  window.__tv = { key: key, back: back, pageReady: pageReady };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pageReady);
  else pageReady();
})();
