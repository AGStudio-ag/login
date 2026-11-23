/* 27 考研政治 · 主动回忆 — offline shell */
const CACHE = 'zz27-portal-fe133c1f';
const ASSETS = [
  './',
  './index.html',
  './home.html',
  './politics/index.html',
  './politics/app/index.html',
  './english/index.html',
  './math/index.html',
  '#/index.html',
  './app.css',
  './app.js',
  './data/cards.js',
  './refine.css',
  './portal.css',
  './portal.js',

  './english-writing.html',
  './essay/handbook.html',
  './essay/copy-card.html',
  './vocab/index.html',
  './vocab/vocab.css',
  './vocab/data/words.js',
  './vocab/data/highfreq.js',
  '#/index.html',
  '#/app.js',
  './quick/index.html',
  './quick/quick.css',
  './quick/app.js',
  './quick/data/cards.js',
  '#/index.html',
  '#/app.js',
  '#/enhance.js',
  '#/data/questions.js',
  '#/data/answers.js',
  './sync.js',
  './math2.html',
  './math2mock.html',
  './math2map.html',
  './math2assets/sheet.css',
  './math2assets/sheet.js',
  './math2assets/data/cheatsheet.js',
  './math2assets/mock/mock.css',
  './math2assets/mock/mock.js',
  './math2assets/mock/data/questions.js',
  './math2assets/mock/data/no_answer.js',
  './math2assets/map/map.css',
  './math2assets/map/map.js',
  './math2assets/map/data/lec_ga1.js',
  './math2assets/map/data/lec_ga2.js',
  './math2assets/map/data/lec_la_prob.js',
  './math2assets/map/vendor/katex/katex.min.css',
  './math2assets/map/vendor/katex/katex.min.js',
  '#/index.html',
  '#/app.js',
  '#/data/seed.js',
  '#/data/seed.json',
  './realexam/index.html',
  './realexam/realexam.css',
  './realexam/app.js',
  './realexam/data/seed.js',
  './realexam/data/seed.json',
  './method/data/seed.js',
  './method/data/seed.json',
  './knowledge/data/seed.js',
  './knowledge/data/seed.json',

  '#/index.html',
  '#/index.html',
  '#/app.js',
  '#/index.html',
  '#/app.js',
  '#/data/meta.js',
  '#/data/recall.js',
  '#/data/questions.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  '#/index.html',
  '#/probability.html',
  '#/blindspot.html',
  '#/speed.html',
  '#/anchor.html',
  '#/app.js',
  '#/data/speed.js',
  '#/data/anchor.js',
  '#/guide.html',
  '#/workbook.html',
  '#/data/workbook.js',
  '#/exammap.html',
  '#/data/exam_map.js',
  './math2assets/map/vendor/katex/fonts/KaTeX_AMS-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Main-Bold.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Main-Italic.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Main-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Math-Italic.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Script-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Size2-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Size3-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Size4-Regular.woff2',
  './math2assets/map/vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2',
  './essay/docs/00-start.html',
  './essay/docs/01-big-template.html',
  './essay/docs/02-one-page.html',
  './essay/docs/03-exam-samples.html',
  './essay/docs/04-small-essay.html',
  './essay/docs/05-mini-sections.html',
  './essay/docs/06-six-types.html',
  './essay/docs/07-quick-recall.html',
  './essay/docs/10-new-sources.html',
  './essay/docs/11-onepage-analysis.html',
  './essay/handbook.html',
  './404.html',
  './essay/practice/index.html',
  './essay/practice/practice.css',
  './essay/practice/practice.js',
  './essay/practice/data/lessons.js',
  './essay/08-essay-map.html',
  './essay/09-plan.html',
  './essay/practice/images/2020.png',
  './essay/practice/images/2021.png',
  './essay/practice/images/2022.png',
  './essay/practice/images/2023.png',
  './essay/practice/images/2024.png',
  './essay/practice/images/2025.png',
  './essay/practice/images/2026.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 云端同步接口（/api/）不走 Service Worker 缓存，始终走网络，保证进度实时。
  if (url.pathname.startsWith('/api/')) return;

  // Navigation: network first so a new deployment shows up; on ANY failure
  // (offline, 5xx, 404) fall back to the cached page. Directory URLs such as
  // of a sub-page fails with ERR_CONNECTION_REFUSED.
  async function navigationFallback(req) {
    const u = new URL(req.url);
    const opts = { ignoreSearch: true };
    let hit = await caches.match(req, opts);
    if (hit) return hit;
    // 数学：无斜杠 / 旧目录 URL 直接映射到扁平页面缓存，
    // 弱网下 308 跳转失败也不会回退到首页或报 ERR_FAILED。
    const ALIAS = {
      '/kaoyan/math2': './math2.html', '/kaoyan/math2/': './math2.html',
      '/kaoyan/math2/mock': './math2mock.html', '/kaoyan/math2/mock/': './math2mock.html'
    };
    if (ALIAS[u.pathname]) {
      hit = await caches.match(ALIAS[u.pathname], opts);
      if (hit) return hit;
    }
    if (u.pathname.endsWith('/')) {
      hit = await caches.match(u.pathname + 'index.html', opts);
      if (hit) return hit;
    } else if (!/\.[a-z0-9]+$/i.test(u.pathname)) {
      // 预缓存清单里存的是文件原名，不带后缀的请求必须这样映射，
      // 否则弱网/断网时资料库等页面会回退到首页而「打不开」。
      hit = await caches.match(u.pathname + '.html', opts);
      if (hit) return hit;
    }
    hit = await caches.match('./index.html', opts);
    if (hit) return hit;
    return new Response('<h1>离线</h1><p>页面尚未缓存，请联网打开一次后再试。</p>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        // 不要把「跟随重定向后」的响应缓存到原 URL：308 结果被缓存会让
        // 无斜杠地址在弱网里出现 ERR_FAILED / 循环跳转。
        if (res && res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res && res.ok ? res : navigationFallback(req);
      }).catch(() => navigationFallback(req))
    );
    return;
  }

  // Code assets: network-first, so a new deploy takes effect without a hard refresh.
  if (/\.(js|css|json|webmanifest)$/i.test(url.pathname)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // Other assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
