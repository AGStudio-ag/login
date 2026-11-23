/* 隔离版公共课资料库：统一返回考勤登录页入口（所有页面共用） */
(function () {
  if (window.__BACK_TO_LOGIN_READY__) return;
  window.__BACK_TO_LOGIN_READY__ = true;
  function mount() {
    if (document.getElementById('backToLoginFab')) return;
    var a = document.createElement('a');
    a.id = 'backToLoginFab';
    a.href = '/';
    a.title = '返回考勤系统登录页';
    a.setAttribute('aria-label', '返回登录页');
    a.textContent = '← 返回登录';
    a.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;' +
      'display:inline-flex;align-items:center;gap:6px;padding:9px 15px;border-radius:99px;' +
      'background:#14223b;color:#f2bb41;text-decoration:none;font:800 13px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
      'box-shadow:0 8px 26px rgba(15,61,54,.28);border:1px solid rgba(242,187,65,.35);' +
      'transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s';
    a.addEventListener('mouseenter', function () { a.style.transform = 'translateY(-2px)'; a.style.boxShadow = '0 12px 30px rgba(15,61,54,.35)'; });
    a.addEventListener('mouseleave', function () { a.style.transform = ''; a.style.boxShadow = '0 8px 26px rgba(15,61,54,.28)'; });
    (document.body || document.documentElement).appendChild(a);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
