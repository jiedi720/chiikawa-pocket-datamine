// 主题切换：自动（跟随系统）/ 浅色 / 深色，记忆到 localStorage('cp-theme')
(function () {
  var root = document.documentElement;
  var btns = document.querySelectorAll('.theme-switch [data-theme-opt]');

  function apply(t) {
    if (t !== 'light' && t !== 'dark' && t !== 'auto') t = 'auto';
    root.setAttribute('data-theme', t);
    try { localStorage.setItem('cp-theme', t); } catch (e) {}
    btns.forEach(function (b) {
      var on = b.getAttribute('data-theme-opt') === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      apply(b.getAttribute('data-theme-opt'));
    });
  });

  var saved = root.getAttribute('data-theme') || 'auto';
  apply(saved);
})();
