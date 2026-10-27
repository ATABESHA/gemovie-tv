/*
 * TV remote navigation for a web page inside the app's WebView.
 * Runs in every frame (video players usually live in iframes):
 *  - video control (play/pause/seek) routed to whichever frame has the video
 *  - arrow-key highlight + OK = real tap, in the page and, in full screen,
 *    over the player's own controls (quality, audio, settings …)
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

  var osdTimer = null;
  function osd(text) {
    var host = fsEl();
    if (!host || host.tagName === 'VIDEO') host = document.body;
    if (!host) return;
    var el = document.getElementById('__tvosd');
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

  function fsEl() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  // ========================================== navigation engine (any frame)
  var NATIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,' +
    '[onclick],[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemradio],' +
    '[role=menuitemcheckbox],[role=option],[role=radio],[role=switch],[role=slider],' +
    '[tabindex]:not([tabindex="-1"]),video,iframe';
  var LINKISH = 'a[href],button,[role=button],[role=link]';

  var cache = null;      // gathered candidates, rebuilt when the DOM changes
  var cacheRoot = null;
  var cur = null;        // highlighted element
  var lastRect = null;   // where the highlight was, to recover if the element disappears
  var editing = false;
  var fsMode = false;    // navigating the player's controls in full screen

  function addStyle() {
    if (!document.head || document.getElementById('__tvstyle')) return;
    var st = document.createElement('style');
    st.id = '__tvstyle';
    st.textContent =
      '*{-webkit-tap-highlight-color:transparent!important}' +
      '.__tvf{outline:4px solid #e50914!important;outline-offset:3px!important;' +
      'box-shadow:0 0 0 8px rgba(229,9,20,.35),0 10px 30px rgba(0,0,0,.6)!important;' +
      'transition:transform .15s ease!important}' +
      '.__tvs{transform:scale(1.07)!important}';
    document.head.appendChild(st);
  }

  function scopeRoot() {
    return (fsMode && fsEl()) || document.body;
  }

  function gather() {
    var root = scopeRoot();
    if (cache && cacheRoot === root) return cache;
    cacheRoot = root;
    var found = [], set = new Set();
    function add(el) {
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

  function isShown(el, r) {
    if (!el.isConnected || r.width < 6 || r.height < 6) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) return false;
    if (r.right <= 0 || r.bottom <= -innerHeight * 50) return false;
    var vw = innerWidth, vh = innerHeight;
    var inView = r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
    if (!inView) return !fsMode;
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
      // Stay in the same row when possible (like a TV app).
      return primary + align * 0.3 + (gap > 0 ? 100000 + gap * 4 : 0);
    }
    if (dir === 'down' ? !(bcy > acy + 1 && b.top > a.top) : !(bcy < acy - 1 && b.bottom < a.bottom)) return null;
    primary = dir === 'down' ? Math.max(0, b.top - a.bottom) : Math.max(0, a.top - b.bottom);
    gap = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
    align = Math.abs(bcx - acx);
    return primary + gap * 2 + align * 0.5;
  }

  function pickStart(list) {
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

  function focusEl(el, scroll) {
    if (cur) cur.classList.remove('__tvf', '__tvs');
    cur = el;
    if (!el) return;
    el.classList.add('__tvf');
    var r = el.getBoundingClientRect();
    var tag = el.tagName;
    var small = r.width * r.height < innerWidth * innerHeight * 0.2;
    if (small && tag !== 'INPUT' && tag !== 'IFRAME' && tag !== 'VIDEO' &&
        getComputedStyle(el).transform === 'none') {
      el.classList.add('__tvs');
    }
    if (!fsMode && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      try { el.focus({ preventScroll: true }); } catch (e) {}
    }
    if (scroll !== false && !fsMode) {
      var needV = r.top < 90 || r.bottom > innerHeight - 60;
      var needH = r.left < 30 || r.right > innerWidth - 30;
      if (needV || needH) {
        try {
          el.scrollIntoView({ block: needV ? 'center' : 'nearest',
            inline: needH ? 'center' : 'nearest', behavior: 'smooth' });
        } catch (e) { el.scrollIntoView(); }
      }
    }
    lastRect = el.getBoundingClientRect();
  }

  function clearFocus() {
    if (cur) cur.classList.remove('__tvf', '__tvs');
    cur = null;
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
    var a = cur.getBoundingClientRect(), best = null, bs = Infinity;
    list.forEach(function (o) {
      if (o.el === cur) return;
      var s = score(a, o.r, dir);
      if (s !== null && s < bs) { bs = s; best = o.el; }
    });
    if (best) { focusEl(best); return; }
    // Nothing further: scroll so lazy-loaded rows can appear, then try once more.
    if (!fsMode && (dir === 'down' || dir === 'up') && !retried) {
      window.scrollBy({ top: (dir === 'down' ? 1 : -1) * innerHeight * 0.5, behavior: 'smooth' });
      setTimeout(function () { cache = null; move(dir, true); }, 500);
    }
  }

  function activate() {
    if (!cur || !cur.isConnected) { move('down'); return; }
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

  new MutationObserver(function () {
    cache = null;
    if (cur && !cur.isConnected) cur = null;
    if (TOP) { fixViewport(); addStyle(); }
  }).observe(document, { childList: true, subtree: true }); // works before <html> exists

  // ===================================== full screen: player controls mode
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
  function fsKey(cmd) {
    var f = fsEl();
    if (f && f.tagName === 'IFRAME') {
      try { f.contentWindow.postMessage({ __tv: { fskey: cmd } }, '*'); } catch (e) {}
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

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !d.__tv) return;
    if (d.__tv.media) media(d.__tv.media, d.__tv.arg);
    else if (d.__tv.fskey) fsKey(d.__tv.fskey);
  });

  if (!TOP) return;

  // ================================================ top page only
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
    if (fullscreen) {
      if (cmd === 'ok' && repeat) return;
      fsKey(cmd);
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
    if (!cur || !cur.isConnected) {
      setTimeout(function () {
        if (fsEl()) return;
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
