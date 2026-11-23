/* 27 考研政治 · 主动回忆
 * Vanilla JS, no dependencies. Progress lives in localStorage.
 */
(function () {
  'use strict';

  const CARDS = Array.isArray(window.CARDS) ? window.CARDS : [];
  const META = window.CARD_META || {};
  const TAGS = Array.isArray(META.tags) ? META.tags : [];
  const BY_ID = new Map(CARDS.map(function (c) { return [c.id, c]; }));

  const LS_KEY = 'zz27_recall_v1';
  const THEME_KEY = 'zz27_theme';
  const P_ORDER = { A: 0, B: 1, C: 2 };
  const P_NAME = { A: '必背', B: '巩固', C: '拓展' };
  const INTERVALS = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 15, 6: 30, 7: 60 };
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const ROUTES = ['today', 'browse', 'stats', 'me'];

  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------------- storage ---------------- */
  function blankState() {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      states: {},
      daily: {},
      settings: { newPerDay: 20, examDate: '2026-12-19' }
    };
  }

  function loadState() {
    var raw;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
    if (!raw) return blankState();
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.states !== 'object' || parsed.states === null) return blankState();
      parsed.daily = parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {};
      parsed.settings = Object.assign({ newPerDay: 20, examDate: '2026-12-19' }, parsed.settings || {});
      if (!parsed.settings.examDate || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.settings.examDate)) parsed.settings.examDate = '2026-12-19';
      return parsed;
    } catch (e) { return blankState(); }
  }

  var S = loadState();
  var storageOK = true;

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(S));
      storageOK = true;
    } catch (e) {
      if (storageOK) toast('浏览器存储不可用，进度可能无法保存');
      storageOK = false;
    }
  }

  /* ---------------- date ---------------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseKey(k) {
    var p = String(k).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function addDays(k, n) {
    var d = parseKey(k);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function utcDay(k) {
    var p = String(k).split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]);
  }
  function daysBetween(a, b) { return Math.round((utcDay(b) - utcDay(a)) / 86400000); }
  function formatDateCN(d) {
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 星期' + WEEK[d.getDay()];
  }
  function shortDate(k) { return k.slice(5).replace('-', '.'); }

  /* ---------------- data helpers ---------------- */
  function stateOf(c) { return S.states[c.id] || null; }
  function dayEntry(k) {
    var d = S.daily[k];
    return d || { new: 0, review: 0, good: 0, fuzzy: 0, forgot: 0 };
  }
  function dayTotal(k) {
    var d = dayEntry(k);
    return (d.good || 0) + (d.fuzzy || 0) + (d.forgot || 0);
  }
  function learnedCount() {
    var n = 0;
    for (var i = 0; i < CARDS.length; i++) if (S.states[CARDS[i].id]) n++;
    return n;
  }
  function masteredCount() {
    var n = 0;
    for (var i = 0; i < CARDS.length; i++) {
      var x = S.states[CARDS[i].id];
      if (x && x.lvl >= 5) n++;
    }
    return n;
  }
  function dueCards(prio) {
    var t = todayKey();
    return CARDS.filter(function (c) {
      var x = S.states[c.id];
      return !!x && x.due <= t && (prio === 'all' || c.p === prio);
    }).sort(function (a, b) {
      var xa = S.states[a.id], xb = S.states[b.id];
      return (P_ORDER[a.p] - P_ORDER[b.p]) ||
        String(xa.due).localeCompare(String(xb.due)) ||
        ((xb.lapses || 0) - (xa.lapses || 0)) ||
        (a.id - b.id);
    });
  }
  function newCards(prio) {
    return CARDS.filter(function (c) {
      return !S.states[c.id] && (prio === 'all' || c.p === prio);
    }).sort(function (a, b) {
      return (P_ORDER[a.p] - P_ORDER[b.p]) || (a.id - b.id);
    });
  }
  function newAllowance() {
    var d = dayEntry(todayKey());
    return Math.max(0, Number(S.settings.newPerDay || 20) - (d.new || 0));
  }
  function statusOf(c) {
    var x = S.states[c.id];
    if (!x) return { key: 'new', label: '未学', cls: '' };
    if (x.due <= todayKey()) return { key: 'due', label: '今天到期', cls: 'due' };
    if (x.lvl >= 5) return { key: 'mastered', label: '已掌握', cls: 'mastered' };
    return { key: 'learning', label: shortDate(x.due) + ' 复习', cls: 'learning' };
  }
  function targetInterval(c, grade) {
    var x = stateOf(c);
    var base = Math.max(1, x ? x.lvl : 0);
    if (grade === 'forgot') return 1;
    if (grade === 'fuzzy') return INTERVALS[base];
    return INTERVALS[Math.min(7, base + 1)];
  }
  function intervalText(c, grade) {
    var n = targetInterval(c, grade);
    return n + ' 天后';
  }

  /* ---------------- build queue ---------------- */
  function buildQueue(prio, mode) {
    var fresh, due;
    if (mode === 'free') {
      var pool = CARDS.filter(function (c) {
        return S.states[c.id] && (prio === 'all' || c.p === prio);
      });
      shuffle(pool);
      return pool.slice(0, 20);
    }
    if (mode === 'extra') {
      return newCards(prio).slice(0, 10);
    }
    due = dueCards(prio);
    fresh = newCards(prio).slice(0, newAllowance() + (mode === 'extra-new' ? 10 : 0));
    var out = [];
    var di = 0, ni = 0;
    while (di < due.length || ni < fresh.length) {
      for (var k = 0; k < 3 && di < due.length; k++) out.push(due[di++]);
      if (ni < fresh.length) out.push(fresh[ni++]);
    }
    return out;
  }

  function buildTagQueue(tag, mode) {
    var t = todayKey();
    if (mode === 'free') {
      var pool = CARDS.filter(function (c) { return c.tag === tag && S.states[c.id]; });
      shuffle(pool);
      return pool.slice(0, 20);
    }
    var due = CARDS.filter(function (c) {
      var x = S.states[c.id];
      return c.tag === tag && x && x.due <= t;
    }).sort(function (a, b) {
      return (P_ORDER[a.p] - P_ORDER[b.p]) || (a.id - b.id);
    });
    var fresh = CARDS.filter(function (c) {
      return c.tag === tag && !S.states[c.id];
    }).slice(0, newAllowance());
    var out = [];
    var di = 0, ni = 0;
    while (di < due.length || ni < fresh.length) {
      for (var k = 0; k < 3 && di < due.length; k++) out.push(due[di++]);
      if (ni < fresh.length) out.push(fresh[ni++]);
    }
    return out;
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------------- escape / format ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderLines(text) {
    var lines = String(text).split('\n');
    var html = '';
    var inList = false;
    function closeList() { if (inList) { html += '</ul>'; inList = false; } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { closeList(); continue; }
      var bullet = line.match(/^[·•]\s*(.*)$/);
      if (bullet) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + esc(bullet[1]) + '</li>';
        continue;
      }
      closeList();
      var mnemonic = line.match(/^口诀[：:]\s*(.*)$/);
      if (mnemonic) {
        html += '<p class="mnemonic"><b>口诀：</b>' + esc(mnemonic[1]) + '</p>';
      } else {
        html += '<p>' + esc(line) + '</p>';
      }
    }
    closeList();
    return html;
  }

  function answerHTML(c) {
    var a = String(c.a || '').trim();
    if (!a) return '<div class="ans"><p>（暂无答案）</p></div>';
    var judge = a.match(/^([✓✗])\s*/);
    if (judge) {
      var ok = judge[1] === '✓';
      var rest = a.slice(judge[0].length).trim();
      return '<div class="ans judge"><div class="judge-mark ' + (ok ? 'ok' : 'no') + '">' + judge[1] +
        '</div><div class="judge-body">' + (rest ? renderLines(rest) : '') + '</div></div>';
    }
    if (!a.includes('\n') && a.length <= 32) {
      return '<div class="ans short">' + esc(a) + '</div>';
    }
    return '<div class="ans">' + renderLines(a) + '</div>';
  }

  /* ---------------- toast / body lock ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }
  var lockCount = 0;
  function lockBody() {
    lockCount++;
    document.body.style.overflow = 'hidden';
  }
  function unlockBody() {
    lockCount = Math.max(0, lockCount - 1);
    if (!lockCount) document.body.style.overflow = '';
  }

  /* ---------------- dialog ---------------- */
  var dialogEsc = null;
  var dialogClose = null;
  function openDialog(html, bind) {
    if (session) closeSession(true);
    if (dialogClose) { try { dialogClose(); } catch (e) {} }
    var ov = $('#overlay');
    ov.innerHTML = '<div class="backdrop" id="backdrop"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
    lockBody();
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (dialogEsc) { document.removeEventListener('keydown', dialogEsc); dialogEsc = null; }
      dialogClose = null;
      ov.innerHTML = '';
      unlockBody();
    }
    dialogClose = close;
    var bd = $('#backdrop');
    bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    $$('[data-close]', ov).forEach(function (b) { b.addEventListener('click', close); });
    dialogEsc = function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', dialogEsc);
    if (bind) bind(close);
    return close;
  }

  function confirmDialog(title, message, okText, danger, onOk) {
    openDialog(
      '<div class="sheet-head"><div class="grow"><b>' + esc(title) + '</b></div><button class="close" data-close aria-label="关闭">×</button></div>' +
      '<div class="sheet-body"><p style="margin:0;color:var(--ink2);font-size:13px;line-height:1.85">' + message + '</p></div>' +
      '<div class="sheet-foot"><button class="btn" data-close>取消</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" id="confirmOk">' + esc(okText) + '</button></div>',
      function (close) {
        $('#confirmOk').addEventListener('click', function () { close(); onOk(); });
      }
    );
  }

  /* ---------------- session ---------------- */
  var session = null;

  function startSession(prio, mode) {
    prio = prio || 'all';
    mode = mode || 'srs';
    var queue = buildQueue(prio, mode);
    if (!queue.length) {
      offerEmpty(prio);
      return;
    }
    session = {
      prio: prio, label: prio === 'all' ? '今日任务' : prio + ' 路线', mode: mode,
      queue: queue, i: 0, revealed: false,
      requeued: {}, stats: { good: 0, fuzzy: 0, forgot: 0, total: 0 },
      started: Date.now(), done: false
    };
    renderSession();
  }

  function startTagSession(tag, mode) {
    mode = mode || 'srs';
    var q = buildTagQueue(tag, mode);
    if (!q.length && mode === 'srs') {
      q = buildTagQueue(tag, 'free');
      if (q.length) toast('这个专题今天没有到期卡，随机复习 20 张');
    }
    if (!q.length) { toast('这个专题暂时没有可复习的卡'); return; }
    session = {
      prio: 'tag', tag: tag, label: tag, mode: mode,
      queue: q, i: 0, revealed: false,
      requeued: {}, stats: { good: 0, fuzzy: 0, forgot: 0, total: 0 },
      started: Date.now(), done: false
    };
    renderSession();
  }

  function startQueue(queue, prio) {
    if (!queue.length) return;
    session = {
      prio: prio || 'all', label: '单卡复习', mode: 'single', queue: queue.slice(), i: 0, revealed: false,
      requeued: {}, stats: { good: 0, fuzzy: 0, forgot: 0, total: 0 },
      started: Date.now(), done: false
    };
    renderSession();
  }

  function offerEmpty(prio) {
    var hasLearned = CARDS.some(function (c) { return S.states[c.id] && (prio === 'all' || c.p === prio); });
    var hasNew = newCards(prio).length > 0;
    var label = prio === 'all' ? '今天' : prio + ' 档';
    var body = '<p style="margin:0 0 8px;color:var(--ink2);font-size:13px;line-height:1.8">' + label +
      '没有到期卡' + (hasNew ? '，但每日新卡额度已经用完。' : '，也没有新卡了。') + '</p>';
    body += '<p style="margin:0;color:var(--muted);font-size:11.5px;line-height:1.7">可以加练几张，或者去「我的」调高每日新卡上限。</p>';
    var foot = '<button class="btn" data-close>取消</button>' +
      (hasNew ? '<button class="btn" id="extraNew">加练 10 张新卡</button>' : '') +
      (hasLearned ? '<button class="btn primary" id="freeReview">自由复习 20 张</button>' : '');
    openDialog(
      '<div class="sheet-head"><div class="grow"><b>这一档暂时没有待办</b></div><button class="close" data-close>×</button></div>' +
      '<div class="sheet-body">' + body + '</div><div class="sheet-foot">' + foot + '</div>',
      function (close) {
        var en = $('#extraNew');
        if (en) en.addEventListener('click', function () { close(); startSession(prio, 'extra'); });
        var fr = $('#freeReview');
        if (fr) fr.addEventListener('click', function () { close(); startSession(prio, 'free'); });
      }
    );
  }

  function renderSession() {
    var ov = $('#overlay');
    if (!session) { ov.innerHTML = ''; return; }
    if (!session.done && !session._locked) {
      lockBody();
      session._locked = true;
    }
    if (session.done) {
      ov.innerHTML = doneHTML();
      bindDone();
      return;
    }
    var c = session.queue[session.i];
    var x = stateOf(c);
    var total = session.queue.length;
    var num = Math.min(session.i + 1, total);
    var meta = '<span class="badge ' + c.p + '">' + c.p + ' · ' + c.pl + '</span>' +
      '<span class="badge tag">' + esc(c.tag) + '</span>' +
      (x ? '<span class="badge plain">第 ' + ((x.reps || 0) + 1) + ' 次</span>' : '') +
      '<span class="s-idx">#' + String(c.id).padStart(3, '0') + '</span>';
    var hint = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>轻点卡片显示答案';
    var grades = '<button class="grade forgot" data-g="forgot"><b>忘记</b><small>' + intervalText(c, 'forgot') + '</small></button>' +
      '<button class="grade fuzzy" data-g="fuzzy"><b>模糊</b><small>' + intervalText(c, 'fuzzy') + '</small></button>' +
      '<button class="grade good" data-g="good"><b>记得</b><small>' + intervalText(c, 'good') + '</small></button>';

    ov.innerHTML =
      '<div class="session">' +
        '<div class="s-head">' +
          '<button class="s-close" id="sClose" aria-label="退出复习">×</button>' +
          '<div class="s-progress"><div class="track"><i style="width:' + (session.i / total * 100) + '%"></i></div>' +
          '<div class="nums"><span>' + esc(session.label || '今日任务') + '</span><span>' + session.stats.total + ' 已作答</span></div></div>' +
          '<div class="s-count">' + num + ' / ' + total + '</div>' +
        '</div>' +
        '<div class="s-body" id="sBody">' +
          '<div class="s-card" id="sCard" tabindex="0" role="button" aria-label="显示答案">' +
            '<div class="s-meta">' + meta + '</div>' +
            '<div class="s-q">' + (c.sec ? '<span class="qsec">' + esc(c.sec) + '</span>' : '') + esc(c.q) + '</div>' +
            '<div class="s-hint" id="sHint">' + hint + '</div>' +
            '<div class="s-answer" id="sAnswer"><div class="alabel">答案</div>' + answerHTML(c) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="s-foot">' +
          '<div class="s-reveal" id="sReveal"><button class="btn primary wide" id="revealBtn">显示答案 <span class="kbd">Space</span></button></div>' +
          '<div class="grades' + (session.revealed ? ' show' : '') + '" id="sGrades">' + grades + '</div>' +
        '</div>' +
      '</div>';

    if (session.revealed) {
      $('#sAnswer').classList.add('show');
      $('#sHint').style.display = 'none';
      $('#sReveal').style.display = 'none';
    }

    $('#sClose').addEventListener('click', function () { closeSession(); });
    $('#sCard').addEventListener('click', reveal);
    $('#sCard').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); }
    });
    $('#revealBtn').addEventListener('click', function (e) { e.stopPropagation(); reveal(); });
    $$('.grade').forEach(function (b) {
      b.addEventListener('click', function () { grade(b.getAttribute('data-g')); });
    });
  }

  function reveal() {
    if (!session || session.done || session.revealed) return;
    session.revealed = true;
    var ans = $('#sAnswer'), hint = $('#sHint'), rev = $('#sReveal'), gr = $('#sGrades');
    if (ans) ans.classList.add('show');
    if (hint) hint.style.display = 'none';
    if (rev) rev.style.display = 'none';
    if (gr) gr.classList.add('show');
  }

  function grade(g) {
    if (!session || session.done) return;
    if (!session.revealed) { reveal(); return; }
    var c = session.queue[session.i];
    if (!c) return;
    var prev = S.states[c.id];
    var wasNew = !prev;
    var t = todayKey();
    var base = Math.max(1, prev ? prev.lvl : 0);
    var nl, interval;
    if (g === 'forgot') {
      nl = 1; interval = 1;
    } else if (g === 'fuzzy') {
      nl = base; interval = INTERVALS[base];
    } else {
      nl = Math.min(7, base + 1); interval = INTERVALS[nl];
    }
    S.states[c.id] = {
      lvl: nl,
      due: addDays(t, interval),
      reps: (prev ? prev.reps || 0 : 0) + 1,
      lapses: (prev ? prev.lapses || 0 : 0) + (g === 'forgot' ? 1 : 0),
      last: t,
      lastGrade: g,
      first: prev ? prev.first || t : t
    };
    var d = S.daily[t];
    if (!d) d = S.daily[t] = { new: 0, review: 0, good: 0, fuzzy: 0, forgot: 0 };
    if (wasNew) d.new = (d.new || 0) + 1; else d.review = (d.review || 0) + 1;
    d[g] = (d[g] || 0) + 1;
    save();

    session.stats[g]++;
    session.stats.total++;
    if (g === 'forgot' && !session.requeued[c.id]) {
      session.requeued[c.id] = true;
      var pos = Math.min(session.i + 4, session.queue.length);
      session.queue.splice(pos, 0, c);
    }
    session.i++;
    session.revealed = false;
    if (session.i >= session.queue.length) {
      session.done = true;
      $('#overlay').innerHTML = doneHTML();
      bindDone();
      return;
    }
    renderSession();
    var body = $('#sBody');
    if (body) body.scrollTop = 0;
  }

  function doneHTML() {
    var st = session.stats;
    var acc = st.total ? Math.round((st.good + st.fuzzy * 0.5) / st.total * 100) : 0;
    var mins = Math.max(1, Math.round((Date.now() - session.started) / 60000));
    var words = acc >= 85 ? '记得很稳，继续保持。' : acc >= 60 ? '有印象了，明天再滚一遍。' : '别急，这一组正是要暴露问题。';
    return '<div class="session"><div class="s-body" style="align-items:center"><div class="done">' +
      '<div class="done-icon">✓</div><h2>这一组完成了</h2><p>' + words + '</p>' +
      '<div class="done-grid"><div><b>' + st.total + '</b><span>作答</span></div><div><b>' + acc + '%</b><span>记得率</span></div><div><b>' + mins + '</b><span>分钟</span></div></div>' +
      '<div class="done-actions"><button class="btn primary" id="againBtn">再来一组</button><button class="btn" id="doneClose">回到今日</button></div>' +
      '</div></div></div>';
  }

  function bindDone() {
    var again = $('#againBtn'), dc = $('#doneClose');
    var prio = session ? session.prio : 'all';
    var tag = session ? session.tag : null;
    if (again) again.addEventListener('click', function () {
      closeSession(true);
      if (tag) startTagSession(tag); else startSession(prio);
    });
    if (dc) dc.addEventListener('click', function () { closeSession(); });
  }

  function closeSession(silent) {
    if (!session) return;
    session = null;
    var ov = $('#overlay');
    if (ov) ov.innerHTML = '';
    if (lockCount > 0) unlockBody();
    lockCount = 0;
    document.body.style.overflow = '';
    if (!silent) render();
  }

  /* ---------------- views ---------------- */
  function todayHTML() {
    var t = todayKey();
    var due = dueCards('all').length;
    var allow = newAllowance();
    var unlearned = CARDS.length - learnedCount();
    var newAvail = Math.min(allow, unlearned);
    var doneToday = dayTotal(t);
    var learned = learnedCount();
    var mastered = masteredCount();
    var streak = calcStreak();
    var plan = due + newAvail;
    var ctaMode = plan > 0 ? 'srs' : 'free';
    var ctaText = plan > 0 ? (doneToday > 0 ? '继续今日复习' : '开始今日复习') : '自由复习 20 张';
    var ctaSub = plan > 0 ? (due + ' 复习 + ' + newAvail + ' 新卡') : '今日任务已完成';
    var wd = new Date();
    var countdown = daysBetween(t, S.settings.examDate);

    var routes = ['A', 'B', 'C'].map(function (p) {
      var all = CARDS.filter(function (c) { return c.p === p; });
      var l = all.filter(function (c) { return !!S.states[c.id]; }).length;
      var du = all.filter(function (c) {
        var x = S.states[c.id];
        return x && x.due <= t;
      }).length;
      var pct = all.length ? Math.round(l / all.length * 100) : 0;
      return '<button class="route ' + p + '" data-p="' + p + '">' +
        '<span class="letter ' + p + '">' + p + '</span>' +
        '<span class="route-main">' +
          '<span class="route-top"><b>' + p + ' ' + P_NAME[p] + '</b><span>' + all.length + ' 张</span></span>' +
          '<span class="route-bar"><i style="width:' + pct + '%"></i></span>' +
          '<span class="route-meta"><span>已学 <b>' + l + '</b></span><span>到期 <b>' + du + '</b></span><span>未学 <b>' + (all.length - l) + '</b></span></span>' +
        '</span>' +
        '<span class="route-go">开始' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</span>' +
      '</button>';
    }).join('');

    var topicDefs = [
      ['正误判断', '正误判断', 'red'],
      ['经典表述', '经典表述', 'gold'],
      ['口诀', '口诀', 'jade'],
      ['会议 史纲', '会议', 'blue']
    ];
    var topics = topicDefs.map(function (x) {
      var n = CARDS.filter(function (c) { return c.tag === x[0]; }).length;
      return '<button class="topic ' + x[2] + '" data-tag="' + esc(x[0]) + '"><b>' + x[1] + '</b><span>' + n + ' 张</span></button>';
    }).join('');

    return '<section>' +
      '<div class="hero">' +
        '<p class="eyebrow"><span class="dot"></span>' + formatDateCN(wd) + '</p>' +
        '<h1>今天，先回忆，<em>再翻面</em>。</h1>' +
        '<p class="hero-sub">到期 <b>' + due + '</b> 张 · 新卡额度 <b>' + newAvail + '</b> 张 · 全库还剩 <b>' + unlearned + '</b> 张未学' +
          (countdown >= 0 ? ' · 距初试 <b>' + countdown + '</b> 天' : '') + '</p>' +
        '<div class="hero-cta"><button class="btn primary" id="startToday" data-mode="' + ctaMode + '">' +
          ctaText + ' <small>' + ctaSub + '</small></button></div>' +
        '<div class="hero-stats">' +
          '<div class="hs"><b>' + doneToday + '<small>张</small></b><span>今日已刷</span></div>' +
          '<div class="hs"><b>' + learned + '<small>/ ' + CARDS.length + '</small></b><span>全库已学</span></div>' +
          '<div class="hs"><b>' + streak + '<small>天</small></b><span>连续复习</span></div>' +
        '</div>' +
      '</div>' +

      '<div class="section-head"><h2>优先级路线</h2><span>建议先把 A 刷到条件反射</span></div>' +
      '<div class="routes">' + routes + '</div>' +

      '<div class="section-head"><h2>专题训练</h2><span>按标签直接开一组</span></div>' +
      '<div class="topics">' + topics + '</div>' +

      '<div class="section-head"><h2>资料与工具</h2><span>配合使用</span></div>' +
      '<div class="quick">' +
        '<a href="/kaoyan/jisu"><span class="qi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3 7v13l6-3 6 3 6-3V4l-6 3-6-3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 4v13M15 7v13" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></span><b>知识地图</b><span>七大板块 · 会议时间轴 · 真题热度</span></a>' +
        '<a href="/kaoyan/onepage"><span class="qi"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span><b>考前 30 分钟</b><span>A4 打印版 · 进考场前扫一遍</span></a>' +
        '<a href="#"><span class="qi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v3h16v-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><b>卡片下载</b><span>Anki / 墨墨 · 进度备份</span></a>' +
        '<a href="/kaoyan/english-writing"><span class="qi blue"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 4 20l1-5 9.5-9.5a2.1 2.1 0 0 1 3 3L8 18l-3 1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13 8.5 15.5 11" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></span><b>英语作文</b><span>103 张记忆卡 · 判型练习</span></a>' +
      '</div>' +

      '<div class="section-head"><h2>最近 7 天</h2><span>每天刷一点，比周末突击稳</span></div>' +
      '<div class="card"><div class="week">' + weekHTML() + '</div></div>' +
    '</section>';
  }

  function weekHTML() {
    var html = '';
    var days = [];
    for (var i = 6; i >= 0; i--) days.push(addDays(todayKey(), -i));
    var max = 1;
    days.forEach(function (k) { max = Math.max(max, dayTotal(k)); });
    days.forEach(function (k, idx) {
      var n = dayTotal(k);
      var h = n ? Math.max(6, Math.round(n / max * 100)) : 3;
      var d = parseKey(k);
      html += '<div class="wd" title="' + k + '：' + n + ' 张">' +
        '<div class="bar"><i style="height:' + h + '%;opacity:' + (n ? 0.9 : 0.35) + '"></i></div>' +
        '<span class="lbl">' + (idx === days.length - 1 ? '今天' : '周' + WEEK[d.getDay()]) + '</span></div>';
    });
    return html;
  }

  function calcStreak() {
    var d = todayKey();
    if (!dayTotal(d)) d = addDays(d, -1);
    var n = 0;
    while (dayTotal(d) > 0 && n < 400) { n++; d = addDays(d, -1); }
    return n;
  }

  /* ---------------- browse ---------------- */
  var browse = { q: '', p: 'all', tag: 'all', status: 'all', shown: 80 };

  function filteredCards() {
    var q = browse.q.trim().toLowerCase();
    var t = todayKey();
    return CARDS.filter(function (c) {
      if (browse.p !== 'all' && c.p !== browse.p) return false;
      if (browse.tag !== 'all' && c.tag !== browse.tag) return false;
      if (browse.status !== 'all') {
        var x = S.states[c.id];
        if (browse.status === 'new' && x) return false;
        if (browse.status === 'learning' && (!x || x.lvl >= 5)) return false;
        if (browse.status === 'mastered' && (!x || x.lvl < 5)) return false;
        if (browse.status === 'due' && (!x || x.due > t)) return false;
        if (browse.status === 'wrong' && (!x || !(x.lapses > 0))) return false;
      }
      if (q) {
        var hay = (c.f + ' ' + c.a + ' ' + c.tag).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function browseHTML() {
    var total = CARDS.length;
    var counts = { A: 0, B: 0, C: 0 };
    CARDS.forEach(function (c) { counts[c.p]++; });
    var chips = ['all', 'A', 'B', 'C'].map(function (p) {
      var label = p === 'all' ? '全部' : p + ' ' + P_NAME[p];
      var n = p === 'all' ? total : counts[p];
      return '<button class="chip ' + (p === 'all' ? '' : p) + (browse.p === p ? ' on' : '') + '" data-p="' + p + '">' + label + ' <span style="opacity:.6">' + n + '</span></button>';
    }).join('');
    var tagOpts = '<option value="all">全部标签</option>' + TAGS.map(function (t) {
      return '<option value="' + esc(t.tag) + '"' + (browse.tag === t.tag ? ' selected' : '') + '>' + esc(t.tag) + ' · ' + t.count + '</option>';
    }).join('');
    var statusOpts = [['all', '全部状态'], ['new', '未学'], ['learning', '学习中'], ['mastered', '已掌握'], ['due', '今天到期'], ['wrong', '错题']]
      .map(function (x) { return '<option value="' + x[0] + '"' + (browse.status === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('');

    return '<section>' +
      '<div class="searchbox' + (browse.q ? ' has-q' : '') + '" id="searchbox">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
        '<input id="q" type="search" placeholder="搜问题、答案、标签…" value="' + esc(browse.q) + '" autocomplete="off" enterkeyhint="search">' +
        '<button class="clear" id="qClear" aria-label="清空搜索">×</button>' +
      '</div>' +
      '<div class="chips" id="prioChips">' + chips + '</div>' +
      '<div class="browse-tools">' +
        '<select id="tagFilter" aria-label="按标签筛选">' + tagOpts + '</select>' +
        '<select id="statusFilter" aria-label="按状态筛选">' + statusOpts + '</select>' +
        '<span class="spacer"></span>' +
        '<button class="btn small" id="exportBtn">导出 CSV</button>' +
      '</div>' +
      '<div class="result-line"><span>共 <b id="resultCount">0</b> 张</span><span id="resultShown"></span></div>' +
      '<div class="list" id="list"></div>' +
      '<div class="more-wrap" id="moreWrap" hidden><button class="btn small" id="moreBtn">显示更多</button></div>' +
    '</section>';
  }

  function renderList() {
    var all = filteredCards();
    var shown = all.slice(0, browse.shown);
    var list = $('#list');
    if (!list) return;
    $('#resultCount').textContent = all.length;
    $('#resultShown').textContent = all.length > shown.length ? '已显示 ' + shown.length : '';
    if (!all.length) {
      list.innerHTML = '<div class="card" style="text-align:center;padding:34px 18px;color:var(--muted);font-size:12.5px">没有匹配的卡片。<br><button class="link-btn" id="resetFilters" style="margin-top:8px">清空筛选</button></div>';
      var rf = $('#resetFilters');
      if (rf) rf.addEventListener('click', function () {
        browse.q = ''; browse.p = 'all'; browse.tag = 'all'; browse.status = 'all'; browse.shown = 80;
        render();
      });
      $('#moreWrap').hidden = true;
      return;
    }
    list.innerHTML = shown.map(function (c) {
      var st = statusOf(c);
      return '<button class="card-row" data-id="' + c.id + '">' +
        '<span class="pdot ' + c.p + '">' + c.p + '</span>' +
        '<span class="row-main"><span class="row-q">' + esc(c.q) + '</span>' +
          '<span class="row-meta"><span>' + esc(c.tag) + '</span><span class="st ' + st.cls + '">' + st.label + '</span></span></span>' +
        '<span class="chev">›</span>' +
      '</button>';
    }).join('');
    $('#moreWrap').hidden = shown.length >= all.length;
  }

  function bindBrowse() {
    var q = $('#q');
    var timer = null;
    q.addEventListener('input', function () {
      var sb = $('#searchbox');
      if (q.value) sb.classList.add('has-q'); else sb.classList.remove('has-q');
      clearTimeout(timer);
      timer = setTimeout(function () {
        browse.q = q.value;
        browse.shown = 80;
        renderList();
      }, 120);
    });
    $('#qClear').addEventListener('click', function () {
      q.value = ''; browse.q = ''; browse.shown = 80;
      $('#searchbox').classList.remove('has-q');
      renderList(); q.focus();
    });
    $('#prioChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      browse.p = b.getAttribute('data-p');
      browse.shown = 80;
      $$('#prioChips .chip').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderList();
    });
    $('#tagFilter').addEventListener('change', function (e) {
      browse.tag = e.target.value; browse.shown = 80; renderList();
    });
    $('#statusFilter').addEventListener('change', function (e) {
      browse.status = e.target.value; browse.shown = 80; renderList();
    });
    $('#moreBtn').addEventListener('click', function () {
      browse.shown += 80; renderList();
    });
    $('#list').addEventListener('click', function (e) {
      var b = e.target.closest('.card-row');
      if (b) openCard(Number(b.getAttribute('data-id')));
    });
    $('#exportBtn').addEventListener('click', openExport);
    renderList();
  }

  function openCard(id) {
    var c = BY_ID.get(id);
    if (!c) return;
    var x = S.states[id];
    var st = statusOf(c);
    var stats = x ? '<span>复习 ' + (x.reps || 0) + ' 次</span><span>遗忘 ' + (x.lapses || 0) + ' 次</span><span>下次 ' + (x.due <= todayKey() ? '今天' : shortDate(x.due)) + '</span>' : '<span>还没学过</span>';
    var body = '<div class="sheet-body">' +
      '<div class="sheet-meta"><span class="badge ' + c.p + '">' + c.p + ' · ' + c.pl + '</span><span class="badge tag">' + esc(c.tag) + '</span><span class="badge plain">' + st.label + '</span></div>' +
      '<p class="sheet-q">' + (c.sec ? '<span style="display:block;font-size:11px;color:var(--muted);letter-spacing:.12em;font-family:var(--sans);margin-bottom:7px">' + esc(c.sec) + '</span>' : '') + esc(c.q) + '</p>' +
      answerHTML(c) +
      '<div class="meta-line">' + stats + '</div>' +
    '</div>';
    var foot = '<div class="sheet-foot">' +
      (x ? '<button class="btn danger small" id="resetCard">重置这张</button>' : '') +
      '<button class="btn" data-close>关闭</button>' +
      '<button class="btn primary" id="singleCard">单独复习这张</button>' +
    '</div>';
    openDialog(
      '<div class="sheet-head"><div class="grow"><b>卡片 #' + String(c.id).padStart(3, '0') + '</b></div><button class="close" data-close aria-label="关闭">×</button></div>' + body + foot,
      function (close) {
        var rc = $('#resetCard');
        if (rc) rc.addEventListener('click', function () {
          delete S.states[id]; save(); close(); toast('已重置这张卡'); render();
        });
        $('#singleCard').addEventListener('click', function () {
          close(); startQueue([c], c.p);
        });
      }
    );
  }

  /* ---------------- export ---------------- */
  function csvCell(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
  }

  function exportCSV(cards, mode) {
    if (!cards.length) { toast('没有可导出的卡片'); return; }
    var lines = [];
    if (mode === 'momo') {
      lines.push('问题,答案');
      cards.forEach(function (c) {
        lines.push(csvCell(c.f) + ',' + csvCell(String(c.a).replace(/\n/g, '；')));
      });
    } else {
      cards.forEach(function (c) {
        lines.push(csvCell(c.f) + ',' + csvCell(String(c.a).replace(/\n/g, '<br>')));
      });
    }
    var text = (mode === 'momo' ? '\ufeff' : '') + lines.join('\r\n') + '\r\n';
    var name = '政治卡片-' + cards.length + '张-' + (mode === 'momo' ? '墨墨' : 'Anki') + '.csv';
    downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), name);
    toast('已导出 ' + cards.length + ' 张');
  }

  function openExport() {
    var cards = filteredCards();
    var body = '<div class="sheet-body">' +
      '<p style="margin:0 0 6px;font-size:13px;color:var(--ink2);line-height:1.8">当前筛选下共 <b style="color:var(--red)">' + cards.length + '</b> 张。</p>' +
      '<p style="margin:0;font-size:11.5px;color:var(--muted);line-height:1.8">Anki 版保留换行（导入时勾选 Allow HTML）；墨墨版把换行改成中文分号，并带「问题 / 答案」表头。</p>' +
      '<div class="meta-line" style="border-top:0;padding-top:0;margin-top:14px"><a class="link-btn" href="#/all-495.csv" download>下载原始 495 张 4 列 CSV</a></div>' +
    '</div>';
    var foot = '<div class="sheet-foot">' +
      '<a class="btn small" href="#">更多下载</a>' +
      '<button class="btn" id="csvMomo">墨墨 CSV</button>' +
      '<button class="btn primary" id="csvAnki">Anki CSV</button>' +
    '</div>';
    openDialog(
      '<div class="sheet-head"><div class="grow"><b>导出当前筛选</b></div><button class="close" data-close aria-label="关闭">×</button></div>' + body + foot,
      function (close) {
        $('#csvAnki').addEventListener('click', function () { exportCSV(cards, 'anki'); close(); });
        $('#csvMomo').addEventListener('click', function () { exportCSV(cards, 'momo'); close(); });
      }
    );
  }

  /* ---------------- stats ---------------- */
  function allTime() {
    var acc = { good: 0, fuzzy: 0, forgot: 0, new: 0, review: 0 };
    Object.keys(S.daily).forEach(function (k) {
      var d = dayEntry(k);
      acc.good += d.good || 0; acc.fuzzy += d.fuzzy || 0; acc.forgot += d.forgot || 0;
      acc.new += d.new || 0; acc.review += d.review || 0;
    });
    return acc;
  }

  function statsHTML() {
    var learned = learnedCount(), mastered = masteredCount();
    var total = CARDS.length;
    var at = allTime();
    var totalGrades = at.good + at.fuzzy + at.forgot;
    var acc = totalGrades ? Math.round((at.good + at.fuzzy * 0.5) / totalGrades * 100) : 0;
    var streak = calcStreak();
    var days = daysBetween(todayKey(), S.settings.examDate);

    var pbars = ['A', 'B', 'C'].map(function (p) {
      var all = CARDS.filter(function (c) { return c.p === p; });
      var l = all.filter(function (c) { return !!S.states[c.id]; }).length;
      var m = all.filter(function (c) { var x = S.states[c.id]; return x && x.lvl >= 5; }).length;
      var lp = all.length ? l / all.length * 100 : 0;
      var mp = all.length ? m / all.length * 100 : 0;
      return '<div><div class="pbar-top"><b>' + p + ' ' + P_NAME[p] + '</b><span>' + l + ' / ' + all.length + ' 已学 · ' + m + ' 已掌握</span></div>' +
        '<div class="pbar ' + p + '"><i class="m" style="width:' + mp + '%"></i><i class="l" style="width:' + Math.max(0, lp - mp) + '%"></i></div></div>';
    }).join('');

    var days14 = [];
    var maxDay = 1;
    for (var i = 13; i >= 0; i--) {
      var k = addDays(todayKey(), -i);
      var n = dayTotal(k);
      maxDay = Math.max(maxDay, n);
      days14.push({ k: k, n: n });
    }
    var chart = days14.map(function (d, idx) {
      var h = d.n ? Math.max(5, Math.round(d.n / maxDay * 100)) : 2;
      var dd = parseKey(d.k);
      var label = (idx % 2 === 0 || idx === 13) ? (dd.getMonth() + 1) + '/' + dd.getDate() : '';
      if (!d.n) {
        return '<div class="col" title="' + d.k + '：0 张"><div class="cb empty"></div><span class="cl">' + label + '</span></div>';
      }
      return '<div class="col" title="' + d.k + '：' + d.n + ' 张"><div class="cb"><i style="height:' + h + '%"></i></div><span class="cl">' + label + '</span></div>';
    }).join('');

    var tagRows = TAGS.map(function (t) {
      var list = CARDS.filter(function (c) { return c.tag === t.tag; });
      var l = list.filter(function (c) { return !!S.states[c.id]; }).length;
      var m = list.filter(function (c) { var x = S.states[c.id]; return x && x.lvl >= 5; }).length;
      var pct = list.length ? Math.round(m / list.length * 100) : 0;
      return '<div class="tag-row"><span class="tag-name" title="' + esc(t.tag) + '">' + esc(t.tag) + '</span>' +
        '<span class="tag-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="tag-num">' + m + '/' + list.length + '</span></div>';
    }).join('');

    var weak = CARDS.filter(function (c) { var x = S.states[c.id]; return x && x.lapses > 0; })
      .sort(function (a, b) { return (S.states[b.id].lapses - S.states[a.id].lapses) || (a.id - b.id); })
      .slice(0, 8);
    var weakHTML = weak.length ? weak.map(function (c) {
      return '<button class="weak" data-id="' + c.id + '" style="text-align:left;background:none;border:0;border-bottom:1px dashed var(--line);width:100%;font:inherit"><span>' + esc(c.q) + '</span><b>忘 ' + S.states[c.id].lapses + ' 次</b></button>';
    }).join('') : '<p style="margin:6px 0 0;font-size:11.5px;color:var(--muted)">还没有错题。继续保持。</p>';

    return '<section>' +
      '<div class="stat-grid">' +
        '<div class="stat-box"><b>' + learned + '</b><span>已学 / ' + total + '</span></div>' +
        '<div class="stat-box"><b>' + mastered + '</b><span>已掌握</span></div>' +
        '<div class="stat-box"><b>' + acc + '%</b><span>累计记得率</span></div>' +
        '<div class="stat-box"><b>' + streak + '</b><span>连续天数</span></div>' +
      '</div>' +
      '<div class="card" style="margin-top:12px"><h3>各档进度</h3><div class="pbars">' + pbars + '</div>' +
        (days >= 0 ? '<p class="note" style="margin-bottom:0">距 ' + S.settings.examDate + ' 初试还有 <b style="color:var(--red)">' + days + '</b> 天。</p>' : '') +
      '</div>' +
      '<div class="card"><h3>近 14 天作答</h3><div class="chart">' + chart + '</div></div>' +
      '<div class="card"><h3>标签掌握度 <span class="pill-note">按已掌握 / 总数</span></h3><div class="tag-list">' + tagRows + '</div></div>' +
      '<div class="card"><h3>薄弱卡片</h3><div class="weak-list">' + weakHTML + '</div>' +
        (weak.length ? '<div style="margin-top:10px"><button class="link-btn" id="openWrong">打开错题本 →</button></div>' : '') +
      '</div>' +
    '</section>';
  }

  /* ---------------- settings ---------------- */
  function meHTML() {
    var opts = [10, 15, 20, 30, 50];
    var cur = Number(S.settings.newPerDay || 20);
    if (opts.indexOf(cur) === -1) opts.push(cur);
    opts.sort(function (a, b) { return a - b; });
    var seg = opts.map(function (n) {
      return '<button data-n="' + n + '" class="' + (n === cur ? 'on' : '') + '">' + n + '</button>';
    }).join('');

    return '<section>' +
      '<div class="card">' +
        '<h3>学习节奏</h3>' +
        '<div class="setting"><div class="txt"><b>每日新卡上限</b><span>只限制「第一次学」的卡；到期复习不受限制。</span></div><div class="seg" id="newSeg">' + seg + '</div></div>' +
        '<div class="setting"><div class="txt"><b>初试日期</b><span>用于倒计时，默认 2026-12-19。</span></div><input class="date-input" type="date" id="examDate" value="' + esc(S.settings.examDate) + '"></div>' +
      '</div>' +

      '<div class="card">' +
        '<h3>进度与备份</h3>' +
        '<div class="setting"><div class="txt"><b>进度保存在本机浏览器</b><span>换手机 / 电脑时：先导出 JSON，再到新设备导入。清理浏览器数据会清空进度。</span></div></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">' +
          '<button class="btn small" id="exportData">导出进度 JSON</button>' +
          '<button class="btn small" id="importBtn">导入进度</button>' +
          '<button class="btn small danger" id="resetAll">清空进度</button>' +
        '</div>' +
        '<input type="file" id="importFile" accept=".json,application/json" hidden>' +
      '</div>' +

      '<div class="card">' +
        '<h3>资料</h3>' +
        '<div class="res-links">' +
          '<a href="#"><span>全部资料库</span><span>政治 / 英语</span></a>' +
          '<a href="/kaoyan/jisu"><span>知识地图 · 极速记忆系统</span><span>七大板块 / 会议 / 真题热度</span></a>' +
          '<a href="/kaoyan/onepage"><span>考前 30 分钟一页纸</span><span>A4 打印</span></a>' +
          '<a href="#"><span>卡片下载 · Anki / 墨墨</span><span>CSV</span></a>' +
          '<a href="#/all-495.csv" download><span>原始 495 张 CSV</span><span>4 列</span></a>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<h3>关于这套系统</h3>' +
        '<div class="about">' +
          '<p style="margin:0 0 8px">题库：<b>' + CARDS.length + ' 张</b>（A 必背 151 / B 巩固 236 / C 拓展 108），21 个标签。复习算法是简化的 Leitner 间隔：忘记 → 明天，模糊 → 保持档位，记得 → 升一档（1 / 2 / 4 / 7 / 15 / 30 / 60 天）。</p>' +
          '<p style="margin:0 0 8px">练习时<b>先在脑子里作答，再翻面</b>；想不起来就老老实实按「忘记」，别顺手点「记得」。这张表有没有用，全在这一步。</p>' +
          '<p style="margin:0 0 8px">手机可以把本站添加到主屏幕：iPhone Safari → 分享 → 添加到主屏幕；Android Chrome → 菜单 → 安装应用。安装后可离线打开。</p>' +
          '<p style="margin:0">版本 1.0 · 数据与进度均在本机处理，不上传服务器。</p>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  function bindMe() {
    $('#newSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-n]');
      if (!b) return;
      S.settings.newPerDay = Number(b.getAttribute('data-n'));
      save(); render();
    });
    $('#examDate').addEventListener('change', function (e) {
      var v = e.target.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        S.settings.examDate = v; save(); updateCountdown(); toast('初试日期已更新');
      }
    });
    $('#exportData').addEventListener('click', function () {
      var data = {
        app: 'zz27-recall', version: 1, exportedAt: new Date().toISOString(),
        settings: S.settings, states: S.states, daily: S.daily
      };
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        '政治复习进度-' + todayKey() + '.json');
      toast('进度已导出');
    });
    $('#importBtn').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var data;
        try { data = JSON.parse(String(reader.result)); } catch (err) { toast('文件不是有效的 JSON'); return; }
        if (!data || typeof data !== 'object' || !data.states || typeof data.states !== 'object') {
          toast('文件格式不对，需要本系统导出的进度 JSON'); return;
        }
        confirmDialog('导入进度', '导入会<b>覆盖</b>当前的全部学习进度。确定继续吗？', '覆盖并导入', true, function () {
          S.states = data.states || {};
          S.daily = data.daily && typeof data.daily === 'object' ? data.daily : {};
          S.settings = Object.assign({ newPerDay: 20, examDate: '2026-12-19' }, data.settings || {});
          save(); render(); toast('进度已导入');
        });
      };
      reader.readAsText(f, 'utf-8');
      e.target.value = '';
    });
    $('#resetAll').addEventListener('click', function () {
      confirmDialog('清空进度', '会删除全部学习记录（保留设置）。此操作<b>不可撤销</b>，建议先导出备份。', '确定清空', true, function () {
        S.states = {}; S.daily = {};
        save(); render(); toast('进度已清空');
      });
    });
  }

  /* ---------------- router ---------------- */
  function currentRoute() {
    var raw = location.hash.replace(/^#\/?/, '');
    var name = raw.split('?')[0];
    return ROUTES.indexOf(name) !== -1 ? name : 'today';
  }

  function render() {
    if (session) return;
    var route = currentRoute();
    $$('#tabs a').forEach(function (a) {
      var on = a.getAttribute('data-route') === route;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var view = $('#view');
    if (route === 'today') view.innerHTML = todayHTML();
    else if (route === 'browse') view.innerHTML = browseHTML();
    else if (route === 'stats') view.innerHTML = statsHTML();
    else view.innerHTML = meHTML();

    if (route === 'today') {
      $('#startToday').addEventListener('click', function (e) {
        startSession('all', e.currentTarget.getAttribute('data-mode') || 'srs');
      });
      $$('.route').forEach(function (b) {
        b.addEventListener('click', function () { startSession(b.getAttribute('data-p'), 'srs'); });
      });
      $$('.topic').forEach(function (b) {
        b.addEventListener('click', function () { startTagSession(b.getAttribute('data-tag')); });
      });
    } else if (route === 'browse') {
      bindBrowse();
    } else if (route === 'stats') {
      $$('.weak[data-id]').forEach(function (b) {
        b.addEventListener('click', function () { openCard(Number(b.getAttribute('data-id'))); });
      });
      var ow = $('#openWrong');
      if (ow) ow.addEventListener('click', function () {
        browse.q = ''; browse.p = 'all'; browse.tag = 'all'; browse.status = 'wrong'; browse.shown = 80;
        location.hash = '#/browse';
      });
    } else if (route === 'me') {
      bindMe();
    }

    var titles = { today: '主动回忆', browse: '卡库', stats: '统计', me: '我的' };
    document.title = '27 考研政治 · ' + titles[route];
    updateCountdown();
    window.scrollTo(0, 0);
    view.focus({ preventScroll: true });
  }

  function updateCountdown() {
    var el = $('#countdown');
    if (!el) return;
    var days = daysBetween(todayKey(), S.settings.examDate);
    if (days > 0) el.textContent = '距初试 ' + days + ' 天';
    else if (days === 0) el.textContent = '今天初试';
    else el.textContent = '初试已结束';
  }

  /* ---------------- theme ---------------- */
  function setTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#13110d' : '#f3eee3');
    if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) {} }
    var btn = $('#themeBtn');
    if (btn) {
      btn.innerHTML = theme === 'dark'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.3 8.3 0 1 0 20 14.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
      btn.setAttribute('aria-label', theme === 'dark' ? '切换到亮色' : '切换到暗色');
    }
  }

  /* ---------------- init ---------------- */
  function onKey(e) {
    if (dialogClose) {
      if (e.key === 'Escape') { e.preventDefault(); dialogClose(); }
      return;
    }
    if (!session) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSession(); return; }
    if (session.done) return;
    if (e.key === ' ' || e.key === 'Enter') {
      if (!session.revealed) { e.preventDefault(); reveal(); }
      return;
    }
    if (!session.revealed) return;
    if (e.key === '1') { e.preventDefault(); grade('forgot'); }
    else if (e.key === '2') { e.preventDefault(); grade('fuzzy'); }
    else if (e.key === '3') { e.preventDefault(); grade('good'); }
  }

  function init() {
    if (!CARDS.length) {
      $('#view').innerHTML = '<div class="card">题库加载失败，请刷新页面。</div>';
      return;
    }
    setTheme(document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), false);
    $('#themeBtn').addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      setTheme(next, true);
    });
    window.addEventListener('hashchange', function () {
      if (session) closeSession(true);
      if (dialogClose) dialogClose();
      render();
    });
    window.addEventListener('keydown', onKey);
    window.addEventListener('storage', function (e) {
      if (e.key === LS_KEY && !session) { S = loadState(); render(); }
    });
    render();
    // Service Worker 统一由 portal.js 注册（带内容版本参数），避免两个不同
    // scriptURL 在同一 scope 下来回替换。此处不再重复注册。
  }

  init();
})();
