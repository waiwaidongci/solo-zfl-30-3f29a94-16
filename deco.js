/*
 * deco.js — ZHL-16C 离线潜水减压剖面复核引擎（纯计算，无 DOM，浏览器 / Node 共用）
 *
 * 模型要点：
 *  - 16 组织舱室，空气（氮气 79%），Schreiner 方程逐秒推进组织压力；
 *  - 海拔修正水面气压（ISA 对流层公式），组织初始压力按海拔平衡；
 *  - 水温修正：冷水降低灌注（排氮半时变长）并提高溶解度（启发式保守修正）；
 *  - 工作强度修正：强度越高，吸氮越快、排氮越慢（双向保守）；
 *  - 重复潜水：模拟上一潜（方形剖面）+ 水面间隔，残留氮作为本潜初始组织压力；
 *  - 梯度因子 GF 低值控制首次停留深度，高值控制出水上限，中间随深度线性插值；
 *  - 拒绝出结果（带分段定位）：时间倒序 TIME_REVERSED、上升过快 ASCENT_TOO_FAST、
 *    超出模型范围 OUT_OF_RANGE、迭代不收敛 NO_CONVERGENCE。
 *
 * 仅供教学复核，不能替代潜水电脑表与正式减压计划。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Deco = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // ---- ZHL-16C 氮气参数 ----
  var HALF_TIMES = [4, 8, 12.5, 18.5, 27, 38.3, 54.3, 77, 109, 146, 187, 239, 305, 390, 498, 635]; // min
  var A_N2 = [1.2599, 1.0000, 0.8618, 0.7562, 0.6667, 0.5933, 0.5282, 0.4701, 0.4187, 0.3798,
              0.3497, 0.3223, 0.2971, 0.2737, 0.2523, 0.2327]; // bar
  var B_N2 = [0.5050, 0.6514, 0.7222, 0.7825, 0.8126, 0.8434, 0.8693, 0.8910, 0.9092, 0.9222,
              0.9319, 0.9403, 0.9477, 0.9544, 0.9602, 0.9653];
  var N_COMP = 16;

  var WATER_VAPOR_BAR = 0.0627;  // 37°C 饱和水蒸气分压
  var FN2_AIR = 0.79;            // 空气氮气体积分数
  var P_SEA_LEVEL = 1.01325;     // bar
  var BAR_PER_M = { salt: 0.1006, fresh: 0.0981 };
  var LN2 = Math.LN2;
  var STOP_STEP_M = 3;           // 减压停留深度步进（米）

  var LIMITS = {
    maxDepth: 120,            // m，ZHL-16C 空气适用上限
    maxAltitude: 4000,        // m
    minTemp: -2, maxTemp: 40, // °C
    maxAscentRate: 18,        // m/min，上升速率硬上限
    maxDescentRate: 60,       // m/min，下降速率合理性上限
    maxSegmentMin: 1440,      // 单段最长 24 h
    maxTotalMin: 2880,        // 全剖面最长 48 h
    maxSegments: 60,
    maxSurfaceIntervalMin: 10080, // 水面间隔最长 7 天
    gfMin: 0.1, gfMax: 1.0
  };

  // 工作强度：on 加快吸氮、off 减慢排氮（双向保守）
  var WORKLOADS = {
    light:    { on: 1.0,  off: 1.0 },
    moderate: { on: 1.1,  off: 1 / 1.1 },
    heavy:    { on: 1.25, off: 1 / 1.25 }
  };

  var SEGMENT_TYPES = { descent: "下潜", bottom: "停留", ascent: "上升" };

  var DEFAULT_OPTIONS = {
    maxAscentRate: LIMITS.maxAscentRate,
    maxDescentRate: LIMITS.maxDescentRate,
    decoAscentRate: 9,        // 计算减压方案时采用的上升速率 m/min
    maxStopMinutes: 720,      // 单个停留点求解上限（不收敛判定）
    maxScheduleSeconds: 200000 // 减压方案总模拟秒数上限（不收敛判定）
  };

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function numOr(v, d) { return v == null ? d : Number(v); }

  function DecoError(code, message, segmentIndex) {
    var e = new Error(message);
    e.__deco = true;
    e.code = code;
    e.segmentIndex = segmentIndex == null ? null : segmentIndex;
    return e;
  }

  // 海拔修正：ISA 对流层气压公式（0–11000 m 有效）
  function surfacePressure(altitudeM) {
    return P_SEA_LEVEL * Math.pow(1 - 2.25577e-5 * altitudeM, 5.25588);
  }

  // 水温修正（启发式）：冷水降低灌注 → 排氮半时变长；提高溶解度 → 吸入分压等效升高
  function tempOffGasFactor(tempC) { return clamp(1 + 0.02 * (20 - tempC), 0.8, 1.5); }
  function tempSolubilityFactor(tempC) { return clamp(1 + 0.01 * (20 - tempC), 0.9, 1.15); }

  function makeContext(env) {
    var pSurf = surfacePressure(env.altitude);
    var barPerM = BAR_PER_M[env.salinity];
    var wl = WORKLOADS[env.workload];
    var offF = tempOffGasFactor(env.waterTemp);
    var kOn = new Array(N_COMP), kOff = new Array(N_COMP);
    for (var i = 0; i < N_COMP; i++) {
      var k = LN2 / (HALF_TIMES[i] * 60); // 每秒衰减常数
      kOn[i] = k * wl.on;
      kOff[i] = k * wl.off / offF;
    }
    return {
      pSurf: pSurf,
      barPerM: barPerM,
      kOn: kOn,
      kOff: kOff,
      solub: tempSolubilityFactor(env.waterTemp),
      env: env
    };
  }

  function inspiredN2(depthM, ctx) {
    return (ctx.pSurf + depthM * ctx.barPerM - WATER_VAPOR_BAR) * FN2_AIR * ctx.solub;
  }

  // Schreiner 方程：1 秒内深度由 d0 线性变化到 d1，逐舱室推进组织压力
  function stepSecond(tissues, d0, d1, ctx) {
    var pAlv = inspiredN2(d0, ctx);
    var R = inspiredN2(d1, ctx) - pAlv; // bar/s
    for (var i = 0; i < N_COMP; i++) {
      var t0 = tissues[i];
      var k = t0 < pAlv ? ctx.kOn[i] : ctx.kOff[i];
      tissues[i] = pAlv + R * (1 - 1 / k) - (pAlv - t0 - R / k) * Math.exp(-k);
    }
  }

  // 单舱室在梯度因子 gf 下的容许环境压力（bar）
  function ceilingPressure(tissue, gf, a, b) {
    return (tissue - gf * a) / (1 - gf + gf / b);
  }

  // GF 随深度插值：首停深度处取 gfLow，水面取 gfHigh，更深处以 gfLow 计
  function gfAtDepth(depth, firstStop, gfLow, gfHigh) {
    if (firstStop <= 0 || depth <= 0) return gfHigh;
    return gfHigh + (gfLow - gfHigh) * Math.min(1, depth / firstStop);
  }

  // 当前组织状态下不允许浅于的深度（米）；firstStop 为按 gfLow 求得的首停深度
  function ceilingInfo(tissues, depth, gfLow, gfHigh, ctx) {
    var firstStop = firstStopDepth(tissues, gfLow, ctx);
    var gf = gfAtDepth(depth, firstStop, gfLow, gfHigh);
    var maxP2 = -Infinity;
    for (var i = 0; i < N_COMP; i++) {
      maxP2 = Math.max(maxP2, ceilingPressure(tissues[i], gf, A_N2[i], B_N2[i]));
    }
    return { ceiling: Math.max(0, (maxP2 - ctx.pSurf) / ctx.barPerM), firstStop: firstStop, gf: gf };
  }

  // 按 gfLow 求得的首停锚点深度（3 m 步进，方案计算期间固定不变）
  function firstStopDepth(tissues, gfLow, ctx) {
    var maxP = -Infinity;
    for (var i = 0; i < N_COMP; i++) {
      maxP = Math.max(maxP, ceilingPressure(tissues[i], gfLow, A_N2[i], B_N2[i]));
    }
    return Math.max(0,
      Math.ceil((maxP - ctx.pSurf) / ctx.barPerM / STOP_STEP_M - 1e-9) * STOP_STEP_M);
  }

  // 是否允许上升到 targetDepth：全部舱室在 targetDepth 处的 GF 校验通过
  function clearedToDepth(tissues, targetDepth, firstStop, gfLow, gfHigh, ctx) {
    var gf = gfAtDepth(targetDepth, firstStop, gfLow, gfHigh);
    var pAmb = ctx.pSurf + targetDepth * ctx.barPerM;
    for (var i = 0; i < N_COMP; i++) {
      if (ceilingPressure(tissues[i], gf, A_N2[i], B_N2[i]) > pAmb + 1e-9) return false;
    }
    return true;
  }

  // 从 startDepth / startTissues 起，按 3 m 步进求减压方案：停留 + 总出水时间（秒）
  function computeSchedule(startDepth, startTissues, gfLow, gfHigh, ctx, opts) {
    var tissues = startTissues.slice();
    var depth = startDepth;
    var tts = 0, guard = 0;
    var stops = [];
    var ascend = opts.decoAscentRate / 60; // m/s
    var firstStop = firstStopDepth(startTissues, gfLow, ctx); // 固定锚点

    function noConv(msg) {
      throw DecoError("NO_CONVERGENCE",
        "减压求解不收敛（" + msg + "），超出迭代上限，请检查剖面深度与梯度因子设置", null);
    }
    function addWait(d, s) {
      if (s <= 0) return;
      var last = stops[stops.length - 1];
      if (last && Math.abs(last.depth - d) < 1e-9) last.seconds += s;
      else stops.push({ depth: Math.round(d * 100) / 100, seconds: s });
    }
    // 等深停留，直至允许上升到 nextStop；返回停留秒数
    function waitUntilCleared(nextStop) {
      var waited = 0;
      while (!clearedToDepth(tissues, nextStop, firstStop, gfLow, gfHigh, ctx)) {
        if (++guard > opts.maxScheduleSeconds) noConv("减压模拟总时长超过 " + opts.maxScheduleSeconds + " s");
        if (++waited > opts.maxStopMinutes * 60) {
          noConv(Math.round(depth * 10) / 10 + " m 停留超过 " + opts.maxStopMinutes + " min 仍未清除上限");
        }
        stepSecond(tissues, depth, depth, ctx);
        tts++;
      }
      return waited;
    }
    // 等速上升至 target（逐秒模拟）
    function ascendTo(target) {
      while (depth > target + 1e-9) {
        if (++guard > opts.maxScheduleSeconds) noConv("上升模拟超过 " + opts.maxScheduleSeconds + " s");
        var next = Math.max(target, depth - ascend);
        stepSecond(tissues, depth, next, ctx);
        depth = next;
        tts++;
      }
    }

    // 第一阶段：从最大深度直达首停（首停以下 gf 恒为 gfLow，上限不会超过身位）
    if (firstStop > 1e-9 && depth > firstStop + 1e-9) ascendTo(firstStop);
    // 第二阶段：停留阶梯，逐 3 m 上行直至水面
    while (depth > 1e-9) {
      var nextStop = depth <= STOP_STEP_M + 1e-9 ? 0
        : Math.max(0, Math.floor((depth - 1e-6) / STOP_STEP_M) * STOP_STEP_M);
      addWait(depth, waitUntilCleared(nextStop));
      ascendTo(nextStop);
    }
    return { stops: stops, ttsSec: tts, firstStopDepth: stops.length ? stops[0].depth : 0 };
  }

  // 组织压力相对当前环境 M 值的饱和度（>1 表示超过模型极限）
  function saturation(tissues, depth, ctx) {
    var pAmb = ctx.pSurf + depth * ctx.barPerM;
    var out = new Array(N_COMP);
    for (var i = 0; i < N_COMP; i++) out[i] = tissues[i] / (A_N2[i] + pAmb / B_N2[i]);
    return out;
  }

  // 重复潜水：上一潜方形剖面（下潜 18 m/min、上升 9 m/min）+ 水面间隔，求残留氮组织压力
  function simulateRepetitive(rep, ctx) {
    var tissues = new Array(N_COMP);
    var p0 = inspiredN2(0, ctx);
    for (var i = 0; i < N_COMP; i++) tissues[i] = p0;
    var depth = 0, s, next;
    var descendSec = Math.ceil(rep.depth / (18 / 60));
    for (s = 0; s < descendSec; s++) {
      next = Math.min(rep.depth, depth + 18 / 60);
      stepSecond(tissues, depth, next, ctx);
      depth = next;
    }
    var bottomSec = Math.round(rep.bottomTime * 60);
    for (s = 0; s < bottomSec; s++) stepSecond(tissues, depth, depth, ctx);
    var ascendSec = Math.ceil(rep.depth / (9 / 60));
    for (s = 0; s < ascendSec; s++) {
      next = Math.max(0, depth - 9 / 60);
      stepSecond(tissues, depth, next, ctx);
      depth = next;
    }
    var siSec = Math.round(rep.surfaceInterval * 60);
    for (s = 0; s < siSec; s++) stepSecond(tissues, 0, 0, ctx);
    return tissues;
  }

  function run(input, opts) {
    // ---- 环境与修正参数 ----
    var envIn = input.env || {};
    var env = {
      altitude: numOr(envIn.altitude, 0),
      waterTemp: numOr(envIn.waterTemp, 20),
      salinity: envIn.salinity === "fresh" ? "fresh" : "salt",
      workload: WORKLOADS[envIn.workload] ? envIn.workload : "moderate"
    };
    if (!isNum(env.altitude) || env.altitude < 0 || env.altitude > LIMITS.maxAltitude) {
      throw DecoError("OUT_OF_RANGE", "海拔 " + env.altitude + " m 超出模型范围 0–" + LIMITS.maxAltitude + " m");
    }
    if (!isNum(env.waterTemp) || env.waterTemp < LIMITS.minTemp || env.waterTemp > LIMITS.maxTemp) {
      throw DecoError("OUT_OF_RANGE", "水温 " + env.waterTemp + " °C 超出模型范围 " + LIMITS.minTemp + "–" + LIMITS.maxTemp + " °C");
    }
    var gfIn = input.gf || {};
    var gfLow = numOr(gfIn.low, 0.3), gfHigh = numOr(gfIn.high, 0.85);
    if (!isNum(gfLow) || gfLow < LIMITS.gfMin || gfLow > LIMITS.gfMax ||
        !isNum(gfHigh) || gfHigh < LIMITS.gfMin || gfHigh > LIMITS.gfMax) {
      throw DecoError("OUT_OF_RANGE", "梯度因子须位于 " + LIMITS.gfMin * 100 + "%–" + LIMITS.gfMax * 100 + "% 之间");
    }
    if (gfLow > gfHigh + 1e-9) {
      throw DecoError("OUT_OF_RANGE", "梯度因子低值（" + Math.round(gfLow * 100) + "%）不能高于高值（" + Math.round(gfHigh * 100) + "%）");
    }

    // ---- 剖面分段 ----
    var segs = input.segments;
    if (!Array.isArray(segs) || segs.length === 0) {
      throw DecoError("OUT_OF_RANGE", "至少需要一段剖面分段");
    }
    if (segs.length > LIMITS.maxSegments) {
      throw DecoError("OUT_OF_RANGE", "分段数 " + segs.length + " 超出模型上限 " + LIMITS.maxSegments);
    }
    var totalMin = 0;
    var normSegs = [];
    for (var v = 0; v < segs.length; v++) {
      var sg = segs[v] || {};
      var no = v + 1;
      if (!SEGMENT_TYPES[sg.type]) {
        throw DecoError("OUT_OF_RANGE", "第" + no + "段：未知分段类型 " + String(sg.type), v);
      }
      var sDepth = numOr(sg.depth, NaN);
      var sDur = numOr(sg.duration, NaN);
      if (!isNum(sDepth) || sDepth < 0 || sDepth > LIMITS.maxDepth) {
        throw DecoError("OUT_OF_RANGE", "第" + no + "段（" + SEGMENT_TYPES[sg.type] + "）：深度 " + sg.depth + " m 超出模型范围 0–" + LIMITS.maxDepth + " m", v);
      }
      if (!isNum(sDur)) {
        throw DecoError("OUT_OF_RANGE", "第" + no + "段（" + SEGMENT_TYPES[sg.type] + "）：时长无效", v);
      }
      if (sDur < 0) {
        throw DecoError("TIME_REVERSED", "第" + no + "段（" + SEGMENT_TYPES[sg.type] + "）：时长 " + sDur + " min 为负，时间不能倒退", v);
      }
      if (sDur <= 0) {
        throw DecoError("OUT_OF_RANGE", "第" + no + "段（" + SEGMENT_TYPES[sg.type] + "）：时长为 0，无法形成有效剖面", v);
      }
      if (sDur > LIMITS.maxSegmentMin) {
        throw DecoError("OUT_OF_RANGE", "第" + no + "段（" + SEGMENT_TYPES[sg.type] + "）：单段时长超出模型上限 " + LIMITS.maxSegmentMin + " min", v);
      }
      totalMin += sDur;
      if (totalMin > LIMITS.maxTotalMin) {
        throw DecoError("OUT_OF_RANGE", "剖面总时长超出模型上限 " + LIMITS.maxTotalMin + " min", v);
      }
      normSegs.push({ type: sg.type, depth: sDepth, duration: sDur });
    }

    var ctx = makeContext(env);

    // ---- 初始组织压力：海拔平衡 或 重复潜水残留氮 ----
    var tissues, residual = null;
    if (input.repetitive) {
      var rep = input.repetitive;
      if (!isNum(rep.depth) || rep.depth <= 0 || rep.depth > LIMITS.maxDepth) {
        throw DecoError("OUT_OF_RANGE", "上一潜深度 " + rep.depth + " m 超出模型范围 0–" + LIMITS.maxDepth + " m");
      }
      if (!isNum(rep.bottomTime) || rep.bottomTime <= 0 || rep.bottomTime > LIMITS.maxSegmentMin) {
        throw DecoError("OUT_OF_RANGE", "上一潜底部时间 " + rep.bottomTime + " min 超出模型范围");
      }
      if (!isNum(rep.surfaceInterval) || rep.surfaceInterval < 0 || rep.surfaceInterval > LIMITS.maxSurfaceIntervalMin) {
        throw DecoError("OUT_OF_RANGE", "水面间隔 " + rep.surfaceInterval + " min 超出模型范围 0–" + LIMITS.maxSurfaceIntervalMin + " min");
      }
      tissues = simulateRepetitive(rep, ctx);
      var resSat = saturation(tissues, 0, ctx);
      residual = {
        tissues: tissues.slice(),
        maxSaturation: Math.max.apply(null, resSat),
        repetitive: { depth: rep.depth, bottomTime: rep.bottomTime, surfaceInterval: rep.surfaceInterval }
      };
    } else {
      tissues = new Array(N_COMP);
      var pInit = inspiredN2(0, ctx);
      for (var i0 = 0; i0 < N_COMP; i0++) tissues[i0] = pInit;
    }

    // ---- 逐秒模拟录入剖面 ----
    var depth = 0;
    var maxDepth = 0;
    var snapshot = tissues.slice(); // 最后一次处于最大深度时的组织状态（减压计算起点）
    var peak = saturation(tissues, 0, ctx);
    for (var idx = 0; idx < normSegs.length; idx++) {
      var seg = normSegs[idx];
      var from = depth, to = seg.depth;
      var durSec = Math.round(seg.duration * 60);
      var rate = Math.abs(to - from) / seg.duration; // m/min
      if (to < from && rate > opts.maxAscentRate + 1e-9) {
        throw DecoError("ASCENT_TOO_FAST",
          "第" + (idx + 1) + "段（" + SEGMENT_TYPES[seg.type] + "）：上升速率 " + rate.toFixed(1) +
          " m/min 超过模型上限 " + opts.maxAscentRate + " m/min", idx);
      }
      if (to > from && rate > opts.maxDescentRate + 1e-9) {
        throw DecoError("OUT_OF_RANGE",
          "第" + (idx + 1) + "段（" + SEGMENT_TYPES[seg.type] + "）：下降速率 " + rate.toFixed(1) +
          " m/min 超出模型上限 " + opts.maxDescentRate + " m/min", idx);
      }
      for (var s2 = 0; s2 < durSec; s2++) {
        var nxt = from + (to - from) * (s2 + 1) / durSec;
        stepSecond(tissues, depth, nxt, ctx);
        depth = nxt;
        if (depth > maxDepth + 1e-9) {
          maxDepth = depth;
          snapshot = tissues.slice();
        } else if (Math.abs(depth - maxDepth) <= 1e-9) {
          snapshot = tissues.slice(); // 同一最大深度上取最后时刻
        }
        var sat = saturation(tissues, depth, ctx);
        for (var p = 0; p < N_COMP; p++) if (sat[p] > peak[p]) peak[p] = sat[p];
      }
    }

    // ---- 减压方案：自最后一次离开最大深度的状态起算 ----
    var sched = computeSchedule(maxDepth, snapshot, gfLow, gfHigh, ctx, opts);
    var endInfo = ceilingInfo(tissues, depth, gfLow, gfHigh, ctx);
    var satEnd = saturation(tissues, depth, ctx);
    var controlling = 0;
    for (var c = 1; c < N_COMP; c++) if (satEnd[c] > satEnd[controlling]) controlling = c;

    return {
      stops: sched.stops,
      ttsSec: sched.ttsSec,
      firstStopDepth: sched.firstStopDepth,
      maxDepth: maxDepth,
      endDepth: depth,
      ceilingAtEnd: endInfo.ceiling,
      totalDiveMin: totalMin,
      tissuesEnd: tissues.slice(),
      saturationEnd: satEnd,
      saturationPeak: peak,
      controlling: controlling,
      residual: residual,
      env: {
        altitude: env.altitude, waterTemp: env.waterTemp, salinity: env.salinity,
        workload: env.workload, pSurf: ctx.pSurf, barPerM: ctx.barPerM
      },
      gf: { low: gfLow, high: gfHigh }
    };
  }

  function reviewProfile(input, options) {
    var opts = {};
    for (var k in DEFAULT_OPTIONS) opts[k] = DEFAULT_OPTIONS[k];
    if (options) for (var k2 in options) opts[k2] = options[k2];
    try {
      var r = run(input || {}, opts);
      r.ok = true;
      return r;
    } catch (e) {
      if (e && e.__deco) {
        return { ok: false, error: { code: e.code, message: e.message, segmentIndex: e.segmentIndex } };
      }
      throw e;
    }
  }

  return {
    reviewProfile: reviewProfile,
    LIMITS: LIMITS,
    STOP_STEP_M: STOP_STEP_M,
    ZHL16C: { halfTimes: HALF_TIMES.slice(), a: A_N2.slice(), b: B_N2.slice() },
    _internals: {
      surfacePressure: surfacePressure,
      tempOffGasFactor: tempOffGasFactor,
      tempSolubilityFactor: tempSolubilityFactor,
      makeContext: makeContext,
      inspiredN2: inspiredN2,
      stepSecond: stepSecond,
      ceilingInfo: ceilingInfo,
      firstStopDepth: firstStopDepth,
      clearedToDepth: clearedToDepth,
      computeSchedule: computeSchedule,
      saturation: saturation,
      simulateRepetitive: simulateRepetitive
    }
  };
});
