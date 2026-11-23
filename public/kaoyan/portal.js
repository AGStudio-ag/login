/* 27 研考资料库 · portal runtime（由 build_portal.py 生成，勿手改） */
/* 在脚本执行期捕获自身的内容版本参数，供 registerSW 拼进 SW 注册 URL */
window.__CS_VER = (function(){
  var s = document.currentScript && document.currentScript.src || '';
  var m = /[?&]v=([0-9a-f]{6,})/.exec(s);
  return m ? m[1] : '';
})();
/* 站点根目录（供本地 file:// 打开时把 /library 还原成 …/site/library.html） */
window.__CS_ROOT = (function(){
  var s = document.currentScript && document.currentScript.src || '';
  return s ? s.replace(/[^/]*$/, '') : '';
})();
var PORTAL_DATA = {"meta":{"title":"27 研考资料库","subtitle":"政治 · 英语 · 数学","examDate":"2026-12-19","planStart":"2026-10-20","planDays":60,"updated":"2026-11-16","notice":"本页为公共课开放版，仅展示公共课内容。","privacy":"公共课演示版；学习进度仅保存在你自己的浏览器中，不会上传。"},"stats":[{"value":"495","label":"政治卡","note":"A 必背 151 张"},{"value":"123","label":"作文卡","note":"英语记忆卡"},{"value":"25","label":"写作分","note":"小 10 + 大 15"},{"value":"10","label":"份讲义","note":"作文定稿资料"}],"subjects":[{"id":"politics","name":"政治","accent":"red","mainHref":"#","summary":"495 张 · A 必背 151 张优先","groups":[{"name":"主动回忆与速记","items":[{"title":"主动回忆","desc":"495 张 · 间隔复习 · 错题本 · 统计","href":"/kaoyan/politics/app","badge":"每日","icon":"cards"},{"title":"知识地图","desc":"七大板块 · 会议时间轴 · 真题热度","href":"/kaoyan/jisu","icon":"map"},{"title":"考前 30 分钟","desc":"A4 三栏打印版，进考场前扫一遍","href":"/kaoyan/onepage","icon":"clock"}]},{"name":"模拟题 · 肖八（2027 版）","items":[]},{"name":"真题 · 解题方法 · 知识点","items":[{"title":"知识点一页纸 · 100 条","desc":"知识点册全 35 页 · 100 个编号逐条完整收录 · Z02 新变考点 / Z03 全年时政 / 肖八精简考点","href":"/kaoyan/realexam/#knowledge","badge":"核心","icon":"map"},{"title":"解题方法 · 73 条","desc":"墓碑词 / 绝对化 / 时态 / 夸张 · 先认标志词，再按错因刷同类题","href":"/kaoyan/realexam/#methods","badge":"重点","icon":"map"},{"title":"真题考点专项 / 我的薄弱考点","desc":"11 套卷 · 377 道真题 + 2 道模拟 · 48 个恒重考点；由肖八错题自动推荐","href":"/kaoyan/realexam/#weak","icon":"dice"}]}]},{"id":"english","name":"英语","accent":"blue","mainHref":"#","summary":"作文 25 分 · 单词大观（2868 词）已上线","groups":[{"name":"作文 · 本轮重点","items":[{"title":"作文记忆卡","desc":"123 张 · 自动复习排期 · 判型小游戏","href":"/kaoyan/english-writing","badge":"主推","icon":"cards"},{"title":"抄背卡 · 9 句定稿","desc":"5 页 A4 可打印 · 骨架 + 语料 + 七年数据 + 32 天安排","href":"/kaoyan/essay/copy-card","badge":"先抄这一张","icon":"doc"},{"title":"英语真题套写 · 2020—2026","desc":"7 年 · 南萧简化版 9 句定稿逐段揭示 · 四档原版对照","href":"/kaoyan/essay/practice/","badge":"新","icon":"pen"},{"title":"随手记 · 碎片卡片墙","desc":"百余张短卡 · 翻卡 / 搜索 / 随机抽 / 标记已记住","href":"/kaoyan/quick/","badge":"随手看","icon":"cards"},{"title":"先看这里 · 资料总说明","desc":"资料来源、文件清单、三条铁律","href":"/kaoyan/essay/docs/00-start","badge":"讲义","icon":"doc","minutes":"约 5 分钟"},{"title":"大作文 · 最终定稿模板（南萧简化版）","desc":"唯一骨架 9 句（2+5+3）· 175—190 词 · 只填 5 个空 · 七类价值观语料","href":"/kaoyan/essay/docs/01-big-template","badge":"讲义","icon":"doc","minutes":"约 12 分钟"},{"title":"大作文 · 一页纸速背卡","desc":"A4 一页纯骨架，每天 5 分钟、考前 3 天","href":"/kaoyan/essay/docs/02-one-page","badge":"讲义","icon":"doc","minutes":"约 3 分钟"},{"title":"大作文 · 真题套用示范","desc":"5 篇完整范文，数据取自真题原件","href":"/kaoyan/essay/docs/03-exam-samples","badge":"讲义","icon":"doc","minutes":"约 15 分钟"},{"title":"小作文 · 定稿模板","desc":"9 类目的句 + 6 个必背模板 + 格式硬差异","href":"/kaoyan/essay/docs/04-small-essay","badge":"讲义","icon":"doc","minutes":"约 12 分钟"},{"title":"小题型速查","desc":"分值步骤 + 英语六大题型分布、避坑五条、题文同序、分数账","href":"/kaoyan/essay/docs/05-mini-sections","badge":"讲义","icon":"doc","minutes":"约 6 分钟"},{"title":"大作文 · 六类完整成篇","desc":"A/B1/B2/C/D/E 各一篇成篇 + 混用红线 + 辨析 8 题","href":"/kaoyan/essay/docs/06-six-types","badge":"讲义","icon":"doc","minutes":"约 15 分钟"},{"title":"作文 · 英语分类速记总表","desc":"13 份模板裁剪 · 7 类 P1 · 4 种格式 · 2026 真题与三年连考 · 37 天速记路线","href":"/kaoyan/essay/docs/07-quick-recall","badge":"讲义","icon":"doc","minutes":"约 20 分钟"},{"title":"新增资料集成与英语取舍","desc":"598 份新资料去重 · 英语边界 · 7 条结论 + 3 处勘误 · 34 天嵌入点","href":"/kaoyan/essay/docs/10-new-sources","badge":"讲义","icon":"doc","minutes":"约 10 分钟"},{"title":"27 大作文一页纸 · 拆解与取舍","desc":"五份 PDF + 28 份套写实测 · 宏大叙事方法论 · 四档定位","href":"/kaoyan/essay/docs/11-onepage-analysis","badge":"讲义","icon":"doc","minutes":"约 12 分钟"},{"title":"备考手册 PDF","desc":"85 页 · 在线阅读 / 下载打印","href":"/kaoyan/essay/handbook","badge":"合订本","icon":"pdf"}]},{"name":"词汇","items":[{"title":"单词大观 · 2868 词","desc":"南萧速成版 · 推导记忆（思维链路）· 已考词义 · 云同步续做","href":"/kaoyan/vocab/","badge":"主推","icon":"cards"},{"title":"真题词汇自测","desc":"1772 词 · 翻卡自测 · 1-2-4-7 复习","href":"/kaoyan/vocab/#drill","badge":"真题","icon":"cards"},{"title":"真题词频表","desc":"词频原表数值 · Top 100/500/1000 · 搜索","href":"/kaoyan/vocab/#freq","badge":"词频","icon":"dice"},{"title":"小题型资料地图","desc":"阅读 / 完型 / 翻译 / 真题资料清单（本机）","href":"/kaoyan/vocab/#files","badge":"索引","icon":"map"}]}]},{"id":"math","name":"数学","accent":"blue","mainHref":"#","summary":"知识图谱 · 速查速背 · 模拟卷逐题刷","groups":[{"name":"数学 · 已接入","items":[]},{"name":"速查速背 · 模拟卷刷题（已接入）","items":[{"title":"数学知识图谱 · 30 讲","desc":"每讲六板块：核心框架 / 关键公式 / 解题步骤 / 技巧 / 误区 / 题型 · KaTeX · 搜索 · 数学默认过滤","href":"/kaoyan/math2map","badge":"新上线","icon":"map"},{"title":"速查速背看板","desc":"精简要点 · 高数 / 线代按考纲章节 · 公式 / 概念 / 解题技巧与思路 · 翻卡背诵","href":"/kaoyan/math2","badge":"主推","icon":"cards"},{"title":"模拟卷逐题刷","desc":"一题一条目 · 优先有答案与解析 · 题干与解析原图逐题呈现 · 自评错题本","href":"/kaoyan/math2mock","badge":"新增","icon":"doc"},{"title":"模拟卷 · 错题本","desc":"只刷做错与模糊的题 · 上次进度打开即恢复","href":"/kaoyan/math2mock#mode=wrong","icon":"dice"},{"title":"无答案模拟卷合集","desc":"未附答案的卷集中存放，明确标注「无答案」，不进逐题清单","href":"/kaoyan/math2mock#mode=noans","icon":"map"}]}]}],"roadmap":[{"subject":"政治","text":"肖四 / 更多模拟卷待接入（2027 版肖八已上线）","status":"planned"},{"subject":"英语","text":"完型 / 翻译 / 新题型讲义内容","status":"planned"},{"subject":"英语","text":"历年真题按年份建索引","status":"planned"},{"subject":"数学","text":"知识图谱 / 速查看板 / 模拟卷刷题已上线；后续新增模拟卷由构建脚本自动增量入库并去重","status":"planned"}]};
(function(){
  var D = PORTAL_DATA, doc = document, root = doc.documentElement;
  var THEME_KEY = 'zz27_theme';
  var ICON = {"cards": "<rect x=\"4\" y=\"5\" width=\"16\" height=\"14\" rx=\"2.2\"/><path d=\"M8 9h8M8 13h5\"/>", "map": "<path d=\"M9 4 3 7v13l6-3 6 3 6-3V4l-6 3-6-3Z\"/><path d=\"M9 4v13M15 7v13\"/>", "clock": "<circle cx=\"12\" cy=\"12\" r=\"8.2\"/><path d=\"M12 7.5V12l3 2\"/>", "download": "<path d=\"M12 3v11m0 0 4-4m-4 4-4-4M4 17v3h16v-3\"/>", "doc": "<path d=\"M6 3h8l4 4v14H6V3Z\"/><path d=\"M14 3v4h4M9 12h6M9 16h6\"/>", "pen": "<path d=\"M5 19 4 20l1-5 9.5-9.5a2.1 2.1 0 0 1 3 3L8 18l-3 1Z\"/><path d=\"M13 8.5 15.5 11\"/>", "pdf": "<path d=\"M6 3h8l4 4v14H6V3Z\"/><path d=\"M14 3v4h4M9 12h6M9 16h6\"/>", "book": "<path d=\"M12 6.4C10.4 4.9 8.3 4.3 6 4.3v14.3c2.3 0 4.4.6 6 2.1 1.6-1.5 3.7-2.1 6-2.1V4.3c-2.3 0-4.4.6-6 2.1Z\"/><path d=\"M12 6.4v14.2\"/>", "dice": "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"3\"/><circle cx=\"9\" cy=\"9\" r=\"1\"/><circle cx=\"15\" cy=\"15\" r=\"1\"/>"};

  function theme(){ return root.getAttribute('data-theme') || 'light'; }
  function setTheme(t){
    root.setAttribute('data-theme', t);
    var m = doc.querySelector('meta[name="theme-color"]');
    if(m) m.setAttribute('content', t === 'dark' ? '#13110d' : '#f3eee3');
    try{ localStorage.setItem(THEME_KEY, t); }catch(e){}
    var b = doc.querySelector('[data-portal-theme]');
    if(b) b.textContent = t === 'dark' ? '☀' : '☾';
  }

  function dates(){
    var p = D.meta;
    var exam = new Date(p.examDate + 'T00:00:00');
    var start = new Date(p.planStart + 'T00:00:00');
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var left = Math.round((exam - today) / 86400000);
    var dayN = Math.floor((today - start) / 86400000) + 1;
    var pct = Math.max(0, Math.min(100, (dayN / p.planDays) * 100));
    return {left:left, dayN:dayN, pct:pct};
  }

  function icon(name){
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[name] || ICON['doc']) + '</svg>';
  }

  /* ---------- 顶部导航 + 倒计时 ---------- */
  function fillMeta(){
    var d = dates();
    doc.querySelectorAll('[data-countdown]').forEach(function(el){
      el.innerHTML = d.left > 0 ? '距初试 <b>' + d.left + '</b> 天' : (d.left === 0 ? '今天初试' : '初试已结束');
    });
    doc.querySelectorAll('[data-dayn]').forEach(function(el){
      el.textContent = 'Day ' + (d.dayN > 0 ? d.dayN : 1) + ' / ' + D.meta.planDays;
    });
    doc.querySelectorAll('[data-ring]').forEach(function(el){
      el.style.setProperty('--p', d.pct.toFixed(1) + '%');
    });
    doc.querySelectorAll('[data-ringpct]').forEach(function(el){
      el.textContent = Math.round(d.pct) + '%';
    });
    var nav = doc.getElementById('ptNav');
    if(nav){
      nav.innerHTML = '<a href="/" class="cur">主站首页</a>' +
        D.subjects.map(function(s){
          return '<a href="/#' + s.id + '">' + s.name + '</a>';
        }).join('');
    }
  }

  /* ---------- 门户首页渲染（数据驱动） ---------- */
  function renderPortal(){
    var host = doc.getElementById('ptContent');
    if(!host) return;
    var h = [];

    (D.stats || []).forEach(function(s){
      h.push('<div class="pt-stat"><b>' + s.value + '</b><span>' + s.label + '</span><small>' + s.note + '</small></div>');
    });
    var stats = h.join('');

    /* 一学科一主入口：其余功能收进二级入口，英语保留作文/词汇两个高频子入口 */
    var KEEP = { english: ['/kaoyan/essay/copy-card', '/kaoyan/essay/practice/', '/kaoyan/vocab/'] };
    function card(it, s, cls){
      return '<a class="pt-card ' + (s.accent === 'blue' ? 'blue' : '') + (cls || '') + '" href="' + it.href + '">' +
        '<span class="pt-ic">' + icon(it.icon || 'map') + '</span>' +
        '<span class="pt-txt"><b>' + it.title + '</b><span>' + it.desc + '</span></span>' +
        (it.badge ? '<span class="pt-badge">' + it.badge + '</span>' : '') +
        '<span class="pt-arrow">›</span></a>';
    }
    var body = D.subjects.map(function(s){
      var main = s.mainHref || '#';
      var flat = [], planned = [];
      s.groups.forEach(function(g){
        if(g.status === 'planned'){ planned.push(g); return; }
        (g.items || []).forEach(function(it){ flat.push(it); });
      });
      var keep = KEEP[s.id] || [];
      var top = flat.filter(function(it){ return keep.indexOf(it.href) >= 0; });
      var rest = flat.filter(function(it){ return it.href !== main && keep.indexOf(it.href) < 0; });
      var mainItem = { title: s.name + ' · 主界面', desc: '本学科全部功能一页直达，点开即用（' + s.summary + '）',
                       href: main, icon: 'cards', badge: '主界面' };
      return '<section class="pt-subject" id="' + s.id + '">' +
        '<div class="pt-subject-head"><h2>' + s.name + '</h2><span>' + s.summary + '</span></div>' +
        '<div class="pt-grid">' + card(mainItem, s, ' hot') + top.map(function(it){ return card(it, s); }).join('') +
        '</div></section>';
    }).join('');

    var road = '<section class="pt-roadmap"><h2>接下来可以加什么</h2>' +
      '<p>这些是预留位，资料到位后只需在 data/portal.json 里补一条记录，页面与导航自动生成。</p><ul>' +
      D.roadmap.map(function(r){
        return '<li><em>' + r.subject + '</em>' + r.text + '</li>';
      }).join('') + '</ul></section>';

    var heroStats = doc.getElementById('ptStats');
    if(heroStats) heroStats.innerHTML = stats;
    host.innerHTML = body + road;
  }

  /* ---------- 站点导航：按场景让位，翻卡时零误触 ---------- */
  function compass(){
    if(doc.body.getAttribute('data-portal') === 'library') return;  // 首页已有完整导航
    if(doc.body.getAttribute('data-wp-portal')) return;
    // Cloudflare Pages 会把 /xxx.html 规范化成 /xxx，统一去掉后缀再判断
    var raw = location.pathname.split('/').pop() || 'index.html';
    var file = raw.replace(/\.html$/i, '');
    if(file === '404'){ doc.body.setAttribute('data-wp-portal','none'); return; }
    var mode = 'fab';
    if(file === 'index' || file === 'english-writing') mode = 'top';
    else if(file === 'jisu' || file === 'onepage') mode = 'side';

    // ① 两个翻卡应用：入口收进顶栏，完全不渲染悬浮球
    if(mode === 'top'){
      var host = doc.querySelector('.topright') || doc.querySelector('.top-actions');
      if(host){
        var existing = host.querySelector('a[href="/"],a[href="./library.html"],a[href="/library.html"]');
        if(existing){
          existing.classList.add('wp-top-link','on-light');
          if(!existing.querySelector('.wp-label')){
            var lab = doc.createElement('span'); lab.className = 'wp-label'; lab.textContent = '主站';
            existing.appendChild(lab);
          }
        }else{
          var a = doc.createElement('a');
          a.href = navTarget('/'); a.className = 'wp-top-link on-dark';
          a.setAttribute('aria-label','返回主站');
          a.innerHTML = '<span class="wp-ic">⌂</span><span class="wp-label">主站</span>';
          host.insertBefore(a, host.firstChild);
        }
      }
      doc.body.setAttribute('data-wp-portal','top');
      return;
    }

    // ② 单文件学习页：左下角小胶囊，避开右下角已有的「← 主动回忆」
    if(mode === 'side'){
      var sb = doc.createElement('div'); sb.className = 'wp-root pos-side';
      sb.innerHTML = '<a class="wp-side-link" href="/" aria-label="返回主站"><span>⌂</span> 主站</a>';
      doc.body.appendChild(sb);
      doc.body.setAttribute('data-wp-portal','side');
      return;
    }

    // ③ 阅读类页面：保留右下角可展开罗盘
    var box = doc.createElement('div');
    box.className = 'wp-root pos-fab';
    var links = [];
    D.subjects.forEach(function(s){
      var items = [];
      s.groups.forEach(function(g){ (g.items || []).forEach(function(it){ items.push(it); }); });
      items = items.slice(0, s.id === 'english' ? 8 : 4);
      links.push('<div class="wp-group">' + s.name + '</div>');
      items.forEach(function(it){
        var curPath = (location.pathname.replace(/\/+$/, '') || '/').replace(/\.html$/i, '');
        var here = curPath === it.href.replace(/\.html$/i, '');
        links.push('<a class="wp-link' + (here ? ' cur' : '') + '" href="' + it.href + '"><i>›</i>' + it.title + '</a>');
      });
    });
    var cur = (location.pathname.replace(/\/+$/, '') || '/').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    box.innerHTML =
      '<button class="wp-fab" id="wpFab" type="button" aria-label="资料库导航" aria-expanded="false">✦</button>' +
      '<div class="wp-panel" id="wpPanel" role="dialog" aria-label="资料库导航">' +
        '<div class="wp-head"><b>资料库导航</b><button class="wp-close" id="wpClose" type="button" aria-label="关闭">×</button></div>' +
        '<div class="wp-here">当前：' + cur + '</div>' +
        links.join('') +
        '<a class="wp-home" href="/">← 返回主站首页</a>' +
      '</div>';
    doc.body.appendChild(box);
    doc.body.setAttribute('data-wp-portal','fab');
    var fab = doc.getElementById('wpFab'), panel = doc.getElementById('wpPanel');
    function toggle(open){
      panel.classList.toggle('open', open);
      fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    fab.addEventListener('click', function(){ toggle(!panel.classList.contains('open')); });
    doc.getElementById('wpClose').addEventListener('click', function(){ toggle(false); });
    doc.addEventListener('keydown', function(e){ if(e.key === 'Escape') toggle(false); });
    doc.addEventListener('click', function(e){
      if(panel.classList.contains('open') && !box.contains(e.target)) toggle(false);
    });
  }

  // 站内链接归一化：这是「点资料库跳不过去」的根治点，所有页面共用。
  // 1) 线上：根绝对路径统一去掉 .html——Pages 会把 /library.html 308 到 /library，
  //    弱网 / 代理抖动时那一次跳转经常直接失败。
  // 2) 本地双击打开（file://）：把根绝对路径还原成站点目录下的 .html，否则会去请求
  //    file:///library 这种不存在的位置。
  // 3) 预览沙箱 / 本地 http 服务器：这类环境没有 clean URL，直接指向线上正式站。
  // 统一入口：任何脚本要生成站内链接都走这里，不要在别处硬写 '#'。
  function navTarget(raw){
    var LIVE = '#';
    var host = location.hostname || '';
    var isFile = location.protocol === 'file:';
    var sameSite = /(^|\.)dbzz\.agai\.online$/.test(host) || /\.pages\.dev$/.test(host);
    var base = window.__CS_ROOT || '';
    var clean = raw.replace(/\.html(?=$|[?#])/i, '');
    if(isFile){
      var rel = clean.replace(/^\//, '');
      if(!rel) rel = 'index.html';
      if(!/\.[a-z0-9]+$/i.test(rel)) rel += '.html';
      return base + rel;
    }
    if(sameSite) return clean;
    return LIVE + (clean.charAt(0) === '/' ? clean : '/' + clean);
  }

  function normalizeLinks(){
    var target = navTarget;

    var links = doc.querySelectorAll('a[href^="/"]');
    for(var i = 0; i < links.length; i++){
      var raw = links[i].getAttribute('href');
      if(raw && raw.indexOf('//') !== 0) links[i].setAttribute('href', target(raw));
    }
    var assets = doc.querySelectorAll('script[src^="/"],link[href^="/"]');
    for(var j = 0; j < assets.length; j++){
      var el = assets[j];
      if(el.hasAttribute('src')){
        var sv = el.getAttribute('src');
        if(sv && sv.indexOf('//') !== 0) el.setAttribute('src', target(sv));
      } else {
        var hv = el.getAttribute('href');
        if(hv && hv.indexOf('//') !== 0) el.setAttribute('href', target(hv));
      }
    }
  }

  // 注册 Service Worker，并在新版本就绪后自动刷新，避免一直看到旧缓存页面
  function registerSW(){
    if(!('serviceWorker' in navigator)) return;
    var hadController = !!navigator.serviceWorker.controller;  // 已有旧 SW 控制 = 更新场景
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function(){
      if(hadController && !reloaded){ reloaded = true; location.reload(); }
    });
    // 用根绝对路径：子目录页（/drill/、/quick/）里 './sw.js' 会解析成 /drill/sw.js 而 404。
    // 再拼上本脚本的内容版本参数：每次部署 portal.js 内容变化 → 注册 URL 变化 →
    // 浏览器必定安装新 SW（skipWaiting + 清旧缓存），不受 sw.js 的 max-age 影响。
    var v = (window.__CS_VER || '');
    navigator.serviceWorker.register('/kaoyan/sw.js' + (v ? '?v=' + v : ''), {scope:'/'}).catch(function(){});
  }

  function init(){
    var b = doc.querySelector('[data-portal-theme]');
    if(b){ b.textContent = theme() === 'dark' ? '☀' : '☾';
           b.addEventListener('click', function(){ setTheme(theme() === 'dark' ? 'light' : 'dark'); }); }
    normalizeLinks();
    fillMeta();
    renderPortal();
    normalizeLinks();   // 卡片是渲染期生成的，渲染完再补一遍，否则本地打开时卡片仍指向 /library
    compass();
    registerSW();
    // 目录高亮
    var links = [].slice.call(doc.querySelectorAll('.pt-toc a'));
    if(links.length && 'IntersectionObserver' in window){
      var map = {};
      links.forEach(function(a){
        var t = doc.querySelector(a.getAttribute('href'));
        if(t) map[t.id] = a;
      });
      var io = new IntersectionObserver(function(es){
        es.forEach(function(e){
          if(e.isIntersecting){
            links.forEach(function(a){ a.classList.remove('cur'); });
            if(map[e.target.id]) map[e.target.id].classList.add('cur');
          }
        });
      }, {rootMargin:'-12% 0px -78% 0px'});
      Object.keys(map).forEach(function(id){ var t = doc.getElementById(id); if(t) io.observe(t); });
    }
  }
  if(doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
