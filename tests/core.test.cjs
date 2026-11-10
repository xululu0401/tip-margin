/* 倾覆余量台 · 核心测试（node --test tests/core.test.cjs）
 *
 * 验证策略（不拿两个 undefined 当正确）：
 *  A. 手算锚点（独立于代码推导，写在注释里可复算）
 *  B. 独立实现对拍：
 *     B1 方向采样求「重心投影到支撑面边界的最短距离」（不依赖四边取最小）
 *     B2 势能增量的数值积分（不同公式路径：∫ m·g·(d·cosθ − h·sinθ) dθ）
 *     B3 临界风速用二分法解 ½ρCdAv²·z_w − m·g·d = 0
 *     B4 反推尺寸用二分法搜索最小可行尺寸
 *     B5 全部改以 mm / g 为单位重算一遍（单位路径独立，抓单位错误）
 *  C. 结构恒等式：力矩平衡、动能=势能、单调性、与质量无关、与重心高度无关、判定分档、反推回代
 *  D. 非法输入逐条、输出契约（无 NaN/Infinity/undefined）、确定性、不修改入参
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

const G = 9.80665, RHO = 1.225;

/* ── 工具 ─────────────────────────────────────────────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function ok(raw) { const n = C.normalize(raw); assert.ok(n.ok, 'normalize 应当通过：' + JSON.stringify(n.errors)); return n.cfg; }
function one(it, push, wind, plan) {
  return ok({
    items: [it],
    push: push || { z: 95, F: 100, mu: 0.5 },
    wind: wind || { on: false, cd: 1.2, vT: 17.2 },
    plan: plan || { sf: 2, zf: 90 }
  });
}

/* ── B1：方向采样，独立求最短支撑距离（cm） ───────────── */
function bruteD(it, steps) {
  const a = it.W / 2, b = it.D / 2, px = it.ox, py = it.oy;
  let best = Infinity;
  const N = steps || 20000;
  for (let i = 0; i < N; i++) {
    const phi = (2 * Math.PI * i) / N;
    const cx = Math.cos(phi), sy = Math.sin(phi);
    let t = Infinity;
    if (Math.abs(cx) > 1e-12) t = Math.min(t, (cx > 0 ? a - px : -a - px) / cx);
    if (Math.abs(sy) > 1e-12) t = Math.min(t, (sy > 0 ? b - py : -b - py) / sy);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

/* ── B2：势能增量的数值积分（Simpson） ────────────────── */
function numericDU(m, hCm, dCm) {
  const h = hCm / 100, d = dCm / 100;
  const thC = Math.atan2(d, h);
  const f = (th) => m * G * (d * Math.cos(th) - h * Math.sin(th));
  const N = 4000, a = 0, b = thC;
  const n = N % 2 === 0 ? N : N + 1;
  const hh = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += f(a + i * hh) * (i % 2 ? 4 : 2);
  return s * hh / 3;
}

/* ── B3：二分法解临界风速 ─────────────────────────────── */
function bisectVcrit(m, dM, zwM, A, cd) {
  const target = m * G * dM;
  const f = (v) => 0.5 * RHO * cd * A * v * v * zwM - target;
  let lo = 1e-6, hi = 1e4;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/* ── B4：二分法搜最小可行半尺寸（cm） ─────────────────── */
function bisectHalfSize(it, zCm, Ft) {
  // 独立搜索：把宽与深同时放大到同一半尺寸，找最小的可行半尺寸
  const f = (half) => {
    const alt = C.itemPhysics(Object.assign({}, it, { W: half * 2, D: half * 2 }), zCm, 0.5, 1.2);
    return it.m * G * alt.d / (zCm / 100) - Ft;
  };
  let lo = 0.5, hi = 4000;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/* ── B5：mm / g 单位路径的独立重算 ────────────────────── */
function altPhysicsMm(it, zCm, mu, cd) {
  const mKg = it.m, hMm = it.h * 10, aMm = it.W * 5, bMm = it.D * 5, zMm = zCm * 10;
  const oxMm = it.ox * 10, oyMm = it.oy * 10;
  const dists = [aMm - oxMm, aMm + oxMm, bMm - oyMm, bMm + oyMm];
  const dMm = Math.min.apply(null, dists);
  // 力 = 力矩 / 力臂：质量用 g 表示（m×1000 g），g 换算 9.80665 m/s² → mm/s² 乘 1000
  const FtipN = (mKg * 1000 * (G * 1000) * dMm / zMm) / 1e6;
  const thC = Math.atan2(dMm, hMm) * 180 / Math.PI;
  return { dCm: dMm / 10, FtipN: FtipN, thC: thC };
}

/* ══════════════════════════════════════════════════════
 * A. 手算锚点
 * ══════════════════════════════════════════════════════ */
const SHELF = { name: '书架', m: 45, H: 180, h: 105, W: 80, D: 30, ox: 0, oy: 0, wind: false };

test('A1 书架（80×30 cm、重心 105 cm、45 kg、力在 95 cm）手算锚点', () => {
  // d = min(40, 40, 15, 15) = 0.15 m
  // θc = atan(0.15/1.05) = 8.1301°
  // F_c = 45 × 9.80665 × 0.15 / 0.95 = 69.6832… N
  // v_min = √(2×9.80665×(√(0.15²+1.05²) − 1.05)) = √(19.6133×0.01066017) = 0.457257 m/s
  const cfg = one(SHELF);
  const r = C.analyze(cfg);
  const s = r.items[0];
  assert.strictEqual(s.weakAxis, 'y');
  assert.ok(near(s.d, 0.15, 1e-12), 'd 应为 0.15 m，实际 ' + s.d);
  assert.ok(near(s.thC, 8.1301, 1e-3), 'θc 应为 8.1301°，实际 ' + s.thC);
  const Fc = 45 * G * 0.15 / 0.95;
  assert.ok(near(s.Ftip, Fc, 1e-9), '临界推力应为 ' + Fc);
  const vmin = Math.sqrt(2 * G * (Math.hypot(0.15, 1.05) - 1.05));
  assert.ok(near(s.vMin, vmin, 1e-12), 'v_min 应为 ' + vmin);
  assert.ok(near(s.vMin, 0.457254, 1e-6), 'v_min 手算 0.457254 m/s，实际 ' + s.vMin);
  assert.ok(near(s.FtipKgf, Fc / G, 1e-12));
});

test('A2 倾斜 45°：最短支撑距离恰等于重心高度时临界倾角为 45°', () => {
  // W = D = 100 cm → 半尺寸 0.50 m；h = 50 cm → d = h → θc = atan(1) = 45°
  const cfg = one({ name: '正方体', m: 20, H: 100, h: 50, W: 100, D: 100, ox: 0, oy: 0, wind: false });
  const s = C.analyze(cfg).items[0];
  assert.strictEqual(s.weakAxis, 'x');                       // 四个方向等距，取第一条边
  assert.ok(near(s.d, 0.5, 1e-12));
  assert.ok(near(s.thC, 45, 1e-9), 'θc 应为 45°，实际 ' + s.thC);
  assert.ok(near(s.Ftip, 20 * G * 0.5 / 0.95, 1e-9));
});

test('A3 重心投影偏置会缩短最短距离：偏置 10 cm 后 80 cm 宽的一半变成 30 cm', () => {
  const cfg = one({ name: '偏心箱', m: 10, H: 60, h: 30, W: 80, D: 200, ox: 10, oy: 0, wind: false });
  const s = C.analyze(cfg).items[0];
  assert.strictEqual(s.weakAxis, 'x');
  assert.strictEqual(s.weakSign, 1);
  assert.ok(near(s.d, 0.3, 1e-12), 'd 应为 0.30 m（= 0.40 − 0.10），实际 ' + s.d);
});

test('A4 零分母口径：力作用高度为 0 时判「推不翻」，重心高度为 0 时倾角记 90°', () => {
  const cfg = one({ name: '地面推', m: 30, H: 100, h: 50, W: 60, D: 60, ox: 0, oy: 0, wind: false },
    { z: 0, F: 100, mu: 0.5 });
  const s = C.analyze(cfg).items[0];
  assert.strictEqual(s.Ftip, null);
  assert.strictEqual(s.kF, null);
  assert.strictEqual(s.verdict, 'ok');           // 没有约束就不谎报危险
  assert.strictEqual(s.forceHeadroom, null);
  const cfg2 = one({ name: '贴地', m: 30, H: 100, h: 0, W: 60, D: 60, ox: 0, oy: 0, wind: false });
  const s2 = C.analyze(cfg2).items[0];
  assert.strictEqual(s2.thC, 90);
  assert.ok(near(s2.vMin, Math.sqrt(2 * G * 0.30), 1e-12), 'h = 0 时 v_min = √(2gd)');
});

/* ══════════════════════════════════════════════════════
 * B. 独立实现对拍
 * ══════════════════════════════════════════════════════ */
test('B1 方向采样求最短支撑距离：300 组随机支撑面/偏置对拍（误差 < 0.01 cm）', () => {
  const rnd = mulberry32(20261110);
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    const W = 20 + rnd() * 180, D = 20 + rnd() * 180;
    const ox = (rnd() - 0.5) * (W - 1), oy = (rnd() - 0.5) * (D - 1);
    const it = { name: 't', m: 10 + rnd() * 50, H: 200, h: 50 + rnd() * 60, W: W, D: D, ox: ox, oy: oy, wind: false };
    const p = C.itemPhysics(it, 95, 0.5, 1.2);
    const bd = bruteD(it) / 100;                       // m
    worst = Math.max(worst, Math.abs(p.d - bd) * 100);  // cm
    assert.ok(near(p.d, bd, 0.01), '组 ' + i + '：闭环 ' + p.d + ' vs 采样 ' + bd);
  }
  assert.ok(worst < 0.01, '最大偏差 ' + worst + ' cm');
});

test('B2 势能增量对拍数值积分：300 组（相对误差 < 1e-9）', () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 300; i++) {
    const m = 1 + rnd() * 200, h = 5 + rnd() * 250, a = 10 + rnd() * 100, b = 10 + rnd() * 100;
    const it = { name: 't', m: m, H: h + 50, h: h, W: a * 2, D: b * 2, ox: 0, oy: 0, wind: false };
    const p = C.itemPhysics(it, 95, 0.5, 1.2);
    const num = numericDU(m, h, p.d * 100);
    assert.ok(Math.abs(p.dU - num) <= 1e-9 * Math.max(1, Math.abs(num)), '组 ' + i + '：' + p.dU + ' vs ' + num);
  }
});

test('B3 临界风速二分法对拍：200 组（相对误差 < 1e-9）', () => {
  const rnd = mulberry32(11);
  for (let i = 0; i < 200; i++) {
    const it = {
      name: 't', m: 2 + rnd() * 80, H: 60 + rnd() * 200, h: 30 + rnd() * 100,
      W: 40 + rnd() * 160, D: 40 + rnd() * 160, ox: 0, oy: 0, wind: true
    };
    const cd = 0.5 + rnd() * 1.5;
    const p = C.itemPhysics(it, 95, 0.5, cd);
    const v = bisectVcrit(it.m, p.d, p.zw, p.A, cd);
    assert.ok(Math.abs(p.vCrit - v) <= 1e-9 * Math.max(1, v), '组 ' + i + '：' + p.vCrit + ' vs ' + v);
  }
});

test('B4 反推尺寸二分法对拍：200 组（误差 < 0.05 cm，且必需的那一侧恰好达标）', () => {
  const rnd = mulberry32(23);
  const zCm = 95, Ft = 100;
  for (let i = 0; i < 200; i++) {
    const W = 20 + rnd() * 200, D = 20 + rnd() * 200;
    const it = { name: 't', m: 2 + rnd() * 90, H: 200, h: 20 + rnd() * 150, W: W, D: D, ox: 0, oy: 0, wind: false };
    const cfg = one(it, { z: zCm, F: Ft, mu: 0.5 });
    const s = C.analyze(cfg).items[0];
    const half = bisectHalfSize(it, zCm, Ft);
    const want = half * 2;
    assert.ok(near(s.reqW, want, 0.05) && near(s.reqD, want, 0.05), '组 ' + i + '：闭环 ' + s.reqW + '/' + s.reqD + ' vs 二分 ' + want);
  }
});

test('B5 mm / g 单位路径重算：200 组 d、θc、F_c 与工程实现一致', () => {
  const rnd = mulberry32(31);
  for (let i = 0; i < 200; i++) {
    const it = {
      name: 't', m: 1 + rnd() * 60, H: 250, h: 5 + rnd() * 150,
      W: 10 + rnd() * 200, D: 10 + rnd() * 200, ox: 0, oy: 0, wind: false
    };
    const p = C.itemPhysics(it, 95, 0.5, 1.2);
    const alt = altPhysicsMm(it, 95, 0.5, 1.2);
    assert.ok(near(p.d * 100, alt.dCm, 1e-9), '组 ' + i + ' d：' + p.d * 100 + ' vs ' + alt.dCm);
    assert.ok(Math.abs(p.thC - alt.thC) < 1e-9);
    assert.ok(Math.abs(p.Ftip - alt.FtipN) <= 1e-9 * Math.max(1, p.Ftip), '组 ' + i + ' F：' + p.Ftip + ' vs ' + alt.FtipN);
  }
});

/* ══════════════════════════════════════════════════════
 * C. 结构恒等式
 * ══════════════════════════════════════════════════════ */
test('C1 力矩恒等式 F_c·z = m·g·d：300 组', () => {
  const rnd = mulberry32(41);
  for (let i = 0; i < 300; i++) {
    const z = [0, 20, 95, 200, 500][Math.floor(rnd() * 5)];
    const it = { name: 't', m: 0.5 + rnd() * 300, H: 300, h: 1 + rnd() * 250, W: 5 + rnd() * 400, D: 5 + rnd() * 400, ox: 0, oy: 0, wind: false };
    const p = C.itemPhysics(it, z, 0.4, 1.2);
    if (z === 0) { assert.strictEqual(p.Ftip, null, 'z = 0 必须判为推不翻'); continue; }
    assert.ok(Math.abs(p.Ftip * (z / 100) - it.m * G * p.d) <= 1e-9 * Math.max(1, it.m * G * p.d));
  }
});

test('C2 撞倒所需动能 = 势能增量（½mv² = ΔU）：300 组', () => {
  const rnd = mulberry32(43);
  for (let i = 0; i < 300; i++) {
    const it = { name: 't', m: 0.5 + rnd() * 200, H: 300, h: 1 + rnd() * 200, W: 5 + rnd() * 300, D: 5 + rnd() * 300, ox: 0, oy: 0, wind: false };
    const p = C.itemPhysics(it, 95, 0.4, 1.2);
    assert.ok(Math.abs(0.5 * it.m * p.vMin * p.vMin - p.dU) <= 1e-9 * Math.max(1, p.dU));
  }
});

test('C3 撞倒所需最小速度与质量无关：同 d、h 下 3 倍质量得到同一个 v_min', () => {
  const base = { name: 't', m: 10, H: 200, h: 100, W: 60, D: 40, ox: 0, oy: 0, wind: false };
  const a = C.itemPhysics(base, 95, 0.5, 1.2);
  const b = C.itemPhysics(Object.assign({}, base, { m: 30 }), 95, 0.5, 1.2);
  const c = C.itemPhysics(Object.assign({}, base, { m: 3000 }), 95, 0.5, 1.2);
  assert.strictEqual(a.vMin, b.vMin);
  assert.strictEqual(a.vMin, c.vMin);
  assert.ok(b.dU > a.dU * 2.9 && b.dU < a.dU * 3.1, '势能增量与质量成正比');
});

test('C4 临界推力不含重心高度：h 从 10 改到 200 cm，F_c 不变而 θc 变小', () => {
  const base = { name: 't', m: 40, H: 300, h: 100, W: 80, D: 60, ox: 0, oy: 0, wind: false };
  const a = C.itemPhysics(base, 95, 0.5, 1.2);
  const b = C.itemPhysics(Object.assign({}, base, { h: 200 }), 95, 0.5, 1.2);
  const c = C.itemPhysics(Object.assign({}, base, { h: 10 }), 95, 0.5, 1.2);
  assert.ok(near(a.Ftip, b.Ftip, 1e-9) && near(a.Ftip, c.Ftip, 1e-9), 'F_c 不应随 h 变化');
  assert.ok(b.thC < a.thC && a.thC < c.thC, 'θc 应随 h 升高而变小');
  assert.ok(b.vMin < a.vMin && a.vMin < c.vMin, 'v_min 应随 h 升高而变小');
});

test('C5 单调性：最短边加长 → d、θc、F_c、v_min 都不减；缩短 → 都不增', () => {
  const rnd = mulberry32(53);
  for (let i = 0; i < 150; i++) {
    const it = { name: 't', m: 5 + rnd() * 60, H: 250, h: 10 + rnd() * 150, W: 20 + rnd() * 150, D: 20 + rnd() * 150, ox: 0, oy: 0, wind: false };
    const p = C.itemPhysics(it, 95, 0.5, 1.2);
    const growAxis = p.weakAxis === 'x' ? 'W' : 'D';
    const pg = C.itemPhysics(Object.assign({}, it, { [growAxis]: it[growAxis] * 1.4 }), 95, 0.5, 1.2);
    const ps = C.itemPhysics(Object.assign({}, it, { [growAxis]: it[growAxis] * 0.6 }), 95, 0.5, 1.2);
    assert.ok(pg.d >= p.d - 1e-12 && pg.thC >= p.thC - 1e-12 && pg.Ftip >= p.Ftip - 1e-9 && pg.vMin >= p.vMin - 1e-12);
    assert.ok(ps.d <= p.d + 1e-12 && ps.thC <= p.thC + 1e-12 && ps.Ftip <= p.Ftip + 1e-9 && ps.vMin <= p.vMin + 1e-12);
  }
});

test('C6 临界风速反代：½ρCdAv²·z_w 恰等于 m·g·d（200 组，相对误差 < 1e-12）', () => {
  const rnd = mulberry32(59);
  for (let i = 0; i < 200; i++) {
    const it = { name: 't', m: 2 + rnd() * 100, H: 80 + rnd() * 300, h: 20 + rnd() * 100, W: 30 + rnd() * 200, D: 30 + rnd() * 200, ox: 0, oy: 0, wind: true };
    const cd = 0.3 + rnd() * 2;
    const p = C.itemPhysics(it, 95, 0.5, cd);
    const lhs = 0.5 * RHO * cd * p.A * p.vCrit * p.vCrit * p.zw;
    const rhs = it.m * G * p.d;
    assert.ok(Math.abs(lhs - rhs) <= 1e-12 * Math.max(1, rhs));
  }
});

test('C7 判定分档两侧：k 恰好 1 与恰好 sf 的边界归属正确', () => {
  // 构造 k = 1：让 F_c = F。取 m、d、z 使 m·g·d/z = 100
  const cfg = one({ name: 'x', m: 100, H: 200, h: 50, W: 60, D: 40, ox: 0, oy: 0, wind: false }, { z: 100, F: 100, mu: 0.5 }, { on: false, cd: 1.2, vT: 17.2 }, { sf: 2, zf: 90 });
  // d = 0.20, F_c = 100×9.80665×0.2/1 = 196.133 N（≠100）→ 用以验证分档而非等式
  const s = C.analyze(cfg).items[0];
  const k = s.Ftip / 100;
  assert.strictEqual(s.k, k);
  assert.strictEqual(s.verdict, k >= 2 ? 'ok' : 'tight');
  // 直接验证三档判定函数的行为
  const mk = (m, z, F, sf) => {
    const c = one({ name: 'y', m: m, H: 200, h: 50, W: 40, D: 40, ox: 0, oy: 0, wind: false }, { z: z, F: F, mu: 0.5 }, { on: false, cd: 1.2, vT: 17.2 }, { sf: sf, zf: 90 });
    return C.analyze(c).items[0];
  };
  const at1 = mk(40, 100, 40 * G * 0.2, 2);          // F_c = 40·g·0.2/1 = F → k = 1
  assert.ok(near(at1.k, 1, 1e-12));
  assert.strictEqual(at1.verdict, 'tight', 'k 恰好为 1 时属于「勉强」而不是「会倒」');
  const atSf = mk(40, 100, 40 * G * 0.2 / 2, 2);      // k = 2
  assert.ok(near(atSf.k, 2, 1e-12));
  assert.strictEqual(atSf.verdict, 'ok', 'k 恰好等于 sf 时属于「稳」');
  const under = mk(40, 100, 40 * G * 0.2 * 1.0001, 2);
  assert.ok(under.k < 1 && under.verdict === 'fail');
});

test('C8 反推回代：把宽深都加到反推值后，临界推力 ≥ 预想推力（且刚好够）', () => {
  const rnd = mulberry32(67);
  let tested = 0;
  for (let i = 0; i < 200; i++) {
    const it = { name: 't', m: 3 + rnd() * 80, H: 250, h: 20 + rnd() * 120, W: 15 + rnd() * 120, D: 15 + rnd() * 120, ox: 0, oy: 0, wind: false };
    const cfg = one(it, { z: 95, F: 100, mu: 0.5 });
    const s = C.analyze(cfg).items[0];
    if (!s.sizeFeasible) continue;
    tested++;
    const alt = C.itemPhysics(it, 95, 0.5, 1.2);
    const wasShort = s.Ftip < 100;
    const patched = C.itemPhysics(
      Object.assign({}, it, { W: Math.max(it.W, s.reqW), D: Math.max(it.D, s.reqD) }), 95, 0.5, 1.2);
    assert.ok(patched.d >= alt.d - 1e-12, '补到反推值后最短支撑距离不应变小');
    const F2 = it.m * G * patched.d / 0.95;
    assert.ok(F2 >= 100 - 1e-9, '回代后应达标：' + F2);
    if (wasShort) assert.ok(F2 <= 100 * 1.02 + 1e-9, '本来不达标时回代后不应远超：' + F2);
    else assert.ok(near(F2, s.Ftip, 1e-9), '本来就达标时不应改动尺寸');
  }
  assert.ok(tested > 150, '应有足够多组可回代，实际 ' + tested);
});

test('C9 固定件拉力是非负有限值，且恰好抵消超出重力力矩的部分', () => {
  const cfg = one({ name: 'x', m: 45, H: 180, h: 105, W: 80, D: 30, ox: 0, oy: 0, wind: false },
    { z: 95, F: 100, mu: 0.5 }, { on: false, cd: 1.2, vT: 17.2 }, { sf: 2, zf: 90 });
  const s = C.analyze(cfg).items[0];
  const want = Math.max(0, 100 * 0.95 - 45 * G * 0.15) / 0.90;
  assert.ok(near(s.anchorForce, want, 1e-9), '期望 ' + want + '，实际 ' + s.anchorForce);
  assert.ok(s.anchorForce > 0);
  // 已经足够稳时固定件拉力为 0
  const strong = one({ name: 'x', m: 500, H: 80, h: 20, W: 400, D: 400, ox: 0, oy: 0, wind: false },
    { z: 95, F: 100, mu: 0.5 }, { on: false, cd: 1.2, vT: 17.2 }, { sf: 2, zf: 90 });
  assert.strictEqual(C.analyze(strong).items[0].anchorForce, 0);
});

test('C10 敏感性：力越推越高越容易倒（×0.5 / ×1 / ×1.5 单调），降重心不改抗推力', () => {
  const cfg = one(SHELF);
  const s = C.analyze(cfg).items[0];
  const [half, base, one5] = s.sens;
  assert.ok(half.Ftip > base.Ftip && base.Ftip > one5.Ftip, '施力越高临界推力越小');
  assert.ok(near(base.Ftip, s.Ftip, 1e-9));
  assert.ok(near(one5.Ftip * 1.5, s.Ftip, 1e-9), '力作用高度 ×1.5 → 临界推力 ÷1.5');
  const down = s.sens[4];
  assert.ok(near(down.Ftip, s.Ftip, 1e-9), '降重心后临界推力不变');
  assert.ok(near(down.ratio, 1, 1e-12), '降重心的临界推力比值应恰为 1');
  assert.ok(down.thCRatio > 1, '降重心后临界倾角应更大');
  assert.ok(down.vMinRatio > 1, '降重心后撞倒所需速度应更大');
});

test('C11 四向对照：每个方向的临界倾角与临界推力都能由该方向距离推出，且最弱方向就是 d', () => {
  const cfg = one({ name: '偏心', m: 30, H: 120, h: 60, W: 100, D: 40, ox: 15, oy: -5, wind: false });
  const s = C.analyze(cfg).items[0];
  assert.strictEqual(s.edges.length, 4);
  assert.strictEqual(s.edges.filter((e) => e.weakest).length, 1);
  s.edges.forEach((e) => {
    assert.ok(near(e.thC, Math.atan2(e.d, s.h / 100) * 180 / Math.PI, 1e-9));
    assert.ok(near(e.Ftip, s.m * G * e.d / 0.95, 1e-9));
    if (e.weakest) assert.ok(near(e.d, s.d, 1e-12));
  });
  // 右 (±x) 与后 (±y)：d(+x) = 50−15 = 35 cm、d(−x) = 65、d(+y) = 20+5 = 25、d(−y) = 15
  const byDir = {};
  s.edges.forEach((e) => { byDir[e.dir] = e.d; });
  assert.ok(near(byDir['朝 +宽 那侧（右）'], 0.35, 1e-12));
  assert.ok(near(byDir['朝 −宽 那侧（左）'], 0.65, 1e-12));
  assert.ok(near(byDir['朝 +深 那侧（后）'], 0.25, 1e-12));
  assert.ok(near(byDir['朝 −深 那侧（前）'], 0.15, 1e-12), '最弱方向应是 −深（前）');
  assert.strictEqual(s.weakSign, -1);
});

test('C12 滑动先行判据：μ 很小 → 先滑走；μ 大 → 先翻倒；阈值为 μ·m·g = F_c 两侧', () => {
  const it = { name: 'x', m: 45, H: 180, h: 105, W: 80, D: 30, ox: 0, oy: 0, wind: false };
  const Fc = 45 * G * 0.15 / 0.95;
  const muCrit = Fc / (45 * G);
  const low = C.analyze(one(it, { z: 95, F: 100, mu: muCrit * 0.99 })).items[0];
  const high = C.analyze(one(it, { z: 95, F: 100, mu: muCrit * 1.01 })).items[0];
  assert.strictEqual(low.slideFirst, true, 'μ 略小 → 先滑动');
  assert.strictEqual(high.slideFirst, false, 'μ 略大 → 先翻倒');
  assert.ok(near(low.Fslide, Fc * 0.99, 1e-9) && near(high.Fslide, Fc * 1.01, 1e-9));
});

test('C13 聚合：最弱一件 = k 最小者；needAction / failCount / practicalCount 与逐件判定一致', () => {
  const cfg = ok(C.defaultsClone());
  const r = C.analyze(cfg);
  const kOf = (x) => (x.k === null ? Infinity : x.k);
  const min = Math.min.apply(null, r.items.map(kOf));
  assert.ok(near(kOf(r.worst), min, 1e-12));
  assert.strictEqual(r.needAction, r.items.filter((x) => x.verdict !== 'ok').length);
  assert.strictEqual(r.failCount, r.items.filter((x) => x.verdict === 'fail').length);
  assert.strictEqual(r.practicalCount, r.items.filter((x) => x.verdict !== 'ok' && x.sizePractical).length);
  assert.strictEqual(r.items.length, 6);
});

test('C14 默认虚构场景的关键数字与手算一致（说明文案里的数字可回溯）', () => {
  const cfg = ok(C.defaultsClone());
  const r = C.analyze(cfg);
  const lamp = r.items.find((x) => x.name === '落地灯');
  assert.ok(near(lamp.d, 0.15, 1e-12));
  assert.ok(near(lamp.thC, Math.atan2(0.15, 1.12) * 180 / Math.PI, 1e-9));
  assert.ok(near(lamp.Ftip, 4.5 * G * 0.15 / 0.95, 1e-9));
  assert.ok(near(lamp.FtipKgf, 4.5 * 0.15 / 0.95, 1e-12));
  const shelf = r.items.find((x) => x.name === '书架（客厅）');
  assert.ok(near(shelf.Ftip, 45 * G * 0.15 / 0.95, 1e-9));
  assert.ok(near(shelf.reqD, 2 * (100 * 0.95 / (45 * G)) * 100, 1e-9));
  const flower = r.items.find((x) => x.name === '阳台花架');
  assert.strictEqual(flower.windOn, true);
  const A = (0.60) * 1.20;  // 最弱方向为 ±y → 迎风面宽 = W = 60 cm
  assert.ok(near(flower.A, A, 1e-12), '迎风面积应为 ' + A + '，实际 ' + flower.A);
  assert.ok(near(flower.vCrit, Math.sqrt(2 * (25 * G * 0.15 / 0.60) / (RHO * 1.2 * A)), 1e-9));
});

test('C15 verify() 在默认与 6 个场景、以及随机构造下全部通过', () => {
  const cases = [C.defaultsClone()];
  C.scenarios.forEach((sc) => {
    const base = C.defaultsClone();
    const merged = {
      items: sc.patch.items || base.items,
      push: Object.assign({}, base.push, sc.patch.push || {}),
      wind: Object.assign({}, base.wind, sc.patch.wind || {}),
      plan: Object.assign({}, base.plan, sc.patch.plan || {})
    };
    cases.push(merged);
  });
  const rnd = mulberry32(97);
  for (let i = 0; i < 120; i++) {
    const n = 1 + Math.floor(rnd() * 4);
    const items = [];
    for (let k = 0; k < n; k++) {
      const W = 10 + rnd() * 300, D = 10 + rnd() * 300, H = 10 + rnd() * 500;
      items.push({
        name: 'i' + k, m: 0.5 + rnd() * 500, H: H,
        h: rnd() * H * 0.99, W: W, D: D,
        ox: (rnd() - 0.5) * (W - 1), oy: (rnd() - 0.5) * (D - 1), wind: rnd() > 0.5
      });
    }
    cases.push({
      items: items,
      push: { z: [0, 30, 95, 200][Math.floor(rnd() * 4)], F: 1 + rnd() * 500, mu: rnd() * 2 },
      wind: { on: rnd() > 0.3, cd: 0.2 + rnd() * 3, vT: 1 + rnd() * 60 },
      plan: { sf: 1 + rnd() * 9, zf: 1 + rnd() * 400 }
    });
  }
  cases.forEach((raw, i) => {
    const nm = C.normalize(raw);
    assert.ok(nm.ok, '场景 ' + i + ' 规范化失败：' + JSON.stringify(nm.errors));
    const res = C.analyze(nm.cfg);
    const checks = C.verify(nm.cfg, res);
    const failed = checks.filter((c) => !c.ok);
    assert.deepStrictEqual(failed, [], '场景 ' + i + ' 结构自检失败：' + JSON.stringify(failed));
  });
});

/* ══════════════════════════════════════════════════════
 * D. 非法输入、输出契约、确定性、不修改入参
 * ══════════════════════════════════════════════════════ */
test('D1 非法输入逐条拦截（32 条）', () => {
  const bad = [
    [{ items: [] }, 'items'],
    [{ items: [Object.assign({}, SHELF, { name: '' })] }, 'name'],
    [{ items: [Object.assign({}, SHELF, { name: 'x'.repeat(25) })] }, 'name'],
    [{ items: [Object.assign({}, SHELF, { m: 0 })] }, 'm'],
    [{ items: [Object.assign({}, SHELF, { m: -5 })] }, 'm'],
    [{ items: [Object.assign({}, SHELF, { m: 'abc' })] }, 'm'],
    [{ items: [Object.assign({}, SHELF, { m: '' })] }, 'm'],
    [{ items: [Object.assign({}, SHELF, { m: 1e6 })] }, 'm'],
    [{ items: [Object.assign({}, SHELF, { H: 0 })] }, 'H'],
    [{ items: [Object.assign({}, SHELF, { H: '5f' })] }, 'H'],
    [{ items: [Object.assign({}, SHELF, { h: -1 })] }, 'h'],
    [{ items: [Object.assign({}, SHELF, { h: 200 })] }, 'h'],   // 重心高于物品
    [{ items: [Object.assign({}, SHELF, { W: 0 })] }, 'W'],
    [{ items: [Object.assign({}, SHELF, { D: -1 })] }, 'D'],
    [{ items: [Object.assign({}, SHELF, { ox: 40 })] }, 'ox'],  // 投影在边界上
    [{ items: [Object.assign({}, SHELF, { ox: 41 })] }, 'ox'],
    [{ items: [Object.assign({}, SHELF, { oy: 15 })] }, 'oy'],
    [{ items: [Object.assign({}, SHELF, { ox: 'x' })] }, 'ox'],
    [{ items: [Object.assign({}, SHELF, { D: 3000 })] }, 'D'],
    [{ items: new Array(13).fill(SHELF) }, 'items'],
    [{ items: [SHELF], push: { z: -1, F: 100, mu: 0.5 } }, 'push.z'],
    [{ items: [SHELF], push: { z: 95, F: 0, mu: 0.5 } }, 'push.F'],
    [{ items: [SHELF], push: { z: 95, F: 100, mu: -0.1 } }, 'push.mu'],
    [{ items: [SHELF], push: { z: 95, F: 100, mu: 3 } }, 'push.mu'],
    [{ items: [SHELF], push: { z: 501, F: 100, mu: 0.5 } }, 'push.z'],
    [{ items: [SHELF], wind: { on: true, cd: 0, vT: 17 } }, 'wind.cd'],
    [{ items: [SHELF], wind: { on: true, cd: 1.2, vT: 0 } }, 'wind.vT'],
    [{ items: [SHELF], wind: { on: true, cd: 1.2, vT: 101 } }, 'wind.vT'],
    [{ items: [SHELF], plan: { sf: 0.9, zf: 90 } }, 'plan.sf'],
    [{ items: [SHELF], plan: { sf: 2, zf: 0 } }, 'plan.zf'],
    [{ items: [SHELF], plan: { sf: 11, zf: 90 } }, 'plan.sf'],
    [{ items: [Object.assign({}, SHELF, { m: 'Infinity' })] }, 'm']
  ];
  assert.strictEqual(bad.length, 32);
  bad.forEach(([raw, field], i) => {
    const n = C.normalize(raw);
    assert.strictEqual(n.ok, false, '第 ' + i + ' 条（' + field + '）应当被拦截');
    assert.ok(n.errors.some((e) => e.field === field), '第 ' + i + ' 条：应报字段 ' + field + '，实际 ' + JSON.stringify(n.errors));
    assert.ok(n.errors.every((e) => typeof e.msg === 'string' && e.msg.length > 0), '每条错误都要有可读说明');
  });
});

test('D2 合法但需要提示的输入：z=0、μ=0、h=0、风关闭、sf<1.5 都只给警告不报错', () => {
  const warnCases = [
    [{ items: [SHELF], push: { z: 0, F: 100, mu: 0.5 } }, '推力作用高度为 0'],
    [{ items: [SHELF], push: { z: 95, F: 100, mu: 0 } }, '摩擦系数为 0'],
    [{ items: [Object.assign({}, SHELF, { h: 0 })], push: { z: 95, F: 100, mu: 0.5 } }, null],
    [{ items: [SHELF], push: { z: 95, F: 100, mu: 0.5 }, wind: { on: false, cd: 1.2, vT: 17.2 } }, '风口径已关闭'],
    [{ items: [SHELF], push: { z: 95, F: 100, mu: 0.5 }, plan: { sf: 1.2, zf: 90 } }, '目标安全系数低于 1.5']
  ];
  warnCases.forEach(([raw, kw], i) => {
    const n = C.normalize(Object.assign({ wind: { on: true, cd: 1.2, vT: 17.2 }, plan: { sf: 2, zf: 90 } }, raw));
    assert.strictEqual(n.ok, true, '第 ' + i + ' 条不应报错：' + JSON.stringify(n.errors));
    if (kw) assert.ok(n.warnings.some((w) => w.indexOf(kw) >= 0), '第 ' + i + ' 条应含警告「' + kw + '」，实际 ' + JSON.stringify(n.warnings));
  });
  const hz = C.normalize(Object.assign({ items: [Object.assign({}, SHELF, { h: 0 })], push: { z: 95, F: 100, mu: 0.5 } }, { wind: { on: true, cd: 1.2, vT: 17.2 }, plan: { sf: 2, zf: 90 } }));
  const res = C.analyze(hz.cfg);
  assert.ok(res.warnList.some((w) => w.indexOf('重心高度为 0') >= 0), '分析结果里也要提示重心高度为 0');
});

test('D3 输出契约：递归扫描无 NaN / Infinity / undefined，且数字都在有效域', () => {
  const cfg = ok(C.defaultsClone());
  const res = C.analyze(cfg);
  const bad = [];
  (function walk(o, path) {
    if (o === null) return;
    if (typeof o === 'number') { if (!isFinite(o)) bad.push(path + '=' + o); return; }
    if (typeof o === 'undefined') { bad.push(path); return; }
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, path + '[' + i + ']')); return; }
    if (typeof o === 'object') { Object.keys(o).forEach((k) => walk(o[k], path + '.' + k)); }
  })({ items: res.items, headline: res.headline, warnList: res.warnList }, 'res');
  assert.deepStrictEqual(bad, [], '不该出现 ' + JSON.stringify(bad));
  res.items.forEach((x) => {
    assert.ok(x.d >= 0 && x.thC >= 0 && x.thC <= 90);
    assert.ok(x.vMin >= 0 && x.dU >= 0);
    assert.ok(x.kF === null || x.kF >= 0);
    assert.ok(x.kV === null || x.kV >= 0);
    assert.ok(x.reqW > 0 && x.reqD > 0);
    assert.ok(['ok', 'tight', 'fail'].indexOf(x.verdict) >= 0);
  });
});

test('D4 确定性：同一输入两次输出逐字节一致', () => {
  const cfg = ok(C.defaultsClone());
  const a = JSON.stringify(C.analyze(cfg));
  const b = JSON.stringify(C.analyze(ok(C.defaultsClone())));
  assert.strictEqual(a, b);
});

test('D5 不修改入参：analyze 前后输入对象深度相等', () => {
  const raw = C.defaultsClone();
  const snapshot = JSON.stringify(raw);
  const cfg = ok(raw);
  C.analyze(cfg);
  assert.strictEqual(JSON.stringify(raw), snapshot);
  const snapshot2 = JSON.stringify(cfg);
  C.analyze(cfg);
  assert.strictEqual(JSON.stringify(cfg), snapshot2);
});

test('D6 parseNum 的边界：整数、小数、千分位、前后空白都能读；科学计数法与单位后缀被拒', () => {
  assert.deepStrictEqual(C.parseNum('1,234.5', {}), { ok: true, value: 1234.5 });
  assert.deepStrictEqual(C.parseNum(' 12 ', {}), { ok: true, value: 12 });
  assert.deepStrictEqual(C.parseNum('.5', {}), { ok: true, value: 0.5 });
  assert.deepStrictEqual(C.parseNum(-3, {}), { ok: true, value: -3 });
  assert.strictEqual(C.parseNum('1e3', {}).ok, false);
  assert.strictEqual(C.parseNum('12cm', {}).ok, false);
  assert.strictEqual(C.parseNum('', {}).ok, false);
  assert.strictEqual(C.parseNum(' ', {}).ok, false);
  assert.strictEqual(C.parseNum(NaN, {}).ok, false);
  assert.strictEqual(C.parseNum(undefined, {}).ok, false);
  assert.strictEqual(C.parseNum(Infinity, {}).ok, false);
  assert.strictEqual(C.parseNum('5', { min: 6 }).ok, false);
  assert.strictEqual(C.parseNum('5', { max: 4 }).ok, false);
  assert.strictEqual(C.parseNum('5', { min: 5, max: 5 }).ok, true);
});

test('D7 数值极限不产生非法值：极大质量/极小支撑/极大风速', () => {
  const cfg = ok({
    items: [{ name: '极限', m: 100000, H: 3000, h: 0, W: 0.5, D: 0.5, ox: 0, oy: 0, wind: true }],
    push: { z: 500, F: 1000000, mu: 2 },
    wind: { on: true, cd: 5, vT: 100 },
    plan: { sf: 10, zf: 1 }
  });
  const res = C.analyze(cfg);
  assert.strictEqual(C.verify(cfg, res).filter((c) => !c.ok).length, 0);
  const s = res.items[0];
  assert.ok(isFinite(s.Ftip) && s.Ftip > 0);
  assert.ok(isFinite(s.vCrit) && s.vCrit > 0);
  assert.ok(isFinite(s.anchorForce) && s.anchorForce >= 0);
  assert.ok(s.reqW > 0 && s.reqD > 0);
  assert.ok(s.sizeFeasible === false, '这个极限场景的反推尺寸应判为不可行');
  assert.ok(res.warnList.length > 0, '应给出提示');
});
