/* Chiikawa Pocket Team Calculator — engine + UI
   All game math from the v2.4.1 datamine (see analysis/REPORT.md). */
'use strict';

/* ============ number formatting (game-style suffixes) ============ */
const SUF = ['', 'K', 'M', 'B', 'T'];
function suffixFor(n) {
  // '', K, M, B, T, aa, ab, ac... like the game
  if (n < 5) return SUF[n];
  let k = n - 5, s = '';
  do { s = String.fromCharCode(97 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0);
  return s;
}
function fmt(x, digits = 3) {
  if (!isFinite(x)) return '∞';
  if (x === 0) return '0';
  const neg = x < 0; x = Math.abs(x);
  let tier = 0;
  while (x >= 1000 && tier < 100) { x /= 1000; tier++; }
  let v = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return (neg ? '-' : '') + v + suffixFor(tier);
}
function fmtPct(x, d = 1) { return (x * 100).toFixed(d) + '%'; }

/* ============ game math primitives ============ */
// LevelRangeValue evaluation (matches WithNetwork.LevelRangeValue.GetValue)
function evalLRV(row, L) {
  if (!row) return 0;
  let v;
  if (row.t === 'Default' || row.t === 1) {
    const total = row.e - row.s;
    v = total === 0 ? Number(row.ev) : Number(row.sv) + (Number(row.ev) - Number(row.sv)) * (L - row.s) / total;
  } else if (row.t === 'AddConstant' || row.t === 2) {
    v = L > 0 ? Number(row.sv) + Number(row.ev) * (L - row.s) : 0;
  } else if (row.t === 'FixedLevel' || row.t === 3) {
    v = Number(row.sv);
  } else v = Number(row.sv);
  if (row.vt === 'Permil' || row.vt === 2) v /= 1000;
  return v;
}
function evalGroup(gid, L) {
  const rows = DATA.lrvGroups[String(gid)];
  if (!rows || rows.length === 0) return 1;
  let best = null;
  for (const r of rows) {
    const end = r.e === 0 ? Infinity : r.e;
    if (L >= r.s && L <= end) { best = r; break; }
  }
  if (!best) best = rows[rows.length - 1];
  return evalLRV(best, L);
}
// skill effect value at skill level
function skillValueAt(eff, slv) { return eff.lv ? evalLRV(eff.lv, slv) : 0; }

const BUFF_TYPES = {
  StatusAttackUp: 'attack', StatusAttackSpeedUp: 'atkSpeed', StatusCriticalRateUp: 'critRate',
  StatusCriticalAttackUp: 'critDmg', StatusBossDamageUp: 'bossRate', StatusMobDamageUp: 'mobRate',
  StatusAttackDown: 'enemyAtkDown', StatusDefenceDown: 'defDown', StatusSpeedDown: 'enemySpeedDown',
  StatusCriticalDefenceDown: 'critDefDown', RecastReset: 'recastReset',
};
// 服装阶级：costumeRarityId 1/2/3 → SR/HR/UR，官方用星标表示（★4/★5/★6）
const RARITY_NAME = ZH_COSTUME_RARITY;

/* ============ state ============ */
const DEF_STATE = {
  owned: {},        // costumeId -> level
  locks: {},        // slotIndex(0-5) -> costumeId
  items: {},        // itemKey -> owned bool
  inputs: {},
};
let state = loadState();
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('chipok-calc'));
    if (s && s.owned) return Object.assign({}, DEF_STATE, s);
  } catch (e) { /* fresh */ }
  return JSON.parse(JSON.stringify(DEF_STATE));
}
function saveState() { localStorage.setItem('chipok-calc', JSON.stringify(state)); }

function readInputs() {
  const g = id => parseFloat(document.getElementById(id).value) || 0;
  const mode = document.getElementById('in-mode').value;
  return {
    critRate: Math.min(1, Math.max(0, g('in-critRate'))),
    critDmg: Math.max(0, g('in-critDmg')),
    normalRate: g('in-normalRate') || 1,
    skillRate: g('in-skillRate') || 1,
    uniqueRate: g('in-uniqueRate') || 1,
    bossRate: g('in-bossRate') || 1,
    mobRate: g('in-mobRate') || 1,
    atkSpeed: g('in-atkSpeed') || 0.66,
    cdr: Math.min(0.9, Math.max(0, g('in-cdr'))),
    defDebuff: g('in-defDebuff') || 1,
    tagWeight: g('in-tagWeight'),
    mode,
  };
}

/* ============ costume & skill model ============ */
function skillOf(c) { return DATA.skills[String(c.skill)]; }

function costumeSkillProfile(c) {
  // one-time per costume summary of its skill at a given skill level (= costume level, capped 100)
  const s = skillOf(c);
  if (!s) return null;
  return s;
}

// Per-slot DPS with attack normalized to 1. Returns rich breakdown.
function slotCalc(c, cLv, inp, teamCtx) {
  const s = skillOf(c);
  const ar = evalGroup(c.arGroup, cLv);          // costume attack rate (×)
  const asr = evalGroup(c.asGroup, cLv);         // costume attack speed rate (×)
  const swings = inp.atkSpeed * asr;
  const critRate = Math.min(1, teamCtx.critRate);
  const critE = 1 + critRate * (teamCtx.critDmg - 1);

  // normal attack DPS (attack=1)
  const bossFrac = teamCtx.bossFrac;
  const bmRate = bossFrac * inp.bossRate + (1 - bossFrac) * inp.mobRate;
  const normalDPS = 1 * inp.normalRate * ar * swings * bmRate * inp.defDebuff * critE;

  // skill parts
  const out = {
    id: c.id, char: c.char, rarity: c.rarity, lv: cLv, tags: c.tags,
    ar, asr, swings, normalDPS, skillDPS: 0, dps: 0,
    buffs: [], debuffs: [], hasAoE: false, isNuke: false, isBuff: false, isDebuffer: false,
    skillId: c.skill, recastMs: 0, cycle: 0, skillMult: 0,
  };
  if (!s) { out.dps = normalDPS; return out; }

  const slv = Math.min(100, cLv); // skill level scales on its own 1-100 range; use costume lv
  const cycle = (s.recastMs / 1000) * (1 - inp.cdr) + (s.castMs / 1000) + 0.5;
  out.recastMs = s.recastMs; out.cycle = cycle;

  let skillDPS = 0;
  for (const e of s.effects) {
    const v = skillValueAt(e, slv);
    const type = e.type;
    if (type === 'Attack') {
      // damage multiplier on attack
      let mult = v * c.skillCoef;
      let rate = inp.skillRate * (inp.uniqueRate); // costume unique skill
      let d = 1 * mult * ar * rate * bmRate * inp.defDebuff * critE / cycle;
      if (e.range === 'Range') { out.hasAoE = true; d *= teamCtx.aoeValue; }
      skillDPS += d;
      out.skillMult = Math.max(out.skillMult, mult);
      out.isNuke = true;
    } else if (BUFF_TYPES[type]) {
      const bt = BUFF_TYPES[type];
      const uptime = Math.min(1, (e.buffSec || 0) / cycle);
      if (e.target === 'Enemy') {
        out.debuffs.push({ kind: bt, value: v, uptime });
        out.isDebuffer = true;
      } else {
        out.buffs.push({ kind: bt, value: v, uptime });
        out.isBuff = true;
      }
    }
  }
  out.skillDPS = skillDPS;
  out.dps = normalDPS + skillDPS;
  return out;
}

// team context starts from inputs; buffs/debuffs of team modify it
function buildTeamContext(inp) {
  const bossFrac = inp.mode === 'boss' ? 0.85 : inp.mode === 'farm' ? 0.1 : 0.4;
  const aoeValue = inp.mode === 'farm' ? 1.6 : inp.mode === 'boss' ? 0.4 : 1.0;
  return { critRate: inp.critRate, critDmg: inp.critDmg, bossFrac, aoeValue };
}

// score a full ordered team
function teamCalc(orderedSlots, inp) {
  // gather buffs/debuffs (they apply to the whole team)
  const ctx = buildTeamContext(inp);
  let attackMult = 1, defAmp = 1, notes = [];
  for (const s of orderedSlots) {
    for (const b of s.buffs) {
      if (b.kind === 'attack') attackMult *= (1 + b.value * b.uptime);
      else if (b.kind === 'critRate') ctx.critRate = Math.min(1, ctx.critRate + b.value * b.uptime);
      else if (b.kind === 'critDmg') ctx.critDmg += b.value * b.uptime;
      else if (b.kind === 'atkSpeed') attackMult *= (1 + 0.5 * b.value * b.uptime); // dps via more swings (approx)
      else if (b.kind === 'bossRate') { ctx.bossRateBuff = (ctx.bossRateBuff || 0) + b.value * b.uptime; }
      else if (b.kind === 'mobRate') { ctx.mobRateBuff = (ctx.mobRateBuff || 0) + b.value * b.uptime; }
      else if (b.kind === 'recastReset') notes.push('存在「特技再发动缩短」效果（不计入评分）');
    }
    for (const d of s.debuffs) {
      if (d.kind === 'defDown') defAmp *= (1 + d.value * d.uptime);
      else if (d.kind === 'critDefDown') defAmp *= (1 + d.value * d.uptime);
    }
  }
  // recompute slot dps under team context (buffs affect everyone)
  const effInp = Object.assign({}, inp);
  effInp.critRate = ctx.critRate; effInp.critDmg = ctx.critDmg;
  effInp.bossRate = inp.bossRate * (1 + (ctx.bossRateBuff || 0));
  effInp.mobRate = inp.mobRate * (1 + (ctx.mobRateBuff || 0));
  const ctx2 = buildTeamContext(effInp);
  let total = 0;
  const recomputed = orderedSlots.map(s => {
    const c = COSTUME_BY_ID[s.id];
    const r = slotCalc(c, s.lv, effInp, ctx2);
    total += r.dps;
    return r;
  });
  // tag synergy
  const tagCounts = {};
  for (const s of recomputed) for (const t of s.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  let tagMult = 1;
  const tagList = [];
  for (const [t, n] of Object.entries(tagCounts)) {
    if (n >= 2) { const m = 1 + (inp.tagWeight / 100) * (n - 1); tagMult *= m; tagList.push({ tag: t, n, m }); }
  }
  total *= attackMult * defAmp * tagMult;
  return { total, slots: recomputed, attackMult, defAmp, tagMult, tagList, tagCounts, ctx: effInp, notes };
}

/* ============ ordering model (sequence-based; the team shares ONE HP pool, so
   nobody tanks — order only decides skill fire sequence) ============ */
function orderScore(slots, inp) {
  // baseline: order-independent team dps
  let score = 0;
  for (const s of slots) score += s.dps;
  const nukeIdx = slots.map((s, i) => s.isNuke ? i : -1).filter(i => i >= 0);
  const nukeDps = i => slots[i].dps;
  let seq = 0;
  // enablers (buff/debuff) score for every nuke to their RIGHT (fires after them)
  for (let i = 0; i < 6; i++) {
    const s = slots[i];
    if (s.isBuff || s.isDebuffer) {
      const enabled = nukeIdx.filter(n => n > i).reduce((a, n) => a + nukeDps(n), 0);
      seq += 0.03 * enabled;
      if (nukeIdx.length && nukeIdx.every(n => n < i)) seq -= 0.02 * score; // wasted enabler behind everything
    }
  }
  // fight-context placement
  if (inp.mode === 'boss') {
    // biggest nuke belongs in the last slots (window alignment); AoE devalued
    const best = slots.reduce((a, s, i) => s.skillMult > (slots[a] ? slots[a].skillMult : 0) ? i : a, 0);
    if (best >= 4) seq += 0.05 * score;
  } else {
    // AoE prefers the middle for wave-clear tempo
    for (let i = 0; i < 6; i++) if (slots[i].hasAoE && i >= 2 && i <= 4) seq += 0.02 * score;
  }
  return score + seq;
}

function* permutations(arr) {
  const a = arr.slice();
  function* gen(k) {
    if (k === 1) { yield a.slice(); return; }
    yield* gen(k - 1);
    for (let i = 0; i < k - 1; i++) {
      const j = k % 2 ? 0 : i;
      [a[j], a[k - 1]] = [a[k - 1], a[j]];
      yield* gen(k - 1);
    }
  }
  yield* gen(a.length);
}

/* ============ data indexes ============ */
const COSTUME_BY_ID = {};
for (const c of DATA.costumes) COSTUME_BY_ID[c.id] = c;
// 角色名取自官方中文表 hunt_character_<id>
const CHAR_NAME = {};
for (let i = 1; i <= 7; i++) CHAR_NAME[i] = ZH['hunt_character_' + i] || ('角色 ' + i);

// 各类名称一律查官方中文表（zh.js）
function costumeName(c) { return ZH['costume_name_' + c.id] || (c.chinese || '').trim(); }
function skillName(id) { return ZH['costume_name_' + id] || ''; }
function itemName(it) {
  if (it.kind === 'weapon' || it.kind === 'armor') {
    const m = /(\d{4})/.exec(it.sprite || '');
    return m ? (ZH[it.kind + '_name_' + m[1]] || '') : '';
  }
  if (it.kind === 'assist') return ZH_ASSIST_BY_ID[it.id] || '';
  if (it.kind === 'treasure') return ZH['treasure_item_name_' + it.id] || '';
  return '';
}
// 标签：官方 textKey 为 4 位补零形式（tag_0011），游戏数据里是裸 id（11），两边都要试
function tagName(t) {
  return ZH['tag_' + t] || ZH['tag_' + String(t).padStart(4, '0')] || String(t);
}
function charName(id) { return CHAR_NAME[id] || ('角色 ' + id); }

// 列表缩略图：img.js 按官方中文编号存放图标。查不到就返回空串，条目保持纯文字。
// zoomable=true 时给图标加 data-zoom，供左键单击打开原始分辨率大图。
function imgTag(key, zoomable) {
  const f = (typeof IMG !== 'undefined' && key) ? IMG[key] : null;
  if (!f) return '';
  const z = zoomable ? ' class="ico zoomable" data-zoom="img/' + f + '"' : ' class="ico"';
  return `<img${z} src="img/${f}" alt="" loading="lazy" onerror="this.style.display='none'">`;
}
// 武器/防具用 sprite 里的 4 位编号（与官方中文名同键），支援用自身 id
function itemImgKey(it) {
  if (it.kind === 'weapon' || it.kind === 'armor') {
    const m = /(\d{4})/.exec(it.sprite || '');
    return m ? it.kind + '_' + m[1] : '';
  }
  if (it.kind === 'assist') return 'assist_' + it.id;
  if (it.kind === 'treasure') return 'treasure_' + it.id;
  return '';
}

function costumeLabel(c) {
  const name = costumeName(c);
  return name ? `#${c.id} · ${name}` : `#${c.id} · ${charName(c.char)} · ${RARITY_NAME[c.rarity] || c.rarity}`;
}
// 特技数值：1级→100级。不随等级变化时只显示一个值，避免 3.00×→3.00× 这种冗余。
function lvPair(v1, v100, sign, suffix) {
  const a = fmt(v1), b = fmt(v100);
  if (a === b) return `${sign}${a}${suffix}`;
  return `${sign}${a}${suffix}→${sign}${b}${suffix}`;
}
function skillDesc(c) {
  const s = skillOf(c);
  if (!s) return '无特技';
  const lines = [];
  for (const e of s.effects) {
    const v1 = skillValueAt(e, 1), v100 = skillValueAt(e, 100);
    if (e.type === 'Attack') {
      lines.push(`${ZH_RANGE[e.range] || e.range} ${lvPair(v1, v100, '', '×')}`);
    } else if (BUFF_TYPES[e.type]) {
      const nm = ZH_BUFF_LABEL[BUFF_TYPES[e.type]] || BUFF_TYPES[e.type];
      const sign = e.target === 'Enemy' ? '-' : '+';
      const dur = e.buffSec ? ` 持续${e.buffSec}秒` : '';
      lines.push(`${nm}${e.range === 'Range' ? '（全体）' : ''} ${lvPair(v1, v100, sign, '')}${dur}`);
    }
  }
  if (s.recastMs) {
    if (s.effects.length === 1) lines[0] += ` （冷却 ${s.recastMs / 1000}秒）`;
    else lines.push(`技能冷却 ${s.recastMs / 1000}秒`);
  }
  return lines.join('\n');
}

/* ============ roster UI ============ */
function ownedLevel(id) { return state.owned[id]; }
function isLocked(id) { return Object.values(state.locks).includes(id); }

function renderRoster() {
  const el = document.getElementById('roster');
  const filter = (document.getElementById('roster-filter').value || '').toLowerCase();
  const ownedOnly = document.getElementById('roster-ownedonly').checked;
  const sortBy = document.getElementById('roster-sort').value;
  const tagFilter = document.getElementById('roster-tagfilter').value;
  const rarityFilter = document.getElementById('roster-rarityfilter').value;
  let shown = 0, ownedN = 0;
  el.innerHTML = '';

  // 1) 先按 标签 / 星级 过滤
  let list = DATA.costumes.slice();
  if (rarityFilter) list = list.filter(c => String(c.rarity) === rarityFilter);
  if (tagFilter) list = list.filter(c => c.tags.includes(+tagFilter));

  // 2) 排序（攻击倍率以满级为基准）
  const atkOf = c => evalGroup(c.arGroup, 100);
  list.sort((a, b) => {
    switch (sortBy) {
      case 'id-asc':   return a.id - b.id;
      case 'id-desc':  return b.id - a.id;
      case 'star-desc':return b.rarity - a.rarity || a.sort - b.sort;
      case 'star-asc': return a.rarity - b.rarity || a.sort - b.sort;
      case 'atk-desc': return atkOf(b) - atkOf(a) || a.sort - b.sort;
      case 'atk-asc':  return atkOf(a) - atkOf(b) || a.sort - b.sort;
      case 'name':     return costumeName(a).localeCompare(costumeName(b), 'zh');
      default:         return a.sort - b.sort;
    }
  });

  // 3) 渲染（再套用文字搜索 / 已拥有）
  for (const c of list) {
    const owned = ownedLevel(c.id) != null;
    if (owned) ownedN++;
    if (ownedOnly && !owned) continue;
    const s = skillOf(c);
    const text = `${c.id} ${costumeName(c)} ${charName(c.char)} ${RARITY_NAME[c.rarity]} ${c.tags.map(tagName).join(' ')} ${skillDesc(c)}`.toLowerCase();
    if (filter && !text.includes(filter)) continue;
    shown++;
    const card = document.createElement('div');
    card.className = 'card' + (owned ? ' owned' : '');
    const badges = [];
    badges.push(`<span class="badge r${c.rarity}">${RARITY_NAME[c.rarity]}</span>`);
    if (s) {
      if (s.effects.some(e => e.type === 'Attack' && e.range === 'Range')) badges.push('<span class="badge aoe">全体</span>');
      if (s.effects.some(e => e.type === 'Attack' && e.range === 'Single')) badges.push('<span class="badge nuke">爆发</span>');
      if (s.effects.some(e => e.target === 'Friend' && BUFF_TYPES[e.type])) badges.push('<span class="badge buff">增益</span>');
      if (s.effects.some(e => e.target === 'Enemy' && BUFF_TYPES[e.type])) badges.push('<span class="badge debuff">减益</span>');
    }
    for (const t of c.tags) badges.push(`<span class="badge tag">标签 ${tagName(t)}</span>`);
    card.innerHTML = `
      <div class="head"><span class="hdmain">${imgTag('costume_' + c.id, true)}<span class="title">${costumeLabel(c)}</span></span>
        <button class="lockbtn ${isLocked(c.id) ? 'locked' : ''}" data-lock="${c.id}">${isLocked(c.id) ? '🔒 已锁定' : '锁定'}</button>
      </div>
      <div class="row">${badges.join('')}</div>
      <div class="row hint skill-desc">${skillDesc(c)}</div>
      <div class="row lvl">
        <label><input type="checkbox" data-own="${c.id}" ${owned ? 'checked' : ''}> 已拥有</label>
        ${owned ? `<label>服装等级 <input type="number" min="1" max="200" value="${ownedLevel(c.id)}" data-lv="${c.id}"></label>` : ''}
      </div>`;
    el.appendChild(card);
  }
  document.getElementById('roster-count').textContent = `（已拥有 ${ownedN}，显示 ${shown}）`;
  el.querySelectorAll('[data-own]').forEach(cb => cb.addEventListener('change', e => {
    const id = +e.target.dataset.own;
    if (e.target.checked) state.owned[id] = 100; else { delete state.owned[id]; deleteSlotLock(id); }
    saveState(); renderRoster();
  }));
  el.querySelectorAll('[data-lv]').forEach(inp => inp.addEventListener('change', e => {
    state.owned[+e.target.dataset.lv] = Math.max(1, Math.min(200, +e.target.value || 1));
    saveState();
  }));
  el.querySelectorAll('[data-lock]').forEach(btn => btn.addEventListener('click', e => {
    toggleLock(+e.target.dataset.lock); saveState(); renderRoster();
  }));
}

// 用数据里的全部标签填充「标签」筛选下拉
function populateRosterFilters() {
  const sel = document.getElementById('roster-tagfilter');
  if (!sel) return;
  const tags = new Set();
  for (const c of DATA.costumes) for (const t of c.tags) tags.add(t);
  for (const t of [...tags].sort((a, b) => a - b)) {
    const o = document.createElement('option');
    o.value = t; o.textContent = '标签 ' + tagName(t);
    sel.appendChild(o);
  }
}
function deleteSlotLock(costumeId) {
  for (const [k, v] of Object.entries(state.locks)) if (v === costumeId) delete state.locks[k];
}
function toggleLock(costumeId) {
  if (isLocked(costumeId)) { deleteSlotLock(costumeId); return; }
  const costume = COSTUME_BY_ID[costumeId];
  if (!costume) return;
  const duplicate = Object.values(state.locks).some(id => {
    const locked = COSTUME_BY_ID[id];
    return locked && locked.char === costume.char;
  });
  if (duplicate) {
    const status = document.getElementById('opt-status');
    if (status) status.textContent = '同一角色只能锁定一套服装，请先解锁该角色的另一套服装。';
    return;
  }
  for (let i = 0; i < 6; i++) if (state.locks[i] == null) { state.locks[i] = costumeId; return; }
}

/* ============ optimizer ============ */
function ownedCostumes() {
  return Object.entries(state.owned).map(([id, lv]) => ({ c: COSTUME_BY_ID[id], lv: Math.max(1, Math.min(200, lv)) })).filter(x => x.c);
}

// 游戏规则：同一角色只能选择一套服装。char 是角色 ID，不是服装 ID。
function hasUniqueCharacters(costumes) {
  const seen = new Set();
  for (const x of costumes) {
    const charId = x.c ? x.c.char : x.char;
    if (charId == null || seen.has(charId)) return false;
    seen.add(charId);
  }
  return true;
}
function duplicateCharacterNames(costumes) {
  const counts = new Map();
  for (const x of costumes) {
    const c = x.c || x;
    counts.set(c.char, (counts.get(c.char) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => {
    const c = DATA.characters.find(x => x.id === id);
    return c ? (c.chinese || c.name || ('角色 ' + id)) : ('角色 ' + id);
  });
}

function optimize() {
  const inp = readInputs();
  const roster = ownedCostumes();
  const status = document.getElementById('opt-status');
  if (roster.length === 0) { status.textContent = '请先勾选一些已拥有的服装。'; return; }
  const ctx0 = buildTeamContext(inp);

  // locked slots
  const locked = [];
  for (let i = 0; i < 6; i++) if (state.locks[i] != null && state.owned[state.locks[i]] != null)
    locked.push({ i, c: COSTUME_BY_ID[state.locks[i]], lv: state.owned[state.locks[i]] });
  if (locked.length !== Object.keys(state.locks).filter(k => state.locks[k] != null && state.owned[state.locks[k]] != null).length) {
    status.textContent = '锁定的服装数据无效，请检查队伍锁定状态。'; return;
  }
  if (!hasUniqueCharacters(locked)) {
    const names = duplicateCharacterNames(locked);
    status.textContent = `锁定队伍包含重复角色（${names.join('、')}）。同一角色只能上场一套服装，请先解除重复锁定。`;
    return;
  }
  const lockedIds = new Set(locked.map(l => l.c.id));
  const lockedChars = new Set(locked.map(l => l.c.char));
  const freeRoster = roster.filter(x => !lockedIds.has(x.c.id) && !lockedChars.has(x.c.char));
  const need = 6 - locked.length;
  if (need < 0) { status.textContent = '锁定的站位太多了。'; return; }

  // 1. score each costume standalone; candidates from the same character are alternatives.
  const scored = freeRoster.map(x => ({ x, r: slotCalc(x.c, x.lv, inp, ctx0) }));
  scored.sort((a, b) => b.r.dps - a.r.dps);

  // 2. Greedily select the best legal six: never take two costumes of one character.
  function teamScoreOf(list) {
    if (!hasUniqueCharacters([...locked, ...list])) return -Infinity;
    const slots = list.map(x => slotCalc(x.c, x.lv, inp, buildTeamContext(inp)));
    return teamCalc(slots, inp).total;
  }
  const team = [];
  const selectedChars = new Set(lockedChars);
  for (const candidate of scored) {
    if (selectedChars.has(candidate.x.c.char)) continue;
    team.push(candidate.x);
    selectedChars.add(candidate.x.c.char);
    if (team.length === need) break;
  }
  if (team.length < need) {
    status.textContent = `可用的不同角色不足：还需要 ${need} 个角色，但当前库存和锁定条件无法组成合法六人队。请补充不同角色服装或解除锁定。`;
    return;
  }
  // role coverage: ensure at least one AoE if mode != boss and available
  if (inp.mode !== 'boss' && need > 0) {
    const hasAoE = team.some(x => slotCalc(x.c, x.lv, inp, ctx0).hasAoE);
    if (!hasAoE) {
      const replaceIndex = team.length - 1;
      const otherChars = new Set([...lockedChars, ...team.filter((_, i) => i !== replaceIndex).map(x => x.c.char)]);
      const bestAoE = scored.find(s =>
        slotCalc(s.x.c, s.x.lv, inp, ctx0).hasAoE &&
        !team.includes(s.x) &&
        !otherChars.has(s.x.c.char)
      );
      if (bestAoE && team.length) team[replaceIndex] = bestAoE.x;
    }
  }
  let improved = true, guard = 0;
  while (improved && guard++ < 12) {
    improved = false;
    let cur = teamScoreOf(team);
    for (let i = 0; i < team.length; i++) {
      for (const cand of scored) {
        if (team.includes(cand.x)) continue;
        const trial = team.slice(); trial[i] = cand.x;
        if (!hasUniqueCharacters([...locked, ...trial])) continue;
        const sc = teamScoreOf(trial);
        if (sc > cur * 1.001) { team = trial; cur = sc; improved = true; }
      }
    }
  }

  // 3. optimize order over all members (locked slots keep their positions)
  const freeCalcs = team.map(x => slotCalc(x.c, x.lv, inp, ctx0));
  const lockedCalcs = locked.map(l => ({ i: l.i, r: slotCalc(l.c, l.lv, inp, ctx0) }));
  let best = null, bestScore = -Infinity;
  for (const perm of permutations(freeCalcs)) {
    // place into full 6 with locks
    const full = new Array(6); let p = 0;
    for (const l of lockedCalcs) full[l.i] = l.r;
    for (let i = 0; i < 6; i++) if (!full[i]) full[i] = perm[p++];
    const sc = orderScore(full, inp);
    if (sc > bestScore) { bestScore = sc; best = full; }
  }
  renderResult(best, inp, '优化后的队伍');
  status.textContent = `已评估 ${scored.length} 套服装、${factorial(need)} 种站位顺序。`;
}
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }

function optimizeOrderOnly() {
  const inp = readInputs();
  const roster = ownedCostumes();
  const status = document.getElementById('opt-status');
  const six = roster.slice(0, 6);
  if (six.length < 6) { status.textContent = '需要至少 6 套已拥有的服装。'; return; }
  if (!hasUniqueCharacters(six)) {
    const names = duplicateCharacterNames(six);
    status.textContent = `当前选取的六套服装存在重复角色（${names.join('、')}），无法进行站位优化。请在已拥有列表中每个角色只保留一套参战服装，或先调整队伍选择。`;
    return;
  }
  const ctx0 = buildTeamContext(inp);
  const calcs = six.map(x => slotCalc(x.c, x.lv, inp, ctx0));
  let best = null, bestScore = -Infinity;
  for (const perm of permutations(calcs)) {
    const sc = orderScore(perm, inp);
    if (sc > bestScore) { bestScore = sc; best = perm; }
  }
  renderResult(best, inp, '仅调整站位（当前 6 人）');
}

/* ============ result rendering ============ */
function renderResult(orderedSlots, inp, title) {
  if (!orderedSlots || orderedSlots.length !== 6 || !hasUniqueCharacters(orderedSlots)) {
    const status = document.getElementById('opt-status');
    if (status) status.textContent = '安全校验未通过：队伍必须由六个不同角色组成，已阻止输出无效推荐。';
    return;
  }
  const tc = teamCalc(orderedSlots, inp);
  const sum = document.getElementById('team-summary');
  const critE = 1 + Math.min(1, tc.ctx.critRate) * (tc.ctx.critDmg - 1);
  sum.innerHTML = `
    <span>模式：<b>${ZH_MODE[inp.mode] || inp.mode}</b>（${title}）</span>
    <span class="big">全队 DPS ≈ ${fmt(tc.total)}× 你的攻击力</span>
    <span>暴击：${fmtPct(tc.ctx.critRate)} @ ${tc.ctx.critDmg.toFixed(2)}×（E=${critE.toFixed(3)}×）</span>
    <span>增益倍率：${tc.attackMult.toFixed(3)}× · 减益削减：${tc.defAmp.toFixed(3)}× · 标签：${tc.tagMult.toFixed(3)}×</span>
    <span>${tc.tagList.map(t => `标签 ${tagName(t.tag)} ×${t.n}`).join('、') || '无同标签组合'}</span>`;

  const roles = ZH_ROLE;
  const wrap = document.getElementById('team-slots');
  wrap.innerHTML = '';
  tc.slots.forEach((s, i) => {
    const c = COSTUME_BY_ID[s.id];
    const div = document.createElement('div');
    div.className = 'slot' + (i === 5 ? ' carry' : i === 0 ? ' tank' : '');
    const buffTxt = s.buffs.map(b => `${ZH_BUFF_LABEL[b.kind] || b.kind} +${fmt(b.value)} @${fmtPct(b.uptime, 0)}`).join('<br>');
    const debTxt = s.debuffs.map(d => `${ZH_BUFF_LABEL[d.kind] || d.kind} ${fmt(d.value)} @${fmtPct(d.uptime, 0)}`).join('<br>');
    div.innerHTML = `
      <div class="pos">${i + 1}</div>
      <div class="role">${roles[i]}</div>
      <div class="name">${costumeLabel(c)} <span class="hint">Lv${s.lv}</span></div>
      <div class="nums">
        <span>攻击倍率 ×<b>${s.ar.toFixed(3)}</b> · 攻速 <b>${s.swings.toFixed(2)}/秒</b></span>
        <span>普攻 <b>${fmt(s.normalDPS)}</b> + 特技 <b>${fmt(s.skillDPS)}</b></span>
        <span>= <b>${fmt(s.dps)}</b> /秒</span>
        ${s.skillMult ? `<span>特技倍率 <b>${fmt(s.skillMult)}×</b> · 循环 <b>${s.cycle.toFixed(1)}秒</b></span>` : ''}
        ${buffTxt ? `<span class="badge buff">${buffTxt}</span>` : ''}
        ${debTxt ? `<span class="badge debuff">${debTxt}</span>` : ''}
        <span class="hint">${s.tags.map(t => '标签 ' + tagName(t)).join(' ')}</span>
      </div>`;
    wrap.appendChild(div);
  });

  // math breakdown
  const lines = [];
  lines.push(`为何这样排：全队共享同一个体力池 —— 没有人需要抗伤，也不会有人先倒下。`);
  lines.push(`站位只决定特技发动顺序（FIFO，特技间隔 0.5 秒 / 支援间隔 2 秒）：开团角色要放在输出左边。`);
  lines.push('');
  orderedSlots.forEach((s, i) => {
    lines.push(`第 ${i + 1} 位 ${costumeLabel(COSTUME_BY_ID[s.id])} Lv${s.lv}：普攻 ${fmt(s.normalDPS)}（1×${inp.normalRate}×${s.ar.toFixed(3)}攻倍×${s.swings.toFixed(2)}攻速×倍率）+ 特技 ${fmt(s.skillDPS)} = ${fmt(s.dps)}/秒`);
  });
  lines.push('');
  lines.push(`全队：ΣDPS ${fmt(tc.slots.reduce((a, s) => a + s.dps, 0))} × 增益 ${tc.attackMult.toFixed(3)} × 减益 ${tc.defAmp.toFixed(3)} × 标签 ${tc.tagMult.toFixed(3)} = ${fmt(tc.total)}/秒`);
  if (tc.notes.length) lines.push(tc.notes.join(' '));
  document.getElementById('team-math').textContent = lines.join('\n');
}

/* ============ items tab ============ */
// effect value of a possessionFx row at a given item level
function fxValueAt(fxid, lv) {
  const fx = DATA.possessionFx[String(fxid)];
  if (!fx) return null;
  let v = Number(fx.value);
  let scaled = false;
  if (fx.group && DATA.lrvGroups[String(fx.group)]) { v = evalGroup(fx.group, lv); scaled = true; }
  else if (fx.vt === 'Permil') { v /= 1000; scaled = true; }
  return { status: fx.status, v, scaled };
}
function itemState(key) {
  const s = state.items[key];
  if (s === true) return { own: true, eq: false };   // migrate legacy
  return { own: !!(s && s.own), eq: !!(s && s.eq) };
}
function setItemState(key, patch) {
  const cur = itemState(key);
  state.items[key] = Object.assign(cur, patch);
  saveState();
}
function targetText(cf) {
  if (!cf) return '';
  if (cf.target === 'Party') return '🎯 全队';
  if (cf.target === 'AssistCharacter') return `🎯 支援 ${cf.targetIds.join('、')}`;
  return `🎯 角色 ${cf.targetIds.join('、')}`;
}
function itemEffectText(it) {
  if (it.kind === 'treasure') {
    const parts = [];
    for (const fxid of it.posFx || []) {
      const r = fxValueAt(fxid, 1);
      if (r) parts.push(`<b>持有：</b> ${ZH_STATUS[r.status] || r.status} ${fmt(r.v)}${r.scaled ? '（随账号进度成长）' : ''}`);
    }
    for (const ch of it.equipChain || []) {
      if (ch.select === 'Custom') {
        const cf = DATA.customFx[String(ch.target)];
        const r = cf ? fxValueAt(cf.fx, 1) : null;
        if (cf && r) {
          const prog = cf.ref === 'ContentsProgress' ? '（随账号进度成长）' : '（随等级成长）';
          parts.push(`<b>装备：</b> ${ZH_STATUS[r.status] || r.status} ${fmt(r.v)} ${targetText(cf)}${cf.cond ? '［有条件］' : ''}${prog}`);
        }
      } else {
        const r = fxValueAt(ch.target, 1);
        if (r) parts.push(`<b>装备：</b> ${ZH_STATUS[r.status] || r.status} ${fmt(r.v)} （随等级成长）`);
      }
    }
    return parts.join(' · ') || '无效果数据';
  }
  const parts = [];
  const own = fxValueAt(it.posFx, 1);
  if (own) parts.push(`<b>持有：</b> ${ZH_STATUS[own.status] || own.status} ${fmt(own.v)}${own.scaled ? '（随道具等级成长）' : ''}`);
  const eq = fxValueAt(it.equipFx, 1);
  if (eq) parts.push(`<b>装备：</b> ${ZH_STATUS[eq.status] || eq.status} ${fmt(eq.v)}${eq.scaled ? '（成长型）' : ''}`);
  return parts.join(' · ') || '无效果数据';
}
function keyholderText(g) {
  const cf = DATA.customFx[String(g.equipFx)];
  const fx = cf ? fxValueAt(cf.fx, 1) : null;
  const parts = [];
  if (cf && fx) parts.push(`<b>装备：</b> ${ZH_STATUS[fx.status] || fx.status} ${fmt(fx.v)} ${targetText(cf)} （随等级成长）`);
  const rf = DATA.customFx[String(g.rarityFx[0])];
  const rfx = rf ? fxValueAt(rf.fx, 1) : null;
  if (rf && rfx) parts.push(`<b>稀有度阶梯：</b> 最多 ${g.rarityFx.length} 条效果（例如 ${ZH_STATUS[rfx.status] || rfx.status} ${targetText(rf)}）`);
  return parts.join(' · ') || '无效果数据';
}
function renderItems() {
  const el = document.getElementById('items');
  const kind = document.getElementById('item-kind').value;
  const sortBy = document.getElementById('item-sort').value;
  const statusFilter = document.getElementById('item-statusfilter').value;
  el.innerHTML = '';
  const addCard = (key, title, text, showEq, levelSel, imgKey) => {
    const st = itemState(key);
    const card = document.createElement('div');
    card.className = 'card' + (st.own ? ' owned' : '');
    card.innerHTML = `
      <div class="head"><span class="hdmain">${imgTag(imgKey || '')}<span class="title">${title}</span></span></div>
      <div class="row hint">${text}</div>
      <div class="row lvl">
        <label><input type="checkbox" data-own="${key}" ${st.own ? 'checked' : ''}> 已拥有</label>
        ${showEq ? `<label><input type="checkbox" data-eq="${key}" ${st.eq ? 'checked' : ''} ${st.own ? '' : 'disabled'}> 已装备</label>` : ''}
        ${levelSel ? `<label>等级 <input type="number" min="1" max="${levelSel}" value="${(state.items[key] && state.items[key].lv) || 1}" data-lv="${key}" style="width:4em"></label>` : ''}
      </div>`;
    el.appendChild(card);
  };
  // 收集全部道具为统一列表，便于排序 / 筛选
  const items = [];
  if (!kind || kind === 'weapon' || kind === 'armor' || kind === 'assist' || kind === 'treasure') {
    for (const it of DATA.items) {
      if (kind && it.kind !== kind) continue;
      const nm = itemName(it);
      items.push({
        key: it.kind + ':' + it.id, kind: it.kind, id: it.id,
        title: `${ZH_KIND[it.kind] || it.kind} #${it.id}${nm ? ' · ' + nm : ''}${it.rarity ? ' · ' + (ZH_RARITY[it.rarity] || it.rarity) : ''}`,
        text: itemEffectText(it), showEq: true, levelSel: undefined, imgKey: itemImgKey(it),
      });
    }
  }
  if (!kind || kind === 'home') {
    for (const h of DATA.homeItems) {
      const fx = fxValueAt(h.fx, 1);
      items.push({
        key: 'home:' + h.id, kind: 'home', id: h.id,
        title: `小天地物品 #${h.id} · ${ZH_HOME_TYPE[h.type] || h.type}${ZH['home_item_' + h.id] ? ' · ' + ZH['home_item_' + h.id] : ''}`,
        text: `<b>持有：</b> ${fx ? (ZH_STATUS[fx.status] || fx.status) : '?'} 道具等级 1/2/3 时为 ×1.15 / ×1.20 / ×1.30（摆放位置只是装饰，拥有即可生效）`,
        showEq: false, levelSel: h.maxLv, imgKey: 'home_' + h.id,
      });
    }
  }
  if (!kind || kind === 'keyholder') {
    for (const g of DATA.keyholderGroups) {
      items.push({
        key: 'kh:' + g.id, kind: 'keyholder', id: g.id,
        title: `钥匙扣 #${g.id} · ${charName(g.chara)}${ZH['assist_skill_' + g.assist] ? ' + ' + ZH['assist_skill_' + g.assist] : ''}`,
        text: keyholderText(g), showEq: true, levelSel: undefined, imgKey: '',
      });
    }
  }
  // 状态筛选
  if (statusFilter === 'owned') items = items.filter(it => itemState(it.key).own);
  else if (statusFilter === 'equipped') items = items.filter(it => itemState(it.key).eq);
  // 排序
  const kindOrder = { weapon: 0, armor: 1, assist: 2, treasure: 3, home: 4, keyholder: 5 };
  items.sort((a, b) => {
    switch (sortBy) {
      case 'id-asc':  return a.id - b.id || kindOrder[a.kind] - kindOrder[b.kind];
      case 'id-desc': return b.id - a.id || kindOrder[a.kind] - kindOrder[b.kind];
      case 'kind':    return kindOrder[a.kind] - kindOrder[b.kind] || a.id - b.id;
      case 'name':    return a.title.localeCompare(b.title, 'zh');
      default:        return 0;
    }
  });
  for (const it of items) addCard(it.key, it.title, it.text, it.showEq, it.levelSel, it.imgKey);
  el.querySelectorAll('[data-own]').forEach(cb => cb.addEventListener('change', e => {
    const key = e.target.dataset.own;
    setItemState(key, { own: e.target.checked, eq: e.target.checked ? itemState(key).eq : false });
    saveState(); renderItems();
  }));
  el.querySelectorAll('[data-eq]').forEach(cb => cb.addEventListener('change', e => {
    setItemState(e.target.dataset.eq, { eq: e.target.checked }); saveState(); renderItemSummary();
    e.target.closest('.card').classList.toggle('owned', itemState(e.target.dataset.eq).own || e.target.checked);
  }));
  el.querySelectorAll('[data-lv]').forEach(inp => inp.addEventListener('change', e => {
    const key = e.target.dataset.lv;
    const cur = state.items[key] && typeof state.items[key] === 'object' ? state.items[key] : { own: true, eq: false };
    state.items[key] = Object.assign(cur, { lv: Math.max(1, +e.target.value || 1) });
    saveState(); renderItemSummary();
  }));
  renderItemSummary();
}
function accumFx(sums, fxid, lv, note) {
  const r = fxValueAt(fxid, lv);
  if (!r) return;
  const st = r.status;
  sums[st] = sums[st] || { add: 0, mult: 1, notes: [] };
  if (Math.abs(r.v) < 100 && r.scaled) sums[st].mult += r.v;
  else sums[st].add += r.v;
  if (note) sums[st].notes.push(note);
}
function renderItemSummary() {
  const lv = Math.max(1, +document.getElementById('item-level').value || 1);
  const sums = {};
  const targeted = [];   // 修：原版在此处之前就 push，勾选珍藏品会抛 ReferenceError
  for (const it of DATA.items) {
    const st = itemState(it.kind + ':' + it.id);
    if (it.kind === 'treasure') {
      if (st.own) for (const fxid of it.posFx || []) accumFx(sums, fxid, lv);
      if (st.own && st.eq) {
        for (const ch of it.equipChain || []) {
          if (ch.select === 'Custom') {
            const cf = DATA.customFx[String(ch.target)];
            if (!cf) continue;
            const r = fxValueAt(cf.fx, lv);
            if (!r) continue;
            if (cf.cond) targeted.push(`${ZH_STATUS[r.status] || r.status} ×${fmt(r.v)} ${targetText(cf)} ［条件 ${cf.cond}］`);
            else if (cf.target === 'Party') accumFx(sums, cf.fx, lv, '珍藏品');
            else targeted.push(`${ZH_STATUS[r.status] || r.status} ×${fmt(r.v)} ${targetText(cf)}`);
          } else accumFx(sums, ch.target, lv);
        }
      }
      continue;
    }
    if (st.own) accumFx(sums, it.posFx, lv);
    if (st.own && st.eq) accumFx(sums, it.equipFx, lv);
  }
  for (const h of DATA.homeItems) {
    const st = itemState('home:' + h.id);
    if (st.own) accumFx(sums, h.fx, (state.items['home:' + h.id] && state.items['home:' + h.id].lv) || 1, '小天地物品');
  }
  for (const g of DATA.keyholderGroups) {
    const st = itemState('kh:' + g.id);
    if (!(st.own && st.eq)) continue;
    const cf = DATA.customFx[String(g.equipFx)];
    if (!cf) continue;
    if (cf.target === 'Party') accumFx(sums, cf.fx, lv, '钥匙扣');
    else {
      const r = fxValueAt(cf.fx, lv);
      if (r) targeted.push(`${ZH_STATUS[r.status] || r.status} ×${fmt(r.v)} ${targetText(cf)}`);
    }
  }
  const el = document.getElementById('item-summary');
  const txt = Object.entries(sums).map(([st, s]) =>
    `${ZH_STATUS[st] || st}：${s.mult > 1 ? '×' + s.mult.toFixed(3) : ''}${s.add ? ' +' + fmt(s.add) : ''}`).join(' · ');
  el.innerHTML = (txt ? `<b>道具合计（等级 ${lv}）：</b> ${txt}` : '尚未勾选任何道具。') +
    (targeted.length ? `<br><span class="hint">🎯 定向效果（仅当对应角色在场时生效）：${targeted.join(' · ')}</span>` : '');
  el.dataset.sums = JSON.stringify(sums);
}

/* ============ tabs & events ============ */
function bindTabs() {
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tabpage').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'items') renderItems();
  }));
}
function bindControls() {
  document.getElementById('roster-filter').addEventListener('input', renderRoster);
  document.getElementById('roster-ownedonly').addEventListener('change', renderRoster);
  document.getElementById('btn-allowned').addEventListener('click', () => {
    for (const c of DATA.costumes) state.owned[c.id] = state.owned[c.id] || 100; saveState(); renderRoster();
  });
  document.getElementById('btn-noneowned').addEventListener('click', () => {
    state.owned = {}; state.locks = {}; saveState(); renderRoster();
  });
  document.getElementById('btn-optimize').addEventListener('click', optimize);
  document.getElementById('btn-orderonly').addEventListener('click', optimizeOrderOnly);
  document.getElementById('btn-clearlocks').addEventListener('click', () => { state.locks = {}; saveState(); renderRoster(); });
  document.getElementById('item-kind').addEventListener('change', renderItems);
  document.getElementById('item-level').addEventListener('change', renderItemSummary);
  document.getElementById('roster-sort').addEventListener('change', renderRoster);
  document.getElementById('roster-tagfilter').addEventListener('change', renderRoster);
  document.getElementById('roster-rarityfilter').addEventListener('change', renderRoster);
  document.getElementById('item-sort').addEventListener('change', renderItems);
  document.getElementById('item-statusfilter').addEventListener('change', renderItems);
  document.getElementById('btn-applyitems').addEventListener('click', () => {
    const sums = JSON.parse(document.getElementById('item-summary').dataset.sums || '{}');
    const mul = (id, st) => {
      const s = sums[st]; if (!s) return;
      const el = document.getElementById(id);
      el.value = ((parseFloat(el.value) || 1) * (s.mult || 1)).toFixed(3);
    };
    mul('in-bossRate', 'BossDamageRate'); mul('in-mobRate', 'MobDamageRate');
    mul('in-normalRate', 'NormalAttackDamageRate'); mul('in-skillRate', 'SkillDamageRate');
    mul('in-uniqueRate', 'UniqueSkillDamageRate');
    if (sums['CriticalRate']) document.getElementById('in-critRate').value =
      Math.min(1, (parseFloat(document.getElementById('in-critRate').value) || 0) + (sums['CriticalRate'].mult - 1)).toFixed(3);
    if (sums['CriticalDamage']) document.getElementById('in-critDmg').value =
      ((parseFloat(document.getElementById('in-critDmg').value) || 1) + (sums['CriticalDamage'].mult - 1)).toFixed(3);
    document.querySelector('.tab[data-tab=optimizer]').click();
  });
  // persist inputs
  const ids = ['in-critRate', 'in-critDmg', 'in-normalRate', 'in-skillRate', 'in-uniqueRate',
    'in-bossRate', 'in-mobRate', 'in-atkSpeed', 'in-cdr', 'in-defDebuff', 'in-tagWeight', 'in-mode'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (state.inputs[id] != null) el.value = state.inputs[id];
    el.addEventListener('change', () => { state.inputs[id] = el.value; saveState(); });
  }
}

/* ============ 放大图灯箱（左键单击服装图标） ============ */
function openLightbox(src, cap) {
  const lb = document.getElementById('lightbox');
  lb.querySelector('.lightbox-img').src = src;
  lb.querySelector('.lightbox-cap').textContent = cap || '';
  lb.hidden = false;
}
function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.hidden = true;
  lb.querySelector('.lightbox-img').src = '';
}
function bindLightbox() {
  const lb = document.getElementById('lightbox');
  lb.addEventListener('click', e => { if (e.target.hasAttribute('data-close')) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
  // 事件委托：roster 内任意 zoomable 图标左键单击即放大
  document.getElementById('roster').addEventListener('click', e => {
    const img = e.target.closest('img.ico.zoomable');
    if (!img) return;
    const card = img.closest('.card');
    const cap = card ? (card.querySelector('.title') || {}).textContent : '';
    openLightbox(img.getAttribute('data-zoom'), cap);
  });
}

bindTabs();
bindControls();
populateRosterFilters();
bindLightbox();
renderRoster();
