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
  check("出水仍有上限的安全警告出现", await page.locator("#dWarning").isVisible());
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
  await segInput(page, 2, ".seg-dur").fill("1"); // 30m 用 1 分钟升完 = 30 m/min
  await page.waitForSelector("#dError:not([hidden])");
  const errText2 = await page.locator("#dError").textContent();
  check("上升过快被拒绝并提示速率", /上升速率 30\.0 m\/min/.test(errText2), errText2);
  check("错误定位到第 3 段", /第3段/.test(errText2), errText2);

  // --- 非法剖面 3：超出模型范围 ---
  await page.locator("#dReset").click();
  await segInput(page, 0, ".seg-depth").fill("150");
  await page.waitForSelector("#dError:not([hidden])");
  const errText3 = await page.locator("#dError").textContent();
  check("超深被拒绝并提示范围", /超出模型范围/.test(errText3), errText3);

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
  await segInput(page, 1, ".seg-depth").fill("35");
  await page.waitForFunction(t => document.getElementById("dTts").textContent !== t, tts0);
  check("修改分段深度后 TTS 即时变化", (await page.locator("#dTts").textContent()) !== tts0);
  await segInput(page, 1, ".seg-depth").fill("30");

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
  await mob.close();

  await browser.close();
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
