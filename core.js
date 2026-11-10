/* 倾覆余量台 · 核心引擎（tip-margin）
 *
 * 问题：立着的东西被推/被吹到多大会翻？要改哪一项、改到多少？
 *
 * 口径（详见 需求与调研.md 第 3 节）：
 *   d      = 重心地面投影到支撑面四条边的距离里最短的那条（最容易倒的方向）
 *   θc     = atan(d / h)                       临界倾角（准静态倾斜）
 *   F_c    = m·g·d / z                         临界推力（力作用在高度 z；z = 0 时推不翻）
 *   v_min  = √(2g(√(d²+h²) − h))               一次撞击撞倒所需最小速度（与质量无关）
 *   ΔU     = m·g·(√(d²+h²) − h) = ½·m·v_min²   翻过棱边所需的最小势能增量
 *   v_crit = √(2·m·g·d / (z_w·ρ·Cd·A))          临界风速（形心 z_w = H/2，风向取最不利）
 *   滑动先行： μ·m·g < F_c
 * 单位：长度对外用 cm、质量 kg、力 N、风速 m/s；内部长度一律换成 m。
 */
(function (root) {
  'use strict';

  const G = 9.80665;          // m/s²
  const RHO = 1.225;          // kg/m³
  const KGF = G;              // 1 kgf = 9.80665 N
  const MAX_ROWS = 12;
  const MAX_SIZE_REQ = 400;   // 反推所需支撑尺寸上限（cm），超过即判不可行
  const PUSH_H_MAX = 500, F_MAX = 1000000, WIND_MAX = 100;

  const r2 = (x) => Math.round(x * 100) / 100;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const r4 = (x) => Math.round(x * 10000) / 10000;

  /* ── 默认（虚构示例，页面上必须明说） ───────────────── */
  const defaults = {
    items: [
      { name: '书架（客厅）', m: 45, H: 180, h: 105, W: 80, D: 30, ox: 0, oy: 0, wind: false },
      { name: '电视柜', m: 32, H: 50, h: 38, W: 150, D: 40, ox: 0, oy: 0, wind: false },
      { name: '婴儿床', m: 18, H: 95, h: 52, W: 120, D: 60, ox: 0, oy: 0, wind: false },
      { name: '落地灯', m: 4.5, H: 150, h: 112, W: 30, D: 30, ox: 0, oy: 0, wind: false },
      { name: '阳台花架', m: 25, H: 120, h: 58, W: 60, D: 30, ox: 0, oy: 0, wind: true },
      { name: '立式指示牌', m: 18, H: 160, h: 78, W: 60, D: 40, ox: 0, oy: 0, wind: true }
    ],
    push: { z: 95, F: 100, mu: 0.5 },
    wind: { on: true, cd: 1.2, vT: 17.2 },
    plan: { sf: 2.0, zf: 90 }
  };

  /* 场景：只改数字，改完可由页面「一键换上」 */
  const scenarios = [
    { id: 'home', name: '默认·家居 6 件（虚构）', patch: {} },
    { id: 'child', name: '有学步小孩（预想推力 200 N）', patch: { push: { z: 80, F: 200, mu: 0.5 } } },
    { id: 'typhoon', name: '台风天·阳台与院子（10 级 24.5 m/s）', patch: { wind: { on: true, cd: 1.4, vT: 24.5 }, push: { z: 95, F: 100, mu: 0.5 } } },
    { id: 'tile', name: '瓷砖地面（μ = 0.15，先滑后倒）', patch: { push: { z: 95, F: 100, mu: 0.15 } } },
    {
      id: 'sign', name: '一块立式广告牌（户外）',
      patch: {
        items: [{ name: '立式广告牌', m: 22, H: 200, h: 95, W: 70, D: 45, ox: 0, oy: 0, wind: true }],
        wind: { on: true, cd: 1.3, vT: 24.5 }, push: { z: 100, F: 120, mu: 0.6 }
      }
    },
    { id: 'anchor', name: '只关心固定件要多大（sf = 4）', patch: { plan: { sf: 4, zf: 60 } } }
  ];

  /* ── 解析与校验 ─────────────────────────────────────── */
  function parseNum(v, opt) {
    const label = opt.label || '数值';
    let s;
    if (typeof v === 'number') {
      if (!isFinite(v)) return { ok: false, msg: label + '必须是有限数字' };
      s = String(v);
    } else if (typeof v === 'string') {
      s = v.replace(/[,\s　]/g, '');
    } else {
      return { ok: false, msg: label + '不能为空' };
    }
    if (s === '') return { ok: false, msg: label + '不能为空' };
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, msg: label + '只能填数字（可带小数）' };
    const x = Number(s);
    if (!isFinite(x)) return { ok: false, msg: label + '超出可处理范围' };
    if (opt.min !== undefined && x < opt.min) return { ok: false, msg: label + '不能小于 ' + opt.min };
    if (opt.max !== undefined && x > opt.max) return { ok: false, msg: label + '不能大于 ' + opt.max };
    return { ok: true, value: x };
  }

  function num(v) { return typeof v === 'number' ? v : Number(String(v).replace(/[,\s　]/g, '')); }

  /* 规范化 + 校验。返回 { ok, cfg, errors, warnings }，不抛异常。 */
  function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const errors = [], warnings = [];
    const cfg = { items: [], push: {}, wind: {}, plan: {} };

    const items = Array.isArray(src.items) ? src.items : [];
    if (items.length === 0) errors.push({ row: 0, field: 'items', msg: '至少要有 1 件物品' });
    if (items.length > MAX_ROWS) errors.push({ row: 0, field: 'items', msg: '最多支持 ' + MAX_ROWS + ' 件物品，当前 ' + items.length + ' 件' });

    items.slice(0, MAX_ROWS).forEach((it, i) => {
      const row = i + 1;
      const name = String((it && it.name) != null ? it.name : '').trim();
      if (!name) errors.push({ row, field: 'name', msg: '第 ' + row + ' 件：名称不能为空' });
      if (name.length > 24) errors.push({ row, field: 'name', msg: '第 ' + row + ' 件：名称不能超过 24 字' });

      const f = {};
      let bad = false;
      [['m', it && it.m, '质量', 0.1, 100000],
       ['H', it && it.H, '物品高度', 5, 3000],
       ['h', it && it.h, '重心高度', 0, 3000],
       ['W', it && it.W, '支撑面宽', 0.5, 2000],
       ['D', it && it.D, '支撑面深', 0.5, 2000]].forEach(([k, v, label, min, max]) => {
        const p = parseNum(v, { label: label, min: min, max: max });
        if (!p.ok) { errors.push({ row, field: k, msg: '第 ' + row + ' 件：' + p.msg }); bad = true; } else f[k] = p.value;
      });
      [['ox', it && it.ox != null ? it.ox : 0, '重心偏置 x'], ['oy', it && it.oy != null ? it.oy : 0, '重心偏置 y']].forEach(([k, v, label]) => {
        const p = parseNum(v, { label: label, min: -2000, max: 2000 });
        if (!p.ok) { errors.push({ row, field: k, msg: '第 ' + row + ' 件：' + p.msg }); bad = true; } else f[k] = p.value;
      });
      if (bad) return;

      if (f.h > f.H) errors.push({ row, field: 'h', msg: '第 ' + row + ' 件：重心高度（' + f.h + ' cm）不能高于物品高度（' + f.H + ' cm）' });
      if (Math.abs(f.ox) >= f.W / 2) errors.push({ row, field: 'ox', msg: '第 ' + row + ' 件：重心投影已在支撑面外（|偏置 x| ≥ 宽/2），静置就会倒，本页不再算' });
      if (Math.abs(f.oy) >= f.D / 2) errors.push({ row, field: 'oy', msg: '第 ' + row + ' 件：重心投影已在支撑面外（|偏置 y| ≥ 深/2），静置就会倒，本页不再算' });

      cfg.items.push({ name: name, m: f.m, H: f.H, h: f.h, W: f.W, D: f.D, ox: f.ox, oy: f.oy, wind: !!(it && it.wind) });
    });

    const pushSrc = src.push || {};
    [['z', pushSrc.z, '推力作用高度', 0, PUSH_H_MAX],
     ['F', pushSrc.F, '预想推力', 0.1, F_MAX],
     ['mu', pushSrc.mu, '摩擦系数', 0, 2]].forEach(([k, v, label, min, max]) => {
      const p = parseNum(v, { label: label, min: min, max: max });
      if (!p.ok) errors.push({ row: 0, field: 'push.' + k, msg: p.msg }); else cfg.push[k] = p.value;
    });
    if (cfg.push.z === 0) warnings.push('推力作用高度为 0（在地面推）：没有倾覆力矩，本页判为「推不翻，只会被推着走」。');
    if (cfg.push.mu === 0) warnings.push('摩擦系数为 0：任何横向力都会让物体先滑动，本页按「滑动先行」标注。');

    const windSrc = src.wind || {};
    cfg.wind.on = windSrc.on === undefined ? true : !!windSrc.on;
    [['cd', windSrc.cd, '阻力系数 Cd', 0.1, 5],
     ['vT', windSrc.vT, '目标风速', 0.1, WIND_MAX]].forEach(([k, v, label, min, max]) => {
      const p = parseNum(v, { label: label, min: min, max: max });
      if (!p.ok) errors.push({ row: 0, field: 'wind.' + k, msg: p.msg }); else cfg.wind[k] = p.value;
    });
    if (cfg.wind.on === false) warnings.push('风口径已关闭：只按「被推」判定。');

    const planSrc = src.plan || {};
    [['sf', planSrc.sf, '目标安全系数', 1, 10],
     ['zf', planSrc.zf, '固定件安装高度', 1, 500]].forEach(([k, v, label, min, max]) => {
      const p = parseNum(v, { label: label, min: min, max: max });
      if (!p.ok) errors.push({ row: 0, field: 'plan.' + k, msg: p.msg }); else cfg.plan[k] = p.value;
    });
    if (cfg.plan.sf !== undefined && cfg.plan.sf < 1.5) warnings.push('目标安全系数低于 1.5：在本页的分档里这属于「略有裕度」，是否够用请自行判断。');

    return { ok: errors.length === 0, cfg: cfg, errors: errors, warnings: warnings };
  }

  /* ── 单件物理量 ─────────────────────────────────────── */
  function itemPhysics(it, pushZcm, mu, cd) {
    const m = it.m;
    const h = it.h / 100;             // m
    const a = it.W / 200;             // 半宽 m
    const b = it.D / 200;             // 半深 m
    const ox = it.ox / 100, oy = it.oy / 100;
    const zw = it.H / 200;            // 风压形心高度 m

    const edges = [
      { axis: 'x', sign: 1, dir: '朝 +宽 那侧（右）', dist: a - ox },
      { axis: 'x', sign: -1, dir: '朝 −宽 那侧（左）', dist: a + ox },
      { axis: 'y', sign: 1, dir: '朝 +深 那侧（后）', dist: b - oy },
      { axis: 'y', sign: -1, dir: '朝 −深 那侧（前）', dist: b + oy }
    ].map((e) => Object.assign({}, e, { d: Math.max(0, e.dist) }));

    let wi = 0;
    edges.forEach((e, i) => { if (e.d < edges[wi].d) wi = i; });
    const weak = edges[wi];

    const d = weak.d;
    const tieAll = edges.every((e) => Math.abs(e.d - d) < 1e-12);
    const thC = h > 0 ? Math.atan2(d, h) * 180 / Math.PI : 90;
    const z = pushZcm / 100;
    const Ftip = z > 0 ? m * G * d / z : null;      // null = 在地面推，没有倾覆力矩
    const Fslide = mu * m * G;
    const slideFirst = Ftip !== null && Fslide < Ftip;
    const dU = m * G * (Math.hypot(d, h) - h);
    const vMin = Math.sqrt(2 * dU / m);

    // 风：取最不利方向；迎风面积 = 垂直风向的尺寸 × 物品高度
    const perpSize = weak.axis === 'x' ? b * 2 : a * 2;   // m
    const A = perpSize * (it.H / 100);                    // m²
    const Fwind = zw > 0 ? m * G * d / zw : null;
    const vCrit = Fwind !== null && A > 0 && cd > 0 ? Math.sqrt(2 * Fwind / (RHO * cd * A)) : null;

    return {
      m: m, h: h, a: a, b: b, ox: ox, oy: oy, zw: zw, d: d, dTrue: weak.dist,
      ni: wi, tieAll: tieAll,
      weakDir: tieAll ? '四个方向等距' : weak.dir,
      weakAxis: weak.axis, weakSign: weak.sign,
      thC: thC, Ftip: Ftip, Fslide: Fslide, slideFirst: slideFirst,
      dU: dU, vMin: vMin, A: A, Fwind: Fwind, vCrit: vCrit,
      edges: edges.map((e) => ({ axis: e.axis, sign: e.sign, dir: e.dir, d: e.d, dist: e.dist }))
    };
  }

  /* 需要的最短支撑距离 → 需要的宽/深（两个方向都要够，否则另一条边会变成新的短板） */
  function sizePlan(dReqM, oxCm, oyCm) {
    return {
      dReq: dReqM * 100,
      W: 2 * (dReqM * 100 + Math.abs(oxCm)),
      D: 2 * (dReqM * 100 + Math.abs(oyCm))
    };
  }

  /* ── 主分析 ─────────────────────────────────────────── */
  function analyze(cfg) {
    const pushZ = cfg.push.z, mu = cfg.push.mu, Ft = cfg.push.F;
    const cd = cfg.wind.cd, vT = cfg.wind.vT, windOn = !!cfg.wind.on;
    const sf = cfg.plan.sf, zf = Math.max(cfg.plan.zf / 100, 0.05);

    const items = cfg.items.map((it) => {
      const p = itemPhysics(it, pushZ, mu, cd);
      // 不构成约束的口径记 null（而不是 Infinity），避免结果里出现 Infinity
      const kF = p.Ftip === null ? null : p.Ftip / Ft;
      const kV = windOn && it.wind && p.vCrit !== null ? p.vCrit / vT : null;
      const kParts = [kF, kV].filter((v) => v !== null);
      const k = kParts.length ? Math.min.apply(null, kParts) : null;
      const verdict = k === null ? 'ok' : (k < 1 ? 'fail' : (k < sf ? 'tight' : 'ok'));

      // 反推 ①：要扛住预想推力，最短支撑距离至少 dReq
      const dReqM = Ft * (pushZ / 100) / (p.m * G);
      const sp = sizePlan(dReqM, it.ox, it.oy);
      const sizeFeasible = sp.W <= MAX_SIZE_REQ && sp.D <= MAX_SIZE_REQ;
      const sizePractical = sp.W <= 2 * it.W && sp.D <= 2 * it.D;   // 加宽到现有尺寸的 2 倍以内才算「现实可选」
      // 反推 ②：把力施加得多低才能推不翻
      const pushZReq = p.d > 0 ? p.m * G * p.d / Ft * 100 : 0;    // cm
      const pushZReqOk = pushZReq < it.H;
      // 反推 ③：固定件需承受的拉力（抵消超出重力力矩的那部分）
      const anchorForce = Math.max(0, Ft * (pushZ / 100) - p.m * G * p.d) / zf;   // N
      // 风口径的一阶反推（用当前迎风面积）
      const dReqWindM = (p.Fwind !== null && p.Fwind > 0) ? RHO * cd * p.A * vT * vT * p.zw / (2 * p.m * G) : null;
      const spWind = dReqWindM === null ? null : sizePlan(dReqWindM, it.ox, it.oy);

      return {
        name: it.name, input: it,
        m: p.m, H: it.H, h: it.h, W: it.W, D: it.D, ox: it.ox, oy: it.oy,
        d: p.d, dTrue: p.dTrue, weakDir: p.weakDir, weakAxis: p.weakAxis, weakSign: p.weakSign, tieAll: p.tieAll,
        thC: p.thC,
        Ftip: p.Ftip, FtipKgf: p.Ftip === null ? null : p.Ftip / KGF,
        Fslide: p.Fslide, FslideKgf: p.Fslide / KGF, slideFirst: p.slideFirst,
        dU: p.dU, vMin: p.vMin, vMinKmh: p.vMin * 3.6,
        windOn: windOn && !!it.wind, A: p.A, Fwind: p.Fwind, vCrit: p.vCrit,
        kF: kF, kV: kV, k: k, verdict: verdict,
        forceHeadroom: p.Ftip === null ? null : p.Ftip - Ft,
        pushZReq: pushZReq, pushZReqOk: pushZReqOk,
        anchorForce: anchorForce, anchorForceKgf: anchorForce / KGF,
        dReq: sp.dReq, reqW: sp.W, reqD: sp.D, sizeFeasible: sizeFeasible, sizePractical: sizePractical,
        deltaW: sp.W - it.W, deltaD: sp.D - it.D,
        dReqWind: spWind === null ? null : spWind.dReq,
        reqWWind: spWind === null ? null : spWind.W, reqDWind: spWind === null ? null : spWind.D,
        edges: p.edges.map((e, i) => ({
          dir: e.dir, d: e.d,
          thC: it.h > 0 ? Math.atan2(e.d, it.h / 100) * 180 / Math.PI : 90,
          Ftip: pushZ > 0 ? it.m * G * e.d / (pushZ / 100) : null,
          weakest: i === p.ni
        })),
        sens: sensitivity(it, pushZ, mu, cd, p)
      };
    });

    const kOf = (x) => (x.k === null ? Infinity : x.k);
    const sorted = items.slice().sort((x, y) => kOf(x) - kOf(y));
    const worst = sorted.length ? sorted[0] : null;
    const needAction = items.filter((x) => x.verdict !== 'ok').length;
    const failCount = items.filter((x) => x.verdict === 'fail').length;
    const practicalCount = items.filter((x) => x.verdict !== 'ok' && x.sizePractical).length;

    const headline = worst
      ? '最弱的一件是「' + worst.name + '」：' + worst.weakDir + '只要 ' +
        (worst.Ftip === null ? '—' : r2(worst.Ftip) + ' N（' + r2(worst.FtipKgf) + ' kgf）') +
        '就能推倒，倾斜 ' + r2(worst.thC) + '° 就翻；' +
        items.length + ' 件里有 ' + needAction + ' 件没达到 ' + sf + ' 倍目标（其中 ' + failCount + ' 件会被推倒）。'
      : '';

    const warnList = [];
    if (pushZ === 0) warnList.push('推力作用高度为 0：所有「临界推力」显示为「推不翻（在地面推没有倾覆力矩）」。');
    items.forEach((x) => {
      if (x.h === 0) warnList.push('「' + x.name + '」重心高度为 0：临界倾角记为 90°（不会因倾斜而翻，但可被抬过棱边）。');
      if (x.slideFirst) warnList.push('「' + x.name + '」的临界推力（' + r2(x.Ftip) + ' N）大于最大静摩擦（' + r2(x.Fslide) + ' N）：真实情况会先被推着滑走，而不是翻倒。');
      if (!x.sizeFeasible && x.verdict !== 'ok') warnList.push('「' + x.name + '」要扛住 ' + r2(Ft) + ' N，最短支撑距离需要 ' + r2(x.dReq) + ' cm（宽 ≥ ' + r2(x.reqW) + '、深 ≥ ' + r2(x.reqD) + ' cm）——' + (Math.max(x.reqW, x.reqD) > MAX_SIZE_REQ ? '超过本页 400 cm 上限，判为不可行' : '可行') + '。');
      if (x.verdict !== 'ok' && !x.pushZReqOk) warnList.push('「' + x.name + '」即使把力施加在 ' + r2(x.pushZReq) + ' cm 以下也仍不够低（已经超过物品高度 ' + x.H + ' cm），靠「降低施力高度」这条路走不通。');
    });

    return {
      cfg: cfg, items: items, sorted: sorted, worst: worst,
      needAction: needAction, failCount: failCount, practicalCount: practicalCount,
      headline: headline, warnList: warnList,
      G: G, RHO: RHO
    };
  }

  /* 敏感性：施力高度 ×3、最短边 +10 cm、重心降低 20% */
  function sensitivity(it, pushZ, mu, cd, p) {
    const out = [];
    const F = (dd, z) => (z > 0 ? it.m * G * dd / (z / 100) : null);
    [0.5, 1, 1.5].forEach((f) => {
      const z = pushZ * f;
      const v = F(p.d, z);
      out.push({
        what: '力施加高度 ×' + f, detail: r2(z) + ' cm',
        Ftip: v, FtipKgf: v === null ? null : v / KGF,
        ratio: p.Ftip === null || v === null ? null : v / p.Ftip
      });
    });
    const grow = 10;
    const patch = p.weakAxis === 'x' ? { W: it.W + grow } : { D: it.D + grow };
    const p2 = itemPhysics(Object.assign({}, it, patch), pushZ, mu, cd);
    const v2 = F(p2.d, pushZ);
    out.push({
      what: '最短那条边加长 ' + grow + ' cm',
      detail: (p.weakAxis === 'x' ? '支撑面宽 ' + it.W + ' → ' + (it.W + grow) : '支撑面深 ' + it.D + ' → ' + (it.D + grow)) + ' cm',
      d: p2.d, thC: p2.thC, Ftip: v2, FtipKgf: v2 === null ? null : v2 / KGF,
      ratio: p.Ftip === null || v2 === null ? null : v2 / p.Ftip
    });
    const h3 = Math.max(it.h * 0.8, 0.1);
    const p3 = itemPhysics(Object.assign({}, it, { h: h3 }), pushZ, mu, cd);
    const v3 = F(p3.d, pushZ);
    out.push({
      what: '重心降低 20%（其余不变）',
      detail: r2(it.h) + ' → ' + r2(h3) + ' cm',
      d: p3.d, thC: p3.thC, Ftip: v3, FtipKgf: v3 === null ? null : v3 / KGF,
      ratio: p.Ftip === null || v3 === null ? null : v3 / p.Ftip,
      vMin: p3.vMin, vMinRatio: p3.vMin / p.vMin, thCRatio: p3.thC / p.thC
    });
    return out;
  }

  /* ── 每次重算都跑的结构自检 ─────────────────────────── */
  function verify(cfg, res) {
    const out = [];
    const fin = (x) => typeof x === 'number' && isFinite(x);
    const pushZ = cfg.push.z, mu = cfg.push.mu, Ft = cfg.push.F;
    const cd = cfg.wind.cd, windOn = !!cfg.wind.on;

    out.push({ ok: res.items.every((x) => Math.abs(x.d - Math.min.apply(null, x.edges.map((e) => e.d))) < 1e-12), msg: '最短支撑距离 = 四个方向里最小的那个' });
    out.push({ ok: res.items.every((x) => x.h > 0 ? Math.abs(x.thC - Math.atan2(x.d, x.h / 100) * 180 / Math.PI) < 1e-9 : x.thC === 90), msg: '临界倾角与 atan(d/h) 一致' });
    out.push({
      ok: res.items.every((x) => x.Ftip === null ? pushZ === 0 : Math.abs(x.Ftip * (pushZ / 100) - x.m * G * x.d) <= 1e-9 * Math.max(1, x.m * G * x.d)),
      msg: '临界推力满足力矩平衡 F_c·z = m·g·d'
    });
    out.push({ ok: res.items.every((x) => Math.abs(0.5 * x.m * x.vMin * x.vMin - x.dU) <= 1e-9 * Math.max(1, x.dU)), msg: '撞倒所需动能 = 重心抬升势能增量' });
    out.push({
      ok: res.items.every((x) => (!x.windOn || x.vCrit === null) ? true : Math.abs(0.5 * RHO * cd * x.A * x.vCrit * x.vCrit * (x.H / 200) - x.m * G * x.d) <= 1e-9 * Math.max(1, x.m * G * x.d)),
      msg: '临界风速反代回风压力矩与重力力矩相等'
    });
    out.push({
      ok: res.items.every((x) => {
        const alt = itemPhysics(Object.assign({}, x.input, { h: Math.max(x.input.h * 0.5, 0.1) }), pushZ, mu, cd);
        const v = pushZ > 0 ? x.m * G * alt.d / (pushZ / 100) : null;
        return x.Ftip === null ? v === null : Math.abs(v - x.Ftip) <= 1e-9 * Math.max(1, x.Ftip);
      }), msg: '临界推力不含重心高度（降低重心不能提高抗推力）'
    });
    out.push({ ok: res.items.every((x) => Math.abs(itemPhysics(Object.assign({}, x.input, { m: x.input.m * 3 }), pushZ, mu, cd).vMin - x.vMin) < 1e-12), msg: '撞倒所需最小速度与质量无关' });
    out.push({
      ok: res.items.every((x) => {
        const alt = itemPhysics(Object.assign({}, x.input, x.weakAxis === 'x' ? { W: x.input.W * 1.5 } : { D: x.input.D * 1.5 }), pushZ, mu, cd);
        const v = pushZ > 0 ? x.m * G * alt.d / (pushZ / 100) : null;
        return alt.d >= x.d - 1e-12 && alt.thC >= x.thC - 1e-12 && alt.vMin >= x.vMin - 1e-12 && (x.Ftip === null || v >= x.Ftip - 1e-9 * Math.max(1, x.Ftip));
      }), msg: '支撑边越长 → d、倾角、临界推力、撞倒速度都不减'
    });
    out.push({
      ok: res.items.every((x) => {
        if (!x.sizeFeasible) return true;
        const alt = itemPhysics(Object.assign({}, x.input, { W: x.reqW, D: x.reqD }), pushZ, mu, cd);
        const v = pushZ > 0 ? x.m * G * alt.d / (pushZ / 100) : Infinity;
        return v >= Ft - 1e-9 * Math.max(1, Ft);
      }), msg: '反推出的宽/深回代后临界推力 ≥ 预想推力'
    });
    out.push({
      ok: res.items.every((x) => {
        const parts = [x.kF, x.kV].filter((v) => v !== null);
        const k = parts.length ? Math.min.apply(null, parts) : null;
        const want = k === null ? 'ok' : (k < 1 ? 'fail' : (k < cfg.plan.sf ? 'tight' : 'ok'));
        return x.verdict === want && (k === null ? x.k === null : Math.abs(x.k - k) < 1e-12);
      }), msg: '判定分档与 min(推力裕度, 风裕度) 一致'
    });
    const bad = [];
    (function walk(o, path) {
      if (o === null) return;
      if (typeof o === 'number') { if (!isFinite(o)) bad.push(path); return; }
      if (typeof o === 'undefined') { bad.push(path); return; }
      if (Array.isArray(o)) { o.forEach((v, i) => walk(v, path + '[' + i + ']')); return; }
      if (typeof o === 'object') { Object.keys(o).forEach((k) => walk(o[k], path + '.' + k)); }
    })(res.items, 'items');
    out.push({ ok: bad.length === 0, msg: '结果里没有 NaN / Infinity / undefined', extra: bad.slice(0, 5).join(',') });
    out.push({ ok: windOn ? true : res.items.every((x) => x.kV === null), msg: '风口径关闭时不计入风裕度' });
    out.push({ ok: res.items.every((x) => x.sizePractical === (x.reqW <= 2 * x.W && x.reqD <= 2 * x.D)), msg: '「加宽是否现实」的判据与所需尺寸一致' });
    out.push({ ok: res.items.every((x) => fin(x.anchorForce) && x.anchorForce >= 0), msg: '固定件所需拉力为非负有限值' });
    out.push({ ok: res.items.every((x) => fin(x.reqW) && fin(x.reqD) && x.reqW > 0 && x.reqD > 0), msg: '反推出的宽/深都是正数' });

    return out.map((c) => ({ ok: !!c.ok, msg: c.msg, extra: c.extra || '' }));
  }

  const api = {
    G: G, RHO: RHO, KGF: KGF, MAX_ROWS: MAX_ROWS, MAX_SIZE_REQ: MAX_SIZE_REQ,
    PUSH_H_MAX: PUSH_H_MAX, F_MAX: F_MAX, WIND_MAX: WIND_MAX,
    defaults: defaults, scenarios: scenarios,
    parseNum: parseNum, num: num, normalize: normalize, analyze: analyze,
    verify: verify, itemPhysics: itemPhysics, sensitivity: sensitivity, sizePlan: sizePlan,
    r2: r2, r3: r3, r4: r4,
    defaultsClone: function () { return JSON.parse(JSON.stringify(defaults)); }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})(typeof window !== 'undefined' ? window : null);
