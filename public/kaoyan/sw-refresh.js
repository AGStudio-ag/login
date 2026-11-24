/* 一次性自愈：仅当检测到旧 SW 或旧缓存时才清理并重载，避免无谓重载干扰操作 */
(function () {
  var FLAG = 'kaoyan_sw_fix_v2';
  try { if (sessionStorage.getItem(FLAG)) return; } catch (e) {}
  if (location.search.indexOf('swfix=1') >= 0) { try { sessionStorage.setItem(FLAG, '1'); } catch (e) {} return; }
  (async function () {
    var dirty = false;
    try {
      if ('caches' in window) {
        var keys = await caches.keys();
        if (keys.some(function (k) { return k.indexOf('zz27-portal') >= 0 && k.indexOf('demo-20261124') < 0; })) dirty = true;
        if (dirty) await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
      if ('serviceWorker' in navigator) {
        var regs = await navigator.serviceWorker.getRegistrations();
        var bad = regs.filter(function (r) { return (r.scope || '').replace(/\/$/, '') === location.origin.replace(/\/$/, ''); });
        if (bad.length) {
          dirty = true;
          await Promise.all(bad.map(function (r) { return r.unregister(); }));
        }
      }
    } catch (e) { return; }
    try { sessionStorage.setItem(FLAG, '1'); } catch (e) {}
    if (!dirty) return;
    var u = new URL(location.href);
    u.searchParams.set('swfix', '1');
    location.replace(u.toString());
  })();
})();
