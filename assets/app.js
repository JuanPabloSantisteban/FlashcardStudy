/* Flashcards: a small static app. Cards live in /cards as text files (see CARD_GUIDE.md). */
(function () {
  'use strict';

  var MARKS_KEY = 'flashcards.marks.v1';
  var PREFS_KEY = 'flashcards.prefs.v1';
  var app = document.getElementById('app');

  var state = {
    config: null,     // cards/index.json
    cards: [],        // all parsed cards
    byId: {},
    warnings: [],
    marks: loadJSON(MARKS_KEY, {}),   // { cardId: { s: 'g' | 'r', t: epochMs } }
    prefs: loadJSON(PREFS_KEY, {}),   // per-category filter choices
    session: null
  };

  // ---------- storage ----------
  function loadJSON(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ }
  }
  function statusOf(id) { var m = state.marks[id]; return m && (m.s === 'g' || m.s === 'r') ? m.s : 'u'; }
  // A cleared mark is kept as { s: 'u', t } so that clearing also syncs to other devices.
  function setMark(id, s) {
    state.marks[id] = { s: s, t: Date.now() };
    saveJSON(MARKS_KEY, state.marks);
    Sync.schedule();
  }
  // Merge marks: for each card, the most recent change wins. Returns how many local entries changed.
  function mergeMarks(incoming) {
    var n = 0;
    Object.keys(incoming || {}).forEach(function (id) {
      var m = incoming[id];
      if (!m || ['g', 'r', 'u'].indexOf(m.s) === -1) return;
      var cur = state.marks[id], t = +m.t || 0;
      if (!cur || t > (+cur.t || 0)) { state.marks[id] = { s: m.s, t: t }; n++; }
    });
    if (n) saveJSON(MARKS_KEY, state.marks);
    return n;
  }
  function sameMarks(a, b) {
    var ka = Object.keys(a || {}), kb = Object.keys(b || {});
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return b[k] && b[k].s === a[k].s && +b[k].t === +a[k].t; });
  }

  // ---------- sync via a private GitHub Gist ----------
  var SYNC_KEY = 'flashcards.sync.v1';
  var GIST_FILE = 'flashcard-marks.json';
  var Sync = {
    cfg: loadJSON(SYNC_KEY, {}),   // { token, gistId, last }
    status: 'off',                 // off | syncing | ok | error
    error: '',
    timer: null,
    running: null,
    enabled: function () { return !!(this.cfg.token && this.cfg.gistId); },
    api: function (path, opts) {
      opts = opts || {};
      return fetch('https://api.github.com' + path, {
        method: opts.method || 'GET',
        cache: 'no-store',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Bearer ' + this.cfg.token,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        if (r.status === 401) throw new Error('The token was rejected. It may have expired or been revoked.');
        if (r.status === 404) throw new Error('Gist not found, or the token lacks the "gist" permission.');
        if (!r.ok) throw new Error('GitHub answered ' + r.status + '.');
        return r.json();
      });
    },
    payload: function () {
      return { files: (function () { var f = {}; f[GIST_FILE] = { content: JSON.stringify({ app: 'flashcards', version: 1, marks: state.marks }) }; return f; })() };
    },
    // Find an existing marks gist for this account, or create a private one.
    connect: function (token) {
      var self = this;
      self.cfg = { token: token.trim() };
      return self.api('/gists?per_page=100').then(function (list) {
        var found = list.filter(function (g) { return g.files && g.files[GIST_FILE]; })[0];
        if (found) return found;
        var body = self.payload(); body.description = 'Flashcards: red/green marks (used by the flashcard app)'; body.public = false;
        return self.api('/gists', { method: 'POST', body: body });
      }).then(function (g) {
        self.cfg.gistId = g.id; saveJSON(SYNC_KEY, self.cfg);
        return self.now();
      }).catch(function (e) { self.cfg = {}; self.setStatus('off'); throw e; });
    },
    disconnect: function () { this.cfg = {}; try { localStorage.removeItem(SYNC_KEY); } catch (e) {} this.setStatus('off'); },
    schedule: function () {
      if (!this.enabled()) return;
      var self = this; clearTimeout(self.timer);
      self.timer = setTimeout(function () { self.now(); }, 1500);
    },
    // Pull, merge, and push back if this device has anything newer.
    now: function () {
      var self = this;
      if (!self.enabled()) return Promise.resolve();
      if (self.running) { self.again = true; return self.running; }
      clearTimeout(self.timer);
      self.setStatus('syncing');
      self.running = self.api('/gists/' + self.cfg.gistId).then(function (g) {
        var file = g.files && g.files[GIST_FILE], remote = {};
        var get = file && file.truncated ? fetch(file.raw_url, { cache: 'no-store' }).then(function (r) { return r.text(); }) : Promise.resolve(file ? file.content : '');
        return get.then(function (txt) {
          try { remote = (JSON.parse(txt || '{}').marks) || {}; } catch (e) { remote = {}; }
          var changed = mergeMarks(remote);
          var needPush = !sameMarks(state.marks, remote);
          return (needPush ? self.api('/gists/' + self.cfg.gistId, { method: 'PATCH', body: self.payload() }) : Promise.resolve())
            .then(function () { return changed; });
        });
      }).then(function (changed) {
        self.cfg.last = Date.now(); saveJSON(SYNC_KEY, self.cfg);
        self.setStatus('ok');
        if (changed) rerenderIfIdle();
      }).catch(function (e) {
        self.error = e.message || String(e);
        self.setStatus(navigator.onLine === false ? 'offline' : 'error');
      }).then(function () {
        self.running = null;
        if (self.again) { self.again = false; self.schedule(); }
      });
      return self.running;
    },
    setStatus: function (s) {
      this.status = s;
      var el = document.getElementById('sync-status');
      if (!el) return;
      var label = { off: '', syncing: 'Syncing…', ok: 'Synced', error: 'Sync error', offline: 'Offline' }[s] || '';
      el.textContent = label; el.className = 'sync-status ' + s; el.hidden = !label;
      el.title = s === 'error' ? this.error : '';
    }
  };
  // Re-draw the current screen after remote marks arrive, but never in the middle of a card.
  function rerenderIfIdle() {
    var h = location.hash || '#/';
    if (h === '#/review') return;
    if (h === '#/progress') return viewProgress();
    route(true);
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function slug(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function uniq(a) { var seen = {}; return a.filter(function (x) { if (!x || seen[x]) return false; seen[x] = 1; return true; }); }
  function countStatus(cards) {
    var c = { g: 0, r: 0, u: 0, total: cards.length };
    cards.forEach(function (card) { c[statusOf(card.id)]++; });
    return c;
  }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2200);
  }

  // ---------- rich text: Markdown + LaTeX ----------
  // Math is pulled out before Markdown runs (so _ and * inside formulas are safe), then rendered with KaTeX.
  var MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g;
  function renderRich(src) {
    var math = [];
    var text = String(src || '').replace(/\\\$/g, '\u0000DOLLAR\u0000');
    text = text.replace(MATH_RE, function (_, d1, d2, i1, i2) {
      var display = d1 != null || d2 != null;
      var tex = (d1 != null ? d1 : d2 != null ? d2 : i1 != null ? i1 : i2).replace(/\u0000DOLLAR\u0000/g, '\\$');
      math.push({ tex: tex, display: display });
      return (display ? '\n\nMATHBLOCK' : 'MATHINLINE') + (math.length - 1) + 'X' + (display ? '\n\n' : '');
    });
    text = text.replace(/\u0000DOLLAR\u0000/g, '&#36;');
    var html = window.marked ? window.marked.parse(text, { breaks: true, gfm: true }) : '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
    html = html.replace(/<p>\s*MATHBLOCK(\d+)X\s*<\/p>/g, function (_, i) { return renderMath(math[+i]); });
    html = html.replace(/MATH(?:BLOCK|INLINE)(\d+)X/g, function (_, i) { return renderMath(math[+i]); });
    return html;
  }
  function renderMath(m) {
    if (!m) return '';
    if (!window.katex) return '<code>' + esc(m.tex) + '</code>';
    try {
      return window.katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false, strict: 'ignore', trust: false });
    } catch (e) {
      return '<span class="math-error" title="' + esc(e.message) + '">' + esc(m.tex) + '</span>';
    }
  }

  // ---------- deck parsing ----------
  // A deck file: optional front matter between --- lines, then cards separated by a line of ===.
  // Each card: optional "id:", "topic:", "course:" lines, then "front:" (text), then "back:" (text to end of card).
  function parseKV(block) {
    var out = {};
    block.split('\n').forEach(function (line) {
      var m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/);
      if (m) out[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '');
    });
    return out;
  }
  function parseDeck(text, path) {
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var meta = {}, body = text;
    var fm = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/);
    if (fm) { meta = parseKV(fm[1]); body = text.slice(fm[0].length); }

    var category = meta.category;
    if (!category) state.warnings.push(path + ': missing "category:" in the header.');

    var blocks = [], cur = [];
    body.split('\n').forEach(function (line) {
      if (/^={3,}\s*$/.test(line)) { blocks.push(cur); cur = []; } else cur.push(line);
    });
    blocks.push(cur);

    var cards = [];
    blocks.forEach(function (lines, bi) {
      var fields = {}, mode = null, front = [], back = [];
      lines.forEach(function (line) {
        var m;
        if (mode === 'back') { back.push(line); return; }
        if ((m = line.match(/^back:\s?(.*)$/i))) { mode = 'back'; if (m[1]) back.push(m[1]); return; }
        if (mode === 'front') { front.push(line); return; }
        if ((m = line.match(/^front:\s?(.*)$/i))) { mode = 'front'; if (m[1]) front.push(m[1]); return; }
        if ((m = line.match(/^(id|topic|course)\s*:\s*(.*?)\s*$/i))) { fields[m[1].toLowerCase()] = m[2]; return; }
        if (line.trim() && !/^\s*(<!--.*-->|\/\/)/.test(line)) {
          state.warnings.push(path + ', card ' + (bi + 1) + ': ignored line before "front:" → ' + line.trim().slice(0, 60));
        }
      });
      var f = front.join('\n').trim(), b = back.join('\n').trim();
      if (!f && !b && !fields.id) return; // empty block
      if (!f || !b) { state.warnings.push(path + ', card ' + (bi + 1) + ': needs both "front:" and "back:".'); return; }
      cards.push({
        id: fields.id ? fields.id.trim() : 'h-' + hash(path + '|' + f),
        category: category,
        course: fields.course || meta.course || '',
        topic: fields.topic || meta.topic || '',
        front: f,
        back: b,
        deck: meta.deck || meta.title || path.replace(/^.*\//, '').replace(/\.\w+$/, ''),
        file: path
      });
    });
    return cards;
  }

  function fetchText(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
      return r.text();
    });
  }

  function load() {
    return fetchText('cards/index.json').then(function (t) {
      var cfg;
      try { cfg = JSON.parse(t); } catch (e) { throw new Error('cards/index.json is not valid JSON: ' + e.message); }
      state.config = cfg;
      var files = cfg.decks || [];
      return Promise.all(files.map(function (f) {
        return fetchText('cards/' + f).then(function (txt) { return parseDeck(txt, f); })
          .catch(function (e) { state.warnings.push('Could not load ' + f + ' (' + e.message + ').'); return []; });
      }));
    }).then(function (lists) {
      var names = (state.config.categories || []).map(function (c) { return c.name; });
      var all = [].concat.apply([], lists);
      all.forEach(function (c) {
        if (c.category && names.indexOf(c.category) === -1) {
          state.warnings.push(c.file + ': category "' + c.category + '" is not listed in cards/index.json.');
        }
        if (state.byId[c.id]) { state.warnings.push('Duplicate card id "' + c.id + '" in ' + c.file + ' and ' + state.byId[c.id].file + '. Only the first is used.'); return; }
        state.byId[c.id] = c;
        state.cards.push(c);
      });
      showWarnings();
    });
  }

  function showWarnings() {
    var box = document.getElementById('warnings');
    var w = uniq(state.warnings);
    if (!w.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<strong>Some cards have problems:</strong><ul>' + w.slice(0, 12).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' + (w.length > 12 ? '…and ' + (w.length - 12) + ' more.' : '');
  }

  // ---------- views ----------
  function categories() { return (state.config && state.config.categories) || []; }
  function categoryBySlug(s) { return categories().filter(function (c) { return slug(c.name) === s; })[0]; }
  function cardsIn(catName) { return state.cards.filter(function (c) { return c.category === catName; }); }

  function barHTML(c) {
    if (!c.total) return '<div class="bar"></div>';
    return '<div class="bar"><span class="g" style="width:' + (100 * c.g / c.total) + '%"></span><span class="r" style="width:' + (100 * c.r / c.total) + '%"></span></div>';
  }
  function countsHTML(c) {
    return '<div class="counts"><span><span class="dot g"></span>' + c.g + ' knew</span><span><span class="dot r"></span>' + c.r + ' didn’t</span><span><span class="dot u"></span>' + c.u + ' not seen</span></div>';
  }

  function viewHome() {
    var cats = categories();
    var html = '<h1>What do you want to review?</h1><p class="sub">Pick a category, choose which cards, and go.</p><div class="cat-grid">';
    cats.forEach(function (cat) {
      var c = countStatus(cardsIn(cat.name));
      html += '<a class="cat-tile" href="#/c/' + slug(cat.name) + '"><h3>' + esc(cat.name) + '</h3><p>' +
        (c.total ? c.total + (c.total === 1 ? ' card' : ' cards') : 'No cards yet') +
        (cat.description ? ' · ' + esc(cat.description) : '') + '</p>' + barHTML(c) + countsHTML(c) + '</a>';
    });
    html += '</div>';
    app.innerHTML = html;
  }

  var STATUS_OPTS = [
    { v: 'all', label: 'All' },
    { v: 'r', label: 'Red only' },
    { v: 'ru', label: 'Red + not seen' },
    { v: 'u', label: 'Not seen' },
    { v: 'g', label: 'Green only' }
  ];

  function getPrefs(catName) {
    var p = state.prefs[catName] || {};
    return { course: p.course || '', topics: p.topics || [], status: p.status || 'all', shuffle: p.shuffle !== false };
  }
  function setPrefs(catName, p) { state.prefs[catName] = p; saveJSON(PREFS_KEY, state.prefs); }

  function selectCards(catName, p) {
    return cardsIn(catName).filter(function (c) {
      if (p.course && c.course !== p.course) return false;
      if (p.topics.length && p.topics.indexOf(c.topic) === -1) return false;
      var s = statusOf(c.id);
      if (p.status === 'all') return true;
      if (p.status === 'ru') return s === 'r' || s === 'u';
      return s === p.status;
    });
  }

  function viewCategory(cat) {
    var all = cardsIn(cat.name);
    var p = getPrefs(cat.name);
    var courses = uniq(all.map(function (c) { return c.course; })).sort();
    if (p.course && courses.indexOf(p.course) === -1) p.course = '';
    var inCourse = all.filter(function (c) { return !p.course || c.course === p.course; });
    var topics = uniq(inCourse.map(function (c) { return c.topic; })).sort();
    p.topics = p.topics.filter(function (t) { return topics.indexOf(t) !== -1; });
    var chosen = selectCards(cat.name, p);
    var scoped = inCourse.filter(function (c) { return !p.topics.length || p.topics.indexOf(c.topic) !== -1; });
    var sc = countStatus(scoped);

    function n(list) { return '<span class="n">' + list.length + '</span>'; }

    var html = '<a class="back" href="#/">← All categories</a><h1>' + esc(cat.name) + '</h1><p class="sub">' +
      (all.length ? all.length + (all.length === 1 ? ' card' : ' cards') : 'No cards yet') + (cat.description ? ' · ' + esc(cat.description) : '') + '</p>';

    if (!all.length) {
      html += '<div class="panel empty">No cards in this category yet. Add a deck file under <code>cards/</code> (see the card guide).</div>';
      app.innerHTML = html; return;
    }

    html += '<div class="panel">';
    if (courses.length > 0 && !(courses.length === 1 && !courses[0])) {
      html += '<div class="field"><div class="field-label">Course</div><div class="chips">' +
        '<button class="chip" data-course="" aria-pressed="' + (!p.course) + '">All courses' + n(all) + '</button>' +
        courses.map(function (c) {
          return '<button class="chip" data-course="' + esc(c) + '" aria-pressed="' + (p.course === c) + '">' + esc(c) + n(all.filter(function (x) { return x.course === c; })) + '</button>';
        }).join('') + '</div></div>';
    }
    if (topics.length > 1 || (topics.length === 1 && topics[0])) {
      html += '<div class="field"><div class="field-label">Topics <span style="text-transform:none;letter-spacing:0;font-weight:400">(none selected = all)</span></div><div class="chips">' +
        topics.map(function (t) {
          return '<button class="chip" data-topic="' + esc(t) + '" aria-pressed="' + (p.topics.indexOf(t) !== -1) + '">' + esc(t) + n(inCourse.filter(function (x) { return x.topic === t; })) + '</button>';
        }).join('') + '</div></div>';
    }
    html += '<div class="field"><div class="field-label">Which cards</div><div class="chips">' +
      STATUS_OPTS.map(function (o) {
        var cnt = o.v === 'all' ? sc.total : o.v === 'ru' ? sc.r + sc.u : sc[o.v];
        return '<button class="chip" data-status="' + o.v + '" aria-pressed="' + (p.status === o.v) + '">' +
          (o.v === 'r' ? '<span class="dot r"></span>' : o.v === 'g' ? '<span class="dot g"></span>' : o.v === 'u' ? '<span class="dot u"></span>' : '') +
          o.label + '<span class="n">' + cnt + '</span></button>';
      }).join('') + '</div></div>';
    html += '<div class="field"><label class="toggle"><input type="checkbox" id="shuffle"' + (p.shuffle ? ' checked' : '') + '> Shuffle order</label></div>';
    html += '<div class="start-row"><button class="btn primary" id="start"' + (chosen.length ? '' : ' disabled') + '>' +
      (chosen.length ? 'Review ' + chosen.length + (chosen.length === 1 ? ' card' : ' cards') : 'No cards match') + '</button></div>';
    html += '</div>';

    html += '<div class="list-head"><h2>Cards in this selection</h2>' +
      (chosen.length ? '<button class="btn small" id="reset-sel">Clear marks</button>' : '') + '</div>';
    if (!chosen.length) html += '<div class="panel empty">Nothing here with these filters.</div>';
    else {
      html += '<ul class="list">' + chosen.map(function (c) {
        var s = statusOf(c.id);
        var meta = [c.course, c.topic].filter(Boolean).map(esc).join(' · ');
        return '<li data-id="' + esc(c.id) + '"><button class="row" aria-expanded="false"><span class="dot ' + s + '"></span><span class="row-main"><span class="row-front rich">' +
          renderRich(c.front) + '</span>' + (meta ? '<span class="row-meta">' + meta + '</span>' : '') + '</span></button></li>';
      }).join('') + '</ul>';
    }
    app.innerHTML = html;

    app.querySelectorAll('[data-course]').forEach(function (b) {
      b.onclick = function () { p.course = b.getAttribute('data-course'); p.topics = []; setPrefs(cat.name, p); viewCategory(cat); };
    });
    app.querySelectorAll('[data-topic]').forEach(function (b) {
      b.onclick = function () {
        var t = b.getAttribute('data-topic'), i = p.topics.indexOf(t);
        if (i === -1) p.topics.push(t); else p.topics.splice(i, 1);
        setPrefs(cat.name, p); viewCategory(cat);
      };
    });
    app.querySelectorAll('[data-status]').forEach(function (b) {
      b.onclick = function () { p.status = b.getAttribute('data-status'); setPrefs(cat.name, p); viewCategory(cat); };
    });
    var sh = document.getElementById('shuffle');
    sh.onchange = function () { p.shuffle = sh.checked; setPrefs(cat.name, p); };
    var start = document.getElementById('start');
    if (start) start.onclick = function () { startSession(cat, chosen, p.shuffle); };
    var reset = document.getElementById('reset-sel');
    if (reset) reset.onclick = function () {
      if (reset.dataset.armed) {
        chosen.forEach(function (c) { setMark(c.id, 'u'); });
        toast('Marks cleared for ' + chosen.length + ' cards'); viewCategory(cat);
      } else { reset.dataset.armed = '1'; reset.textContent = 'Tap again to confirm'; setTimeout(function () { if (reset.isConnected) { delete reset.dataset.armed; reset.textContent = 'Clear marks'; } }, 3000); }
    };
    app.querySelectorAll('.list li').forEach(function (li) {
      var btn = li.querySelector('.row');
      btn.onclick = function () {
        var open = li.querySelector('.row-back');
        if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
        btn.setAttribute('aria-expanded', 'true');
        var c = state.byId[li.getAttribute('data-id')];
        var d = document.createElement('div');
        d.className = 'row-back rich';
        d.innerHTML = renderRich(c.back) + '<div class="row-actions"><button class="btn small" data-m="g"><span class="dot g"></span>Knew it</button><button class="btn small" data-m="r"><span class="dot r"></span>Didn’t know</button><button class="btn small" data-m="u">Clear</button></div>';
        li.appendChild(d);
        d.querySelectorAll('[data-m]').forEach(function (mb) {
          mb.onclick = function () {
            setMark(c.id, mb.getAttribute('data-m'));
            li.querySelector('.row .dot').className = 'dot ' + statusOf(c.id);
          };
        });
      };
    });
  }

  // ---------- review session ----------
  function startSession(cat, cards, doShuffle) {
    state.session = { cat: cat, queue: doShuffle ? shuffle(cards) : cards.slice(), i: 0, flipped: false, results: {} };
    location.hash = '#/review';
  }

  function viewReview() {
    var s = state.session;
    if (!s) { location.replace('#/'); return; }
    if (s.i >= s.queue.length) { viewSummary(); return; }
    var c = s.queue[s.i];
    var st = statusOf(c.id);
    var tags = [c.course, c.topic].filter(Boolean).map(esc).join(' · ');
    var pill = st === 'g' ? '<span class="status-pill g">Green</span>' : st === 'r' ? '<span class="status-pill r">Red</span>' : '';

    app.innerHTML =
      '<div class="review-top"><a class="back" href="#/c/' + slug(s.cat.name) + '" style="margin:0">✕ End</a>' +
      '<div class="progress"><span style="width:' + (100 * s.i / s.queue.length) + '%"></span></div>' +
      '<span class="pos">' + (s.i + 1) + ' / ' + s.queue.length + '</span></div>' +
      '<div class="card-wrap"><div class="card' + (s.flipped ? ' is-back' : '') + '" id="card" tabindex="0" role="button" aria-label="' + (s.flipped ? 'Card answer' : 'Card, tap to flip') + '">' +
      '<div class="card-tags"><span>' + tags + '</span>' + pill + '</div>' +
      '<div class="card-body"><div class="card-front rich">' + renderRich(c.front) + '</div>' +
      (s.flipped ? '<div class="card-back rich">' + renderRich(c.back) + '</div>' : '') + '</div>' +
      (s.flipped ? '' : '<div class="card-hint">Tap the card to flip</div>') +
      '</div></div>' +
      (s.flipped
        ? '<div class="answer-row"><button class="btn red" id="no">✗ Didn’t know</button><button class="btn green" id="yes">✓ Knew it</button></div>'
        : '<div class="reveal-row"><button class="btn block" id="flip">Show answer</button></div>') +
      '<div class="review-foot">' +
      (s.i > 0 ? '<button class="btn small" id="prev">← Previous</button>' : '<span></span>') +
      '<button class="btn small" id="skip">Skip →</button></div>' +
      '<div class="kbd-help"><kbd>Space</kbd> flip · <kbd>←</kbd> or <kbd>1</kbd> didn’t know · <kbd>→</kbd> or <kbd>2</kbd> knew it</div>';

    var card = document.getElementById('card');
    card.onclick = function (e) { if (window.getSelection && String(window.getSelection()).length) return; if (e.target.closest('a')) return; flip(); };
    var f = document.getElementById('flip'); if (f) f.onclick = flip;
    var y = document.getElementById('yes'); if (y) y.onclick = function () { answer('g'); };
    var n = document.getElementById('no'); if (n) n.onclick = function () { answer('r'); };
    var p = document.getElementById('prev'); if (p) p.onclick = function () { s.i--; s.flipped = false; viewReview(); };
    document.getElementById('skip').onclick = function () { s.i++; s.flipped = false; viewReview(); };
  }

  function flip() {
    var s = state.session;
    s.flipped = !s.flipped;
    viewReview();
    var card = document.getElementById('card');
    if (card) { card.classList.add('flipping'); setTimeout(function () { card.classList.remove('flipping'); }, 340); }
  }

  function answer(mark) {
    var s = state.session, c = s.queue[s.i];
    setMark(c.id, mark);
    s.results[c.id] = mark;
    s.i++; s.flipped = false;
    viewReview();
  }

  function viewSummary() {
    var s = state.session;
    var g = 0, r = 0;
    Object.keys(s.results).forEach(function (k) { if (s.results[k] === 'g') g++; else r++; });
    var reds = s.queue.filter(function (c) { return s.results[c.id] === 'r'; });
    app.innerHTML = '<div class="panel summary"><h1>Done</h1><p class="muted">' + esc(s.cat.name) + '</p>' +
      '<div class="summary-nums"><div class="g">' + g + '<small>Knew it</small></div><div class="r">' + r + '<small>Didn’t know</small></div>' +
      (s.queue.length - g - r ? '<div class="muted">' + (s.queue.length - g - r) + '<small>Skipped</small></div>' : '') + '</div>' +
      '<div class="summary-actions">' +
      (reds.length ? '<button class="btn red" id="again">Review the ' + reds.length + ' red ' + (reds.length === 1 ? 'card' : 'cards') + ' again</button>' : '') +
      '<button class="btn" id="repeat">Repeat this set</button>' +
      '<a class="btn" href="#/c/' + slug(s.cat.name) + '">Back to ' + esc(s.cat.name) + '</a></div></div>';
    var a = document.getElementById('again');
    if (a) a.onclick = function () { state.session = { cat: s.cat, queue: shuffle(reds), i: 0, flipped: false, results: {} }; viewReview(); };
    document.getElementById('repeat').onclick = function () { state.session = { cat: s.cat, queue: shuffle(s.queue), i: 0, flipped: false, results: {} }; viewReview(); };
  }

  // ---------- progress / backup ----------
  function viewProgress() {
    var c = countStatus(state.cards);
    app.innerHTML = '<a class="back" href="#/">← All categories</a><h1>Progress</h1>' +
      '<p class="sub">Your green and red marks are saved in this browser.</p>' +
      '<div class="panel">' + barHTML(c) + countsHTML(c) + '</div>' +
      '<h2>Sync between devices</h2>' + syncPanelHTML() +
      '<h2>Backup file</h2>' +
      '<div class="panel stack"><p class="note" style="margin:0">Export a backup file, or import one. Importing merges: for each card, the most recent mark wins.</p>' +
      '<button class="btn" id="export">Export marks</button>' +
      '<label class="btn file-label">Import marks<input type="file" id="import" accept="application/json,.json"></label></div>' +
      '<h2>Start over</h2><div class="panel stack"><button class="btn" id="reset-all">Clear all marks</button></div>';

    bindSyncPanel();
    document.getElementById('export').onclick = function () {
      var data = JSON.stringify({ app: 'flashcards', version: 1, exported: new Date().toISOString(), marks: state.marks }, null, 1);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'flashcard-marks-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    };
    document.getElementById('import').onchange = function (e) {
      var file = e.target.files[0]; if (!file) return;
      file.text().then(function (t) {
        var d = JSON.parse(t), n = mergeMarks(d.marks || d);
        Sync.schedule();
        toast('Imported ' + n + ' marks'); viewProgress();
      }).catch(function () { toast('That file could not be read'); });
    };
    var ra = document.getElementById('reset-all');
    ra.onclick = function () {
      if (ra.dataset.armed) {
        var now = Date.now();
        Object.keys(state.marks).forEach(function (id) { state.marks[id] = { s: 'u', t: now }; });
        saveJSON(MARKS_KEY, state.marks); Sync.schedule(); toast('All marks cleared'); viewProgress();
      }
      else { ra.dataset.armed = '1'; ra.textContent = 'Tap again to clear everything'; }
    };
  }

  function syncPanelHTML() {
    if (Sync.enabled()) {
      var last = Sync.cfg.last ? new Date(Sync.cfg.last).toLocaleString() : 'not yet';
      return '<div class="panel stack"><p class="note" style="margin:0"><strong style="color:var(--green)">● Sync is on.</strong> Marks are saved to a private Gist on your GitHub account and shared with your other devices. Last synced: ' + esc(last) + '.</p>' +
        (Sync.status === 'error' ? '<p class="note" style="margin:0;color:var(--red)">' + esc(Sync.error) + '</p>' : '') +
        '<button class="btn" id="sync-now">Sync now</button><button class="btn small" id="sync-off">Turn off sync on this device</button></div>';
    }
    return '<div class="panel stack"><p class="note" style="margin:0">Paste a GitHub token with the <strong>gist</strong> permission to sync your marks through a private Gist. Do this once on each device, using the same token. ' +
      '<a href="https://github.com/settings/tokens/new?scopes=gist&description=Flashcards%20sync" target="_blank" rel="noopener">Create a token</a> (choose "No expiration" or a long one, and only tick <em>gist</em>).</p>' +
      '<input class="input" id="sync-token" type="password" autocomplete="off" spellcheck="false" placeholder="ghp_…">' +
      '<button class="btn primary" id="sync-on">Turn on sync</button></div>';
  }
  function bindSyncPanel() {
    var on = document.getElementById('sync-on');
    if (on) on.onclick = function () {
      var tok = document.getElementById('sync-token').value.trim();
      if (!tok) { toast('Paste your token first'); return; }
      on.disabled = true; on.textContent = 'Connecting…';
      Sync.connect(tok).then(function () {
        if (Sync.status === 'ok') toast('Sync is on'); else toast(Sync.error || 'Sync failed');
        viewProgress();
      }).catch(function (e) { on.disabled = false; on.textContent = 'Turn on sync'; toast(e.message || 'Could not connect'); });
    };
    var now = document.getElementById('sync-now');
    if (now) now.onclick = function () { now.disabled = true; Sync.now().then(function () { viewProgress(); }); };
    var off = document.getElementById('sync-off');
    if (off) off.onclick = function () { Sync.disconnect(); toast('Sync turned off on this device'); viewProgress(); };
  }

  // ---------- routing & keys ----------
  function route(keepScroll) {
    var h = location.hash || '#/';
    if (keepScroll !== true) window.scrollTo(0, 0);
    if (h === '#/review') return viewReview();
    if (h === '#/progress') return viewProgress();
    var m = h.match(/^#\/c\/([^/?]+)/);
    if (m) { var cat = categoryBySlug(m[1]); if (cat) return viewCategory(cat); }
    state.session = null;
    viewHome();
  }

  document.addEventListener('keydown', function (e) {
    if (location.hash !== '#/review' || !state.session || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches('input, textarea')) return;
    var s = state.session; if (s.i >= s.queue.length) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); flip(); }
    else if (s.flipped && (e.key === 'ArrowRight' || e.key === '2')) answer('g');
    else if (s.flipped && (e.key === 'ArrowLeft' || e.key === '1')) answer('r');
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', function () {
    if (!Sync.enabled()) return;
    if (document.visibilityState === 'visible') Sync.now(); else if (Sync.timer) Sync.now();
  });
  window.addEventListener('online', function () { Sync.now(); });
  load().then(function () { route(); Sync.setStatus(Sync.enabled() ? 'syncing' : 'off'); Sync.now(); }).catch(function (e) {
    app.innerHTML = '<div class="panel empty"><strong>Could not load the cards.</strong><br>' + esc(e.message) + '</div>';
  });

  // exposed for tests
  window.__flashcards = { parseDeck: parseDeck, renderRich: renderRich, state: state, Sync: Sync };
})();
