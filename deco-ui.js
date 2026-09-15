/* deco-ui.js — 复核台界面与 deco.js 引擎的接线（全部 DOM 逻辑在此，计算一律走 Deco.reviewProfile） */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var panel = $("deco");
  if (!panel || !window.Deco) return;

  var segList = $("dSegList");
  var TYPE_NAMES = { descent: "下潜", bottom: "停留", ascent: "上升" };
  var HT = Deco.ZHL16C.halfTimes;
  var DEFAULT_SEGMENTS = [
    { type: "descent", depth: 30, duration: 3 },
    { type: "bottom", depth: 30, duration: 17 },
    { type: "ascent", depth: 10, duration: 2 }
  ];
  var DEFAULT_ENV = { altitude: 0, waterTemp: 20, salinity: "salt", workload: "moderate", gfLow: 30, gfHigh: 85 };
  var segments = cloneSegments(DEFAULT_SEGMENTS);

  function cloneSegments(list) {
    return list.map(function (s) { return { type: s.type, depth: s.depth, duration: s.duration }; });
  }

  // ---------- 分段行 ----------
  function renderSegments() {
    segList.innerHTML = "";
    segments.forEach(function (seg, i) {
      var row = document.createElement("div");
      row.className = "deco-seg";
      row.dataset.idx = i;
      var options = Object.keys(TYPE_NAMES).map(function (t) {
        return '<option value="' + t + '"' + (seg.type === t ? " selected" : "") + ">" + TYPE_NAMES[t] + "</option>";
      }).join("");
      row.innerHTML =
        '<span class="deco-seg-no">' + (i + 1) + "</span>" +
        '<label class="seg-cell"><span>类型</span><select class="seg-type">' + options + "</select></label>" +
        '<label class="seg-cell"><span>目标深度 m</span>' +
          '<input class="seg-depth" type="number" inputmode="decimal" step="0.5" min="0" max="120" value="' + seg.depth + '"></label>' +
        '<label class="seg-cell"><span>时长 min</span>' +
          '<input class="seg-dur" type="number" inputmode="decimal" step="0.5" value="' + seg.duration + '"></label>' +
        '<button type="button" class="seg-del secondary" title="删除本段" aria-label="删除第' + (i + 1) + '段">×</button>';
      segList.appendChild(row);
    });
  }

  function readSegments() {
    return Array.prototype.map.call(segList.querySelectorAll(".deco-seg"), function (row) {
      return {
        type: row.querySelector(".seg-type").value,
        depth: parseFloat(row.querySelector(".seg-depth").value),
        duration: parseFloat(row.querySelector(".seg-dur").value)
      };
    });
  }

  // ---------- 输入收集 ----------
  function readInputs() {
    var repetitive = null;
    if ($("dRepEnabled").checked) {
      repetitive = {
        depth: parseFloat($("dRepDepth").value),
        bottomTime: parseFloat($("dRepBottom").value),
        surfaceInterval: parseFloat($("dRepInterval").value)
      };
    }
    return {
      segments: readSegments(),
      env: {
        altitude: parseFloat($("dAltitude").value),
        waterTemp: parseFloat($("dTemp").value),
        salinity: $("dSalinity").value,
        workload: $("dWorkload").value
      },
      gf: {
        low: parseFloat($("dGfLow").value) / 100,
        high: parseFloat($("dGfHigh").value) / 100
      },
      repetitive: repetitive
    };
  }

  // ---------- 结果渲染 ----------
  function fmtTime(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return h + "小时" + m + "分";
    if (m) return m + "分" + (s ? s + "秒" : "");
    return s + "秒";
  }

  function renderError(error) {
    $("dOk").hidden = true;
    $("dWarning").hidden = true;
    var errBox = $("dError");
    errBox.hidden = false;
    errBox.textContent = "⚠ 复核拒绝：" + error.message;
    if (error.segmentIndex != null) {
      var row = segList.querySelector('.deco-seg[data-idx="' + error.segmentIndex + '"]');
      if (row) row.classList.add("seg-error");
    }
  }

  function renderResult(r) {
    $("dError").hidden = true;
    $("dOk").hidden = false;

    // 安全报警：途中越限（逐秒检出，回潜也不掩盖）+ 结束状态越限
    var warns = [];
    if (r.profileViolation) {
      var pv = r.profileViolation;
      warns.push("第" + (pv.segmentIndex + 1) + "段（" + TYPE_NAMES[pv.segmentType] + "）：剖面在 " +
        pv.depth.toFixed(1) + " m 处突破减压上限 " + pv.ceiling.toFixed(1) + " m（入水第 " +
        pv.timeSec + " 秒，累计越限 " + pv.violatedSec + " 秒）——途中越限即使随后回潜也不安全。");
      var vRow = segList.querySelector('.deco-seg[data-idx="' + pv.segmentIndex + '"]');
      if (vRow) vRow.classList.add("seg-error");
    }
    if (r.ceilingViolation) {
      if (r.endDepth <= 0.01) {
        warns.push("按当前剖面出水时减压上限为 " + r.ceilingAtEnd.toFixed(1) +
          " m，超出梯度因子允许范围，直接出水不安全。");
      } else {
        warns.push("剖面结束于 " + r.endDepth.toFixed(1) + " m，浅于当前减压上限 " +
          r.ceilingAtEnd.toFixed(1) + " m——该位置已突破减压上限，剖面不安全。");
      }
    }
    var warnBox = $("dWarning");
    warnBox.hidden = warns.length === 0;
    warnBox.classList.toggle("severe", warns.length > 0);
    warnBox.innerHTML = warns.map(function (w) { return "<div>⚠ " + w + "</div>"; }).join("");

    // 概览卡片
    $("dTts").textContent = r.ttsSec > 0 ? fmtTime(r.ttsSec) : "已在安全范围";
    $("dFirstStop").textContent = r.firstStopDepth > 0 ? r.firstStopDepth + " m" : "无需停留";
    $("dCeiling").textContent = r.ceilingAtEnd.toFixed(1) + " m";
    $("dControl").textContent = "舱室 " + (r.controlling + 1) + "（半时 " + HT[r.controlling] + " 分）";
    $("dEnvInfo").textContent =
      "剖面结束于 " + (r.endDepth <= 0.01 ? "水面" : r.endDepth.toFixed(1) + " m") +
      " · 最大深度 " + r.maxDepth.toFixed(1) + " m · TTS 自剖面结束状态起算 · 减压上升 9 m/min · 水面气压 " +
      r.env.pSurf.toFixed(3) + " bar（" + (r.env.salinity === "fresh" ? "淡水" : "海水") +
      "）· 剖面总时长 " + r.totalDiveMin + " min";

    // 减压停留
    var stopsEl = $("dStops");
    if (!r.stops.length) {
      if (r.endDepth <= 0.01 && r.ceilingAtEnd > 0.05) {
        stopsEl.innerHTML = '<div class="muted">已在水面：出水时减压义务未清除（见上方警告），模型无法在水面继续安排停留。</div>';
      } else if (r.endDepth <= 0.01) {
        stopsEl.innerHTML = '<div class="muted">无需减压停留：剖面已安全回到水面。</div>';
      } else {
        stopsEl.innerHTML = '<div class="muted">无需减压停留：可按 ≤9 m/min 直接升至水面。</div>';
      }
    } else {
      stopsEl.innerHTML = r.stops.map(function (s) {
        return '<div class="stop-row"><b>' + s.depth + " m</b><span>" + fmtTime(s.seconds) + "</span></div>";
      }).join("") +
      '<div class="stop-row total"><b>出水</b><span>累计 ' + fmtTime(r.ttsSec) + "</span></div>";
    }

    // 组织饱和度条形图（16 舱室）
    $("dTissues").innerHTML = r.saturationEnd.map(function (end, i) {
      var peak = r.saturationPeak[i];
      var cls = end > 1 ? "over" : end > 0.85 ? "hot" : "";
      return '<div class="tissue-row ' + cls + '">' +
        '<span class="tissue-label">舱室' + (i + 1) + " · " + HT[i] + "分</span>" +
        '<div class="tissue-bars">' +
          '<div class="bar-peak" style="width:' + Math.min(100, peak * 100).toFixed(1) + '%"></div>' +
          '<div class="bar-end" style="width:' + Math.min(100, end * 100).toFixed(1) + '%"></div>' +
        "</div>" +
        '<span class="tissue-pct">' + Math.round(end * 100) + "%</span></div>";
    }).join("");

    // 重复潜水残留氮说明
    $("dResidual").textContent = r.residual
      ? "已计入上一潜残留氮（" + r.residual.repetitive.depth + " m / " + r.residual.repetitive.bottomTime +
        " min，水面间隔 " + r.residual.repetitive.surfaceInterval +
        " min）：本潜初始组织负荷最高 " + Math.round(r.residual.maxSaturation * 100) + "%（相对水面 M 值）。"
      : "";
  }

  // ---------- 即时重算 ----------
  var scheduled = false;
  function recalc() {
    scheduled = false;
    segList.querySelectorAll(".deco-seg").forEach(function (row) { row.classList.remove("seg-error"); });
    var r = Deco.reviewProfile(readInputs());
    if (!r.ok) renderError(r.error);
    else renderResult(r);
  }
  function scheduleRecalc() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(recalc);
  }

  // ---------- 事件 ----------
  panel.addEventListener("input", scheduleRecalc);
  panel.addEventListener("change", scheduleRecalc);

  $("dAddSeg").addEventListener("click", function () {
    segments = readSegments();
    if (segments.length >= Deco.LIMITS.maxSegments) return;
    // 新段类型与末段深度保持方向一致：在水面则下潜，在深度则上升至水面
    var lastDepth = segments.length ? segments[segments.length - 1].depth : 0;
    if (!isFinite(lastDepth) || lastDepth <= 0) {
      segments.push({ type: "descent", depth: 18, duration: 2 });
    } else {
      segments.push({ type: "ascent", depth: 0, duration: 5 });
    }
    renderSegments();
    recalc();
  });

  segList.addEventListener("click", function (event) {
    var btn = event.target.closest(".seg-del");
    if (!btn) return;
    segments = readSegments();
    segments.splice(Number(btn.closest(".deco-seg").dataset.idx), 1);
    if (!segments.length) segments.push({ type: "descent", depth: 18, duration: 2 });
    renderSegments();
    recalc();
  });

  $("dReset").addEventListener("click", function () {
    segments = cloneSegments(DEFAULT_SEGMENTS);
    $("dAltitude").value = DEFAULT_ENV.altitude;
    $("dTemp").value = DEFAULT_ENV.waterTemp;
    $("dSalinity").value = DEFAULT_ENV.salinity;
    $("dWorkload").value = DEFAULT_ENV.workload;
    $("dGfLow").value = DEFAULT_ENV.gfLow;
    $("dGfHigh").value = DEFAULT_ENV.gfHigh;
    $("dRepEnabled").checked = false;
    $("dRepFields").hidden = true;
    renderSegments();
    recalc();
  });

  $("dRepEnabled").addEventListener("change", function () {
    $("dRepFields").hidden = !this.checked;
  });

  // ---------- 初始化 ----------
  renderSegments();
  recalc();
})();
