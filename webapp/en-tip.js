/* ============ 原英文名 tooltip ============
   账号面板参数中文化后，用悬停提示给出上游原版英文名，便于对照。
   触发源：元素上的 data-en 属性（内容即原英文名）。
   用 data-en 而非原生 title，是为了只显示一层提示——原生 title 会和本浮层叠加。 */
(function () {
  const TIP_ID = 'en-tip';
  let tip = null, curEl = null, hideTimer = null;

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    return tip;
  }

  function place(el) {
    const t = ensureTip();
    t.textContent = el.getAttribute('data-en');
    t.classList.add('show');
    const r = el.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    // 默认显示在元素下方居中；贴近视口边缘时自动翻到上方 / 靠边
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top = r.bottom + 7;
    if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 7;
    t.style.left = (left + window.scrollX) + 'px';
    t.style.top = (top + window.scrollY) + 'px';
  }

  function show(el) {
    if (!el) return;
    curEl = el;
    clearTimeout(hideTimer);
    place(el);
  }

  function hide() {
    if (!tip) return;
    hideTimer = setTimeout(() => {
      tip.classList.remove('show');
      curEl = null;
    }, 60);
  }

  // 事件委托：整个 document 只需绑一次
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[data-en]');
    if (!el) return;
    if (el === curEl) return;
    const v = el.getAttribute('data-en');
    if (!v || !v.trim()) return;
    show(el);
  });

  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest && e.target.closest('[data-en]');
    if (!el) return;
    // 移到同一个元素的子节点不算离开
    if (el.contains(e.relatedTarget)) return;
    hide();
  });

  document.addEventListener('mousedown', hide);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();
