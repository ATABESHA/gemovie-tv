// GE Inspector — reads a ge.movie page the same way the MyMovie TV app does
// (same selectors as app/src/main/assets/tvui.html) and shows what it finds.
(function () {
  'use strict';
  var BASE = 'https://ge.movie';
  var CARD_SEL = '.movie-card, .filter-result-card, .popular-card, .serials-card';
  var FILTER_NAMES = { type: 'Category', genre: 'ჟანრი (genre)', year: 'წელი (year)', translation: 'გახმოვანება (dubbing)', country: 'ქვეყანა (country)', studio: 'სტუდია (studio)', imdb: 'IMDb', sort: 'სორტირება (sort)' };
  var USED_FILTERS = { genre: 'genres[]', translation: 'languages', country: 'countries', sort: 'sort' };

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function txt(root, sel) { var e = root.querySelector(sel); return e ? clean(e.textContent) : ''; }
  function tmdb(u, size) { return u ? u.replace('/t/p/original/', '/t/p/' + size + '/') : ''; }
  function abs(h, base) { try { return new URL(h, base || BASE).href; } catch (e) { return h || ''; } }
  function host(u) { try { return new URL(u, BASE).hostname; } catch (e) { return '?'; } }
  function isGe(u) { return /(^|\.)ge\.movie$/.test(host(u)); }
  function go(u, label) { return '<a class="go" data-u="' + esc(abs(u)) + '" title="Check this page">' + esc(label || u) + '</a>'; }
  function short(s, n) { s = clean(s); return s.length > n ? s.slice(0, n) + '…' : s; }

  // ------------------------------------------------------------ fetching
  var history = [], current = '';
  function fetchPage(url) {
    var t0 = performance.now();
    return fetch(url, { credentials: 'include', cache: 'no-store' }).then(function (r) {
      return r.text().then(function (h) {
        return { status: r.status, ok: r.ok, finalUrl: r.url || url, html: h, ms: Math.round(performance.now() - t0) };
      });
    });
  }

  function check(url, noHistory) {
    url = clean(url);
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = BASE + (url.charAt(0) === '/' ? '' : '/') + url;
    if (!isGe(url)) {
      $('#out').innerHTML = '<div class="note bad">Only ge.movie addresses can be checked — that is the site the TV app reads.</div>';
      return;
    }
    if (current && !noHistory && current !== url) history.push(current);
    current = url;
    $('#url').value = url;
    $('#go').disabled = true;
    $('#out').innerHTML = '<div class="note"><span class="spin"></span>Opening ' + esc(url) + ' …</div>';
    window.scrollTo(0, 0);
    fetchPage(url).then(function (p) {
      $('#go').disabled = false;
      render(url, p);
    }, function (e) {
      $('#go').disabled = false;
      var asFile = location.protocol === 'file:';
      $('#out').innerHTML = '<div class="note bad"><b>Could not open the page.</b> ' + esc(e.message) + '<br>' +
        (asFile ? 'This file was opened directly from the disk, and browsers block it from reading other websites. ' +
          'Install it as a browser extension (see the README steps) — then the Check button works.' :
          'Check that you are online and that ge.movie opens in a normal tab.') + '</div>' + pasteBox(url);
    });
  }

  // Fallback: the page source can be pasted in by hand (Ctrl+U on the site, Ctrl+A, Ctrl+C).
  function pasteBox(url) {
    return '<h3>Or paste the page source</h3><div class="dim">Open the address in a normal tab, press <b>Ctrl+U</b>, then <b>Ctrl+A</b>, <b>Ctrl+C</b>, and paste it here.</div>' +
      '<textarea id="src" placeholder="Paste the page source here"></textarea><div class="row"><button id="useSrc" class="main" data-for="' + esc(url) + '">Read pasted source</button></div>';
  }

  // ------------------------------------------------------------ the app's card reader
  function parseCard(c) {
    var a = c.querySelector('a[href*="/movie/"],a[href*="/serial/"]');
    if (!a) return null;
    var url = abs(a.getAttribute('href'));
    var img = c.querySelector('img[data-src]') || c.querySelector('img');
    var poster = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
    if (/thumb\.svg|poster\.svg/.test(poster)) poster = '';
    var tA = c.querySelector('h2 a[title]') || c.querySelector('a[title]') || a;
    var both = (tA.getAttribute('title') || '').split(' / ');
    var p = c.querySelector('h2 p'), sp = c.querySelector('h2 span');
    var eps = c.querySelector('.gm-card-episodes:not([hidden]) .gm-episode-text');
    return {
      url: url, serial: /\/serial\//.test(url), cls: c.className.split(' ')[0],
      t: p ? clean(p.textContent) : both[0], en: sp ? clean(sp.textContent) : (both[1] || ''),
      poster: tmdb(abs(poster), 'w342'), r: txt(c, '.imdb span'), y: txt(c, '.gm-year-value'),
      eps: eps && !/S00\s*\/\s*E00/.test(eps.textContent) ? clean(eps.textContent) : '',
      l: $$('.gm-language-text', c).map(function (e) { return clean(e.textContent).toUpperCase(); })
    };
  }
  function parseCards(root) {
    var seen = {}, out = [];
    $$(CARD_SEL, root).forEach(function (c) {
      var it = parseCard(c);
      if (it && !seen[it.url]) { seen[it.url] = 1; out.push(it); }
    });
    return out;
  }
  function cardsHtml(items, max) {
    if (!items.length) return '<div class="dim">No titles found.</div>';
    var list = max ? items.slice(0, max) : items;
    return '<div class="cards">' + list.map(function (c) {
      return '<div class="card" data-u="' + esc(c.url) + '" title="Check this title\'s page">' +
        (c.poster ? '<img loading="lazy" src="' + esc(c.poster) + '" alt="">' : '<img alt="">') +
        '<div class="b"><div class="t">' + esc(c.t) + '</div><div class="e">' + esc(c.en) + '</div>' +
        (c.r ? '<span class="pill y">IMDb ' + esc(c.r) + '</span>' : '') + (c.y ? '<span class="pill">' + esc(c.y) + '</span>' : '') +
        (c.eps ? '<span class="pill">' + esc(c.eps) + '</span>' : '') +
        c.l.map(function (x) { return '<span class="pill">' + esc(x) + '</span>'; }).join('') +
        '<div class="e mono" style="margin-top:4px">' + esc(c.cls) + '</div></div></div>';
    }).join('') + '</div>' + (max && items.length > max ? '<div class="dim" style="margin-top:6px">… and ' + (items.length - max) + ' more</div>' : '');
  }

  // ------------------------------------------------------------ "parts the app needs" checks
  function hasNewLink(d) {
    return $$('a[href*="#"]', d).filter(function (x) { var h = x.getAttribute('href') || ''; try { h = decodeURIComponent(h); } catch (e) {} return h.indexOf('#კინოთეატრებში') >= 0; });
  }
  var CHECKS = {
    home: [
      ['Link #კინოთეატრებში (new releases)', function (d) { return hasNewLink(d).length; }],
      ['#block_cinemas (fallback)', function (d) { return d.querySelectorAll('#block_cinemas').length; }, 1],
      ['.movie-card (home cards)', function (d) { return d.querySelectorAll('.movie-card').length; }]
    ],
    list: [
      ['.mlist (list container)', function (d) { return d.querySelectorAll('.mlist').length; }],
      ['Cards: ' + CARD_SEL, function (d) { return d.querySelectorAll(CARD_SEL).length; }],
      ['Card links to /movie/ or /serial/', function (d) { return d.querySelectorAll('.mlist a[href*="/movie/"], .mlist a[href*="/serial/"]').length; }],
      ['Posters img[data-src]', function (d) { return d.querySelectorAll('.mlist img[data-src]').length; }],
      ['Titles h2 p', function (d) { return d.querySelectorAll('.mlist h2 p').length; }],
      ['.pagination a (page numbers)', function (d) { return d.querySelectorAll('.pagination a').length; }, 1],
      ['.filter-dropdowns (filters)', function (d) { return d.querySelectorAll('.filter-dropdowns').length; }],
      ['  genre choices', function (d) { return d.querySelectorAll('.filter-dropdowns .filter-item.genre input').length; }],
      ['  dubbing choices', function (d) { return d.querySelectorAll('.filter-dropdowns .filter-item.translation input').length; }],
      ['  country choices', function (d) { return d.querySelectorAll('.filter-dropdowns .filter-item.country input').length; }],
      ['  sort choices', function (d) { return d.querySelectorAll('.filter-dropdowns .filter-item.sort input').length; }]
    ],
    details: [
      ['.scenere .desc (description)', function (d) { return d.querySelectorAll('.scenere .desc').length; }],
      ['.gm-watch-fact (genre, director, age…)', function (d) { return d.querySelectorAll('.gm-watch-fact').length; }],
      ['.fullimdb (IMDb rating)', function (d) { return d.querySelectorAll('.fullimdb').length; }, 1],
      ['meta og:image (backdrop)', function (d) { return d.querySelectorAll('meta[property="og:image"]').length; }],
      ['Player iframe #movie_embed / #serial_embed', function (d) { return d.querySelectorAll('iframe#movie_embed, iframe#serial_embed').length; }],
      ['  tmdb_id in the player address', function (d) { var f = d.querySelector('iframe#movie_embed, iframe#serial_embed'); return f && /tmdb_id=\d+/.test(f.getAttribute('src') || '') ? 1 : 0; }],
      ['YouTube link (trailer)', function (d) { return /youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\//.test(d.documentElement.innerHTML) ? 1 : 0; }, 1]
    ]
  };
  function checksHtml(kind, doc) {
    if (!CHECKS[kind]) return '';
    var rows = CHECKS[kind].map(function (c) { var n = 0; try { n = c[1](doc); } catch (e) {} return { name: c[0], n: n, opt: c[2] }; });
    var bad = rows.filter(function (r) { return !r.n && !r.opt; }).length;
    return '<h2>Parts the app needs on this page ' + (bad ? '<span class="bad">— ' + bad + ' missing</span>' : '<span class="ok">— all found</span>') + '</h2>' +
      '<table><tr><th style="width:30px"></th><th>Part</th><th>Found</th></tr>' + rows.map(function (r) {
        var cls = r.n ? 'ok' : r.opt ? 'warn' : 'bad';
        return '<tr><td class="' + cls + '">' + (r.n ? '✓' : r.opt ? '–' : '✗') + '</td><td class="mono">' + esc(r.name) + (r.opt ? ' <span class="dim">(optional)</span>' : '') + '</td><td>' + r.n + '</td></tr>';
      }).join('') + '</table>';
  }

  // ------------------------------------------------------------ page kinds
  function kindOf(url, doc) {
    var p = new URL(url).pathname;
    if (p === '/' || p === '') return 'home';
    if (/^\/filter-movies/.test(p)) return 'list';
    if (/^\/(movie|serial)\//.test(p) || doc.querySelector('iframe#movie_embed, iframe#serial_embed')) return 'details';
    return 'other';
  }
  var KIND_NAME = { home: 'Home page', list: 'List / search page', details: 'Movie or series page', other: 'Other page (the app does not open this kind)' };

  function homeHtml(doc) {
    var h = '';
    var menu = $$('aside a, .sidebar a, nav a', doc).filter(function (a) { return clean(a.textContent) && isGe(abs(a.getAttribute('href'))); });
    var seen = {};
    menu = menu.filter(function (a) { var k = abs(a.getAttribute('href')); if (seen[k]) return false; seen[k] = 1; return true; }).slice(0, 25);
    if (menu.length) h += '<h3>Site menu (not used — the app has its own top bar)</h3><div class="tags">' +
      menu.map(function (a) { return '<a class="go" data-u="' + esc(abs(a.getAttribute('href'))) + '">' + esc(clean(a.textContent)) + '</a>'; }).join('') + '</div>';

    // every block / row on the page
    var newA = hasNewLink(doc)[0];
    var usedSec = newA ? (newA.closest('section') || newA.parentElement.parentElement) : doc.getElementById('block_cinemas');
    var blocks = $$('[id^="block_"], [id^="gm-home-"], section, .movies', doc).filter(function (el) { return !el.classList.contains('site-shell'); });
    var bl = [], seenEl = [];
    blocks.forEach(function (el) {
      if (seenEl.indexOf(el) >= 0) return; seenEl.push(el);
      var cards = parseCards(el);
      var title = txt(el, '.section-title') || txt(el, 'h2') || txt(el, 'h3') || '(no title)';
      var used = usedSec && (el === usedSec || el.contains(usedSec) && cards.length === parseCards(usedSec).length);
      bl.push({ el: el, title: short(title, 60), id: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''), cards: cards, used: !!used });
    });
    h += '<h3>All blocks (rows) on the page</h3><table><tr><th>Block title</th><th>Element</th><th>Titles</th><th>Used by app</th></tr>' +
      bl.map(function (b, i) {
        return '<tr class="' + (b.used ? 'used' : '') + '"><td>' + (b.used ? '<b>' + esc(b.title) + '</b>' : esc(b.title)) + '</td><td class="mono">' + esc(b.id) + '</td><td>' + b.cards.length +
          '</td><td>' + (b.used ? '<span class="ok">✓ "New releases" row</span>' : '<span class="dim">—</span>') + '</td></tr>';
      }).join('') + '</table>';

    var items = usedSec ? parseCards(usedSec) : [];
    h += '<h3>What the app shows: "New releases" row — ' + items.length + ' titles</h3>' +
      '<div class="dim" style="margin-bottom:8px">Found via ' + (newA ? 'the link <span class="mono">#კინოთეატრებში</span>' : usedSec ? 'fallback <span class="mono">#block_cinemas</span>' : '<span class="bad">nothing — the row would be empty</span>') + '.</div>' + cardsHtml(items);

    bl.forEach(function (b) {
      if (b.used || !b.cards.length) return;
      h += '<details><summary>Not used: ' + esc(b.title) + ' (' + b.cards.length + ' titles)</summary>' + cardsHtml(b.cards, 12) + '</details>';
    });
    return h;
  }

  function filtersHtml(doc, url) {
    var items = $$('.filter-dropdowns .filter-item', doc);
    if (!items.length) return '<h3>Filters</h3><div class="bad">No filters found (.filter-dropdowns).</div>';
    var cur = new URL(url).searchParams;
    return '<h3>Filters on the page</h3><table><tr><th>Filter</th><th>Sent as</th><th>Choices</th><th>Examples</th><th>Used by app</th></tr>' + items.map(function (fi) {
      var kind = String(fi.className).replace('filter-item', '').trim().split(' ')[0] || '?';
      var inputs = $$('input', fi).filter(function (i) { return i.type !== 'hidden' || i.name; });
      var names = {};
      inputs.forEach(function (i) { if (i.name) names[i.name] = 1; });
      var opts = inputs.filter(function (i) { return /radio|checkbox/.test(i.type) && i.value !== ''; }).map(function (i) {
        return clean((i.closest('label') || {}).textContent || i.value);
      });
      var range = inputs.filter(function (i) { return i.type === 'range' || i.type === 'number'; });
      var label = FILTER_NAMES[kind] || txt(fi, '.filter-title') || kind;
      var used = USED_FILTERS[kind];
      var nm = Object.keys(names).join(', ') || '—';
      var choice = opts.length ? opts.length : range.length ? 'slider ' + (range[0].min || '') + '–' + (range[range.length - 1].max || '') : '—';
      var active = Object.keys(names).filter(function (n) { return cur.get(n); }).map(function (n) { return n + '=' + cur.getAll(n).join(','); });
      return '<tr class="' + (used ? 'used' : '') + '"><td>' + esc(short(label, 30)) + ' <span class="dim mono">.' + esc(kind) + '</span>' + (active.length ? '<br><span class="warn">active: ' + esc(active.join(' ')) + '</span>' : '') +
        '</td><td class="mono">' + esc(nm) + '</td><td>' + esc(choice) + '</td><td>' + esc(short(opts.slice(0, 10).join(', '), 140)) +
        '</td><td>' + (used ? '<span class="ok">✓</span>' : '<span class="dim">—</span>') + '</td></tr>';
    }).join('') + '</table>';
  }

  function listHtml(doc, url) {
    var u = new URL(url), page = parseInt(u.searchParams.get('page'), 10) || 1;
    var nums = $$('.pagination a', doc).map(function (a) { return parseInt(a.textContent, 10) || 0; });
    var pages = Math.max.apply(null, [page].concat(nums));
    var items = parseCards(doc.querySelector('.mlist') || doc);
    function pageUrl(n) { var x = new URL(url); if (n > 1) x.searchParams.set('page', n); else x.searchParams.delete('page'); return x.href; }
    var h = '<div class="facts"><span>Type <b>' + esc(u.searchParams.get('type') || '—') + '</b></span>' +
      (u.searchParams.get('search') ? '<span>Search <b>' + esc(u.searchParams.get('search')) + '</b></span>' : '') +
      '<span>Page <b>' + page + '</b> of <b>' + pages + '</b></span><span>Titles on this page <b>' + items.length + '</b></span>' +
      '<span>About <b>' + (pages * (items.length || 20)).toLocaleString() + '</b> titles in total</span></div>';
    h += '<div class="tags" style="margin:8px 0">' + (page > 1 ? '<a class="go" data-u="' + esc(pageUrl(page - 1)) + '">← page ' + (page - 1) + '</a>' : '') +
      (page < pages ? '<a class="go" data-u="' + esc(pageUrl(page + 1)) + '">page ' + (page + 1) + ' →</a>' : '') +
      (pages > 1 ? '<a class="go" data-u="' + esc(pageUrl(pages)) + '">last page (' + pages + ')</a>' : '') + '</div>';
    h += filtersHtml(doc, url);
    h += '<h3>Titles the app shows from this page</h3>' + cardsHtml(items);
    return h;
  }

  function detailsHtml(doc, url) {
    var sc = doc.querySelector('.scenere');
    var parts = sc ? $$('.desc', sc).filter(function (d) { return !d.classList.contains('mb-2'); }) : [];
    var plot = parts.map(function (d) { return clean(d.textContent); }).join(' ');
    var plotFrom = plot ? '.scenere .desc' : '';
    if (!plot) { var m = doc.querySelector('meta[name=description]'); plot = m ? m.content : ''; if (plot) plotFrom = 'meta description (fallback)'; }
    var facts = $$('.gm-watch-fact', doc).map(function (f) { return clean(f.textContent).replace(/\s*:\s*/, ': '); }).filter(Boolean);
    var age = facts.filter(function (f) { return /ასაკობრივი/.test(f); })[0] || '';
    var fr = doc.querySelector('iframe#movie_embed, iframe#serial_embed, iframe[src*="embed"], iframe[src*="player"]');
    var src = fr ? (fr.getAttribute('src') || fr.getAttribute('data-src') || '') : '';
    var tm = /[?&]tmdb_id=(\d+)/.exec(src);
    var og = doc.querySelector('meta[property="og:image"]');
    var ym = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|v\/)|youtu\.be\/)([\w-]{11})/.exec(doc.documentElement.innerHTML);
    var serial = /\/serial\//.test(url) || /type=serial/.test(src);
    var others = $$('section, [class*="block"], .related, .recommend', doc).map(function (s) {
      return { t: txt(s, '.section-title') || txt(s, 'h2') || txt(s, 'h3'), c: parseCards(s) };
    }).filter(function (s) { return s.c.length && s.t; });
    var seenT = {}; others = others.filter(function (s) { if (seenT[s.t]) return false; seenT[s.t] = 1; return true; });
    var actors = $$('a[href*="/person"]', doc).map(function (a) { return clean(a.textContent) || a.getAttribute('title') || ''; }).filter(Boolean);
    actors = actors.filter(function (a, i) { return actors.indexOf(a) === i; });

    var h = '<div class="kv">' +
      '<div>Kind</div><div>' + (serial ? 'Series' : 'Movie') + '</div>' +
      '<div>Title (h1)</div><div>' + esc(txt(doc, 'h1') || '—') + '</div>' +
      '<div>IMDb (.fullimdb)</div><div>' + esc(txt(doc, '.fullimdb') || '—') + '</div>' +
      '<div>Description</div><div>' + (plot ? '<span class="ok">✓</span> <span class="dim">from ' + esc(plotFrom) + '</span><br>' + esc(short(plot, 600)) : '<span class="bad">not found</span>') + '</div>' +
      '<div>Facts (.gm-watch-fact, ' + facts.length + ')</div><div>' + (facts.length ? facts.map(esc).join('<br>') : '<span class="bad">none</span>') + '</div>' +
      '<div>Age rating (for kids profiles)</div><div>' + (age ? '<b>' + esc(age) + '</b>' : '<span class="warn">not on the page — kids profiles treat it as unknown</span>') + '</div>' +
      '<div>Backdrop (og:image)</div><div>' + (og ? '<img class="backdrop" src="' + esc(tmdb(abs(og.content), 'w780')) + '" alt=""><div class="mono dim">' + esc(og.content) + '</div>' : '<span class="bad">none</span>') + '</div>' +
      '<div>Player (iframe)</div><div>' + (fr ? '<span class="mono">#' + esc(fr.id || '(no id)') + '</span><br><span class="mono">' + esc(src) + '</span><br>Player site: <b>' + esc(host(src)) + '</b>' : '<span class="bad">no player found — this title cannot play</span>') + '</div>' +
      '<div>TMDB id (RU/EN texts)</div><div>' + (tm ? tm[1] : '<span class="warn">none — titles stay in Georgian</span>') + '</div>' +
      '<div>Trailer on the page</div><div>' + (ym ? '<span class="mono">youtube ' + esc(ym[1]) + '</span>' : '<span class="dim">none — the app searches YouTube instead</span>') + '</div>' +
      (actors.length ? '<div>Actors <span class="dim">(not used)</span></div><div>' + esc(short(actors.join(', '), 300)) + '</div>' : '') +
      '</div>';
    others.forEach(function (s) {
      h += '<details><summary>Not used: ' + esc(short(s.t, 60)) + ' (' + s.c.length + ' titles)</summary>' + cardsHtml(s.c, 12) + '</details>';
    });
    return h;
  }

  // ------------------------------------------------------------ general page facts
  function generalHtml(doc, url) {
    var links = $$('a[href]', doc).map(function (a) { return { u: abs(a.getAttribute('href'), url), t: clean(a.textContent) || a.getAttribute('title') || '' }; })
      .filter(function (l) { return /^https?:/.test(l.u); });
    var internal = links.filter(function (l) { return isGe(l.u); });
    var ext = {}; links.forEach(function (l) { if (!isGe(l.u)) { var hh = host(l.u); ext[hh] = (ext[hh] || 0) + 1; } });
    var scripts = {}; $$('script[src]', doc).forEach(function (s) { var hh = host(abs(s.getAttribute('src'), url)); scripts[hh] = (scripts[hh] || 0) + 1; });
    var inline = $$('script:not([src])', doc).length;
    var imgs = $$('img', doc).map(function (i) { return abs(i.getAttribute('data-src') || i.getAttribute('src') || '', url); }).filter(function (s) { return /^https?:/.test(s) && !/\.svg($|\?)/.test(s); });
    var imgHosts = {}; imgs.forEach(function (s) { var hh = host(s); imgHosts[hh] = (imgHosts[hh] || 0) + 1; });
    var frames = $$('iframe', doc).map(function (f) { return f.getAttribute('src') || f.getAttribute('data-src') || '(empty)'; });
    var heads = $$('h1, h2, h3', doc).map(function (e) { return e.tagName + ' ' + clean(e.textContent); }).filter(function (s) { return s.length > 3; });
    function countList(o) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).map(function (k) { return '<span>' + esc(k) + ' <b>' + o[k] + '</b></span>'; }).join('') || '<span class="dim">none</span>'; }
    var seen = {}, uniq = internal.filter(function (l) { if (seen[l.u]) return false; seen[l.u] = 1; return true; });

    return '<h2>Everything else on the page</h2>' +
      '<h3>Links</h3><div class="facts"><span>All <b>' + links.length + '</b></span><span>To ge.movie <b>' + internal.length + '</b> (' + uniq.length + ' different)</span></div>' +
      '<div class="dim">Other sites linked:</div><div class="tags">' + countList(ext) + '</div>' +
      '<details><summary>Show all ' + uniq.length + ' ge.movie links (click one to check it)</summary><table><tr><th>Text</th><th>Address</th></tr>' +
      uniq.map(function (l) { return '<tr><td>' + esc(short(l.t, 60)) + '</td><td class="mono">' + go(l.u, l.u.replace(BASE, '')) + '</td></tr>'; }).join('') + '</table></details>' +
      '<h3>Pictures</h3><div class="facts"><span>All <b>' + imgs.length + '</b></span></div><div class="dim">Picture servers:</div><div class="tags">' + countList(imgHosts) + '</div>' +
      '<details><summary>Show pictures</summary><div class="cards">' + imgs.slice(0, 80).map(function (s) { return '<div class="card"><img loading="lazy" src="' + esc(s) + '" alt=""><div class="b e mono">' + esc(host(s)) + '</div></div>'; }).join('') + '</div></details>' +
      '<h3>Scripts</h3><div class="tags">' + countList(scripts) + '<span>inline <b>' + inline + '</b></span></div>' +
      '<div class="dim" style="margin-top:4px">The app does not run any of these — it only reads the page text.</div>' +
      '<h3>Frames (iframe)</h3>' + (frames.length ? frames.map(function (f) { return '<div class="mono">' + esc(f) + '</div>'; }).join('') : '<div class="dim">none</div>') +
      '<h3>Headings</h3><details><summary>' + heads.length + ' headings</summary>' + heads.slice(0, 80).map(function (s) { return '<div>' + esc(short(s, 120)) + '</div>'; }).join('') + '</details>';
  }

  // ------------------------------------------------------------ render
  function render(url, p) {
    var doc = new DOMParser().parseFromString(p.html, 'text/html');
    var kind = kindOf(p.finalUrl || url, doc);
    var title = clean((doc.querySelector('title') || {}).textContent || '');
    var desc = doc.querySelector('meta[name=description]');
    var h = '<h2 style="border:0;padding-top:6px">' + esc(KIND_NAME[kind]) + '</h2>' +
      '<div class="mono"><a class="go" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a> <span class="dim">(opens the real page)</span></div>' +
      (p.finalUrl && p.finalUrl !== url && p.finalUrl.indexOf('chrome-extension') < 0 ? '<div class="warn">Redirected to ' + esc(p.finalUrl) + '</div>' : '') +
      '<div class="facts"><span>Status <b class="' + (p.ok ? 'ok' : 'bad') + '">' + p.status + '</b></span><span>Size <b>' + Math.round(p.html.length / 1024) + ' KB</b></span>' +
      (p.ms != null ? '<span>Loaded in <b>' + p.ms + ' ms</b></span>' : '') + '<span>Checked <b>' + new Date().toLocaleTimeString() + '</b></span></div>' +
      '<div class="kv"><div>Page title</div><div>' + esc(title || '—') + '</div><div>Description (meta)</div><div>' + esc(short(desc ? desc.content : '—', 300)) + '</div></div>';
    if (!p.ok) h += '<div class="note bad">The site answered with an error (' + p.status + '). The TV app would show nothing for this page.</div>';
    if (/<title>\s*Just a moment|id="challenge-form"|cf-chl-widget/i.test(p.html)) h += '<div class="note bad">The site showed a "checking your browser" page instead of content. The TV app would see nothing here.</div>';

    h += checksHtml(kind, doc);
    h += '<h2>What the app reads here</h2>';
    if (kind === 'home') h += homeHtml(doc);
    else if (kind === 'list') h += listHtml(doc, url);
    else if (kind === 'details') h += detailsHtml(doc, url);
    else {
      var cards = parseCards(doc);
      h += '<div class="dim">The TV app never opens this kind of page. Titles found on it anyway:</div>' + cardsHtml(cards, 40);
    }
    h += generalHtml(doc, url);
    $('#out').innerHTML = h;
  }

  // ------------------------------------------------------------ events
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-u]');
    if (t && !(t.tagName === 'A' && t.target === '_blank')) { e.preventDefault(); check(t.getAttribute('data-u')); return; }
    if (e.target.id === 'useSrc') {
      var u = e.target.getAttribute('data-for'), src = $('#src').value;
      if (src.trim()) render(u, { status: 'pasted', ok: true, finalUrl: u, html: src, ms: null });
    }
  });
  $('#go').addEventListener('click', function () { check($('#url').value); });
  $('#url').addEventListener('keydown', function (e) { if (e.key === 'Enter') check($('#url').value); });
  $('#url').addEventListener('focus', function () { this.select(); });
  $('#back').addEventListener('click', function () { if (history.length) check(history.pop(), true); });
  $('#url').focus();
})();
