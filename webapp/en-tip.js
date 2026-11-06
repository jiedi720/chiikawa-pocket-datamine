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
    // 锚定到中文文字，显示在【其右侧】并垂直居中；右侧空间不足则翻到左侧；再不足兜底到下方居中
    let left = r.right + 6;
    let top = r.top + (r.height - tr.height) / 2;
    if (left + tr.width > window.innerWidth - 8) {
      left = r.left - tr.width - 6;                 // 右侧放不下 → 翻到左侧
    }
    if (left < 8) {                                 // 左侧也放不下 → 下方居中兜底
      left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8));
      top = r.bottom + 6;
    }
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
