/* 一次性自愈：清掉旧 Service Worker 与旧缓存，确保 DEMO 标识与返回按钮生效 */
(function () {
  var FLAG = 'kaoyan_sw_fix_v2';
  try { if (sessionStorage.getItem(FLAG)) return; } catch (e) {}
  var done = function () {
    try { sessionStorage.setItem(FLAG, '1'); } catch (e) {}
  };
  // 已完成则跳过
  if (location.search.indexOf('swfix=1') >= 0) { done(); return; }
  done();
  (async function () {
    try {
      if ('caches' in window) {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
      if ('serviceWorker' in navigator) {
        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
      var u = new URL(location.href);
      u.searchParams.set('swfix', '1');
      location.replace(u.toString());
    } catch (e) {}
  })();
})();
