/* 历年真题 · 考点专项（2016—2026）
 * 资料：/api/materials?id=realexam-2016-2026（同一个 D1，失败回退静态种子）
 * 进度：/api/progress，material 同上，共用 zz27_cloudsync_key。
 *
 * 两条与肖八一致的项目红线：
 *  1) 任何未作答状态都不显示答案 / 正确选项 / 解析，答案渲染只走 canReveal(q)；
 *  2) 进度只由「完成某题并产生作答记录」推进（commitAnswer），翻页/浏览/搜索/筛选只改视图。
 */
(function () {
  'use strict';

  var MID = 'realexam-2016-2026';
  var K_STATE = 'realexam_progress_v1', K_LAST = 'realexam_last', K_STAMP = 'realexam_stamp',
      K_VIEW = 'realexam_view_v1';
  var K_KEY = 'zz27_cloudsync_key', K_DEV = 'realexam_device_key', K_LASTKEY = 'realexam_cloud_key';
  var X8_STATE = 'xiao8_progress_v1';
  var HOSTS = ['', '/__disabled_sync__'];

  var data = null, questions = [], topicMap = {}, sourceTag = '';
  var state = {}, last = {}, cloudRev = 0, cloudOK = false, cloudAt = 0, pushTimer = null, retrying = false;
  var filter = { topic: '', trap: '', year: 0, type: '', sort: 'new', q: '', rnd: 0 };
  var idx = 0, sel = [], revealed = false, revealedFor = null, verdict = null, feedback = null;
  var wrongStreak = 0;          // 会话内连错计数：只用于「去看方法」提示，不落盘、不参与统计
  var fromX8 = null;               // 从肖八某一题跳来时的来源题号（仅视图提示，不算进度）
  var method = null;               // 《27 解题方法一页纸》方法库（方法册）
  var knowledge = null;            // 《27 知识点一页纸》知识点册（同一套两册的另一册）
  var methodGroup = 'think', methodQ = '';
  var knGroup = '全部', knQ = '', knExtra = 0, knFocus = '';
  var knX8Open = false, knX8Only = '', knX8Paper = 0, knX8Q = '';
  var view = 'drill', focusNo = 0; // drill=刷题 / method=解题方法 / knowledge=知识点

  /* 方法卡与错因解析里的墓碑词：前端自动标红加粗（不改变原文，只做视觉标记） */
  var TRAP_WORDS = [
    '必须', '一定', '绝对', '所有', '一切', '总是', '始终', '任何', '任意',
    '只能', '只是', '只有', '单纯', '纯粹', '唯一', '一元', '一种', '一套', '一条',
    '无差别', '总和', '线性', '机械', '直观', '一成不变',
    '已经', '实现了', '完成了', '一开始就', '同时', '同步',
    '根本', '决定', '取决于', '取代', '代替', '主导', '主体', '主要', '主线',
    '解决了', '破解了', '全面', '完整', '不再', '不包含', '不可能', '没有',
    '一脉相承', '一样', '一致', '自发', '直接', '具体', '细致',
    '有利于', '重要', '正在', '不断', '逐步', '进一步',
    '结盟', '盟友', '同盟', '盟国', '可有可无', '无足轻重', '无关紧要'
  ].sort(function (a, b) { return b.length - a.length; });

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) { return Number(v) || 0; }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  /* 稳定的伪随机排序：同一 seed 下同一批题顺序固定，避免每次渲染乱跳 */
  function hashId(s, seed) {
    var h = (2166136261 ^ num(seed)) >>> 0;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619 >>> 0; }
    return h;
  }
  function jget(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function fmt(ts) { try { return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; } }
  function jget2(s, d) { try { return JSON.parse(s) || d; } catch (e) { return d; } }

  /* ---------------- 云端资料 / 进度 ---------------- */
  function syncKey() {
    var k = '';
    try { k = localStorage.getItem(K_KEY) || ''; } catch (e) {}
    if (k) return k;
    var d = '';
    try { d = localStorage.getItem(K_DEV) || ''; } catch (e) {}
    if (!d) {
      d = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(K_DEV, d); } catch (e) {}
    }
    return d;
  }
  function request(path, opts) {
    var i = 0;
    function attempt() {
      var base = HOSTS[i];
      var o = { method: (opts && opts.method) || 'GET',
        headers: Object.assign({ 'cache-control': 'no-store' }, (opts && opts.headers) || {}),
        credentials: base ? 'omit' : 'include' };
      if (opts && opts.body) o.body = opts.body;
      return fetch(base + path, o).then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('application/json') < 0) throw new Error('blocked');
        return r.json().then(function (j) { return { ok: r.ok, j: j, status: r.status }; });
      }).catch(function (e) {
        if (++i < HOSTS.length) return attempt();
        throw e;
      });
    }
    return attempt();
  }
  function loadMaterial() {
    return request('/api/materials?id=' + encodeURIComponent(MID)).then(function (res) {
      if (res.ok && res.j && res.j.payload && res.j.payload.questions && res.j.payload.questions.length) {
        return { data: res.j.payload, tag: res.j.source === 'd1' ? '云端 D1' : '已灌入云端 D1' };
      }
      throw new Error('empty payload');
    }).catch(function () {
      return { data: window.REALEXAM_SEED || { questions: [], topics: [], papers: [] }, tag: '本地种子' };
    });
  }
  function loadMethod() {
    return request('/api/materials?id=' + encodeURIComponent('method-2027')).then(function (res) {
      if (res.ok && res.j && res.j.payload && res.j.payload.items && res.j.payload.items.length) {
        return res.j.payload;
      }
      throw new Error('empty method');
    }).catch(function () {
      return window.METHOD_SEED || null;
    });
  }
  function loadKnowledge() {
    return request('/api/materials?id=' + encodeURIComponent('knowledge-2027')).then(function (res) {
      if (res.ok && res.j && res.j.payload && res.j.payload.points && res.j.payload.points.length) {
        return res.j.payload;
      }
      throw new Error('empty knowledge');
    }).catch(function () {
      return window.KNOWLEDGE_SEED || null;
    });
  }
  function setCloudLabel() {
    var e = $('reCloud'); if (!e) return;
    e.textContent = '资料：' + sourceTag + ' · 进度：' + (cloudOK ? '云端已保存' : '本机即时保存') +
      (cloudAt ? '（' + fmt(cloudAt) + '）' : '');
    e.className = 're-cloud' + (cloudOK ? '' : ' warn');
  }
  function showRestore(msg) {
    var e = $('reRestore'); if (!e) return;
    e.innerHTML = '<b>已恢复上次进度</b>　' + esc(msg);
    e.hidden = false;
  }
  function cloudRestore() {
    var key = syncKey(), prev = '';
    try { prev = localStorage.getItem(K_LASTKEY) || ''; } catch (e) {}
    if (prev !== key) { cloudRev = 0; try { localStorage.setItem(K_LASTKEY, key); } catch (e) {} }
    request('/api/progress?key=' + encodeURIComponent(key) + '&material=' + encodeURIComponent(MID))
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 404) schedulePush();
          else showRestore(describeLast() + '（本机）');
          return;
        }
        var j = res.j || {};
        cloudRev = num(j.rev); cloudOK = true; cloudAt = num(j.updated_at);
        var localT = num(localStorage.getItem(K_STAMP));
        if (cloudAt > localT + 1000) {
          state = mergeState(state, normalizeState(jget2(j.state, {})));
          last = jget2(j.last, {});
          jset(K_STATE, state); jset(K_LAST, last);
          try { localStorage.setItem(K_STAMP, String(cloudAt)); } catch (e) {}
          applyLast(); renderAll();
          showRestore(describeLast() + '（云端 ' + fmt(cloudAt) + '）');
        } else {
          showRestore(describeLast() + '（本机）');
          if (localT > 0) schedulePush();
        }
        setCloudLabel();
      }).catch(function () { showRestore(describeLast() + '（本机，云端暂不可用）'); setCloudLabel(); });
  }
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; pushCloud(); }, 1200);
  }
  function pushCloud() {
    var body = { key: syncKey(), material: MID,
      state: JSON.stringify(state), last: JSON.stringify(last), rev: cloudRev };
    request('/api/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) {
          cloudRev = num(res.j.rev) || cloudRev; cloudOK = true;
          cloudAt = num(res.j.updated_at) || Date.now(); retrying = false; setCloudLabel();
        } else if (res.status === 409 && !retrying) {
          retrying = true; cloudRev = num(res.j && res.j.rev) || cloudRev; pushCloud();
        }
      }).catch(function () {});
  }

  /* ---------------- 进度模型 ---------------- */
  function blank() { return { w: 0, r: 0, n: 0, t: 0, last: 'w', pick: '', m: 0 }; }
  function normalizeState(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (k) {
      var o = raw[k];
      if (!o || typeof o !== 'object') return;
      if (typeof o.w === 'number' || typeof o.r === 'number') {
        var w0 = Math.max(0, num(o.w)), r0 = Math.max(0, num(o.r));
        out[k] = { w: w0, r: r0, n: Math.max(num(o.n), w0 + r0), t: num(o.t),
                   last: o.last === 'r' ? 'r' : 'w', pick: o.pick || '', m: o.m ? 1 : 0 };
      } else {
        var cnt = Math.max(1, num(o.n) || 1), ok = o.s === 'right' || o.s === 'mastered';
        out[k] = { w: ok ? 0 : cnt, r: ok ? cnt : 0, n: cnt, t: num(o.t),
                   last: ok ? 'r' : 'w', pick: o.pick || '', m: 0 };
      }
    });
    return out;
  }
  function mergeState(a, b) {
    var out = {}, seen = {};
    Object.keys(a || {}).concat(Object.keys(b || {})).forEach(function (k) { seen[k] = 1; });
    Object.keys(seen).forEach(function (k) {
      var x = a[k], y = b[k];
      if (!x) { out[k] = y; return; }
      if (!y) { out[k] = x; return; }
      var w = Math.max(num(x.w), num(y.w)), r = Math.max(num(x.r), num(y.r));
      var newer = num(y.t) >= num(x.t) ? y : x;
      out[k] = { w: w, r: r, n: Math.max(num(x.n), num(y.n), w + r),
                 t: Math.max(num(x.t), num(y.t)), last: newer.last || 'w',
                 pick: newer.pick || '', m: newer.m ? 1 : 0 };
    });
    return out;
  }
  function record(q, ok, pick) {
    var o = state[q.id];
    if (!o || typeof o.w !== 'number') o = normalizeState({ x: o }).x || blank();
    o.w = num(o.w) + (ok ? 0 : 1);
    o.r = num(o.r) + (ok ? 1 : 0);
    o.n = o.w + o.r; o.t = Date.now(); o.last = ok ? 'r' : 'w'; o.pick = pick;
    state[q.id] = o;
  }
  /* ★ 唯一能推进度指针的函数 */
  function commitAnswer(q, pick, ok) {
    var t = Date.now();
    last = { qid: q.id, year: q.year, no: q.no, pick: pick || '',
      result: ok ? 'r' : 'w', filter: {
        topic: filter.topic, year: filter.year, type: filter.type, sort: filter.sort, q: filter.q },
      answeredAt: t, t: t };
    jset(K_STATE, state); jset(K_LAST, last);
    try { localStorage.setItem(K_STAMP, String(t)); } catch (e) {}
    schedulePush();
    var btn = $('reResume');
    if (btn) { btn.textContent = '回到上次作答：' + describeLast(); btn.hidden = false; }
  }
  function persistView() {
    jset(K_VIEW, { view: view, topic: filter.topic, trap: filter.trap, year: filter.year,
      type: filter.type, sort: filter.sort, q: filter.q, rnd: num(filter.rnd) });
  }
  function describeLast() {
    if (!last || !last.qid) return '从第 1 题开始';
    var q = byId(last.qid);
    return q ? (q.year + ' 年 · 第 ' + q.no + ' 题' + (last.pick ? '（选 ' + last.pick + '）' : '')) : '从第 1 题开始';
  }
  function applyLast() {
    var v = jget(K_VIEW, null) || (last && last.filter) || {};
    if (v.view === 'method' || v.view === 'knowledge') view = v.view;
    filter.topic = v.topic || ''; filter.trap = v.trap || ''; filter.year = num(v.year);
    filter.type = v.type || ''; filter.sort = v.sort || 'new'; filter.q = v.q || '';
    filter.rnd = num(v.rnd);
    resetReveal();
    if (last && last.pick) sel = String(last.pick).split('').filter(function (c) { return 'ABCD'.indexOf(c) >= 0; });
    if (last && last.qid) {
      var l = visible(), found = -1;
      for (var i = 0; i < l.length; i++) if (l[i].id === last.qid) { found = i; break; }
      if (found < 0) {
        // 当前筛选不含上次作答题 → 自动放宽到该题所在年份，保证「回到上次作答」一定定位得到
        var q = byId(last.qid);
        if (q) {
          filter = { topic: '', trap: '', year: q.year, type: '', sort: 'new', q: '' };
          l = visible();
          for (var j = 0; j < l.length; j++) if (l[j].id === q.id) { found = j; break; }
        }
      }
      if (found >= 0) idx = found;
    }
    syncControls(); renderResumeNote();
    var btn = $('reResume');
    if (btn && last && last.qid) { btn.textContent = '回到上次作答：' + describeLast(); btn.hidden = false; }
  }
  function renderResumeNote() {
    var e = $('reResumeNote'); if (!e) return;
    if (!last || !last.qid) { e.hidden = true; e.innerHTML = ''; return; }
    e.hidden = false;
    e.innerHTML = '<b>已恢复到上次作答</b>　' + esc(describeLast()) +
      (last.result ? '（' + (last.result === 'r' ? '答对' : '答错') + '）' : '') +
      '　翻页 / 浏览 / 搜索都不会改动这个进度。' +
      '<button type="button" id="reSeeLast" class="re-btn-ghost">查看上次结果</button>';
    $('reSeeLast').addEventListener('click', function () {
      var q = byId(last.qid); if (!q) return;
      filter = { topic: '', trap: '', year: q.year, type: '', sort: 'new', q: '' };
      resetReveal();
      var l = visible();
      for (var i = 0; i < l.length; i++) if (l[i].id === q.id) { idx = i; break; }
      if (last.pick) sel = String(last.pick).split('').filter(function (c) { return 'ABCD'.indexOf(c) >= 0; });
      revealed = true; revealedFor = q.id; verdict = (last.result === 'r'); feedback = null;
      syncControls(); renderAll();
    });
  }

  /* ---------------- 从肖八跳转来的来源条（逐题级联动） ---------------- */
  var CN8 = '一二三四五六七八';
  function fromInfo(id) {
    var m = /^X8-(\d+)-(\d+)$/.exec(id || '');
    if (!m) return null;
    var o = jget(X8_STATE, {})[id] || {};
    return { id: id, paper: Number(m[1]), no: Number(m[2]),
      label: '卷' + (CN8[Number(m[1]) - 1] || m[1]) + ' · 第 ' + Number(m[2]) + ' 题',
      w: num(o.w), r: num(o.r) };
  }
  function renderFrom() {
    var e = $('reFrom'); if (!e) return;
    if (!fromX8) { e.hidden = true; e.innerHTML = ''; return; }
    var f = fromInfo(fromX8);
    e.hidden = false;
    e.innerHTML = '<div class="re-from-in"><b>从肖八错题跳来</b>　' +
      (f ? esc(f.label) + '（累计答错 ' + f.w + ' 次 · 答对 ' + f.r + ' 次）' : esc(fromX8)) +
      (filter.topic && filter.topic !== '__none__'
        ? '　·　正在补考点「<b>' + esc(filter.topic) + '</b>」' : '') +
      '　<span class="re-from-tip">这是延伸视图，做完可回肖八继续；跳转不改变任何学习进度</span></div>' +
      '<div class="re-from-act">' +
      (f ? '<a class="re-btn-ghost" href="#/#q=' + esc(f.id) + '&p=' + f.paper +
        '&mode=practice">← 返回肖八原题</a>' : '') +
      '<button type="button" class="re-btn-ghost" data-act="clearfrom">清除来源</button></div>';
  }
  function renderResumeButton() {
    var btn = $('reResume');
    if (btn && last && last.qid) { btn.textContent = '回到上次作答：' + describeLast(); btn.hidden = false; }
  }

  /* ---------------- 筛选 / 渲染 ---------------- */
  function byId(id) {
    for (var i = 0; i < questions.length; i++) if (questions[i].id === id) return questions[i];
    return null;
  }
  function topicInfo(term) {
    var list = (data && data.topics) || [];
    for (var i = 0; i < list.length; i++) if (list[i].term === term) return list[i];
    return null;
  }
  function hotScore(q) {
    var best = 0;
    (q.topics || []).forEach(function (t) {
      var i = topicInfo(t);
      if (i) best = Math.max(best, num(i.years) * 10 + Math.min(num(i.count), 200) / 100);
    });
    return best;
  }
  function visible() {
    var s = (filter.q || '').trim().toLowerCase();
    var out = questions.filter(function (q) {
      if (filter.topic === '__none__') { if (q.topics && q.topics.length) return false; }
      else if (filter.topic && (!q.topics || q.topics.indexOf(filter.topic) < 0)) return false;
      if (filter.trap) {
        var tags = (q.trapTags || []).concat(q.traps || []);
        if (tags.indexOf(filter.trap) < 0) return false;
      }
      if (filter.year === -1) { if (!q.simulated) return false; }
      else if (filter.year && q.year !== filter.year) return false;
      if (filter.type && q.type !== filter.type) return false;
      if (s) {
        var hay = (q.id + ' ' + q.year + ' ' + q.stem + ' ' + ['A', 'B', 'C', 'D']
          .map(function (L) { return q.options[L] || ''; }).join(' ') + ' ' + (q.topics || []).join(' ')).toLowerCase();
        if (hay.indexOf(s) < 0) return false;
      }
      return true;
    });
    out.sort(function (a, b) {
      if (filter.sort === 'random') return hashId(a.id, filter.rnd) - hashId(b.id, filter.rnd);
      if (filter.sort === 'old') return a.year - b.year || a.no - b.no;
      if (filter.sort === 'hot') return hotScore(b) - hotScore(a) || b.year - a.year || a.no - b.no;
      return b.year - a.year || a.no - b.no;
    });
    return out;
  }
  function canReveal(q) { return revealed && revealedFor === q.id; }
  function resetReveal() { revealed = false; revealedFor = null; sel = []; verdict = null; feedback = null; }

  function renderAll() {
    renderStats(); renderControls(); renderFrom(); renderWeak(); renderCard(); renderTopics();
  }
  function renderStats() {
    var c = (data && data.counts) || {};
    $('rePapers').textContent = c.papers || '—';
    $('reTotal').textContent = c.usable || questions.length || '—';
    $('reTopics').textContent = c.topics || ((data && data.topics || []).length) || '—';
    $('reExplain').textContent = c.withExplain || '—';
    var note = $('reStatNote');
    if (note) {
      note.textContent = c.questions
        ? '真题 ' + c.questions + ' 道 · 米六模拟 ' + num(c.simulated) + ' 道（不计入真题统计）· 手册遴选 19 道已并入 · 错因解析 133 条'
        : '';
    }
    var el = $('reTotal');
    if (el) el.title = '真题 ' + num(c.questions) + ' 道 + 米六模拟 ' + num(c.simulated) + ' 道';
  }
  function syncControls() {
    if ($('reTopic')) $('reTopic').value = filter.topic || '';
    if ($('reTrap')) $('reTrap').value = filter.trap || '';
    if ($('reYear')) $('reYear').value = String(filter.year || 0);
    if ($('reType')) $('reType').value = filter.type || '';
    if ($('reSort')) $('reSort').value = filter.sort || 'new';
    if ($('reQ')) $('reQ').value = filter.q || '';
  }
  function renderControls() {
    var tp = $('reTopic'), yr = $('reYear');
    if (tp && !tp.dataset.ready) {
      var list = (data && data.topics) || [];
      tp.innerHTML = '<option value="">全部考点</option>' + list.map(function (t) {
        return '<option value="' + esc(t.term) + '">' + esc(t.term) + '（' + num(t.questionCount) + ' 题）</option>';
      }).join('') + '<option value="__none__">未归类考点</option>';
      tp.dataset.ready = '1';
    }
    if (yr && !yr.dataset.ready) {
      var years = (data && data.years) ||
        ((data && data.papers) || []).map(function (p) { return p.year; });
      yr.innerHTML = '<option value="0">全部年份</option>' + years.map(function (y) {
        return '<option value="' + y + '">' + y + ' 年</option>';
      }).join('') + '<option value="-1">模拟题（米六）</option>';
      yr.dataset.ready = '1';
    }
    var tr = $('reTrap');
    if (tr && !tr.dataset.ready) {
      var tags = (method && method.trapTagList) || [];
      var tset = {}, tlist = [];
      questions.forEach(function (q) {
        (q.traps || []).forEach(function (t) { if (!tset[t]) { tset[t] = 1; tlist.push(t); } });
      });
      tr.innerHTML = '<option value="">全部错因</option>' +
        (tags.length ? '<optgroup label="陷阱类型">' + tags.map(function (t) {
          return '<option value="' + esc(t.tag) + '">' + esc(t.tag) + '（' + t.count + ' 题）</option>';
        }).join('') + '</optgroup>' : '') +
        (tlist.length ? '<optgroup label="手册专题">' + tlist.map(function (t) {
          return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
        }).join('') + '</optgroup>' : '');
      tr.dataset.ready = '1';
    }
    syncControls();
  }

  /* 薄弱考点：读肖八错题状态 + 轻量映射，不加载肖八题库 */
  function weakTopics() {
    var x8 = jget(X8_STATE, {}), map = (data && data.xiao8TopicMap) || {}, c = {};
    Object.keys(x8).forEach(function (id) {
      var o = x8[id];
      if (!o || !(num(o.w) > 0) || o.arch) return;
      (map[id] || []).forEach(function (t) { c[t] = num(c[t]) + Math.max(1, num(o.w)); });
    });
    return Object.keys(c).map(function (term) {
      var t = topicInfo(term) || {};
      return { term: term, weight: num(c[term]), years: num(t.years), count: num(t.count), questions: num(t.questionCount) };
    }).sort(function (a, b) { return b.weight - a.weight || b.years - a.years; }).slice(0, 6);
  }
  function renderWeak() {
    var box = $('reWeakList'); if (!box) return;
    var list = weakTopics();
    if (!list.length) {
      box.innerHTML = '<div class="re-weak-empty">肖八错题本还没有错题，或错题暂未匹配到恒重考点。' +
        '先去 <a href="#/">肖八逐题精练</a> 做几题，这里会自动算出你最该补的考点。</div>';
      return;
    }
    box.innerHTML = list.map(function (t) {
      return '<div class="re-weak-item"><h3>' + esc(t.term) + '</h3><p>肖八累计错 <b>' + t.weight +
        '</b> 次 · 真题收录 <b>' + t.questions + '</b> 道 · 近 11 年考过 <b>' + t.years +
        '</b> 年</p><button type="button" class="re-btn-ghost" data-act="topic" data-t="' + esc(t.term) +
        '">练这个考点的历年真题 →</button></div>';
    }).join('');
  }

  function renderCard() {
    var box = $('reCard'), list = visible();
    var info = $('reInfo');
    if (info) info.textContent = '当前范围 ' + list.length + ' 题 / 共 ' + questions.length + ' 题';
    if (revealedFor && (!list.length || list[clamp(idx, 0, list.length - 1)].id !== revealedFor)) resetReveal();
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="re-empty">这个筛选下没有真题。该考点可能暂无收录题，' +
        '或年份 / 题型筛得太窄。<br><button type="button" class="re-btn-ghost" data-act="alltopic" ' +
        'style="margin-top:10px">清空筛选看全部真题</button></div>';
      $('rePos').textContent = '—';
      return;
    }
    idx = clamp(idx, 0, list.length - 1);
    var q = list[idx], o = state[q.id], show = canReveal(q);
    var chips = '<span class="re-chip">' +
      (q.year ? q.year + ' 年 · 第 ' + q.no + ' 题' : '模拟题 · ' + esc(q.src || '米六')) + '</span>' +
      '<span class="re-chip type">' + (q.type === 'single' ? '单选 · 1 分' : '多选 · 2 分') + '</span>' +
      (q.simulated ? '<span class="re-chip sim">模拟题 · 不计入真题</span>' : '');
    (q.topics || []).slice(0, 3).forEach(function (t) {
      var i = topicInfo(t);
      chips += '<span class="re-chip hot">' + esc(t) + (i ? ' · ' + num(i.years) + '/11 年' : '') + '</span>';
    });
    if (o && (num(o.w) + num(o.r)) > 0) {
      chips += '<span class="re-chip state ' + (o.last === 'r' ? 'ok' : 'bad') + '">做过 ' + num(o.n) +
        ' 次 · 对 ' + num(o.r) + ' · 错 ' + num(o.w) + '</span>';
    }
    var pct = Math.round((idx + 1) / list.length * 100);
    var html = '<div class="re-progress" title="当前范围进度 ' + (idx + 1) + '/' + list.length +
      '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="re-chead">' + chips + '<span class="re-qid">' + esc(q.id) + '</span></div>' +
      '<div class="re-stem">' + esc(q.stem) + '</div><div class="re-opts">';
    ['A', 'B', 'C', 'D'].forEach(function (L) {
      var cls = 're-opt';
      if (show) {
        if (String(q.answer).indexOf(L) >= 0) cls += ' correct';
        else if (sel.indexOf(L) >= 0) cls += ' wrong';
      } else if (sel.indexOf(L) >= 0) cls += ' sel';
      html += '<button type="button" class="' + cls + '" data-act="pick" data-l="' + L + '"' +
        (show ? ' disabled' : '') + '><b>' + L + '</b><span>' + esc(q.options[L] || '') + '</span></button>';
    });
    html += '</div><div class="re-actions">';
    if (!show) {
      var restored = last && last.qid === q.id && last.pick && sel.length;
      html += '<button type="button" class="re-btn-main" data-act="submit">提交作答（Enter）</button>' +
        '<button type="button" class="re-btn-ghost" data-act="clear">清空选择</button>' +
        '<span class="re-hint">' + (restored
          ? '已恢复上次所选 <b>' + esc(last.pick) + '</b>；提交后看本次结果'
          : '单选点选项即判分；多选可点多个再提交。作答前不显示答案、正确选项与解析') + '</span>';
    } else {
      var pick = sel.slice().sort().join('');
      html += '<div class="re-result"><div class="re-answer' + (verdict ? '' : ' bad') + '">' +
        (verdict ? '✓ 答对了' : '✗ 答错了') + '　正确答案：<b>' + esc(q.answer) + '</b>　你的选择：' +
        (pick ? esc(pick) : '未选') + '</div>' +
        '<div class="re-explain"><b class="re-explain-t">知识点解析</b>　' + (q.explain ? esc(q.explain) :
          '该年份解析段未提取到本题解析，请以原卷为准；本页不编造。') +
        '<span class="re-explain-src">来源：' + (q.year ? q.year + ' 年真题 · 试卷 p' +
        (q.pages && q.pages[0] ? q.pages[0] : '—') + ' / 解析 p' +
        (q.pages && q.pages[1] ? q.pages[1] : '—') : '米六模拟 · ' + esc(q.src || '')) +
        ' · PDF 文字层整理，识别误差以原卷为准</span>' +
        '</div>' + knowledgeLink(q) + renderTrap(q, verdict) + renderFeedback(q) +
        renderEvolution(q) + '</div>';
      html += '<div class="re-rate"><span>自评只做标记，不改统计：</span>' +
        '<button type="button" class="re-btn-ghost" data-act="rate" data-v="again">1 再练</button>' +
        '<button type="button" class="re-btn-ghost" data-act="rate" data-v="marked">2 会了</button>' +
        '<button type="button" class="re-btn-ghost" data-act="next">下一题 →</button></div>';
    }
    html += '</div>';
    box.innerHTML = html;
    $('rePos').textContent = (idx + 1) + ' / ' + list.length;
  }
  /* 墓碑词自动标红：先转义再替换，避免把 HTML 当文本执行 */
  function hl(s) {
    var out = esc(s || '');
    for (var i = 0; i < TRAP_WORDS.length; i++) {
      var w = TRAP_WORDS[i];
      if (out.indexOf(w) < 0) continue;
      out = out.split(w).join('<b class="re-tw">' + w + '</b>');
    }
    return out;
  }
  /* 手册解析里作者用 ❌ / ✅ 标注错误与正确说法：符号着色，配合墓碑词标红 */
  function markExplain(s) {
    return hl(s || '')
      .replace(/❌/g, '<b class="re-xmark bad">❌</b>')
      .replace(/✅/g, '<b class="re-xmark ok">✅</b>');
  }
  /* 错因解析（手册）：只在本题提交作答后出现；答错时红色强调，答对时普通样式 */
  function renderTrap(q, ok) {
    if (!q.methodExplain && !(q.trapTags || []).length) return '';
    var tags = [];
    (q.trapTags || []).concat(q.traps || []).forEach(function (t) {
      if (t && tags.indexOf(t) < 0) tags.push(t);
    });
    return '<div class="re-trap' + (ok ? '' : ' bad') + '">' +
      '<div class="re-trap-head"><b>错因解析（手册）</b>' +
      (tags.length ? '<span>' + tags.map(esc).join(' · ') + '</span>' : '') +
      (q.methodNo ? '<button type="button" class="re-trap-link" data-act="tomethod" data-no="' +
        num(q.methodNo) + '">看这条方法 →</button>' : '') + '</div>' +
      (q.methodExplain ? '<div class="re-trap-text">' + markExplain(q.methodExplain) + '</div>' : '') +
      '</div>';
  }

  function renderFeedback(q) {
    if (!feedback || feedback.id !== q.id) return '';
    var f = feedback, t = topicInfo((q.topics || [])[0]);
    return '<div class="re-feedback"><b>本次作答反馈</b><br>' +
      '累计答对 <b>' + f.after.r + '</b> 次 · 累计答错 <b>' + f.after.w + '</b> 次' +
      (f.after.w > f.before.w ? '（本次答错 +1）' : '') + '<br>' +
      (t ? '本题关联恒重考点「<b>' + esc(t.term) + '</b>」：近 11 年考过 ' + num(t.years) +
        ' 年、出现 ' + num(t.count) + ' 次，真题库收录 ' + num(t.questionCount) + ' 道。' :
        '本题暂未匹配到恒重考点，可切到「按年份」继续练。') +
      '<br>答错记录会保留，进度停在本题直到你完成下一道题。' +
      (f.streak >= 2 ? '<div class="re-streak">连错 <b>' + num(f.streak) +
        '</b> 题了，先别硬刷——把对应陷阱的方法看一遍再回来。' +
        '<button type="button" class="re-btn-ghost" data-act="tomethod" data-no="' +
        num(f.methodNo) + '">' + (f.methodNo ? '看对应方法 →' : '去方法库 →') + '</button></div>' : '') +
      '</div>';
  }
  /* 同考点跨年份考法：只列题干摘要与作答状态，绝不列答案/正确选项/解析。
     仅在对本题提交作答后出现，点「练这题」跳转时一律 resetReveal。 */
  function focusTopic(q) {
    if (filter.topic && filter.topic !== '__none__') return filter.topic;
    return (q.topics || [])[0] || '';
  }
  function renderEvolution(q) {
    var t = focusTopic(q);
    if (!t) return '';
    var sibs = questions.filter(function (x) {
      return x.id !== q.id && (x.topics || []).indexOf(t) >= 0;
    }).sort(function (a, b) { return b.year - a.year || a.no - b.no; });
    if (!sibs.length) return '';
    var ti = topicInfo(t);
    var html = '<details class="re-evo"><summary>同考点跨年份考法 · 「' + esc(t) + '」共 ' +
      (sibs.length + 1) + ' 题' + (ti ? '（近 11 年考过 ' + num(ti.years) + ' 年）' : '') +
      '<span>展开看这些年怎么变形；列表只有题干，答案仍需逐题作答后揭晓</span></summary>' +
      '<div class="re-evo-list">';
    sibs.slice(0, 12).forEach(function (x) {
      var o = state[x.id], done = o && (num(o.w) + num(o.r)) > 0;
      html += '<div class="re-evo-row"><span class="re-evo-y">' + x.year + ' · 第 ' + x.no + ' 题 · ' +
        (x.type === 'single' ? '单选' : '多选') + '</span>' +
        '<span class="re-evo-s">' + esc(x.stem.slice(0, 78)) + (x.stem.length > 78 ? '…' : '') + '</span>' +
        '<span class="re-evo-st">' + (done ? '做过 ' + num(o.n) + ' 次' : '未做') + '</span>' +
        '<button type="button" class="re-btn-ghost" data-act="evo" data-q="' + esc(x.id) + '">练这题 →</button></div>';
    });
    if (sibs.length > 12) html += '<div class="re-evo-more">另有 ' + (sibs.length - 12) +
      ' 题，可用上方考点筛选继续查看。</div>';
    return html + '</div></details>';
  }
  /* ---------------- 解题方法库（/api/materials?id=method-2027） ---------------- */
  function countTrap(tag) {
    var n = 0;
    questions.forEach(function (q) {
      if ((q.trapTags || []).indexOf(tag) >= 0 || (q.traps || []).indexOf(tag) >= 0) n++;
    });
    return n;
  }
  function renderMethodGroups() {
    var box = $('reMethodGroups'); if (!box) return;
    if (!method) { box.innerHTML = ''; return; }
    box.innerHTML = method.groups.map(function (g) {
      return '<button type="button" class="re-mgroup' + (g.key === methodGroup ? ' on' : '') +
        '" data-act="mgroup" data-g="' + esc(g.key) + '">' + esc(g.name) +
        '<span>' + num(g.count) + '</span></button>';
    }).join('');
  }
  /* ---- 方法正文富文本渲染（借鉴《一页纸解题方法手册V1.0.html》的排版） ----
     · 以标点开头的行接回上一行，修复 PDF 断行残留
     · 真题例证（A. 选项行 / 2025-24 引用行）打包成引用卡片
     · ✅ / ❌ 行分色，年份-题号引用标来源，短行作小标题
     · 按「本条方法」的标题 / 标志词精准高亮，不再全篇铺满红色
     一律先 esc 再替换，原文不当 HTML 执行。 */
  var GROUP_KW = {
    '绝对化词': ['必须', '一定', '绝对', '所有', '一切', '总是', '任何', '任意', '凡是', '全都'],
    '简单化词': ['只能', '只是', '单纯', '纯粹', '唯一', '一元', '总和', '线性', '机械', '直观', '无差别'],
    '时态词': ['已经', '实现了', '完成了', '一开始就', '同时', '同步', '不再'],
    '夸张词': ['彻底', '根本', '决定', '取代', '代替', '主导', '主体', '主要', '主线', '全面', '完整', '破解了'],
    '否定词': ['不再', '没有', '不可能', '不包含', '否认', '并非'],
    '比较词': ['更优越', '更强大', '更重要', '更高级', '高于', '超越', '一样', '一致'],
    '好词': []
  };
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function methodKeywords(it) {
    var kw = [];
    String(it.title || '').replace(/[⚠️⭐\uFE0F]/g, '')
      .split(/[，,、\/／\s]+/).forEach(function (x) {
        x = x.trim(); if (x && x.length <= 8 && kw.indexOf(x) < 0) kw.push(x);
      });
    (GROUP_KW[it.trapTag] || []).forEach(function (x) { if (kw.indexOf(x) < 0) kw.push(x); });
    (it.signs || []).forEach(function (x) { if (x && x.length <= 6 && kw.indexOf(x) < 0) kw.push(x); });
    if (!kw.length) return TRAP_WORDS.slice();
    return kw.sort(function (a, b) { return b.length - a.length; });
  }
  function markLine(line, kw, plain) {
    var h = esc(line);
    if (!plain && kw && kw.length) {
      try {
        h = h.replace(new RegExp('(' + kw.map(escapeRe).join('|') + ')', 'g'), '<b class="re-tw">$1</b>');
      } catch (e) {}
    }
    return h.replace(/(\d{4}[-–—]\d{1,2})/g, '<span class="re-msrc">$1</span>');
  }
  function renderMethodBody(it, kw) {
    var lines = [];
    String(it.body || '').split('\n').forEach(function (l) {
      l = l.trim(); if (!l) return;
      if (lines.length && /^[，。、；：？！）】」』%]/.test(l)) lines[lines.length - 1] += l;
      else lines.push(l);
    });
    var chunks = [], box = [];
    lines.forEach(function (l) {
      if (/^[A-D][.、．]/.test(l) || /^（?\d{4}[-–—]\d{1,2}）?/.test(l)) { box.push(l); return; }
      if (box.length) { chunks.push({ box: box }); box = []; }
      chunks.push({ line: l });
    });
    if (box.length) chunks.push({ box: box });
    var out = chunks.map(function (c) {
      if (c.box) {
        return '<div class="re-mqbox">' + c.box.map(function (l) {
          return '<div class="re-mql' + (/^[A-D][.、．]/.test(l) ? ' opt' : '') + '">' +
            markLine(l, kw, true) + '</div>';
        }).join('') + '</div>';
      }
      var l = c.line, cls = 're-mline';
      if (l.indexOf('❌') >= 0) cls += ' bad';
      else if (l.indexOf('✅') >= 0 || l.indexOf('✔') >= 0) cls += ' ok';
      if (l.length <= 12 && !/[。，；：、？！A-Za-z]/.test(l) && !/^[A-D][.、．]/.test(l)) cls += ' head';
      if (it.group === 'good' && (l.length <= 12 || /[A-Za-z]/.test(l))) cls += ' goodred';
      return '<div class="' + cls + '">' + markLine(l, kw, / bad| ok/.test(cls)) + '</div>';
    }).join('');
    return '<div class="re-method-body rich">' + out + '</div>';
  }
  /* 「写在前面」：默认折叠的引导卡，内容来自同一份 D1 资料（已过滤宣传） */
  function renderGuide() {
    var box = $('reGuide'), body = $('reGuideBody');
    if (!box || !body) return;
    var g = method && method.guide;
    if (!g || !g.lead) { box.hidden = true; return; }
    box.hidden = false;
    var h = '<p class="re-guide-lead">' + esc(g.lead) + '</p><div class="re-guide-grid">';
    (g.points || []).forEach(function (p) {
      h += '<div class="re-guide-p"><b>' + esc(p.t) + '</b><span>' + esc(p.d) + '</span></div>';
    });
    h += '</div><div class="re-guide-route"><b>建议路径</b>' +
      (g.route || []).map(function (r) { return '<span>' + esc(r) + '</span>'; }).join('') + '</div>';
    if (g.caveat) h += '<p class="re-guide-caveat">' + esc(g.caveat) + '</p>';
    body.innerHTML = h;
  }
  function renderMethodList() {
    var box = $('reMethodList'); if (!box) return;
    if (!method) {
      box.innerHTML = '<div class="re-empty">方法库暂未加载成功，刷新重试；刷题功能不受影响。</div>';
      return;
    }
    var kw = (methodQ || '').trim().toLowerCase();
    var list = method.items.filter(function (it) {
      if (!kw) return it.group === methodGroup;
      return (it.title + ' ' + it.oneLine + ' ' + it.body + ' ' + (it.signs || []).join(' '))
        .toLowerCase().indexOf(kw) >= 0;
    });
    var info = $('reMethodInfo');
    if (info) {
      info.textContent = kw ? ('搜索到 ' + list.length + ' 条')
        : ('本组 ' + list.length + ' 条 / 共 ' + method.items.length + ' 条');
    }
    if (!list.length) { box.innerHTML = '<div class="re-empty">没有匹配的方法，换个关键词试试。</div>'; return; }
    var legend = '<div class="re-mlegend"><span><b class="re-tw">红色加粗</b>＝本条方法要认的标志词</span>' +
      '<span>方框＝手册引用的真题例证</span>' +
      '<span><i class="re-msrc">2025-24</i>＝真题出处</span>' +
      '<span>绿行 ✅ 正确说法 / 红行 ❌ 错误说法</span></div>';
    box.innerHTML = legend + list.map(function (it) {
      var kw = methodKeywords(it);
      var tag = it.trapTag && it.trapTag !== '其他' ? it.trapTag : (it.trap || '');
      var n = tag ? countTrap(tag) : 0;
      var isFocus = focusNo === it.no;
      return '<details class="re-method' + (isFocus ? ' focus' : '') + '"' +
        (isFocus || list.length <= 12 ? ' open' : '') + ' data-no="' + it.no + '">' +
        '<summary><b>' + esc(it.title) + '</b>' +
        '<span class="re-method-path">' + esc((it.path || []).join(' › ')) + '</span></summary>' +
        '<p class="re-method-one">' + markLine(it.oneLine, kw, false) + '</p>' +
        ((it.signs || []).length ? '<div class="re-method-signs">' + it.signs.map(function (w) {
          return '<span>' + esc(w) + '</span>';
        }).join('') + '</div>' : '') +
        renderMethodBody(it, kw) +
        '<div class="re-method-foot">' +
        ((it.examples || []).length ? '<span class="re-method-ex">例证：' + it.examples.map(function (e) {
          return e.id ? '<button type="button" data-act="gotoq" data-q="' + esc(e.id) + '">' +
            esc(e.label) + '</button>' : esc(e.label);
        }).join(' / ') + '</span>' : '<span></span>') +
        (tag ? '<button type="button" class="re-btn-ghost" data-act="drill" data-trap="' + esc(tag) +
          '">练同类 · ' + esc(tag) + (n ? '（' + n + ' 题）' : '') + ' →</button>'
             : '<button type="button" class="re-btn-ghost" data-act="drill" data-trap="">去刷真题 →</button>') +
        '<button type="button" class="re-btn-ghost" data-act="tokn" data-kw="' +
          esc(knKeywords(it.title) || it.title) + '">查知识点册 →</button>' +
        '</div></details>';
    }).join('');
  }
  function renderMethods() { renderGuide(); renderToday(); renderMethodGroups(); renderMethodList(); }

  /* ---------------- 知识点一页纸（/api/materials?id=knowledge-2027） ----------------
     与解题方法册是同一套两册：题卡作答后 → 知识点；方法卡 → 知识点；
     知识点 → 真题 / 方法。肖八精简考点含各题结论，按红线只在自行作答后展开。 */
  function knKeywords(s) {
    return String(s || '').replace(/[（(【\[].*?[)）】\]]/g, '')
      .replace(/[“”"'，,。；;：:？！!、\/\s]/g, '').trim().slice(0, 14);
  }
  function countKnDrill(kw) {
    if (!kw) return questions.length;
    var k = String(kw).toLowerCase(), n = 0;
    questions.forEach(function (q) {
      if ((q.stem + ' ' + (q.topics || []).join(' ')).toLowerCase().indexOf(k) >= 0) n++;
    });
    return n;
  }
  function countKnMethod(kw) {
    if (!method || !kw) return method ? method.items.length : 0;
    var k = String(kw).toLowerCase(), n = 0;
    method.items.forEach(function (it) {
      if ((it.title + ' ' + it.oneLine + ' ' + (it.signs || []).join(' ') +
           ' ' + it.body).toLowerCase().indexOf(k) >= 0) n++;
    });
    return n;
  }
  function knowledgeLink(q) {
    if (!knowledge) return '';
    var kw = (q.topics || [])[0] ||
      String(q.stem || '').replace(/[“”"'（），,。？！\s]/g, '').slice(0, 10);
    return '<div class="re-kn-link">两册联动 · 本题线索「<b>' + esc(kw) + '</b>」' +
      '<button type="button" data-act="tokn" data-kw="' + esc(kw) + '">查知识点册 →</button></div>';
  }
  function renderKnGuide() {
    var box = $('reKnGuide'), body = $('reKnGuideBody');
    if (!box || !body) return;
    var p = knowledge && knowledge.provenance;
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    var rows = [['核心册', p.core], ['正文口径', p.cleanText], ['补齐说明', p.gapFixed],
                ['两册关系', p.twoVolumes], ['新增材料', p.supplements],
                ['未纳入', p.excluded], ['题本口径', p.questionBank], ['注意', p.caveat]];
    body.innerHTML = rows.map(function (r) {
      return r[1] ? '<p><b>' + esc(r[0]) + '：</b>' + esc(r[1]) + '</p>' : '';
    }).join('');
  }
  function renderKnStats() {
    var box = $('reKnStats'); if (!box) return;
    var c = knowledge && knowledge.counts || {};
    var rows = [
      [num(c.points), '编号知识点 · 无缺号'],
      [num(c.pdfPages), '原册页 · 逐页原文'],
      [num(c.statements) + ' / ' + num(c.classics), '正误表述 / 经典表述'],
      [num(c.z02) + ' / ' + num(c.z03Pages), 'Z02 新变 / Z03 时政页'],
      [num(c.xiao8Points), '肖八精简考点'],
      [num(c.extras), '组新增材料补充']
    ];
    box.innerHTML = rows.map(function (r) {
      return '<div class="re-kn-stat"><b>' + r[0] + '</b><span>' + esc(r[1]) + '</span></div>';
    }).join('');
    var cnt = $('reKnCount'); if (cnt) cnt.textContent = num(c.points) || 100;
  }
  function renderKnGroups() {
    var box = $('reKnGroups'); if (!box) return;
    if (!knowledge) { box.innerHTML = ''; return; }
    var gs = [{ name: '全部', count: knowledge.points.length }].concat(
      (knowledge.groups || []).map(function (g) { return { name: g.name, count: g.nums.length }; }));
    box.innerHTML = gs.map(function (g) {
      return '<button type="button" class="re-kn-group' + (g.name === knGroup ? ' on' : '') +
        '" data-act="kngroup" data-g="' + esc(g.name) + '">' + esc(g.name) +
        '<span>' + num(g.count) + '</span></button>';
    }).join('');
  }
  function renderKnList() {
    var box = $('reKnList'); if (!box) return;
    if (!knowledge) {
      box.innerHTML = '<div class="re-kn-empty">知识点册暂未加载成功，刷新重试；刷题与方法功能不受影响。</div>';
      return;
    }
    var k = (knQ || '').trim().toLowerCase();
    var list = knowledge.points.filter(function (p) {
      if (knGroup !== '全部' && p.ch !== knGroup) return false;
      if (!k) return true;
      return (p.num + ' ' + p.title + ' ' + p.sec + ' ' + (p.lines || []).join(' ') +
        ' ' + (p.mnemonic || '') + ' ' + (p.raw || '')).toLowerCase().indexOf(k) >= 0;
    });
    var fellBack = false;
    if (!list.length && k) {
      // 从题目/方法带关键词跳来时可能没有精确匹配：回退到全部，不显示空白页
      list = knowledge.points.filter(function (p) { return knGroup === '全部' || p.ch === knGroup; });
      knQ = ''; var qi = $('reKnQ'); if (qi) qi.value = '';
      fellBack = true;
    }
    var info = $('reKnInfo');
    if (info) info.textContent = (fellBack ? '未找到精确匹配，已显示全部 · ' : '') +
      '当前 ' + list.length + ' 条 / 共 ' + knowledge.points.length + ' 条';
    if (!list.length) { box.innerHTML = '<div class="re-kn-empty">没有匹配的知识点。</div>'; return; }
    box.innerHTML = list.map(function (p) {
      var kw = knKeywords(p.title) || p.title;
      var nd = countKnDrill(kw), nm = countKnMethod(kw);
      var focus = knFocus === p.num;
      return '<details class="re-kn-item' + (focus ? ' focus' : '') + '"' +
        (focus || list.length <= 8 ? ' open' : '') + ' data-num="' + esc(p.num) + '">' +
        '<summary><span class="re-kn-num">' + esc(p.num) + '</span><b>' + esc(p.title) + '</b>' +
        '<span class="re-kn-ch">' + esc(p.ch) + (p.sec ? ' · ' + esc(p.sec) : '') + '</span></summary>' +
        '<ul class="re-kn-lines">' + (p.lines || []).map(function (l) {
          return '<li>' + esc(l) + '</li>';
        }).join('') + '</ul>' +
        (p.mnemonic ? '<div class="re-kn-mnemonic">口诀 · ' + esc(p.mnemonic) + '</div>' : '') +
        (p.note ? '<p class="re-kn-note">' + esc(p.note) + '</p>' : '') +
        (p.raw ? '<details class="re-kn-raw"><summary>查看原册文字层（第 ' +
          num(p.pdfPage) + ' 页）</summary><pre>' + esc(p.raw) + '</pre></details>' : '') +
        '<div class="re-kn-foot"><span class="re-kn-src">《知识点手册》p' + num(p.pdfPage) +
        (p.origin === 'pdf' ? ' · 由原 PDF 补齐' : ' · 清洗版正文 + 原文兜底') + '</span>' +
        '<span><button type="button" class="re-btn-ghost" data-act="kndrill" data-kw="' +
        esc(nd ? kw : '') + '">' + (nd ? '练同类真题（' + nd + ' 题）→' : '去刷真题 →') + '</button> ' +
        '<button type="button" class="re-btn-ghost" data-act="knmethod" data-kw="' +
        esc(nm ? kw : '') + '">' + (nm ? '查相关方法（' + nm + ' 条）→' : '去方法库 →') +
        '</button></span></div></details>';
    }).join('');
  }
  function renderKnExtras() {
    var tabs = $('reKnExtraTabs'), box = $('reKnExtraList');
    if (!tabs || !box) return;
    var ex = (knowledge && knowledge.extras) || [];
    if (!ex.length) { tabs.innerHTML = ''; box.innerHTML = ''; return; }
    if (knExtra >= ex.length) knExtra = 0;
    tabs.innerHTML = ex.map(function (e, i) {
      return '<button type="button" class="re-kn-tab' + (i === knExtra ? ' on' : '') +
        '" data-act="knextra" data-i="' + i + '">' + esc(e.title) +
        '（' + num(e.items.length) + '）</button>';
    }).join('');
    var g = ex[knExtra];
    if (!g.items.length) { box.innerHTML = '<div class="re-kn-empty">本组暂无内容。</div>'; return; }
    box.innerHTML = (g.ocr ? '<div class="re-kn-ocr">扫描件 OCR 文本，识别有误，只作参考，一切以原卷为准</div>' : '') +
      g.items.map(function (it, i) {
        return '<details class="re-kn-extra"' + (g.items.length <= 3 ? ' open' : '') + '>' +
          '<summary>' + esc(it.title) + '</summary><pre>' + esc(it.text) + '</pre></details>';
      }).join('');
  }
  function renderKnX8() {
    var gate = $('reKnX8Gate'), box = $('reKnX8List'), info = $('reKnX8Info');
    var sel = $('reKnX8Paper'), kw = $('reKnX8Q');
    if (!gate || !box) return;
    var pts = (knowledge && knowledge.xiao8Points) || [];
    if (sel && sel.options.length <= 1) {
      for (var p = 1; p <= 8; p++) {
        var op = document.createElement('option'); op.value = String(p);
        op.textContent = '第 ' + p + ' 套卷'; sel.appendChild(op);
      }
    }
    if (sel) sel.value = String(knX8Paper);
    if (kw && kw.value !== knX8Q) kw.value = knX8Q;
    var allowed = knX8Open || !!knX8Only;
    if (knX8Only) {
      gate.innerHTML = '<b>已从作答后的题目跳来</b>：只显示该题对应的精简考点，' +
        '其余套卷的考点结论不展开，避免作答前看到答案。' +
        '<button type="button" class="re-btn-ghost" data-act="knx8all">查看全部（需先自行作答）</button>';
    } else if (!knX8Open) {
      gate.innerHTML = '<b>本组含各卷各题的考点结论</b>，相当于答案要点。' +
        '按项目红线，请先自行完成对应套卷再展开；未自行作答前一律不显示。' +
        '<br><button type="button" class="re-btn-ghost" data-act="knx8ok">我已自行作答，展开全部 →</button>';
      box.innerHTML = ''; if (info) info.textContent = '未展开';
      return;
    } else {
      gate.innerHTML = '<b>已确认自行作答</b>：以下为《27 肖八知识点精简版（全）》按卷题号整理的 264 条考点，' +
        '仅用于核对与背诵，不参与统计、不改动错题归属。';
    }
    var list = pts.filter(function (x) {
      if (knX8Only) return x.id === knX8Only;
      if (knX8Paper && x.paper !== knX8Paper) return false;
      if (knX8Q && (x.id + ' ' + x.text).toLowerCase().indexOf(knX8Q.toLowerCase()) < 0) return false;
      return true;
    });
    if (info) info.textContent = '显示 ' + list.length + ' 条 / 共 ' + pts.length + ' 条';
    if (!list.length) { box.innerHTML = '<div class="re-kn-empty">没有匹配的精简考点。</div>'; return; }
    box.innerHTML = (list.length > 60 ? '<div class="re-kn-note">条目较多，可用上方套卷筛选或搜索缩小范围。</div>' : '') +
      list.map(function (x) {
        return '<details class="re-kn-x8-item"><summary>第 ' + num(x.paper) +
          ' 套卷 · 第 ' + num(x.no) + ' 题 <span class="re-kn-ch">' + esc(x.id) +
          '</span></summary><div class="re-kn-x8-text">' + esc(x.text) + '</div></details>';
      }).join('');
  }
  function renderKnowledge() {
    renderKnGuide(); renderKnStats(); renderKnGroups(); renderKnList();
    renderKnExtras(); renderKnX8();
  }
  function drillKn(kw) {
    filter = { topic: '', trap: '', year: 0, type: '', sort: 'new', q: String(kw || ''), rnd: 0 };
    var q = $('reQ'); if (q) q.value = filter.q;
    syncControls(); resetReveal(); idx = 0;
    setView('drill', { quiet: true }); renderAll();
  }
  function methodKn(kw) {
    methodGroup = 'think'; methodQ = String(kw || ''); focusNo = 0;
    var q = $('reMethodQ'); if (q) q.value = methodQ;
    setView('method', { quiet: true });
  }
  function gotoKn(kw, num2) {
    knGroup = '全部'; knQ = String(kw || ''); knFocus = num2 || '';
    var q = $('reKnQ'); if (q) q.value = knQ;
    setView('knowledge', { quiet: true });
    if (knFocus) {
      setTimeout(function () {
        var el = document.querySelector('#reKnList [data-num="' + knFocus + '"]');
        if (el) { el.open = true; el.classList.add('focus');
          try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} }
      }, 80);
    }
  }
  function todayMethod() {
    if (!method || !method.items.length) return null;
    var d = new Date();
    var n = d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate();
    return method.items[n % method.items.length];
  }
  function renderToday() {
    var it = todayMethod();
    var btn = $('reTodayBtn'), title = $('reTodayTitle'), card = $('reTodayCard');
    if (!it) {
      if (btn) btn.hidden = true;
      if (card) card.innerHTML = '';
      return;
    }
    if (btn) btn.hidden = false;
    if (title) title.textContent = it.title;
    if (card) {
      card.innerHTML = '<div class="re-today-card-k">今日方法 · 每天一条，先看再刷</div>' +
        '<h3>' + esc(it.title) + '</h3>' +
        '<p>' + hl(it.oneLine) + '</p>' +
        ((it.signs || []).length ? '<div class="re-method-signs">' + it.signs.map(function (w) {
          return '<span>' + esc(w) + '</span>';
        }).join('') + '</div>' : '') +
        '<div class="re-today-actions">' +
        '<button type="button" class="re-btn-ghost" data-act="focusmethod" data-no="' + it.no +
        '">看全文 →</button>' +
        (it.trapTag && it.trapTag !== '其他'
          ? '<button type="button" class="re-btn-ghost" data-act="drill" data-trap="' +
            esc(it.trapTag) + '">练同类 →</button>' : '') +
        '</div>';
    }
  }
  function setView(v, opts) {
    view = (v === 'method' || v === 'knowledge') ? v : 'drill';
    var body = document.body;
    if (body && body.classList) {
      body.classList.toggle('re-view-method', view === 'method');
      body.classList.toggle('re-view-knowledge', view === 'knowledge');
    }
    var tabs = document.querySelectorAll('.re-switch-tabs button');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].dataset.view === view);
    }
    if (view === 'method') renderMethods();
    else if (view === 'knowledge') renderKnowledge();
    else renderToday();            // 刷题视图也要显示首屏「今日方法」入口
    persistView();
    if (!(opts && opts.quiet)) {
      try { if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
    }
  }
  function focusMethod(no) {
    if (!method) return;
    var it = null;
    for (var i = 0; i < method.items.length; i++) if (method.items[i].no === no) { it = method.items[i]; break; }
    if (!it) return;
    methodGroup = it.group; methodQ = ''; focusNo = no;
    var q = $('reMethodQ'); if (q) q.value = '';
    setView('method', { quiet: true });
    setTimeout(function () {
      var el = document.querySelector('#reMethodList [data-no="' + no + '"]');
      if (el) {
        if (el.tagName === 'DETAILS') el.open = true;
        el.classList.add('focus');
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
      }
      focusNo = 0;
    }, 80);
  }
  function drillTrap(tag) {
    setView('drill', { quiet: true });
    filter = { topic: '', trap: tag || '', year: 0, type: '', sort: 'new', q: '' };
    resetReveal(); idx = 0;
    syncControls(); persistView(); renderAll();
    try { document.querySelector('.re-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  }
  function jumpToQ(qid) {
    if (!byId(qid)) return;
    filter = { topic: '', trap: '', year: 0, type: '', sort: 'new', q: '' };
    resetReveal();
    var l = visible(), fi = -1;
    for (var i = 0; i < l.length; i++) if (l[i].id === qid) { fi = i; break; }
    if (fi < 0) return;
    idx = fi; persistView(); renderAll();
    try { document.querySelector('.re-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  }

  function renderTopics() {
    var box = $('reTopicGrid'); if (!box) return;
    var list = ((data && data.topics) || []).slice()
      .sort(function (a, b) { return num(b.years) - num(a.years) || num(b.count) - num(a.count); });
    box.innerHTML = list.map(function (t) {
      return '<button type="button" class="re-topic" data-act="topic" data-t="' + esc(t.term) + '">' +
        '<b>' + esc(t.term) + '</b><span>' + esc(t.module || '') + ' · 真题 ' + num(t.questionCount) +
        ' 道 · ' + num(t.years) + '/11 年考过 · 出现 ' + num(t.count) + ' 次</span></button>';
    }).join('');
  }

  /* ---------------- 交互 ---------------- */
  function submit() {
    var list = visible();
    if (!list.length || !sel.length || revealed) return;
    var q = list[idx], o0 = state[q.id] || blank();
    var before = { w: num(o0.w), r: num(o0.r) };
    var pick = sel.slice().sort().join('');
    var ok = pick === String(q.answer);
    record(q, ok, pick);
    var o1 = state[q.id];
    revealed = true; revealedFor = q.id; verdict = ok;
    wrongStreak = ok ? 0 : wrongStreak + 1;
    feedback = { id: q.id, before: before, after: { w: num(o1.w), r: num(o1.r) },
                 streak: wrongStreak, methodNo: num(q.methodNo) };
    commitAnswer(q, pick, ok);        // ★ 唯一推进度的地方
    renderAll(); renderResumeNote();
  }
  function goto(delta) {
    resetReveal();                    // 翻页不写任何进度
    var list = visible();
    if (!list.length) { renderCard(); return; }
    idx = clamp(idx + delta, 0, list.length - 1);
    renderCard();
  }
  /* 从「同考点跨年份考法」跳到某一题：只改视图，不写进度，且强制不翻面 */
  function jumpEvo(qid) {
    var target = byId(qid); if (!target) return;
    filter.year = 0; filter.type = ''; filter.q = '';
    resetReveal();
    var l = visible(), fi = -1;
    for (var i = 0; i < l.length; i++) if (l[i].id === qid) { fi = i; break; }
    if (fi < 0) {
      filter.topic = ''; l = visible();
      for (var j = 0; j < l.length; j++) if (l[j].id === qid) { fi = j; break; }
    }
    if (fi < 0) return;
    idx = fi; persistView(); renderAll();
    try { document.querySelector('.re-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  }
  function rate(v) {
    var list = visible(); if (!list.length) return;
    var q = list[idx];
    if (!state[q.id]) state[q.id] = blank();
    state[q.id].m = (v === 'marked') ? 1 : 0;
    jset(K_STATE, state); schedulePush();
    goto(1);
  }
  function onFilterChange() {
    resetReveal(); idx = 0; persistView(); renderAll();
  }
  function pickTopic(t) {
    filter = { topic: t, trap: '', year: 0, type: '', sort: 'new', q: '' };
    resetReveal(); idx = 0; persistView(); renderAll();
    try { document.querySelector('.re-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  }
  function bind() {
    $('reTopic').addEventListener('change', function () { filter.topic = this.value; onFilterChange(); });
    $('reTrap').addEventListener('change', function () { filter.trap = this.value; onFilterChange(); });
    $('reYear').addEventListener('change', function () { filter.year = Number(this.value) || 0; onFilterChange(); });
    $('reType').addEventListener('change', function () { filter.type = this.value; onFilterChange(); });
    $('reSort').addEventListener('change', function () {
      filter.sort = this.value;
      if (filter.sort === 'random') filter.rnd = Math.floor(Math.random() * 1000000000) + 1;
      onFilterChange();
    });
    var qt = null;
    $('reQ').addEventListener('input', function () {
      var v = this.value; if (qt) clearTimeout(qt);
      qt = setTimeout(function () { filter.q = v; onFilterChange(); }, 220);
    });
    $('reReset').addEventListener('click', function () {
      filter = { topic: '', trap: '', year: 0, type: '', sort: 'new', q: '' }; onFilterChange();
    });
    $('rePrev').addEventListener('click', function () { goto(-1); });
    $('reNext').addEventListener('click', function () { goto(1); });
    $('reResume').addEventListener('click', function () { applyLast(); renderAll(); });
    $('reFrom').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act="clearfrom"]'); if (!b) return;
      fromX8 = null;
      try {
        var h = (filter.topic && filter.topic !== '__none__')
          ? '#topic=' + encodeURIComponent(filter.topic) : '';
        history.replaceState(null, '', location.pathname + h);
      } catch (ex) {}
      renderFrom();
    });
    $('reSwitch').addEventListener('click', function (e) {
      var b = e.target.closest('[data-view]'); if (!b) return;
      setView(b.dataset.view);
    });
    $('reTodayBtn').addEventListener('click', function () { setView('method'); });
    $('reTodayCard').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'focusmethod') focusMethod(Number(b.dataset.no));
      else if (b.dataset.act === 'drill') drillTrap(b.dataset.trap || '');
    });
    document.querySelectorAll('.re-tabs a[href="#methods"]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); setView('method'); });
    });
    document.querySelectorAll('.re-tabs a[href="#knowledge"]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); setView('knowledge'); });
    });
    $('reKnGroups').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act="kngroup"]'); if (!b) return;
      knGroup = b.dataset.g; knFocus = ''; renderKnGroups(); renderKnList();
    });
    var kntimer = null;
    $('reKnQ').addEventListener('input', function () {
      var v = this.value; if (kntimer) clearTimeout(kntimer);
      kntimer = setTimeout(function () { knQ = v; knFocus = ''; renderKnList(); }, 160);
    });
    $('reKnList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'kndrill') drillKn(b.dataset.kw || '');
      else if (b.dataset.act === 'knmethod') methodKn(b.dataset.kw || '');
    });
    $('reKnExtraTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act="knextra"]'); if (!b) return;
      knExtra = Number(b.dataset.i) || 0; renderKnExtras();
    });
    $('reKnX8Gate').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'knx8ok') { knX8Open = true; knX8Only = ''; renderKnX8(); }
      else if (b.dataset.act === 'knx8all') { knX8Only = ''; renderKnX8(); }
    });
    $('reKnX8Paper').addEventListener('change', function () {
      knX8Paper = Number(this.value) || 0; renderKnX8();
    });
    var x8timer = null;
    $('reKnX8Q').addEventListener('input', function () {
      var v = this.value; if (x8timer) clearTimeout(x8timer);
      x8timer = setTimeout(function () { knX8Q = v; renderKnX8(); }, 160);
    });
    $('reMethodGroups').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act="mgroup"]'); if (!b) return;
      methodGroup = b.dataset.g; methodQ = ''; focusNo = 0;
      var q = $('reMethodQ'); if (q) q.value = '';
      renderMethods();
    });
    var mtimer = null;
    $('reMethodQ').addEventListener('input', function () {
      var v = this.value; if (mtimer) clearTimeout(mtimer);
      mtimer = setTimeout(function () { methodQ = v; focusNo = 0; renderMethodList(); }, 160);
    });
    $('reMethodList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'drill') drillTrap(b.dataset.trap || '');
      else if (b.dataset.act === 'gotoq') jumpToQ(b.dataset.q);
      else if (b.dataset.act === 'tokn') gotoKn(b.dataset.kw || '', '');
    });
    $('reCard').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var a = b.dataset.act, list = visible(), q = list[idx];
      if (a === 'pick') {
        if (canReveal(q)) return;
        var L = b.dataset.l;
        if (q.type === 'single') { sel = [L]; submit(); return; }  // 单选点选项即完成作答
        var i = sel.indexOf(L); if (i >= 0) sel.splice(i, 1); else sel.push(L);
        renderCard();
      } else if (a === 'submit') submit();
      else if (a === 'clear') { sel = []; renderCard(); }
      else if (a === 'rate') rate(b.dataset.v);
      else if (a === 'next') goto(1);
      else if (a === 'evo') jumpEvo(b.dataset.q);
      else if (a === 'tomethod') { setView('method'); focusMethod(Number(b.dataset.no)); }
      else if (a === 'tokn') gotoKn(b.dataset.kw || '', '');
      else if (a === 'alltopic') {
        filter = { topic: '', trap: '', year: 0, type: '', sort: 'new', q: '' };
        onFilterChange();
      }
    });
    ['reWeakList', 'reTopicGrid'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        var b = e.target.closest('[data-act="topic"]'); if (b) pickTopic(b.dataset.t);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''))) return;
      var k = e.key.toUpperCase(), list = visible(), q = list[idx];
      if ('ABCD'.indexOf(k) >= 0 && !revealed && q) {
        if (q.type === 'single') { sel = [k]; submit(); }
        else {
          var i = sel.indexOf(k); if (i >= 0) sel.splice(i, 1); else sel.push(k);
          renderCard();
        }
        e.preventDefault();
      } else if (e.key === 'Enter' && !revealed) { submit(); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { goto(1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { goto(-1); e.preventDefault(); }
      else if (revealed && ['1', '2'].indexOf(k) >= 0) { rate(k === '1' ? 'again' : 'marked'); e.preventDefault(); }
    });
  }
  function boot() {
    state = normalizeState(jget(K_STATE, {})); jset(K_STATE, state);
    last = jget(K_LAST, {});
    var v = jget(K_VIEW, null);
    if (v) { filter.topic = v.topic || ''; filter.trap = v.trap || ''; filter.year = num(v.year);
             filter.type = v.type || ''; filter.sort = v.sort || 'new'; filter.q = v.q || '';
             filter.rnd = num(v.rnd);
             if (v.view === 'method' || v.view === 'knowledge') view = v.view; }
    bind();
    Promise.all([loadMaterial(), loadMethod(), loadKnowledge()]).then(function (res) {
      var m = res[0];
      method = res[1];
      knowledge = res[2];
      data = m.data; sourceTag = m.tag;
      questions = (data.questions || []).slice();
      topicMap = (data.xiao8TopicMap) || {};
      var h = (location.hash || '').replace(/^#/, '');
      var o = {}, deep = false, hashView = '', wantFocus = 0;
      if (h === 'methods') {
        hashView = 'method';
      } else if (h === 'knowledge' || h === 'knX8') {
        hashView = 'knowledge';
      } else if (h === 'weak' || h === 'topics') {
        hashView = 'drill';
      } else if (h) {
        // 支持 #topic=实践 / #year=2024 / #trap=绝对化词 / #from=X8-1-07 / #method=15
        h.split('&').forEach(function (kv) {
          var p = kv.split('='); if (p.length === 2) o[p[0]] = decodeURIComponent(p[1]);
        });
        if (o.topic) { filter.topic = o.topic; deep = true; }
        if (o.trap) { filter.trap = o.trap; deep = true; }
        if (o.year) deep = true;
        if (o.from) { fromX8 = o.from; deep = true; }
        if (o.method) { hashView = 'method'; wantFocus = Number(o.method) || 0; }
        if (o.kn) { hashView = 'knowledge'; knFocus = o.kn; knQ = ''; }
        if (o.knx) { hashView = 'knowledge'; knExtra = Number(o.knx) || 0; }
        if (o.knx8) { hashView = 'knowledge'; knX8Only = o.knx8; }
      }
      if (deep) {
        // 深链只决定「看哪一批题」：不写 K_LAST 进度，也不定位到上次作答的题。
        // 同时清掉上次的年份/题型/搜索残留，保证该考点的题一定在可见范围内。
        filter.year = o.year ? Number(o.year) || 0 : 0;
        filter.type = ''; filter.q = ''; filter.sort = 'new';
        persistView(); resetReveal(); idx = 0;
        syncControls(); renderResumeNote(); renderResumeButton();
      } else applyLast();
      renderAll(); setCloudLabel(); cloudRestore();
      setView(hashView || view, { quiet: true });
      if (wantFocus) focusMethod(wantFocus);
      if (hashView === 'knowledge') {
        setTimeout(function () {
          var el = null;
          if (knFocus) el = document.querySelector('#reKnList [data-num="' + knFocus + '"]');
          else if (knX8Only) el = $('knX8');
          else if (knExtra) el = $('knExtra');
          if (el) {
            if (el.tagName === 'DETAILS') el.open = true;
            try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
          }
        }, 120);
      }
      if (h === 'weak' || h === 'topics') {
        setTimeout(function () {
          var el = document.getElementById(h);
          if (el) { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {} }
        }, 120);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
