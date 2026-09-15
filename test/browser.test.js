/* 真实浏览器核验：非法剖面拒绝、重复潜水、参数即时重算、移动端可用性
 * 运行：node test/browser.test.js
 */
"use strict";

const { chromium } = require("playwright");
const path = require("path");

const PAGE_URL = "file://" + path.resolve(__dirname, "..", "index.html");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name + (extra ? " — " + extra : "")); }
}

function segInput(page, rowIdx, field) {
  return page.locator(`.deco-seg[data-idx="${rowIdx}"] ${field}`);
}

async function setSeg(page, idx, { type, depth, dur }) {
  if (type) await segInput(page, idx, ".seg-type").selectOption(type);
  if (depth != null) await segInput(page, idx, ".seg-depth").fill(String(depth));
  if (dur != null) await segInput(page, idx, ".seg-dur").fill(String(dur));
}

async function addSeg(page, seg) {
  await page.locator("#dAddSeg").click();
  const idx = (await page.locator(".deco-seg").count()) - 1;
  await setSeg(page, idx, seg);
}

(async () => {
  const browser = await chromium.launch();

  // ---------- 桌面端 ----------
  console.log("桌面端（1280px）");
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(PAGE_URL);
  await page.waitForSelector("#deco .deco-seg");

  check("页面无 JS 异常", errors.length === 0, errors.join("; "));
  check("默认示例自动出结果", await page.locator("#dOk").isVisible());
  const tts0 = await page.locator("#dTts").textContent();
  check("TTS 已计算", /\d/.test(tts0), tts0);
  const stops0 = await page.locator("#dStops").textContent();
  check("减压停留已列出（含 3m 停留）", /3 m/.test(stops0), stops0);
  check("默认示例结束于 10m，无出水警告", await page.locator("#dWarning").isHidden());
  check("信息行标明自剖面结束状态起算", /剖面结束于 10\.0 m/.test(await page.locator("#dEnvInfo").textContent()));
  check("16 舱室饱和度条形图渲染", (await page.locator(".tissue-row").count()) === 16);

  // --- 非法剖面 1：时间倒序 ---
  await segInput(page, 1, ".seg-dur").fill("-5");
  await page.waitForSelector("#dError:not([hidden])");
  const errText1 = await page.locator("#dError").textContent();
  check("时间倒序被拒绝并提示", /时间不能倒退/.test(errText1), errText1);
  check("错误定位到第 2 段", /第2段/.test(errText1), errText1);
  check("出错分段行高亮", await page.locator('.deco-seg[data-idx="1"].seg-error').count() === 1);
  check("拒绝时结果区隐藏", await page.locator("#dOk").isHidden());

  // --- 非法剖面 2：上升过快 ---
  await page.locator("#dReset").click();
  await page.waitForSelector("#dOk:not([hidden])");
  await segInput(page, 2, ".seg-dur").fill("1"); // 30→10m 用 1 分钟 = 20 m/min
  await page.waitForSelector("#dError:not([hidden])");
  const errText2 = await page.locator("#dError").textContent();
  check("上升过快被拒绝并提示速率", /上升速率 20\.0 m\/min/.test(errText2), errText2);
  check("错误定位到第 3 段", /第3段/.test(errText2), errText2);

  // --- 非法剖面 3：超出模型范围 ---
  await page.locator("#dReset").click();
  await segInput(page, 0, ".seg-depth").fill("150");
  await page.waitForSelector("#dError:not([hidden])");
  const errText3 = await page.locator("#dError").textContent();
  check("超深被拒绝并提示范围", /超出模型范围/.test(errText3), errText3);

  // --- 非法剖面 4：分段类型与深度方向不符 ---
  await page.locator("#dReset").click();
  await page.waitForSelector("#dOk:not([hidden])");
  await segInput(page, 0, ".seg-type").selectOption("ascent"); // 0→30m 标成上升
  await page.waitForSelector("#dError:not([hidden])");
  const errText4 = await page.locator("#dError").textContent();
  check("类型与深度方向不符被拒绝", /必须浅于当前深度/.test(errText4), errText4);
  check("类型错配定位到第 1 段并高亮", await page.locator('.deco-seg[data-idx="0"].seg-error').count() === 1);

  // --- 直接出水违反减压上限的警告 ---
  await page.locator("#dReset").click();
  await page.waitForSelector("#dOk:not([hidden])");
  await segInput(page, 2, ".seg-depth").fill("0"); // 30→0m 两分钟升完，出水仍有上限
  await page.waitForSelector("#dWarning:not([hidden])");
  check("直接出水触发减压上限警告", /直接出水不安全/.test(await page.locator("#dWarning").textContent()));
  await segInput(page, 2, ".seg-depth").fill("10");
  await page.waitForSelector("#dWarning", { state: "hidden" });
  check("回升到 10m 结束后警告消失", await page.locator("#dWarning").isHidden());

  // --- 结束深度与减压上限的三种关系 ---
  // 浅于上限：30m 停留 25min 后升到 9m 结束（上限 ≈9.15m）
  await page.locator("#dReset").click();
  await page.waitForSelector("#dOk:not([hidden])");
  await segInput(page, 1, ".seg-dur").fill("25");
  await segInput(page, 2, ".seg-depth").fill("9");
  await segInput(page, 2, ".seg-dur").fill("2.5");
  await page.waitForSelector("#dWarning:not([hidden])");
  const warnShallow = await page.locator("#dWarning").textContent();
  check("结束深度浅于上限时明确报警（不限于水面）", /浅于当前减压上限/.test(warnShallow), warnShallow);
  check("报警为严重级别样式", await page.locator("#dWarning.severe").count() === 1);
  check("报警时仍展示剩余减压方案", await page.locator("#dOk").isVisible());
  const stopDepths = await page.locator("#dStops .stop-row b").allTextContents();
  check("剩余停留不比结束深度 9m 更深",
    stopDepths.every(t => !/ m$/.test(t) || parseFloat(t) <= 9), stopDepths.join(","));
  // 恰好等于上限：底部 24min（上限 ≈9.03m，5cm 容差内）
  await segInput(page, 1, ".seg-dur").fill("24");
  await page.waitForFunction(() => document.getElementById("dWarning").hidden);
  check("结束深度恰好等于上限时不报警", await page.locator("#dWarning").isHidden());
  // 深于上限：底部 23min（上限 ≈8.89m < 9m）
  await segInput(page, 1, ".seg-dur").fill("23");
  await page.waitForFunction(() => document.getElementById("dWarning").hidden);
  check("结束深度深于上限时不报警", await page.locator("#dWarning").isHidden());

  // --- 途中越限后回潜：不被合规结束状态掩盖 ---
  await page.locator("#dReset").click();
  await page.waitForSelector("#dOk:not([hidden])");
  await segInput(page, 1, ".seg-dur").fill("25");
  await segInput(page, 2, ".seg-depth").fill("3");
  await segInput(page, 2, ".seg-dur").fill("2.5"); // 急升到 3m：途中突破上限
  await addSeg(page, { type: "descent", depth: 9, dur: 1 });   // 重新下潜
  await addSeg(page, { type: "bottom", depth: 9, dur: 40 });   // 长时间排氮
  await addSeg(page, { type: "ascent", depth: 0, dur: 1 });    // 结束时已合规
  await page.waitForSelector("#dWarning:not([hidden])");
  const warnMid = await page.locator("#dWarning").textContent();
  check("途中越限后回潜仍明确报警", /突破减压上限/.test(warnMid), warnMid);
  check("报警定位到越限分段（第3段 上升）", /第3段（上升）/.test(warnMid), warnMid);
  check("报警含越限深度与上限", /\d+\.\d m 处突破减压上限 \d+\.\d m/.test(warnMid), warnMid);
  check("越限分段行同步高亮", await page.locator('.deco-seg[data-idx="2"].seg-error').count() === 1);
  check("报警时结果区仍展示", await page.locator("#dOk").isVisible());

  // --- 持续越限：越限分段停留全程报警 ---
  await page.locator("#dReset").click();
  await page.waitForSelector("#dOk:not([hidden])");
  await segInput(page, 1, ".seg-dur").fill("25");
  await segInput(page, 2, ".seg-depth").fill("3");
  await segInput(page, 2, ".seg-dur").fill("2.5");
  await addSeg(page, { type: "bottom", depth: 3, dur: 5 }); // 3m 停留 5min，持续越限
  await page.waitForSelector("#dWarning:not([hidden])");
  const warnSustained = await page.locator("#dWarning").textContent();
  check("持续越限报警含累计越限时长", /累计越限 \d+ 秒/.test(warnSustained), warnSustained);
  check("持续越限时结束状态同步报警", /浅于当前减压上限|直接出水不安全/.test(warnSustained), warnSustained);

  // --- 安全剖面不误报：默认示例 + 重复潜水残留 ---
  await page.locator("#dReset").click();
  await page.waitForSelector("#dOk:not([hidden])");
  check("合规剖面无途中越限报警", await page.locator("#dWarning").isHidden());
  await page.locator("#dRepEnabled").check();
  await page.waitForFunction(() => document.getElementById("dResidual").textContent.includes("残留氮"));
  check("重复潜水残留入水不误报途中越限", await page.locator("#dWarning").isHidden());
  await page.locator("#dRepEnabled").uncheck();

  // --- 恢复示例 ---
  await page.locator("#dReset").click();
  await page.waitForSelector("#dOk:not([hidden])");
  check("恢复示例后结果回归", (await page.locator("#dTts").textContent()) === tts0);

  // --- 重复潜水残留氮 ---
  check("未勾选时上一潜参数隐藏", await page.locator("#dRepFields").isHidden());
  await page.locator("#dRepEnabled").check();
  await page.waitForSelector("#dRepFields:not([hidden])");
  check("勾选后上一潜参数展开", await page.locator("#dRepFields").isVisible());
  await page.waitForFunction(() => document.getElementById("dResidual").textContent.includes("残留氮"));
  const ttsRep = await page.locator("#dTts").textContent();
  check("重复潜水后 TTS 变长", ttsRep !== tts0, `原 ${tts0} → 现 ${ttsRep}`);
  const residual = await page.locator("#dResidual").textContent();
  check("残留氮负荷百分比展示", /初始组织负荷最高 \d+%/.test(residual), residual);
  await page.locator("#dRepEnabled").uncheck();

  // --- 参数即时重算（不刷新页面） ---
  await page.locator("#dGfHigh").fill("40");
  await page.waitForFunction(t => document.getElementById("dTts").textContent !== t, tts0);
  const ttsGf = await page.locator("#dTts").textContent();
  check("修改梯度因子高值后 TTS 即时变化", ttsGf !== tts0, `${tts0} → ${ttsGf}`);
  await page.locator("#dGfHigh").fill("85");
  await page.waitForFunction(t => document.getElementById("dTts").textContent === t, tts0);
  await segInput(page, 1, ".seg-dur").fill("22"); // 停留 17→22 min（改深度会触发类型校验，见类型错配场景）
  await page.waitForFunction(t => document.getElementById("dTts").textContent !== t, tts0);
  check("修改停留时长后 TTS 即时变化", (await page.locator("#dTts").textContent()) !== tts0);
  await segInput(page, 1, ".seg-dur").fill("17");

  // --- 分段增删 ---
  const rowsBefore = await page.locator(".deco-seg").count();
  await page.locator("#dAddSeg").click();
  check("添加分段", (await page.locator(".deco-seg").count()) === rowsBefore + 1);
  await page.locator(`.deco-seg[data-idx="${rowsBefore}"] .seg-del`).click();
  check("删除分段", (await page.locator(".deco-seg").count()) === rowsBefore);
  check("增删后结果仍正常", await page.locator("#dOk").isVisible());
  check("全程无 JS 异常", errors.length === 0, errors.join("; "));
  await page.close();

  // ---------- 移动端 ----------
  console.log("移动端（390px）");
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mob.on("pageerror", e => errors.push(String(e)));
  await mob.goto(PAGE_URL);
  await mob.waitForSelector("#deco .deco-seg");
  check("复核台可见", await mob.locator("#deco").isVisible());
  check("无横向滚动条", await mob.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1));
  check("环境参数可录入", await mob.locator("#dAltitude").isVisible() && await mob.locator("#dGfLow").isVisible());
  check("分段输入框可见可点", await mob.locator('.deco-seg[data-idx="0"] .seg-depth').isVisible());
  await mob.locator("#dAddSeg").click();
  check("移动端可添加分段", (await mob.locator(".deco-seg").count()) === 4);
  await mob.locator('.deco-seg[data-idx="3"] .seg-del').click();
  check("移动端可删除分段", (await mob.locator(".deco-seg").count()) === 3);
  // 移动端非法输入同样拒绝
  await mob.locator('.deco-seg[data-idx="1"] .seg-dur').fill("-3");
  await mob.waitForSelector("#dError:not([hidden])");
  check("移动端非法剖面同样拒绝", /时间不能倒退/.test(await mob.locator("#dError").textContent()));
  await mob.locator("#dReset").click();
  await mob.waitForSelector("#dOk:not([hidden])");
  check("移动端结果区完整（饱和度图）", (await mob.locator(".tissue-row").count()) === 16);
  // 移动端同样对"浅于上限"报警
  await mob.locator('.deco-seg[data-idx="1"] .seg-dur').fill("25");
  await mob.locator('.deco-seg[data-idx="2"] .seg-depth').fill("9");
  await mob.locator('.deco-seg[data-idx="2"] .seg-dur').fill("2.5");
  await mob.waitForSelector("#dWarning:not([hidden])");
  check("移动端浅于上限同样报警", /浅于当前减压上限/.test(await mob.locator("#dWarning").textContent()));
  await mob.close();

  await browser.close();
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
