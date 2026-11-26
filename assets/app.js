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
    if (h === '#/review' || h.indexOf('#/add') === 0) return;
    if (h === '#/progress') { viewProgress(); return; }
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
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, msg.length > 40 ? 5000 : 2200);
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
    html = html.replace(/<img src="([^"]*)"/g, function (_, src) {
      var local = localImages[src.replace(/&amp;/g, '&')];
      return '<img loading="lazy" class="zoomable" src="' + (local || src) + '"';
    });
    return html;
  }

  // ---------- images ----------
  // Images live in /images in the repo and are referenced from card text as ![description](images/file.jpg).
  // Images picked in this session are previewed from memory until GitHub Pages has published them.
  var localImages = {}, uploadedImages = {};
  function openLightbox(src) {
    var box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = '<img src="' + esc(src) + '" alt=""><button class="lightbox-close" aria-label="Close">✕</button>';
    box.onclick = function (e) { if (e.target.tagName !== 'IMG' || box.classList.contains('zoomed')) box.remove(); else box.classList.add('zoomed'); };
    document.body.appendChild(box);
  }
  document.addEventListener('click', function (e) {
    var img = e.target.closest && e.target.closest('img.zoomable');
    if (!img || img.closest('.lightbox')) return;
    e.preventDefault(); e.stopPropagation();
    openLightbox(img.getAttribute('src'));
  }, true);
  document.addEventListener('keydown', function (e) {
    var lb = document.querySelector('.lightbox');
    if (lb && e.key === 'Escape') lb.remove();
  });
  // Shrink a photo so it loads fast on a phone but stays readable (long side at most 1800px).
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1800, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That image format could not be read. Try a JPG or PNG.')); };
      img.src = url;
    });
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
        fileCategory: category || '',
        fileCourse: meta.course || '',
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
      Editor.mergePending();
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
      html += '<div class="panel empty">No cards in this category yet.<br><br><a class="btn primary" href="#/add?cat=' + encodeURIComponent(cat.name) + '">+ Add the first card</a></div>';
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

    html += '<div class="list-head"><h2>Cards in this selection</h2><div style="display:flex;gap:8px">' +
      '<a class="btn small" href="#/add?cat=' + encodeURIComponent(cat.name) + (p.course ? '&course=' + encodeURIComponent(p.course) : '') +
      (p.topics.length === 1 ? '&topic=' + encodeURIComponent(p.topics[0]) : '') + '">+ Add card</a>' +
      (chosen.length ? '<button class="btn small" id="reset-sel">Clear marks</button>' : '') + '</div></div>';
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
    return '<div class="panel stack"><p class="note" style="margin:0">Paste a GitHub token with <strong>gist</strong> and <strong>public_repo</strong> ticked. It syncs your marks through a private Gist and lets you add cards from the app. Do this once on each device, using the same token. ' +
      '<a href="https://github.com/settings/tokens/new?scopes=gist,public_repo&description=Flashcards" target="_blank" rel="noopener">Create a token</a> (choose "No expiration", and tick only <em>gist</em> and <em>public_repo</em>).</p>' +
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

  // ---------- adding cards from the app ----------
  // New cards are committed to the repository in the same text format Claude uses, so every device gets them.
  // Until GitHub Pages republishes (about a minute) they are kept locally as "pending" so they show at once.
  var PENDING_KEY = 'flashcards.pending.v1';
  var Editor = {
    pending: (function () { var p = loadJSON(PENDING_KEY, []); return Array.isArray(p) ? p : []; })(),
    savePending: function () { saveJSON(PENDING_KEY, this.pending); },
    mergePending: function () {
      var dayAgo = Date.now() - 864e5;
      this.pending = this.pending.filter(function (p) { return p && p.card && !state.byId[p.card.id] && p.t > dayAgo; });
      this.savePending();
      this.pending.forEach(function (p) { state.byId[p.card.id] = p.card; state.cards.push(p.card); });
    },
    repo: function () {
      if (state.config && state.config.repo) return state.config.repo;
      var host = location.hostname.match(/^([^.]+)\.github\.io$/i), seg = location.pathname.split('/').filter(Boolean)[0];
      return host && seg ? host[1] + '/' + seg : '';
    },
    branch: function () { return (state.config && state.config.branch) || 'main'; },
    folderFor: function (catName) {
      var cat = categories().filter(function (c) { return c.name === catName; })[0];
      return (cat && cat.folder) || slug(catName);
    },
    // Use an existing deck file with the same category and course, otherwise a new file.
    fileFor: function (catName, course) {
      var match = state.cards.filter(function (c) { return c.fileCategory === catName && (c.fileCourse || '') === (course || ''); })[0];
      if (match) return match.file;
      return this.folderFor(catName) + '/' + (slug(course) || 'my-cards') + '.md';
    },
    makeId: function (catName, course, front) {
      var prefix = slug(course || catName).split('-').slice(0, 2).join('-') || 'card';
      var words = slug(front.replace(/\$[^$]*\$/g, ' ')).split('-').filter(Boolean).slice(0, 6).join('-') || 'card';
      var base = prefix + '-' + words, id = base, n = 2;
      while (state.byId[id]) id = base + '-' + n++;
      return id;
    },
    // Keep typed text from being read as card syntax.
    clean: function (text) {
      return String(text).replace(/\r\n?/g, '\n').trim().split('\n').map(function (l) {
        return (/^={3,}\s*$/.test(l) || /^(back|front|id|topic|course)\s*:/i.test(l)) ? ' ' + l : l;
      }).join('\n');
    },
    serialize: function (card, includeCourse) {
      return 'id: ' + card.id + '\n' +
        (card.topic ? 'topic: ' + card.topic.replace(/\n/g, ' ') + '\n' : '') +
        (includeCourse && card.course ? 'course: ' + card.course + '\n' : '') +
        'front: ' + this.clean(card.front) + '\nback: ' + this.clean(card.back) + '\n';
    },
    b64: function (str) { return btoa(unescape(encodeURIComponent(str))); },
    unb64: function (b) { return decodeURIComponent(escape(atob(b.replace(/\s/g, '')))); },
    gh: function (path, opts) {
      opts = opts || {};
      return fetch('https://api.github.com' + path, {
        method: opts.method || 'GET', cache: 'no-store',
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + Sync.cfg.token, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        if (opts.allow404 && r.status === 404) return null;
        if (r.status === 401) throw new Error('GitHub rejected the token. It may have expired.');
        if (r.status === 403 || r.status === 404) throw new Error('This token can\'t save cards. Make a new token with both "gist" and "public_repo" ticked, then paste it on the Progress page.');
        if (r.status === 409 || r.status === 422) { var e = new Error('conflict'); e.conflict = true; throw e; }
        if (!r.ok) throw new Error('GitHub answered ' + r.status + '.');
        return r.json();
      });
    },
    contentsPath: function (repo, path) { return '/repos/' + repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/'); },
    readFile: function (repo, path) {
      var self = this;
      return self.gh(self.contentsPath(repo, path) + '?ref=' + self.branch(), { allow404: true })
        .then(function (f) { return f ? { sha: f.sha, text: self.unb64(f.content) } : null; });
    },
    writeFile: function (repo, path, text, sha, message) {
      var body = { message: message, content: this.b64(text), branch: this.branch() };
      if (sha) body.sha = sha;
      return this.gh(this.contentsPath(repo, path), { method: 'PUT', body: body });
    },
    retry: function (fn, tries) {
      return fn().catch(function (e) { if (e.conflict && tries > 0) return Editor.retry(fn, tries - 1); throw e; });
    },
    uploadImages: function (card) {
      var self = this, repo = self.repo(), text = card.front + '\n' + card.back;
      var paths = Object.keys(localImages).filter(function (p) { return !uploadedImages[p] && text.indexOf('(' + p + ')') !== -1; });
      return paths.reduce(function (chain, p) {
        return chain.then(function () {
          var data = localImages[p].split(',')[1];
          return self.gh(self.contentsPath(repo, p), { method: 'PUT', body: { message: 'Add image ' + p, content: data, branch: self.branch() } })
            .then(function () { uploadedImages[p] = true; });
        });
      }, Promise.resolve());
    },
    save: function (card) {
      var self = this, repo = self.repo();
      if (!repo) return Promise.reject(new Error('Repository unknown. Add "repo": "owner/name" to cards/index.json.'));
      var path = self.fileFor(card.category, card.course), full = 'cards/' + path, created = false;
      return self.retry(function () {
        return self.readFile(repo, full).then(function (f) {
          var text;
          if (f) {
            var fm = f.text.replace(/\r\n?/g, '\n').match(/^---[ \t]*\n([\s\S]*?)\n---/);
            var fileCourse = fm ? (parseKV(fm[1]).course || '') : '';
            text = f.text.replace(/\s*$/, '') + '\n\n===\n\n' + self.serialize(card, fileCourse !== (card.course || ''));
          } else {
            text = '---\ncategory: ' + card.category + '\n' + (card.course ? 'course: ' + card.course + '\n' : '') + '---\n\n' + self.serialize(card, false);
          }
          created = !f;
          return self.writeFile(repo, full, text, f && f.sha, 'Add card: ' + card.front.split('\n')[0].slice(0, 60));
        });
      }, 2).then(function () {
        if (!created) return;
        // A new deck file must be listed in cards/index.json.
        return self.retry(function () {
          return self.readFile(repo, 'cards/index.json').then(function (f) {
            var cfg = JSON.parse(f.text);
            cfg.decks = cfg.decks || [];
            if (cfg.decks.indexOf(path) !== -1) return;
            cfg.decks.push(path);
            return self.writeFile(repo, 'cards/index.json', JSON.stringify(cfg, null, 2) + '\n', f.sha, 'List new deck ' + path);
          });
        }, 2).then(function () {
          if (state.config.decks.indexOf(path) === -1) state.config.decks.push(path);
        });
      }).then(function () {
        card.file = path; card.fileCategory = card.category; card.fileCourse = card.course;
        card.deck = path.replace(/^.*\//, '').replace(/\.\w+$/, '');
        self.pending.push({ card: card, t: Date.now() }); self.savePending();
        state.byId[card.id] = card; state.cards.push(card);
        return path;
      });
    }
  };

  function viewAdd(params) {
    var cats = categories();
    var last = state.prefs.__add || {};
    var catName = params.cat || last.cat || (cats[0] && cats[0].name) || '';
    var course = params.course != null ? params.course : (catName === last.cat ? last.course || '' : '');
    var topic = params.topic != null ? params.topic : (catName === last.cat && course === (last.course || '') ? last.topic || '' : '');
    var hasToken = !!Sync.cfg.token;
    function opts(list) { return list.map(function (x) { return '<option value="' + esc(x) + '">'; }).join(''); }
    var allCourses = uniq(state.cards.map(function (c) { return c.course; })).sort();
    var allTopics = uniq(state.cards.map(function (c) { return c.topic; })).sort();
    function courseLabel() { return 'Course' + (catName === 'School' ? '' : ' <span class="opt">(optional)</span>'); }

    app.innerHTML = '<a class="back" href="#/">← All categories</a><h1>Add a card</h1>' +
      '<p class="sub">It is saved to your repository, so it shows on all your devices. Math: <code>$x^2$</code> inline, <code>$$...$$</code> on its own line.</p>' +
      (hasToken ? '' : '<div class="panel stack" style="margin-bottom:16px"><p class="note" style="margin:0"><strong>One-time setup on this device.</strong> Saving cards needs a GitHub token with <strong>gist</strong> and <strong>public_repo</strong> ticked. ' +
        '<a href="https://github.com/settings/tokens/new?scopes=gist,public_repo&description=Flashcards" target="_blank" rel="noopener">Create a token</a> and paste it here. This also turns on red/green sync.</p>' +
        '<input class="input" id="add-token" type="password" autocomplete="off" spellcheck="false" placeholder="ghp_…"></div>') +
      '<form class="panel" id="add-form" autocomplete="off">' +
      '<div class="field"><div class="field-label">Category</div><div class="chips">' +
      cats.map(function (c) { return '<button type="button" class="chip" data-cat="' + esc(c.name) + '" aria-pressed="' + (c.name === catName) + '">' + esc(c.name) + '</button>'; }).join('') + '</div></div>' +
      '<div class="form-grid">' +
      '<label class="field"><span class="field-label" id="course-label">' + courseLabel() + '</span><input class="input" id="f-course" list="dl-course" value="' + esc(course) + '" placeholder="e.g. Macroeconomics"></label>' +
      '<label class="field"><span class="field-label">Topic <span class="opt">(optional)</span></span><input class="input" id="f-topic" list="dl-topic" value="' + esc(topic) + '" placeholder="e.g. Growth"></label>' +
      '</div><datalist id="dl-course">' + opts(allCourses) + '</datalist><datalist id="dl-topic">' + opts(allTopics) + '</datalist>' +
      '<label class="field"><span class="field-label">Front</span><textarea class="input" id="f-front" rows="2" placeholder="Term or short question"></textarea></label>' +
      '<label class="field"><span class="field-label">Back</span><textarea class="input" id="f-back" rows="5" placeholder="Explanation. You can use **bold**, lists and $math$."></textarea></label>' +
      '<div class="field img-row"><label class="btn small file-label">🖼 Add image<input type="file" id="f-image" accept="image/*"></label>' +
      '<span class="note">Photo, screenshot or scan. On a computer you can also paste an image into the text box.</span></div>' +
      '<div class="field"><div class="field-label">Preview</div><div class="preview"><div class="card-front rich" id="p-front"><span class="muted">Front</span></div><div class="card-back rich" id="p-back"></div></div></div>' +
      '<div class="start-row"><button class="btn primary" id="f-save" type="submit">Save card</button></div>' +
      '</form>';

    var form = document.getElementById('add-form');
    var fFront = document.getElementById('f-front'), fBack = document.getElementById('f-back');
    var fCourse = document.getElementById('f-course'), fTopic = document.getElementById('f-topic');
    form.querySelectorAll('[data-cat]').forEach(function (b) {
      b.onclick = function () {
        catName = b.getAttribute('data-cat');
        form.querySelectorAll('[data-cat]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        document.getElementById('course-label').innerHTML = courseLabel();
      };
    });
    var timer;
    function preview() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        document.getElementById('p-front').innerHTML = fFront.value.trim() ? renderRich(fFront.value) : '<span class="muted">Front</span>';
        document.getElementById('p-back').innerHTML = renderRich(fBack.value);
      }, 120);
    }
    fFront.oninput = preview; fBack.oninput = preview;
    var lastBox = fBack;
    fFront.onfocus = function () { lastBox = fFront; }; fBack.onfocus = function () { lastBox = fBack; };
    function addImage(file) {
      if (!file || !/^image\//.test(file.type || 'image/')) return;
      toast('Adding image…');
      compressImage(file).then(function (dataUrl) {
        var d = new Date(), stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        var base = slug(fFront.value).split('-').slice(0, 5).join('-') || 'card';
        var path = 'images/' + base + '-' + stamp + '-' + Math.random().toString(36).slice(2, 7) + '.jpg';
        localImages[path] = dataUrl;
        var box = lastBox, md = '![' + (fFront.value.trim().split('\n')[0].replace(/[\[\]]/g, '').slice(0, 60) || 'image') + '](' + path + ')';
        var pos = box.selectionEnd != null ? box.selectionEnd : box.value.length;
        var before = box.value.slice(0, pos), after = box.value.slice(pos);
        var insert = (before && !/\n$/.test(before) ? '\n' : '') + md + (after && !/^\n/.test(after) ? '\n' : '');
        box.value = before + insert + after;
        preview();
      }).catch(function (err) { toast(err.message); });
    }
    document.getElementById('f-image').onchange = function (e) { addImage(e.target.files[0]); e.target.value = ''; };
    [fFront, fBack].forEach(function (box) {
      box.addEventListener('paste', function (e) {
        var items = (e.clipboardData && e.clipboardData.items) || [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { e.preventDefault(); lastBox = box; addImage(items[i].getAsFile()); return; }
        }
      });
    });
    form.onsubmit = function (e) {
      e.preventDefault();
      var btn = document.getElementById('f-save');
      var front = fFront.value.trim(), back = fBack.value.trim();
      if (!front || !back) { toast('Fill in both the front and the back'); return; }
      if (catName === 'School' && !fCourse.value.trim()) { toast('Add a course for School cards'); fCourse.focus(); return; }
      var ready = Promise.resolve();
      if (!Sync.cfg.token) {
        var tokEl = document.getElementById('add-token'), tok = tokEl && tokEl.value.trim();
        if (!tok) { toast('Paste your GitHub token first'); return; }
        ready = Sync.connect(tok);
      }
      btn.disabled = true; btn.textContent = 'Saving…';
      var c = fCourse.value.trim(), tp = fTopic.value.trim();
      ready.then(function () {
        var card = { id: Editor.makeId(catName, c, front), category: catName, course: c, topic: tp, front: front, back: back };
        return Editor.uploadImages(card).then(function () { return Editor.save(card); });
      }).then(function (path) {
        state.prefs.__add = { cat: catName, course: c, topic: tp }; saveJSON(PREFS_KEY, state.prefs);
        toast('Card saved');
        viewAdd({ cat: catName, course: c, topic: tp });
        document.getElementById('f-front').focus();
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = 'Save card';
        toast(err.message || 'Could not save the card');
      });
    };
  }

  // ---------- routing & keys ----------
  function route(keepScroll) {
    var h = location.hash || '#/';
    if (keepScroll !== true) window.scrollTo(0, 0);
    if (h === '#/review') return viewReview();
    if (h === '#/progress') return viewProgress();
    if (h.indexOf('#/add') === 0) {
      var q = {};
      (h.split('?')[1] || '').split('&').forEach(function (kv) { if (kv) { var a = kv.split('='); q[decodeURIComponent(a[0])] = decodeURIComponent(a[1] || ''); } });
      return viewAdd(q);
    }
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
