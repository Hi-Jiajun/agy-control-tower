(function () {
  'use strict';

  function showBootError(msg) {
    var box = document.getElementById('boot-fallback');
    var msgEl = document.getElementById('boot-fallback-msg');
    if (!box || !msgEl) return;
    msgEl.textContent = String(msg || '看板前端脚本初始化异常');
    box.classList.remove('hidden');
  }

  window.addEventListener('error', function (evt) {
    if (window.__CT_BOOTED__ === true) return;
    var detail = (evt && (evt.message || (evt.error && evt.error.message))) || '前端脚本加载失败';
    if (evt && evt.error) {
      console.error('[Control Tower Boot Error]', evt.error);
    }
    showBootError('看板前端初始化异常：' + detail);
  });

  window.addEventListener('unhandledrejection', function (evt) {
    if (window.__CT_BOOTED__ === true) return;
    var reason = evt && evt.reason;
    var detail = (reason && reason.message) ? reason.message : String(reason || '未知异步异常');
    console.error('[Control Tower Boot Rejection]', reason);
    showBootError('看板前端异步初始化异常：' + detail);
  });

  setTimeout(function () {
    if (window.__CT_BOOTED__ === true) return;
    showBootError('看板前端脚本未能完成初始化，请关闭并重开 Control Tower 面板；若仍异常请运行 npm run doctor 检查。');
  }, 4000);
})();
