/* 倾覆余量台 · 界面（tip-margin）
 * 依赖 window.AppCore（core.js）。所有展示数字都来自同一次 analyze() 的结果。
 */
(function () {
  'use strict';
  const C = window.AppCore;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'tip-margin:v1';

  const state = { res: null, checks: [], errors: [], warnings: [], sel: 0, exportCount: 0, renders: 0 };

  /* ── 格式化 ───────────────────────────────────────── */
  const n2 = (x) => (Math.round(x * 100) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const n3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3);
  /* 裕度：极小非零值不能显示成 0（把「几乎没有余量」说成「没有余量」是不诚实的） */
  const kfmt = (x) => {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    if (x === 0) return '0';
    if (x >= 0.01) return (Math.round(x * 1000) / 1000).toFixed(3);
    if (x >= 0.0001) return String(Number(x.toPrecision(2)));
    return '< 0.0001';
  };
  const cm = (x) => n2(x) + ' cm';
  const N = (x) => n2(x) + ' N';
  const kgf = (x) => n2(x) + ' kgf';
  const deg = (x) => n2(x) + '°';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const shortDir = (d) => String(d).replace('朝 +宽 那侧（右）', '+宽（右）').replace('朝 −宽 那侧（左）', '−宽（左）').replace('朝 +深 那侧（后）', '+深（后）').replace('朝 −深 那侧（前）', '−深（前）');
  const verdictText = { ok: '稳', tight: '勉强', fail: '会倒' };
  const verdictCls = { ok: 'ok', tight: 'tight', fail: 'fail' };
  const vdTextCls = { ok: 'vd', tight: 'vt', fail: 'vf' };

  function toast(msg) {
    let t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:26px;background:#16202c;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;z-index:99;opacity:0;transition:opacity .18s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 1900);
  }

  /* ── 表单读写 ─────────────────────────────────────── */
  function readInput() {
    const items = Array.from($('rows').querySelectorAll('.item')).map((el) => {
      const g = (k) => { const e = el.querySelector('.' + k); return e ? e.value : ''; };
      return {
        name: g('nm'), m: g('m'), H: g('H'), h: g('h'), W: g('W'), D: g('D'),
        ox: g('ox'), oy: g('oy'), wind: !!el.querySelector('.w').checked
      };
    });
    return {
      items: items,
      push: { z: $('pz').value, F: $('pF').value, mu: $('pmu').value },
      wind: { on: $('wOn').checked, cd: $('wcd').value, vT: $('wvT').value },
      plan: { sf: $('psf').value, zf: $('pzf').value }
    };
  }

  function rowHTML(it, i) {
    const v = (x) => esc(x === null || x === undefined ? '' : x);
    return '<div class="item" data-i="' + i + '">' +
      '<div class="itemhead">' +
      '<input type="text" class="nm" value="' + v(it.name) + '" aria-label="物品名称">' +
      '<label class="chk"><input type="checkbox" class="w"' + (it.wind ? ' checked' : '') + '>吹得到风</label>' +
      '<button type="button" class="tiny" data-dup="' + i + '">复制</button>' +
      '<button type="button" class="tiny" data-del="' + i + '">删</button>' +
      '</div>' +
      '<div class="grid8">' +
      '<label>质量 kg<input type="text" class="m" value="' + v(it.m) + '"></label>' +
      '<label>物品高 cm<input type="text" class="H" value="' + v(it.H) + '"></label>' +
      '<label>重心高 cm<input type="text" class="h" value="' + v(it.h) + '"></label>' +
      '<label>支撑宽 cm<input type="text" class="W" value="' + v(it.W) + '"></label>' +
      '<label>支撑深 cm<input type="text" class="D" value="' + v(it.D) + '"></label>' +
      '<label>偏置 x cm<input type="text" class="ox" value="' + v(it.ox) + '"></label>' +
      '<label>偏置 y cm<input type="text" class="oy" value="' + v(it.oy) + '"></label>' +
      '</div></div>';
  }

  function writeInput(inp) {
    $('pz').value = inp.push.z;
    $('pF').value = inp.push.F;
    $('pmu').value = inp.push.mu;
    $('psf').value = inp.plan.sf;
    $('pzf').value = inp.plan.zf;
    $('wOn').checked = !!inp.wind.on;
    $('wcd').value = inp.wind.cd;
    $('wvT').value = inp.wind.vT;
    $('rows').innerHTML = inp.items.map(rowHTML).join('');
    $('rowCount').textContent = inp.items.length + ' 件';
  }

  /* ── 计算与渲染 ───────────────────────────────────── */
  function markBad(errors) {
    Array.from(document.querySelectorAll('input.bad')).forEach((e) => e.classList.remove('bad'));
    const rowMap = { name: 'nm' };
    errors.forEach((e) => {
      let el = null;
      if (e.row > 0) {
        const box = $('rows').querySelector('.item[data-i="' + (e.row - 1) + '"]');
        if (box) el = box.querySelector('.' + (rowMap[e.field] || e.field));
      } else if (e.field.indexOf('push.') === 0) el = $({ z: 'pz', F: 'pF', mu: 'pmu' }[e.field.slice(5)]);
      else if (e.field.indexOf('wind.') === 0) el = $({ cd: 'wcd', vT: 'wvT' }[e.field.slice(5)]);
      else if (e.field.indexOf('plan.') === 0) el = $({ sf: 'psf', zf: 'pzf' }[e.field.slice(5)]);
      if (el) el.classList.add('bad');
    });
  }

  function compute() {
    const raw = readInput();
    const nm = C.normalize(raw);
    state.errors = nm.errors;
    state.warnings = nm.warnings;
    markBad(nm.errors);
    if (!nm.ok) {
      state.res = null; state.checks = [];
      $('errors').innerHTML = '<div class="errbox"><b>有 ' + nm.errors.length + ' 处输入要改：</b><ul class="tight">' +
        nm.errors.map((e) => '<li>' + esc(e.msg) + '</li>').join('') + '</ul></div>';
      $('headline').textContent = '先把上面标红的输入改对，本页就会立刻重算。';
      $('kpis').innerHTML = '';
      $('warnBox').innerHTML = '';
      $('rankBody').innerHTML = '<tr><td colspan="9" class="muted">等待合法输入</td></tr>';
      $('detailName').textContent = '';
      $('detailBody').innerHTML = '<p class="muted">—</p>';
      $('insights').innerHTML = '';
      $('steps').innerHTML = '';
      $('checks').innerHTML = '';
      $('checkTag').textContent = '';
      $('verdictTag').textContent = '输入未通过校验';
      $('sfNote').textContent = '目标安全系数';
      return;
    }
    $('errors').innerHTML = '';
    const res = C.analyze(nm.cfg);
    const checks = C.verify(nm.cfg, res);
    state.res = res; state.checks = checks;
    state.sel = Math.min(state.sel, res.items.length - 1);
    render(res, checks, nm.warnings);
  }

  function render(res, checks, warnings) {
    state.renders++;
    $('headline').textContent = res.headline;
    $('sfNote').textContent = res.cfg.plan.sf;

    const worst = res.worst;
    $('verdictTag').textContent = res.failCount > 0
      ? (res.failCount + ' 件会被推倒')
      : (res.needAction > 0 ? '都过 1 倍但不够 ' + res.cfg.plan.sf + ' 倍' : '全部达到目标');

    const windItems = res.items.filter((x) => x.windOn && x.vCrit !== null).sort((a, b) => a.vCrit - b.vCrit);
    const windWorst = windItems.length ? windItems[0] : null;
    const kpi = [
      ['最弱的一件', worst ? worst.name : '—', worst ? '裕度 ' + kfmt(worst.k) + '，判定「' + verdictText[worst.verdict] + '」' : ''],
      ['没达标的件数', res.needAction + ' / ' + res.items.length, '其中 ' + res.failCount + ' 件低于 1 倍（会被推倒）'],
      ['最弱临界推力', worst && worst.Ftip !== null ? N(worst.Ftip) : '推不翻', worst && worst.Ftip !== null ? '≈ ' + kgf(worst.FtipKgf) + '；预想 ' + N(res.cfg.push.F) : '力作用在地面，没有倾覆力矩'],
      ['最弱临界风速', windWorst ? n2(windWorst.vCrit) + ' m/s' : '不适用',
        windWorst ? '「' + windWorst.name + '」；目标 ' + n2(res.cfg.wind.vT) + ' m/s（' + (res.cfg.wind.on ? '风口径已开' : '风口径已关') + '）'
          : (res.cfg.wind.on ? '没有任何一件勾了「吹得到风」' : '风口径已关')],
      ['加宽能解决几件', res.practicalCount + ' / ' + res.needAction, '加宽到现有尺寸 2 倍以内算「现实可选」，其余建议固定']
    ];
    $('kpis').innerHTML = kpi.map((k) => '<div class="kpi"><div class="k">' + esc(k[0]) + '</div><div class="v">' + esc(k[1]) + '</div><div class="s">' + esc(k[2]) + '</div></div>').join('');

    const wl = res.warnList.concat(warnings || []);
    $('warnBox').innerHTML = wl.length
      ? '<div class="warnbox"><b>要留意的边界：</b><ul class="tight">' + wl.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>'
      : '';

    // 排行表
    $('rankBody').innerHTML = res.sorted.map((x) => {
      const idx = res.items.indexOf(x);
      const kTxt = kfmt(x.k);
      const w = x.k === null ? 0 : Math.max(2, Math.min(100, x.k / (res.cfg.plan.sf * 2) * 100));
      const color = x.verdict === 'ok' ? '#0f7b52' : (x.verdict === 'tight' ? '#c47f00' : '#b42318');
      return '<tr class="pick' + (idx === state.sel ? ' sel' : '') + '" data-sel="' + idx + '">' +
        '<td>' + esc(x.name) + (x.windOn ? '<br><span class="muted" style="font-size:11px">含风口径</span>' : '') + '</td>' +
        '<td>' + esc(shortDir(x.weakDir)) + '</td>' +
        '<td>' + cm(x.d * 100) + '</td>' +
        '<td>' + deg(x.thC) + '</td>' +
        '<td>' + (x.Ftip === null ? '推不翻' : N(x.Ftip)) + '<br><span class="muted" style="font-size:11px">' + (x.Ftip === null ? '—' : kgf(x.FtipKgf)) + '</span></td>' +
        '<td>' + n3(x.vMin) + ' m/s<br><span class="muted" style="font-size:11px">' + n2(x.vMinKmh) + ' km/h</span></td>' +
        '<td>' + (x.vCrit === null || !x.windOn ? '—<br><span class="muted" style="font-size:11px">' + (x.vCrit === null ? '风口径关' : '未勾吹风') + '</span>' : n2(x.vCrit) + ' m/s') + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:7px;justify-content:flex-end"><span class="' + vdTextCls[x.verdict] + '">' + kTxt + '</span><span class="bar" style="width:56px"><i style="width:' + w.toFixed(0) + '%;background:' + color + '"></i></span></div></td>' +
        '<td><span class="pill ' + verdictCls[x.verdict] + '">' + verdictText[x.verdict] + '</span></td>' +
        '</tr>';
    }).join('');

    renderDetail(res);
    renderInsights(res);
    renderSteps(res);
    $('limits').innerHTML = [
      '不算材料变形、断裂与连接件失效：本页把物体当刚体，只绕支撑面边界翻倒。',
      '不算地面不平、地毯压缩、地板打滑的具体形态；滑动只用 μ·m·g 的一阶判据。',
      '动态口径是<b>能量等价近似</b>：一次撞击要提供的动能 ≥ 把重心抬过棱边所需的势能增量，不考虑转动惯量分布与回弹。',
      '风压用 ½ρCdAv²，ρ = 1.225 kg/m³，形心取 H/2、风向取最不利方向——真实阵风与风向分布可能不同。',
      '多体碰撞、斜面坡道、多点同时受力、柔性物体（帐篷、伞面、布料）都<b>不在本页范围内</b>。',
      '本页是机械口径的算术工具：<b>不判定任何具体产品是否合格</b>，不引用也不替代任何安全标准条款，不做合规结论。',
      '「预想推力」「目标风速」「目标安全系数」都是使用者填的假设值；默认与场景里的数字都是<b>虚构示例</b>。'
    ].map((s) => '<li>' + s + '</li>').join('');

    const failed = checks.filter((c) => !c.ok);
    $('checkTag').textContent = (checks.length - failed.length) + ' / ' + checks.length + ' 项通过';
    $('checks').innerHTML = checks.map((c) => '<li>' + (c.ok ? '✅ ' : '❌ ') + esc(c.msg) + (c.extra ? ' <span class="muted">（' + esc(c.extra) + '）</span>' : '') + '</li>').join('');
  }

  function renderDetail(res) {
    const x = res.items[state.sel];
    if (!x) { $('detailName').textContent = ''; $('detailBody').innerHTML = '<p class="muted">—</p>'; return; }
    $('detailName').textContent = x.name;

    const L = [];
    L.push('<div class="grid3">' +
      metric('最短支撑距离（决定一切）', cm(x.d * 100), '方向：' + esc(x.weakDir) + '；偏心后四向不等') +
      metric('临界倾角', deg(x.thC), '倾斜到这个角度，重心正好压到支撑边界上') +
      metric('临界推力', x.Ftip === null ? '推不翻' : N(x.Ftip), x.Ftip === null ? '力作用在地面：没有倾覆力矩' : '≈ ' + kgf(x.FtipKgf) + '；预想 ' + N(res.cfg.push.F)) +
      metric('翻过棱边所需能量', n2(x.dU) + ' J', '把重心抬到支撑边正上方') +
      metric('撞倒所需最小速度', n3(x.vMin) + ' m/s', n2(x.vMinKmh) + ' km/h —— 与质量无关') +
      metric('临界风速', (x.vCrit === null || !x.windOn) ? '不计入' : n2(x.vCrit) + ' m/s',
        (x.vCrit === null || !x.windOn)
          ? '该件未勾「吹得到风」' + (x.vCrit === null ? '' : '（按几何可算得 ' + n2(x.vCrit) + ' m/s，仅作参考）')
          : '目标 ' + n2(res.cfg.wind.vT) + ' m/s；迎风面积 ' + n2(x.A) + ' m²') +
      metric('最大静摩擦（滑动门槛）', N(x.Fslide), '≈ ' + kgf(x.FslideKgf) + '；μ = ' + res.cfg.push.mu) +
      metric('裕度 k', kfmt(x.k), (x.kF !== null ? '推口径 ' + kfmt(x.kF) : '推口径不适用（推不翻）') + (x.kV !== null ? '；风口径 ' + kfmt(x.kV) : '')) +
      '</div>');

    L.push('<h3>为什么是这个数（三句）</h3>');
    L.push('<ul class="tight">' +
      '<li>把四向边界距离算出来（+宽 ' + cm(x.edges[0].d * 100) + '、−宽 ' + cm(x.edges[1].d * 100) + '、+深 ' + cm(x.edges[2].d * 100) + '、−深 ' + cm(x.edges[3].d * 100) + '），最短的那条 <b>' + cm(x.d * 100) + '</b> 就是最容易被推翻的方向。</li>' +
      '<li>绕这条边翻倒要先把重心抬到它正上方：抬升量 √(d²+h²) − h = ' + n2(Math.hypot(x.d, x.h / 100) * 100) + ' cm − ' + cm(x.h) + ' = ' + n2((Math.hypot(x.d, x.h / 100) - x.h / 100) * 100) + ' cm，乘 m·g 得 ' + n2(x.dU) + ' J；反过来就是撞倒所需速度 ' + n2(x.vMin) + ' m/s。</li>' +
      '<li>力作用在 ' + cm(res.cfg.push.z) + ' 高处时，绕这条边的力矩平衡是 F·z = m·g·d，所以 F = ' + n2(x.m) + ' × 9.80665 × ' + n2(x.d) + ' ÷ ' + n2(res.cfg.push.z / 100) + ' = <b>' + (x.Ftip === null ? '推不翻' : N(x.Ftip)) + '</b>。</li>' +
      (x.slideFirst ? '<li>但 ' + N(x.Ftip) + ' 已经超过最大静摩擦 ' + N(x.Fslide) + '，真实情况更可能是<b>被推着滑走</b>而不是翻倒。</li>' : '') +
      '</ul>');

    L.push('<h3>四个方向对照</h3><div class="tw"><table><thead><tr><th>推向</th><th>边界距离</th><th>临界倾角</th><th>临界推力</th><th>相对最弱方向</th></tr></thead><tbody>' +
      x.edges.map((e) => '<tr' + (e.weakest ? ' class="sum"' : '') + '><td>' + esc(e.dir) + (e.weakest ? ' <span class="pill fail">最弱</span>' : '') + '</td><td>' + cm(e.d * 100) + '</td><td>' + deg(e.thC) + '</td><td>' + (e.Ftip === null ? '推不翻' : N(e.Ftip)) + '</td><td>' + (x.Ftip === null || e.Ftip === null ? '—' : n2(e.Ftip / x.Ftip * 100) + '%') + '</td></tr>').join('') +
      '</tbody></table></div>');

    L.push('<h3>换个条件会怎样（每一行都完整重算）</h3><div class="tw"><table><thead><tr><th>条件</th><th>明细</th><th>临界推力</th><th>推力比值</th><th>倾角比值</th><th>撞倒速度比值</th></tr></thead><tbody>' +
      x.sens.map((s) => '<tr><td>' + esc(s.what) + '</td><td>' + esc(s.detail) + '</td><td>' + (s.Ftip === null ? '推不翻' : N(s.Ftip)) + '</td><td>' + (s.ratio === null ? '—' : n2(s.ratio)) + '</td><td>' + (s.thCRatio === undefined ? '—' : n2(s.thCRatio)) + '</td><td>' + (s.vMinRatio === undefined ? '—' : n2(s.vMinRatio)) + '</td></tr>').join('') +
      '</tbody></table></div>');

    L.push('<h3>要达标怎么办（反推）</h3>');
    L.push('<div class="tw"><table class="wrap"><thead><tr><th>手段</th><th>需要多少</th><th>现在</th><th>现实可行</th></tr></thead><tbody>' +
      '<tr><td>把支撑面加宽（宽与深都要够）</td><td>宽 ≥ ' + cm(x.reqW) + '、深 ≥ ' + cm(x.reqD) + '</td><td>宽 ' + cm(x.W) + '、深 ' + cm(x.D) + '</td><td>' + (x.sizeFeasible ? (x.sizePractical ? '可以试试（≤ 现有 2 倍）' : '加宽不现实（超过现有 2 倍）') : '不可行（超过 400 cm）') + '</td></tr>' +
      '<tr><td>把力施加得更低</td><td>不高于 ' + cm(x.pushZReq) + '</td><td>现在 ' + cm(res.cfg.push.z) + '</td><td>' + (x.pushZReqOk ? '可行（低于物品高 ' + x.H + ' cm）' : '不可行（已经高过物品本身）') + '</td></tr>' +
      '<tr><td>装固定件（拉到墙/地）</td><td>能承受 ' + N(x.anchorForce) + '（≈ ' + kgf(x.anchorForceKgf) + '）</td><td>固定点高 ' + cm(res.cfg.plan.zf) + '</td><td>' + (x.anchorForce > 0 ? '按这个数选固定件' : '本来就够稳，不需要') + '</td></tr>' +
      (x.windOn && x.dReqWind !== null ? '<tr><td>只按风口径</td><td>最短支撑距离 ≥ ' + cm(x.dReqWind) + '（即宽 ≥ ' + cm(x.reqWWind) + '、深 ≥ ' + cm(x.reqDWind) + '）</td><td>现在 ' + cm(x.d * 100) + '</td><td>按当前迎风面积的一阶估计</td></tr>' : '') +
      '</tbody></table></div>');

    L.push('<div class="btns"><button type="button" id="btnApplySize"' + (x.sizeFeasible && (x.reqW > x.W + 0.05 || x.reqD > x.D + 0.05) ? '' : ' disabled') + '>把这件的支撑尺寸改成反推值</button>' +
      '<button type="button" id="btnApplyZ"' + (x.pushZReqOk && x.pushZReq < res.cfg.push.z - 0.05 ? '' : ' disabled') + '>把全局施力高度改成 ' + n1(x.pushZReq) + ' cm</button></div>');
    L.push('<p class="footnote">反推的手法是：静力口径下「临界推力 = m·g·d ÷ z」，所以要扛住 F 就必须让最短边界距离 d ≥ F·z/(m·g)，换算成尺寸就是<b>宽和深同时</b>满足上面的值（只加一边的话另一条边会变成新的短板）。另外：<b>加宽支撑面会同时加大迎风面积</b>，所以「按推达标」不等于「按风也达标」——风口径的裕度可能不升反降，切换目标风速看一眼再定。</p>');

    $('detailBody').innerHTML = L.join('');
    const bs = $('btnApplySize');
    if (bs) bs.addEventListener('click', applySize);
    const bz = $('btnApplyZ');
    if (bz) bz.addEventListener('click', applyZ);
  }

  function metric(k, v, s) {
    return '<div class="metric"><div class="mk">' + esc(k) + '</div><div class="mv">' + esc(v) + '</div><div class="ms">' + esc(s) + '</div></div>';
  }

  /* 建议：把选中件的支撑尺寸写回表单 */
  function applySize() {
    const res = state.res; if (!res) return;
    const x = res.items[state.sel];
    const box = $('rows').querySelector('.item[data-i="' + state.sel + '"]');
    if (!box) return;
    box.querySelector('.W').value = String(Math.round(Math.max(x.W, x.reqW) * 10) / 10);
    box.querySelector('.D').value = String(Math.round(Math.max(x.D, x.reqD) * 10) / 10);
    compute();
    toast('已把「' + x.name + '」的支撑尺寸改成反推值');
  }

  function applyZ() {
    const res = state.res; if (!res) return;
    const x = res.items[state.sel];
    $('pz').value = String(Math.round(x.pushZReq * 10) / 10);
    compute();
    toast('已把全局施力高度改成 ' + n1(x.pushZReq) + ' cm');
  }

  /* ── 三条可复核的结论（数字全部取自同一次结果） ────── */
  function renderInsights(res) {
    const x = res.items[state.sel];
    const out = [];
    if (x) {
      const lower = x.sens[4];
      out.push('<div class="slice">① <b>降低重心不能提高抗推力。</b>「' + esc(x.name) + '」重心降低 20%（' + esc(lower.detail) + '）后，临界推力仍是 <b>' + (x.Ftip === null ? '推不翻' : N(x.Ftip)) + '</b>（比值 ' + n2(lower.ratio) + '），但临界倾角变成原来的 ' + n2(lower.thCRatio) + ' 倍、撞倒所需速度变成 ' + n2(lower.vMinRatio) + ' 倍——三个口径各有各的杠杆。</div>');
      out.push('<div class="slice">② <b>撞倒所需速度与重量无关。</b>把「' + esc(x.name) + '」的质量从 ' + n2(x.m) + ' kg 改成 ' + n2(x.m * 3) + ' kg，需要抬升的重心高度一样，所以撞倒所需速度仍是 <b>' + n3(x.vMin) + ' m/s</b>（' + n2(x.vMinKmh) + ' km/h）——重的只是更难被推动，不是更难被撞翻。</div>');
      const e = x.edges;
      const maxE = e.reduce((a, b) => (b.d > a.d ? b : a), e[0]);
      out.push('<div class="slice">③ <b>最容易倒的方向就是最短的那条边。</b>「' + esc(x.name) + '」朝 ' + esc(shortDir(x.weakDir)) + ' 推只要 <b>' + (x.Ftip === null ? '推不翻' : N(x.Ftip)) + '</b>，朝 ' + esc(shortDir(maxE.dir)) + ' 推要 ' + (maxE.Ftip === null ? '推不翻' : N(maxE.Ftip)) + '（相差 ' + (x.Ftip === null || maxE.Ftip === null ? '—' : n2(maxE.Ftip / x.Ftip)) + ' 倍）。</div>');
    }
    const massSorted = res.items.slice().sort((a, b) => b.m - a.m);
    if (massSorted.length >= 2) {
      const heavy = massSorted[0], light = massSorted[massSorted.length - 1];
      out.push('<div class="slice">④ <b>顺手看一眼最重与最轻的两件：</b>' + esc(heavy.name) + '（' + n2(heavy.m) + ' kg）撞倒所需速度 ' + n3(heavy.vMin) + ' m/s，' + esc(light.name) + '（' + n2(light.m) + ' kg）是 ' + n3(light.vMin) + ' m/s，质量差 ' + n2(heavy.m / light.m) + ' 倍，速度只差 ' + n3(Math.abs(heavy.vMin - light.vMin)) + ' m/s。</div>');
    }
    $('insights').innerHTML = out.join('');
  }

  function renderSteps(res) {
    const steps = [];
    const sorted = res.sorted.filter((x) => x.verdict !== 'ok');
    sorted.slice(0, 3).forEach((x) => {
      if (x.anchorForce > 0) {
        steps.push('「' + esc(x.name) + '」：裕度 ' + n2(x.k) + '，判定「' + verdictText[x.verdict] + '」。' +
          (x.sizePractical ? '可以先试加宽：宽 ≥ ' + esc(cm(x.reqW)) + '、深 ≥ ' + esc(cm(x.reqD)) + '（现在 ' + esc(cm(x.W)) + ' × ' + esc(cm(x.D)) + '）' : '加宽到反推值不现实（宽 ≥ ' + esc(cm(x.reqW)) + '、深 ≥ ' + esc(cm(x.reqD)) + '）') +
          '；更省事的是装固定件，按能承受 ' + esc(N(x.anchorForce)) + '（≈ ' + esc(kgf(x.anchorForceKgf)) + '）选，固定点落在 ' + esc(cm(res.cfg.plan.zf)) + ' 高处。' +
          (x.windOn && x.vCrit !== null ? '它还会被风吹：临界风速 ' + esc(n2(x.vCrit)) + ' m/s，低于目标 ' + esc(n2(res.cfg.wind.vT)) + ' m/s。' : '（该件未勾「吹得到风」，只按推口径判定。）'));
      } else {
        steps.push('「' + esc(x.name) + '」：裕度 ' + kfmt(x.k) + '，判定「' + verdictText[x.verdict] + '」，但固定件拉力算出 0——它扛得住当前预想推力，可以把注意力放在更弱的那几件上。');
      }
    });
    if (!steps.length) steps.push('当前口径下每一件都达到 ' + res.cfg.plan.sf + ' 倍目标：如果还想更保守，把「预想推力」或「目标风速」调高再算一遍。');
    if (res.items.some((x) => x.slideFirst)) steps.push('注意有件会「先滑走再谈翻不翻」：瓷砖、打蜡地板、带轮子的家具请把摩擦系数调小再算一遍，结论可能从「会倒」变成「会滑出去」。');
    steps.push('想按住某一项看它对结论的影响：在左下「物品清单」里只改这一个数字，Right 侧的排行、详解、自检会一起重算。');
    $('steps').innerHTML = steps.map((s) => '<li>' + s + '</li>').join('');
  }

  /* ── 导出 ─────────────────────────────────────────── */
  function download(name, text, type) {
    state.exportCount++;
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  function cfgLine(res) {
    const c = res.cfg;
    return '力施加高度 ' + cm(c.push.z) + ' / 预想推力 ' + N(c.push.F) + ' / 摩擦系数 μ ' + c.push.mu +
      ' / 目标安全系数 ' + c.plan.sf + ' / 风向口径 ' + (c.wind.on ? ('开（目标 ' + c.wind.vT + ' m/s、Cd ' + c.wind.cd + '）') : '关') +
      ' / 固定件安装高度 ' + cm(c.plan.zf);
  }

  function csvText() {
    const res = state.res; if (!res) return '';
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const L = [];
    L.push(['倾覆余量台 · 导出', '虚构示例口径，非任何真实物品的实测数据'].map(q).join(','));
    L.push(['口径', cfgLine(res)].map(q).join(','));
    L.push([]);
    L.push(['逐件结果'].map(q).join(','));
    L.push(['物品', '质量(kg)', '物品高(cm)', '重心高(cm)', '支撑宽(cm)', '支撑深(cm)', '偏置x(cm)', '偏置y(cm)', '吹得到风',
      '最弱方向', '最短支撑距离(cm)', '临界倾角(deg)', '临界推力(N)', '临界推力(kgf)', '翻过棱边能量(J)',
      '撞倒所需速度(m/s)', '撞倒所需速度(km/h)', '临界风速(m/s)', '迎风面积(m2)', '最大静摩擦(N)', '滑动先行',
      '裕度', '推力裕度', '风裕度', '判定'].map(q).join(','));
    res.sorted.forEach((x) => L.push([x.name, x.m, x.H, x.h, x.W, x.D, x.ox, x.oy, x.windOn ? '是' : '否',
      x.weakDir, (x.d * 100).toFixed(2), x.thC.toFixed(2), x.Ftip === null ? '推不翻' : x.Ftip.toFixed(2),
      x.Ftip === null ? '' : x.FtipKgf.toFixed(2), x.dU.toFixed(4), x.vMin.toFixed(4), x.vMinKmh.toFixed(2),
      (x.vCrit === null || !x.windOn) ? '' : x.vCrit.toFixed(3), x.A.toFixed(4), x.Fslide.toFixed(2), x.slideFirst ? '是' : '否',
      kfmt(x.k), kfmt(x.kF), kfmt(x.kV),
      verdictText[x.verdict]].map(q).join(',')));
    L.push([]);
    L.push(['四向对照（选中件：' + res.items[state.sel].name + '）'].map(q).join(','));
    L.push(['推向', '边界距离(cm)', '临界倾角(deg)', '临界推力(N)', '占最弱方向比'].map(q).join(','));
    res.items[state.sel].edges.forEach((e) => L.push([e.dir, (e.d * 100).toFixed(2), e.thC.toFixed(2),
      e.Ftip === null ? '推不翻' : e.Ftip.toFixed(2), res.items[state.sel].Ftip === null || e.Ftip === null ? '' : (e.Ftip / res.items[state.sel].Ftip * 100).toFixed(1) + '%'].map(q).join(',')));
    L.push([]);
    L.push(['敏感性（选中件）'].map(q).join(','));
    L.push(['条件', '明细', '临界推力(N)', '推力比值'].map(q).join(','));
    res.items[state.sel].sens.forEach((s) => L.push([s.what, s.detail, s.Ftip === null ? '推不翻' : s.Ftip.toFixed(2), s.ratio === null ? '' : s.ratio.toFixed(3)].map(q).join(',')));
    L.push([]);
    L.push(['反推（逐件）'].map(q).join(','));
    L.push(['物品', '需要最短支撑距离(cm)', '需要宽(cm)', '需要深(cm)', '加宽现实可行', '施力高度上限(cm)', '施力高度可行', '固定件拉力(N)', '固定件拉力(kgf)'].map(q).join(','));
    res.sorted.forEach((x) => L.push([x.name, x.dReq.toFixed(2), x.reqW.toFixed(2), x.reqD.toFixed(2),
      x.sizePractical ? '可以试试' : '不现实', x.pushZReq.toFixed(2), x.pushZReqOk ? '可行' : '不可行',
      x.anchorForce.toFixed(2), x.anchorForceKgf.toFixed(2)].map(q).join(',')));
    L.push([]);
    L.push(['结构自检'].map(q).join(','));
    state.checks.forEach((c) => L.push([c.ok ? 'PASS' : 'FAIL', c.msg, c.extra].map(q).join(',')));
    L.push([]);
    L.push(['边界说明'].map(q).join(','));
    L.push(['本页把物体当刚体、只绕支撑面边界翻倒；滑动用 μmg 一阶判据；动态口径为能量等价近似；风压按 ½ρCdAv²（ρ=1.225）形心 H/2、风向取最不利；不判定任何具体产品是否合格，不引标准条款。'].map(q).join(','));
    return '\ufeff' + L.map((r) => (Array.isArray(r) ? r.join('\r\n') : r)).join('\r\n') + '\r\n';
  }

  function mdText() {
    const res = state.res; if (!res) return '';
    const L = [];
    const w = res.worst;
    L.push('# 倾覆余量台 · 导出');
    L.push('');
    L.push('> 口径：' + cfgLine(res) + '。默认与内置场景都是**虚构示例**，不是任何真实物品的实测数据。');
    L.push('');
    L.push('## 结论');
    L.push('');
    L.push(res.headline);
    L.push('');
    L.push('## 逐件排行（按裕度从小到大）');
    L.push('');
    L.push('| 物品 | 最弱方向 | 最短支撑距离 | 临界倾角 | 临界推力 | 撞倒所需速度 | 临界风速 | 裕度 | 判定 |');
    L.push('|---|---|---:|---:|---:|---:|---:|---:|---|');
    res.sorted.forEach((x) => L.push('| ' + x.name + ' | ' + shortDir(x.weakDir) + ' | ' + (x.d * 100).toFixed(2) + ' cm | ' + x.thC.toFixed(2) + '° | ' +
      (x.Ftip === null ? '推不翻' : x.Ftip.toFixed(2) + ' N') + ' | ' + x.vMin.toFixed(3) + ' m/s | ' +
      ((x.vCrit === null || !x.windOn) ? '—' : x.vCrit.toFixed(2) + ' m/s') + ' | ' + (x.k === null ? '—' : x.k.toFixed(3)) + ' | ' + verdictText[x.verdict] + ' |'));
    L.push('');
    if (w) {
      L.push('## 最弱的一件：' + w.name);
      L.push('');
      L.push('- 最容易被推翻的方向：**' + w.weakDir + '**，边界距离 **' + (w.d * 100).toFixed(2) + ' cm**');
      L.push('- 临界倾角 **' + w.thC.toFixed(2) + '°**');
      L.push('- 临界推力 **' + (w.Ftip === null ? '推不翻' : w.Ftip.toFixed(2) + ' N（' + w.FtipKgf.toFixed(2) + ' kgf）') + '**');
      L.push('- 翻过棱边所需能量 **' + w.dU.toFixed(3) + ' J**；撞倒所需最小速度 **' + w.vMin.toFixed(3) + ' m/s（' + w.vMinKmh.toFixed(2) + ' km/h，与质量无关）**');
      L.push('- 临界风速 **' + (w.vCrit === null ? '不适用' : w.vCrit.toFixed(2) + ' m/s') + '**');
      L.push('');
    }
    L.push('## 四向对照（选中件：' + res.items[state.sel].name + '）');
    L.push('');
    L.push('| 推向 | 边界距离 | 临界倾角 | 临界推力 |');
    L.push('|---|---:|---:|---:|');
    res.items[state.sel].edges.forEach((e) => L.push('| ' + e.dir + (e.weakest ? '（最弱）' : '') + ' | ' + (e.d * 100).toFixed(2) + ' cm | ' + e.thC.toFixed(2) + '° | ' + (e.Ftip === null ? '推不翻' : e.Ftip.toFixed(2) + ' N') + ' |'));
    L.push('');
    L.push('## 敏感性（选中件，每一行都完整重算）');
    L.push('');
    L.push('| 条件 | 明细 | 临界推力 | 推力比值 |');
    L.push('|---|---|---:|---:|');
    res.items[state.sel].sens.forEach((s) => L.push('| ' + s.what + ' | ' + s.detail + ' | ' + (s.Ftip === null ? '推不翻' : s.Ftip.toFixed(2) + ' N') + ' | ' + (s.ratio === null ? '—' : s.ratio.toFixed(3)) + ' |'));
    L.push('');
    L.push('## 要达标怎么办（反推）');
    L.push('');
    L.push('| 物品 | 需要宽 | 需要深 | 加宽现实可行 | 施力高度上限 | 固定件拉力 |');
    L.push('|---|---:|---:|---|---:|---:|');
    res.sorted.forEach((x) => L.push('| ' + x.name + ' | ' + x.reqW.toFixed(2) + ' cm | ' + x.reqD.toFixed(2) + ' cm | ' + (x.sizeFeasible ? (x.sizePractical ? '可以试试' : '不现实') : '不可行') + ' | ' + x.pushZReq.toFixed(2) + ' cm | ' + x.anchorForce.toFixed(2) + ' N |'));
    L.push('');
    L.push('## 这份账不算什么');
    L.push('');
    L.push('- 刚体假设：不算材料变形、断裂与连接件失效。');
    L.push('- 滑动只用 μ·m·g 一阶判据；不算地面不平与地毯压缩。');
    L.push('- 动态口径是能量等价近似，不考虑转动惯量分布与回弹。');
    L.push('- 风压按 ½ρCdAv²（ρ = 1.225 kg/m³），形心取 H/2、风向取最不利方向。');
    L.push('- 不判定任何具体产品是否合格，不引用也不替代任何安全标准条款。');
    L.push('');
    L.push('结构自检：' + state.checks.filter((c) => c.ok).length + ' / ' + state.checks.length + ' 项通过。');
    return L.join('\n') + '\n';
  }

  function jsonBackup() {
    const res = state.res; if (!res) return '{}';
    return JSON.stringify({
      app: 'tip-margin', version: 1, savedAt: new Date().toISOString(),
      input: readInput(),
      anchors: {
        headline: res.headline,
        needAction: res.needAction, failCount: res.failCount, practicalCount: res.practicalCount,
        worst: res.worst ? { name: res.worst.name, k: res.worst.k, verdict: res.worst.verdict, d: res.worst.d, thC: res.worst.thC, Ftip: res.worst.Ftip, vMin: res.worst.vMin, vCrit: res.worst.vCrit } : null,
        items: res.sorted.map((x) => ({ name: x.name, k: x.k, verdict: x.verdict, Ftip: x.Ftip, vCrit: x.vCrit, reqW: x.reqW, reqD: x.reqD, anchorForce: x.anchorForce }))
      }
    }, null, 2);
  }

  /* ── 结果卡 PNG（1080×1350，固定坐标排布） ────────── */
  function pngCard() {
    const res = state.res; if (!res) { toast('先让输入通过校验'); return; }
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const F = (w2, sz) => w2 + ' ' + sz + 'px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
    const toks = (t) => String(t).match(/[A-Za-z0-9.,%×÷+\-−/（）()]+|[\u4e00-\u9fa5]|[^\s]/g) || [];
    const wrap = (text, maxW, size, weight) => {
      g.font = F(weight || 400, size);
      const out = [];
      let line = '';
      toks(text).forEach((t) => {
        const t2 = line + t;
        if (g.measureText(t2).width > maxW && line) { out.push(line); line = t; } else line = t2;
      });
      if (line) out.push(line);
      return out.map((x, i) => (i > 0 && /^[）)；，。、%]/.test(x) ? '　' + x : x));
    };
    const put = (text, x, y, size, color, weight, maxW, lh) => {
      g.fillStyle = color; g.font = F(weight || 400, size);
      const lines = maxW ? wrap(text, maxW, size, weight) : [String(text)];
      lines.forEach((ln, i) => g.fillText(ln, x, y + i * (lh || size + 8)));
      return y + lines.length * (lh || size + 8);
    };

    const w = res.worst;
    const windItems = res.items.filter((x) => x.windOn && x.vCrit !== null).sort((a, b) => a.vCrit - b.vCrit);
    const windWorst = windItems.length ? windItems[0] : null;
    const short = (d) => String(d).replace('朝 +宽 那侧（右）', '+宽（右）').replace('朝 −宽 那侧（左）', '−宽（左）').replace('朝 +深 那侧（后）', '+深（后）').replace('朝 −深 那侧（前）', '−深（前）').replace('四个方向等距', '四向等距');

    g.fillStyle = '#f4f6f9'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#1d4ed8'; g.fillRect(0, 0, W, 12);
    put('倾覆余量台', 72, 108, 50, '#16202c', 700);
    put('这东西会被推倒、被吹倒吗：临界倾角 / 临界推力 / 撞倒速度 / 临界风速', 72, 152, 23, '#4a5a6e', 400, W - 144);

    /* 结论 178–374 */
    g.fillStyle = '#eef2ff'; g.fillRect(72, 178, W - 144, 196);
    put(w ? '最弱的一件：' + w.name : '—', 96, 220, 30, '#16202c', 500, W - 240);
    const dirTxt = w ? (w.tieAll ? '四向等距' : '朝 ' + short(w.weakDir)) : '';
    put(w ? '只要 ' + (w.Ftip === null ? '推不翻' : w.Ftip.toFixed(2) + ' N（' + w.FtipKgf.toFixed(2) + ' kgf）') + ' 就能推倒（' + dirTxt + '）' : '', 96, 272, 32, '#b42318', 700, W - 240);
    put((w ? '倾斜 ' + w.thC.toFixed(2) + '° 就翻；撞倒只要 ' + w.vMin.toFixed(3) + ' m/s（' + w.vMinKmh.toFixed(2) + ' km/h）' : '') +
      '；' + res.needAction + ' / ' + res.items.length + ' 件没达到 ' + res.cfg.plan.sf + ' 倍目标', 96, 322, 23, '#16202c', 500, W - 240);

    /* 四个 KPI：394–512 / 520–638 */
    const kpi = [
      ['最弱裕度', kfmt(w ? w.k : null)],
      ['会被推倒的件数', res.failCount + ' / ' + res.items.length],
      ['最弱临界推力', w && w.Ftip !== null ? w.Ftip.toFixed(2) + ' N' : '推不翻'],
      ['最弱临界风速', windWorst ? windWorst.vCrit.toFixed(2) + ' m/s' : '不适用']
    ];
    kpi.forEach((x, i) => {
      const px = 72 + (i % 2) * 476, py = 394 + Math.floor(i / 2) * 126;
      g.fillStyle = '#fff'; g.fillRect(px, py, 452, 118);
      g.strokeStyle = '#e2e8f0'; g.strokeRect(px, py, 452, 118);
      g.fillStyle = '#4a5a6e'; g.font = F(400, 23); g.fillText(x[0], px + 24, py + 40);
      g.fillStyle = '#16202c'; g.font = F(700, 36); g.fillText(x[1], px + 24, py + 90);
    });

    /* 逐件 664–940 */
    put('逐件：最弱方向 → 临界推力 → 撞倒所需速度', 72, 686, 29, '#16202c', 700, W - 144);
    const cols = [72, 366, 606, 846];
    g.fillStyle = '#7d8b9c'; g.font = F(400, 21);
    ['物品（最弱方向）', '临界推力', '撞倒速度', '裕度 / 判定'].forEach((t, i) => g.fillText(t, cols[i], 722));
    g.strokeStyle = '#e2e8f0'; g.beginPath(); g.moveTo(72, 734); g.lineTo(W - 72, 734); g.stroke();
    let ry = 766;
    res.sorted.slice(0, 6).forEach((x) => {
      g.font = F(400, 23); g.fillStyle = '#34455a';
      const nm = x.name.length > 8 ? x.name.slice(0, 8) + '…' : x.name;
      g.fillText(nm + (x.tieAll ? '' : '（' + short(x.weakDir) + '）'), cols[0], ry);
      g.fillText(x.Ftip === null ? '推不翻' : x.Ftip.toFixed(2) + ' N', cols[1], ry);
      g.fillText(x.vMin.toFixed(3) + ' m/s', cols[2], ry);
      g.fillStyle = x.verdict === 'ok' ? '#0f7b52' : (x.verdict === 'tight' ? '#c47f00' : '#b42318');
      g.fillText(kfmt(x.k) + ' / ' + verdictText[x.verdict], cols[3], ry);
      ry += 33;
    });

    /* 要点 950–1080 */
    g.fillStyle = '#e8f6ef'; g.fillRect(72, 950, W - 144, 130);
    put('降重心不能提高抗推力：临界推力 = m·g·d ÷ z，不含重心高度', 96, 990, 25, '#0f7b52', 700, W - 240);
    put('撞倒所需速度只跟重心高度与支撑边界距离有关，与质量无关', 96, 1030, 23, '#16202c', 400, W - 240);
    put('最容易倒的方向就是最短的那条支撑边', 96, 1062, 23, '#16202c', 400, W - 240);

    /* 反推 1108–1216 */
    put('要达标怎么办（反推）', 72, 1112, 28, '#16202c', 700, W - 144);
    if (w) {
      put('加宽：宽 ≥ ' + w.reqW.toFixed(1) + ' cm、深 ≥ ' + w.reqD.toFixed(1) + ' cm（现在 ' + w.W + ' × ' + w.D + ' cm）' + (w.sizePractical ? '' : '　→ 加宽不现实'), 72, 1150, 22, '#34455a', 400, W - 144);
      put('固定件：能承受 ' + w.anchorForce.toFixed(1) + ' N（≈ ' + w.anchorForceKgf.toFixed(1) + ' kgf），固定点在 ' + res.cfg.plan.zf + ' cm 高处', 72, 1182, 22, '#34455a', 400, W - 144);
      put('压低施力点：力不高于 ' + w.pushZReq.toFixed(1) + ' cm' + (w.pushZReqOk ? '' : '（已高过物品本身，走不通）'), 72, 1214, 22, '#34455a', 400, W - 144);
    }

    /* 页脚 1250–1330 */
    g.fillStyle = '#e2e8f0'; g.fillRect(72, 1246, W - 144, 1);
    g.fillStyle = '#7d8b9c';
    put('力施加高度 ' + res.cfg.push.z + ' cm / 预想推力 ' + res.cfg.push.F + ' N / μ ' + res.cfg.push.mu + ' / 目标安全系数 ' + res.cfg.plan.sf + ' / 风口径' + (res.cfg.wind.on ? '开（' + res.cfg.wind.vT + ' m/s）' : '关'), 72, 1276, 20, '#7d8b9c', 400, W - 144);
    put('刚体假设、只绕支撑面边界翻倒；风压按 ½ρCdAv²、ρ = 1.225、风向取最不利方向', 72, 1304, 20, '#7d8b9c', 400, W - 144);
    put('默认与场景都是虚构示例，不是任何真实物品的实测数据 · 不判定产品是否合格 · 不引标准条款', 72, 1332, 20, '#7d8b9c', 400, W - 144);

    cv.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = '倾覆余量台-结果卡.png'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      state.exportCount++;
    }, 'image/png');
  }

  /* ── 本机保存 / 导入 ─────────────────────────────── */
  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(readInput()));
      $('saveState').textContent = '已保存到本机（' + new Date().toLocaleTimeString('zh-CN') + '）。只存在这个浏览器里。';
      toast('已保存到本机');
    } catch (e) { $('saveState').textContent = '这台浏览器不允许本机保存（可能是隐私模式）。'; }
  }

  function loadLocal(silent) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (!silent) toast('本机还没有保存过'); return false; }
      writeInput(JSON.parse(raw));
      if (!silent) toast('已读取上次保存的输入');
      return true;
    } catch (e) { if (!silent) toast('本机保存的内容读不出来'); return false; }
  }

  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const o = JSON.parse(String(fr.result));
        if (!o || o.app !== 'tip-margin' || !o.input) { toast('这不是本页的备份文件'); return; }
        writeInput(o.input);
        compute();
        toast('已导入备份并重算');
      } catch (e) { toast('备份文件解析失败'); }
    };
    fr.readAsText(file);
  }

  /* ── 事件绑定与启动 ─────────────────────────────── */
  function bind() {
    const form = $('form');
    form.addEventListener('input', (e) => { if (e.target.matches('input[type=text]')) compute(); });
    form.addEventListener('change', (e) => {
      if (e.target.matches('input[type=text], input[type=checkbox], select')) compute();
    });
    $('rows').addEventListener('click', (e) => {
      const del = e.target.closest('button[data-del]');
      const dup = e.target.closest('button[data-dup]');
      const cur = readInput();
      if (del) {
        if (cur.items.length <= 1) { toast('至少保留一件'); return; }
        const i = Number(del.dataset.del);
        cur.items.splice(i, 1);
        if (state.sel >= cur.items.length) state.sel = Math.max(0, cur.items.length - 1);
        writeInput(cur); compute();
      } else if (dup) {
        if (cur.items.length >= C.MAX_ROWS) { toast('最多 ' + C.MAX_ROWS + ' 件'); return; }
        const i = Number(dup.dataset.dup);
        const copy = Object.assign({}, cur.items[i], { name: cur.items[i].name + '（副本）' });
        cur.items.splice(i + 1, 0, copy);
        writeInput(cur); compute();
        toast('已复制一件');
      }
    });
    $('rankBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-sel]');
      if (!tr) return;
      state.sel = Number(tr.dataset.sel);
      render(state.res, state.checks, state.warnings);
    });
    $('btnAddRow').addEventListener('click', () => {
      const cur = readInput();
      if (cur.items.length >= C.MAX_ROWS) { toast('最多 ' + C.MAX_ROWS + ' 件'); return; }
      cur.items.push({ name: '新物品', m: '20', H: '120', h: '60', W: '60', D: '40', ox: '0', oy: '0', wind: false });
      writeInput(cur); compute();
    });
    $('btnDup').addEventListener('click', () => {
      const cur = readInput();
      if (cur.items.length >= C.MAX_ROWS) { toast('最多 ' + C.MAX_ROWS + ' 件'); return; }
      const last = cur.items[cur.items.length - 1];
      cur.items.push(Object.assign({}, last, { name: last.name + '（副本）' }));
      writeInput(cur); compute();
    });
    $('btnReset').addEventListener('click', () => { writeInput(C.defaultsClone()); $('scenario').value = 'home'; compute(); toast('已恢复默认虚构示例'); });
    $('btnSave').addEventListener('click', saveLocal);
    $('btnLoad').addEventListener('click', () => { if (loadLocal(false)) { $('scenario').value = ''; compute(); } });
    $('fSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-f]'); if (!b) return;
      $('pF').value = b.dataset.f; compute(); toast('预想推力改成 ' + b.dataset.f + ' N');
    });
    $('vSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      $('wvT').value = b.dataset.v; if (!$('wOn').checked) $('wOn').checked = true; compute();
      toast('目标风速改成 ' + b.dataset.v + ' m/s');
    });
    $('scenario').addEventListener('change', (e) => {
      const sc = C.scenarios.find((s) => s.id === e.target.value);
      if (!sc) return;
      const base = C.defaultsClone();
      const merged = {
        items: sc.patch.items || base.items,
        push: Object.assign({}, base.push, sc.patch.push || {}),
        wind: Object.assign({}, base.wind, sc.patch.wind || {}),
        plan: Object.assign({}, base.plan, sc.patch.plan || {})
      };
      writeInput(merged); state.sel = 0; compute(); toast('已套用场景：' + sc.name);
    });
    $('btnCsv').addEventListener('click', () => { if (!state.res) return toast('先让输入通过校验'); download('倾覆余量台.csv', csvText(), 'text/csv;charset=utf-8'); toast('CSV 已导出'); });
    $('btnMd').addEventListener('click', () => { if (!state.res) return toast('先让输入通过校验'); download('倾覆余量台.md', mdText(), 'text/markdown;charset=utf-8'); toast('Markdown 已导出'); });
    $('btnJson').addEventListener('click', () => { if (!state.res) return toast('先让输入通过校验'); download('倾覆余量台-备份.json', jsonBackup(), 'application/json'); toast('JSON 备份已导出'); });
    $('btnPng').addEventListener('click', () => { pngCard(); toast('结果卡 PNG 正在生成'); });
    $('btnPrint').addEventListener('click', () => window.print());
    $('importFile').addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]); });
  }

  function boot() {
    $('scenario').innerHTML = C.scenarios.map((s) => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
    writeInput(C.defaultsClone());
    bind();
    const loaded = loadLocal(true);
    $('scenario').value = loaded ? '' : 'home';
    compute();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
