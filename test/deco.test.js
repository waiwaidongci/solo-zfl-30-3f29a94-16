/* deco.js 算法边界测试（node --test） */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Deco = require("../deco.js");

const I = Deco._internals;
const HT = Deco.ZHL16C.halfTimes;

// 常用剖面
const NO_STOP = {
  segments: [
    { type: "descent", depth: 18, duration: 2 },
    { type: "bottom", depth: 18, duration: 28 },
    { type: "ascent", depth: 0, duration: 4 }
  ],
  gf: { low: 1, high: 1 }
};
const DECO_40 = { // 结束于 40m 底部，方案自底部起算
  segments: [
    { type: "descent", depth: 40, duration: 3 },
    { type: "bottom", depth: 40, duration: 22 }
  ]
};
const DEMO_30 = { // 结束于 30m 底部
  segments: [
    { type: "descent", depth: 30, duration: 3 },
    { type: "bottom", depth: 30, duration: 17 }
  ]
};

// ---------- 积分器精度 ----------

test("逐秒积分与 Bühlmann 解析解一致：恒定深度经过一个半时，组织压力到达中点", () => {
  const ctx = I.makeContext({ altitude: 0, waterTemp: 20, salinity: "salt", workload: "light" });
  const tissues = new Array(16).fill(I.inspiredN2(0, ctx));
  const pAlv = I.inspiredN2(30, ctx);
  const p0 = tissues[0];
  for (let s = 0; s < HT[0] * 60; s++) I.stepSecond(tissues, 30, 30, ctx);
  assert.ok(Math.abs(tissues[0] - (p0 + pAlv) / 2) < 1e-9,
    `舱室1 半时后应为中点 ${(p0 + pAlv) / 2}，实际 ${tissues[0]}`);
  // 慢舱室几乎未动
  assert.ok(tissues[15] < p0 + (pAlv - p0) * 0.01);
});

test("逐秒积分与 Schreiner 解析解一致：匀速下潜", () => {
  const ctx = I.makeContext({ altitude: 0, waterTemp: 20, salinity: "salt", workload: "light" });
  const tissues = new Array(16).fill(I.inspiredN2(0, ctx));
  const secs = 120; // 0 → 30m，2 分钟
  for (let s = 0; s < secs; s++) I.stepSecond(tissues, 30 * s / secs, 30 * (s + 1) / secs, ctx);
  // 独立解析解：P = Palv0 + R(t-1/k) - (Palv0 - P0 - R/k)e^(-kt)
  const k = Math.LN2 / (HT[0] * 60);
  const pAlv0 = I.inspiredN2(0, ctx);
  const R = (I.inspiredN2(30, ctx) - pAlv0) / secs;
  const P0 = pAlv0, t = secs;
  const expected = pAlv0 + R * (t - 1 / k) - (pAlv0 - P0 - R / k) * Math.exp(-k * t);
  assert.ok(Math.abs(tissues[0] - expected) < 1e-9, `斜坡加载偏差 ${tissues[0] - expected}`);
});

// ---------- 拒绝路径：时间倒序 ----------

test("时间倒序：负时长拒绝并定位分段", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "bottom", depth: 30, duration: -5 }
    ]
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "TIME_REVERSED");
  assert.equal(r.error.segmentIndex, 1);
  assert.match(r.error.message, /第2段/);
  assert.match(r.error.message, /时间不能倒退/);
});

// ---------- 拒绝路径：上升过快 ----------

test("上升过快：30m 一分钟升完拒绝并定位分段", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "ascent", depth: 0, duration: 1 }
    ]
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "ASCENT_TOO_FAST");
  assert.equal(r.error.segmentIndex, 1);
  assert.match(r.error.message, /30\.0 m\/min/);
});

test("上升速率边界：恰好 18 m/min 放行，18.1 m/min 拒绝", () => {
  const ok = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 18, duration: 2 },
      { type: "ascent", depth: 0, duration: 1 }
    ]
  });
  assert.equal(ok.ok, true);
  const bad = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 18.1, duration: 2 },
      { type: "ascent", depth: 0, duration: 1 }
    ]
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "ASCENT_TOO_FAST");
});

// ---------- 拒绝路径：超出模型范围 ----------

test("超出模型范围：深度、海拔、水温、梯度因子、空剖面、非法数值", () => {
  const cases = [
    [{ segments: [{ type: "descent", depth: 150, duration: 5 }] }, /深度/],
    [{ segments: [{ type: "bottom", depth: 10, duration: 10 }], env: { altitude: 4500 } }, /海拔/],
    [{ segments: [{ type: "bottom", depth: 10, duration: 10 }], env: { waterTemp: 45 } }, /水温/],
    [{ segments: [{ type: "bottom", depth: 10, duration: 10 }], gf: { low: 0.9, high: 0.3 } }, /梯度因子/],
    [{ segments: [{ type: "bottom", depth: 10, duration: 10 }], gf: { low: 0.05, high: 0.9 } }, /梯度因子/],
    [{ segments: [] }, /至少需要一段/],
    [{ segments: [{ type: "bottom", depth: 10, duration: 0 }] }, /时长为 0/],
    [{ segments: [{ type: "bottom", depth: NaN, duration: 10 }] }, /深度/],
    [{ segments: [{ type: "bottom", depth: 10, duration: "abc" }] }, /时长无效/],
    [{ segments: [{ type: "hover", depth: 10, duration: 10 }] }, /未知分段类型/],
    [{ segments: [{ type: "descent", depth: 30, duration: 0.4 }] }, /下降速率/], // 75 m/min
    [{ segments: [{ type: "descent", depth: 10, duration: 1 }], repetitive: { depth: 25, bottomTime: 30, surfaceInterval: -1 } }, /水面间隔/]
  ];
  for (const [input, re] of cases) {
    const r = Deco.reviewProfile(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.error.code, "OUT_OF_RANGE", JSON.stringify(input));
    assert.match(r.error.message, re, JSON.stringify(input));
  }
});

test("超出模型范围的分段定位到具体行", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 20, duration: 2 },
      { type: "descent", depth: 130, duration: 5 }
    ]
  });
  assert.equal(r.error.code, "OUT_OF_RANGE");
  assert.equal(r.error.segmentIndex, 1);
});

// ---------- 拒绝路径：迭代不收敛 ----------

test("迭代不收敛：拒绝并指出所属分段与当前停留深度", () => {
  const r = Deco.reviewProfile(DECO_40, { maxStopMinutes: 0.02 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "NO_CONVERGENCE");
  assert.equal(r.error.segmentIndex, DECO_40.segments.length - 1, "应定位到最后一段（方案起点）");
  assert.ok(typeof r.error.stopDepth === "number" && r.error.stopDepth > 0, "应给出不收敛的停留深度");
  assert.match(r.error.message, /第2段结束后/);
  assert.match(r.error.message, /m 处不收敛/);
});

test("默认迭代上限下正常剖面不会误报不收敛", () => {
  const r = Deco.reviewProfile(DECO_40);
  assert.equal(r.ok, true);
  assert.ok(r.stops.length > 0);
});

// ---------- 减压方案结构 ----------

test("免减压剖面回到水面：无停留，TTS 为 0", () => {
  const r = Deco.reviewProfile(NO_STOP);
  assert.equal(r.ok, true);
  assert.equal(r.stops.length, 0);
  assert.equal(r.firstStopDepth, 0);
  assert.equal(r.ttsSec, 0, "已安全回到水面，无剩余出水时间");
});

test("剖面结束于底部：无停留时 TTS 等于直接上升时间", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 18, duration: 2 },
      { type: "bottom", depth: 18, duration: 28 }
    ],
    gf: { low: 1, high: 1 }
  });
  assert.equal(r.ok, true);
  assert.equal(r.stops.length, 0);
  assert.equal(r.ttsSec, Math.round(18 / (9 / 60))); // 18m @ 9m/min
});

test("减压剖面：停留按 3m 步进递减，末停 3m，TTS 大于直接上升", () => {
  const r = Deco.reviewProfile(DECO_40);
  assert.equal(r.ok, true);
  assert.ok(r.stops.length >= 2, "应有多个停留");
  for (const s of r.stops) {
    assert.ok(s.depth % 3 === 0, `停留深度 ${s.depth} 应为 3 的倍数`);
    assert.ok(s.seconds > 0);
  }
  for (let i = 1; i < r.stops.length; i++) {
    assert.ok(r.stops[i].depth < r.stops[i - 1].depth, "停留深度应递减");
  }
  assert.equal(r.stops[r.stops.length - 1].depth, 3, "末停应为 3m");
  assert.equal(r.firstStopDepth, r.stops[0].depth);
  assert.ok(r.ttsSec > 40 / (9 / 60), "TTS 应大于直接上升时间");
});

test("减压方案执行后不突破出水上限（终点饱和度 ≤ 100%）", () => {
  // 免减压剖面直接出水：结束时各舱室都不应超过 M 值
  const r = Deco.reviewProfile(NO_STOP);
  for (const s of r.saturationEnd) assert.ok(s <= 1.0, `结束饱和度 ${s} 不应超过 100%`);
  assert.equal(r.saturationEnd.length, 16);
  assert.equal(r.saturationPeak.length, 16);
});

// ---------- 修正项单调性 ----------

test("海拔修正：同一剖面 2000m 比海平面需要更长出水时间", () => {
  const sea = Deco.reviewProfile({ ...DEMO_30, env: { altitude: 0 } });
  const alt = Deco.reviewProfile({ ...DEMO_30, env: { altitude: 2000 } });
  assert.ok(alt.ttsSec > sea.ttsSec, `海拔 ${alt.ttsSec} 应大于海平面 ${sea.ttsSec}`);
  assert.ok(I.surfacePressure(2000) < I.surfacePressure(0));
});

test("水温修正：冷水（5°C）比温水（25°C）出水时间更长", () => {
  const cold = Deco.reviewProfile({ ...DECO_40, env: { waterTemp: 5 } });
  const warm = Deco.reviewProfile({ ...DECO_40, env: { waterTemp: 25 } });
  assert.ok(cold.ttsSec > warm.ttsSec, `冷水 ${cold.ttsSec} 应大于温水 ${warm.ttsSec}`);
});

test("工作强度修正：繁重比轻度出水时间更长", () => {
  const light = Deco.reviewProfile({ ...DECO_40, env: { workload: "light" } });
  const heavy = Deco.reviewProfile({ ...DECO_40, env: { workload: "heavy" } });
  assert.ok(heavy.ttsSec > light.ttsSec);
});

// ---------- 重复潜水残留氮 ----------

test("重复潜水：残留氮高于水面平衡值，且随水面间隔变长而减少", () => {
  const ctx = I.makeContext({ altitude: 0, waterTemp: 20, salinity: "salt", workload: "moderate" });
  const base = Math.max(...I.saturation(new Array(16).fill(I.inspiredN2(0, ctx)), 0, ctx));
  const short = Deco.reviewProfile({ ...DEMO_30, repetitive: { depth: 25, bottomTime: 30, surfaceInterval: 30 } });
  const long = Deco.reviewProfile({ ...DEMO_30, repetitive: { depth: 25, bottomTime: 30, surfaceInterval: 360 } });
  assert.ok(short.residual.maxSaturation > base, `残留 ${short.residual.maxSaturation} 应高于平衡值 ${base}`);
  assert.ok(long.residual.maxSaturation > base);
  assert.ok(long.residual.maxSaturation < short.residual.maxSaturation, "间隔越长残留越少");
});

test("重复潜水：计入残留氮后同一剖面出水时间变长", () => {
  const clean = Deco.reviewProfile(DEMO_30);
  const rep = Deco.reviewProfile({ ...DEMO_30, repetitive: { depth: 25, bottomTime: 30, surfaceInterval: 30 } });
  assert.equal(clean.residual, null);
  assert.ok(rep.ttsSec > clean.ttsSec, `重复潜水 ${rep.ttsSec} 应大于洁净 ${clean.ttsSec}`);
});

test("重复潜水：水面间隔为 0（连续潜）合法", () => {
  const r = Deco.reviewProfile({ ...DEMO_30, repetitive: { depth: 20, bottomTime: 20, surfaceInterval: 0 } });
  assert.equal(r.ok, true);
  assert.ok(r.residual.maxSaturation > 0);
});

// ---------- 梯度因子 ----------

test("梯度因子低值控制首次停留：GF低 越小首停越深", () => {
  const deep = Deco.reviewProfile({ ...DECO_40, gf: { low: 0.2, high: 0.9 } });
  const shallow = Deco.reviewProfile({ ...DECO_40, gf: { low: 0.9, high: 0.9 } });
  assert.ok(deep.firstStopDepth >= shallow.firstStopDepth,
    `GF低0.2 首停 ${deep.firstStopDepth} 应不浅于 GF低0.9 的 ${shallow.firstStopDepth}`);
});

test("梯度因子高值控制出水上限：GF高 越小出水时间越长", () => {
  const tight = Deco.reviewProfile({ ...DECO_40, gf: { low: 0.5, high: 0.5 } });
  const loose = Deco.reviewProfile({ ...DECO_40, gf: { low: 0.5, high: 0.9 } });
  assert.ok(tight.ttsSec > loose.ttsSec, `GF高0.5 的 TTS ${tight.ttsSec} 应大于 GF高0.9 的 ${loose.ttsSec}`);
  // GF 100/100 即纯 Bühlmann，TTS 最短
  const buhlmann = Deco.reviewProfile({ ...DECO_40, gf: { low: 1, high: 1 } });
  assert.ok(loose.ttsSec >= buhlmann.ttsSec);
});

// ---------- 结束深度与减压上限的安全判断 ----------

test("结束深度浅于减压上限：标记违规（不限于回到水面）", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "bottom", depth: 30, duration: 25 },
      { type: "ascent", depth: 9, duration: 2.5 }
    ]
  });
  assert.equal(r.ok, true);
  assert.equal(r.endDepth, 9);
  assert.ok(r.ceilingAtEnd > r.endDepth, `上限 ${r.ceilingAtEnd} 应深于结束深度 9m`);
  assert.equal(r.ceilingViolation, true, "浅于上限必须标记违规");
});

test("结束深度深于上限：不标记违规", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "bottom", depth: 30, duration: 23 },
      { type: "ascent", depth: 9, duration: 2.5 }
    ]
  });
  assert.equal(r.ok, true);
  assert.ok(r.ceilingAtEnd < r.endDepth);
  assert.equal(r.ceilingViolation, false);
});

test("结束深度恰好等于上限（5cm 容差内）：不标记违规", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "bottom", depth: 30, duration: 24 },
      { type: "ascent", depth: 9, duration: 2.5 }
    ]
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.ceilingAtEnd - r.endDepth) <= 0.05,
    `上限 ${r.ceilingAtEnd.toFixed(3)} 应约等于结束深度 9m`);
  assert.equal(r.ceilingViolation, false, "恰好等于上限不应误报");
});

test("结束深度不在 3m 层时，剩余停留从结束深度继续且不更深", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "bottom", depth: 30, duration: 23 },
      { type: "ascent", depth: 10, duration: 2 }
    ]
  });
  assert.equal(r.ok, true);
  assert.equal(r.endDepth, 10);
  assert.ok(r.ceilingAtEnd > 9 && r.ceilingAtEnd <= 10, `上限 ${r.ceilingAtEnd} 应在 9–10m 之间`);
  assert.equal(r.stops[0].depth, 10, "首个停留必须从结束深度 10m 继续，而非跳到 9m 层");
  for (const s of r.stops) {
    assert.ok(s.depth <= 10 + 1e-9, `停留 ${s.depth}m 不得深于结束深度 10m`);
  }
});

test("任意结束深度：停留深度均不超过结束深度", () => {
  for (const endD of [4, 5.5, 7, 10, 11.5, 13, 16.2, 20]) {
    const r = Deco.reviewProfile({
      segments: [
        { type: "descent", depth: 30, duration: 3 },
        { type: "bottom", depth: 30, duration: 20 },
        { type: "ascent", depth: endD, duration: Math.max(1, (30 - endD) / 9) }
      ]
    });
    assert.equal(r.ok, true, `end ${endD}`);
    for (const s of r.stops) {
      assert.ok(s.depth <= endD + 1e-9, `结束于 ${endD}m 时出现更深停留 ${s.depth}m`);
    }
  }
});

// ---------- 途中减压上限逐秒检测 ----------

test("途中越限后回潜：仍被检出，不被合规的结束状态掩盖", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "bottom", depth: 30, duration: 25 },
      { type: "ascent", depth: 3, duration: 2.5 },  // 途中突破上限
      { type: "descent", depth: 9, duration: 1 },   // 重新下潜
      { type: "bottom", depth: 9, duration: 40 },   // 长时间排氮
      { type: "ascent", depth: 0, duration: 1 }
    ]
  });
  assert.equal(r.ok, true);
  assert.ok(r.profileViolation, "途中越限必须被记录");
  assert.equal(r.profileViolation.segmentIndex, 2, "应定位到急升分段");
  assert.equal(r.profileViolation.segmentType, "ascent");
  assert.ok(r.profileViolation.depth < r.profileViolation.ceiling,
    `越限点深度 ${r.profileViolation.depth} 应浅于上限 ${r.profileViolation.ceiling}`);
  assert.ok(r.profileViolation.timeSec > 0 && r.profileViolation.violatedSec > 0);
  assert.equal(r.ceilingViolation, false, "结束状态已合规，但途中越限不得被掩盖");
});

test("持续越限：累计越限秒数随停留增长，结束状态同步报警", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "bottom", depth: 30, duration: 25 },
      { type: "ascent", depth: 3, duration: 2.5 },
      { type: "bottom", depth: 3, duration: 5 } // 5 分钟全程处于越限状态
    ]
  });
  assert.ok(r.profileViolation);
  assert.ok(r.profileViolation.violatedSec >= 200,
    `越限秒数 ${r.profileViolation.violatedSec} 应覆盖大部分浅停时间`);
  assert.equal(r.ceilingViolation, true, "结束时仍越限应同步标记");
});

test("安全剖面不误报途中越限", () => {
  // 免减压剖面
  assert.equal(Deco.reviewProfile(NO_STOP).profileViolation, null);
  // 结束于 10m 的合规减压剖面
  const demo = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 30, duration: 3 },
      { type: "bottom", depth: 30, duration: 17 },
      { type: "ascent", depth: 10, duration: 2 }
    ]
  });
  assert.equal(demo.profileViolation, null);
  // 重复潜水入水残留属初始状态，不得误报
  const rep = Deco.reviewProfile({ ...DEMO_30, repetitive: { depth: 25, bottomTime: 30, surfaceInterval: 30 } });
  assert.equal(rep.profileViolation, null, "重复潜水入水残留不得误报途中越限");
});

test("按引擎计算方案执行的减压剖面不触发误报", () => {
  const plan = Deco.reviewProfile(DECO_40);
  assert.ok(plan.stops.length > 0);
  const segments = [
    { type: "descent", depth: 40, duration: 3 },
    { type: "bottom", depth: 40, duration: 22 }
  ];
  let depth = 40;
  for (const s of plan.stops) {
    segments.push({ type: "ascent", depth: s.depth, duration: (depth - s.depth) / 9 });
    segments.push({ type: "bottom", depth: s.depth, duration: s.seconds / 60 });
    depth = s.depth;
  }
  segments.push({ type: "ascent", depth: 0, duration: depth / 9 });
  const r = Deco.reviewProfile({ segments });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.profileViolation, null, "按方案逐秒执行不得误报越限");
  assert.equal(r.ceilingViolation, false);
});

// ---------- 剖面结构语义 ----------

test("多分段：浅停增加组织负荷时 TTS 与停留必须随之增长", () => {
  const base = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 40, duration: 3 },
      { type: "bottom", depth: 40, duration: 20 },
      { type: "ascent", depth: 20, duration: 2 }
    ]
  });
  const withStay = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 40, duration: 3 },
      { type: "bottom", depth: 40, duration: 20 },
      { type: "ascent", depth: 20, duration: 2 },
      { type: "bottom", depth: 20, duration: 60 }
    ]
  });
  assert.equal(base.ok, true);
  assert.equal(withStay.ok, true);
  assert.equal(base.endDepth, 20);
  assert.equal(withStay.endDepth, 20);
  assert.ok(withStay.tissuesEnd[15] > base.tissuesEnd[15], "20m 浅停应让慢舱室继续吸氮");
  assert.ok(withStay.ttsSec > base.ttsSec,
    `浅停增负荷后 TTS ${withStay.ttsSec} 必须大于 ${base.ttsSec}，不得保持不变`);
  assert.notDeepEqual(withStay.stops, base.stops, "停留方案必须随浅停改变");
});

test("深潜后回升：方案自回升后的结束状态继续计算", () => {
  const atBottom = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 40, duration: 3 },
      { type: "bottom", depth: 40, duration: 20 }
    ]
  });
  const ascended = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 40, duration: 3 },
      { type: "bottom", depth: 40, duration: 20 },
      { type: "ascent", depth: 15, duration: 2.5 }
    ]
  });
  assert.equal(ascended.ok, true);
  assert.equal(ascended.endDepth, 15);
  assert.ok(ascended.ttsSec > 0, "回升到 15m 后仍需减压");
  assert.ok(ascended.ttsSec < atBottom.ttsSec, "已回升并部分排氮，TTS 应小于停留在 40m 的方案");
  assert.ok(ascended.stops[0].depth <= 15, "首停不深于结束深度");
});

test("剖面结束于深度：方案自结束状态起算", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 25, duration: 3 },
      { type: "bottom", depth: 25, duration: 15 },
      { type: "ascent", depth: 10, duration: 2 }
    ]
  });
  assert.equal(r.ok, true);
  assert.equal(r.endDepth, 10);
  assert.ok(r.ttsSec > 0);
  const atBottom = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 25, duration: 3 },
      { type: "bottom", depth: 25, duration: 15 }
    ]
  });
  assert.ok(r.ttsSec < atBottom.ttsSec, "已上升的部分不应重复计时");
});

// ---------- 分段类型与时长校验 ----------

test("分段类型必须与深度方向一致", () => {
  const cases = [
    [[{ type: "descent", depth: 30, duration: 3 }, { type: "descent", depth: 20, duration: 2 }], /必须深于当前深度/],
    [[{ type: "descent", depth: 30, duration: 3 }, { type: "ascent", depth: 40, duration: 2 }], /必须浅于当前深度/],
    [[{ type: "descent", depth: 30, duration: 3 }, { type: "bottom", depth: 20, duration: 5 }], /停留段深度不得由 .* 移动至/],
    [[{ type: "ascent", depth: 0, duration: 1 }], /必须浅于当前深度/],
    [[{ type: "descent", depth: 30, duration: 3 }, { type: "descent", depth: 30, duration: 2 }], /必须深于当前深度/]
  ];
  for (const [segments, re] of cases) {
    const r = Deco.reviewProfile({ segments });
    assert.equal(r.ok, false, JSON.stringify(segments));
    assert.equal(r.error.code, "TYPE_MISMATCH", JSON.stringify(segments));
    assert.equal(r.error.segmentIndex, segments.length - 1, JSON.stringify(segments));
    assert.match(r.error.message, re, JSON.stringify(segments));
  }
});

test("首段在水面停留合法，随后可正常下潜", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "bottom", depth: 0, duration: 5 },
      { type: "descent", depth: 18, duration: 2 },
      { type: "bottom", depth: 18, duration: 20 },
      { type: "ascent", depth: 0, duration: 4 }
    ],
    gf: { low: 1, high: 1 }
  });
  assert.equal(r.ok, true);
});

test("短于一秒的分段被拒绝，恰好一秒合法", () => {
  const r = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 10, duration: 1 },
      { type: "bottom", depth: 10, duration: 0.005 } // 0.3 秒
    ]
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "OUT_OF_RANGE");
  assert.equal(r.error.segmentIndex, 1);
  assert.match(r.error.message, /不足 1 秒/);
  const ok = Deco.reviewProfile({
    segments: [
      { type: "descent", depth: 10, duration: 1 },
      { type: "bottom", depth: 10, duration: 1 / 60 } // 恰好 1 秒
    ]
  });
  assert.equal(ok.ok, true);
});

test("结果确定性：相同输入两次计算完全一致", () => {
  const a = Deco.reviewProfile({ ...DECO_40, repetitive: { depth: 25, bottomTime: 30, surfaceInterval: 60 } });
  const b = Deco.reviewProfile({ ...DECO_40, repetitive: { depth: 25, bottomTime: 30, surfaceInterval: 60 } });
  assert.deepEqual(a, b);
});

test("控制舱室索引有效，组织压力数组为 16 舱", () => {
  const r = Deco.reviewProfile(DECO_40);
  assert.ok(r.controlling >= 0 && r.controlling < 16);
  assert.equal(r.tissuesEnd.length, 16);
  for (const t of r.tissuesEnd) assert.ok(t > 0 && t < 20, "组织压力应在合理范围");
});
