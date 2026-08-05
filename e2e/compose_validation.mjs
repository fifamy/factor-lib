// 回归：多因子合成页面应展示多因子检验，且不请求全量历史大文件。
// 用法：node e2e/compose_validation.mjs [url]
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://127.0.0.1:8798/";

async function launchValidationBrowser() {
  const options = {
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
  };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  } else if (process.env.PLAYWRIGHT_CHROMIUM_CHANNEL) {
    options.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL;
  } else {
    options.channel = "chrome";
  }

  try {
    return await chromium.launch(options);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error([
      `浏览器进程启动失败：${message}`,
      "这通常表示当前终端环境限制了 Playwright 创建或控制 Chromium 子进程；请在非沙箱权限下运行 e2e。",
      "如需指定本机 Chrome，可设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome。",
    ].join("\n"));
  }
}

(async () => {
  const browser = await launchValidationBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const requests = [];
  page.on("pageerror", err => errors.push(err.stack || err.message));
  page.on("request", req => requests.push(req.url()));

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.locator('.mode-btn[data-mode="compose"]').click();
  await page.waitForSelector("#compose-view", { state: "visible", timeout: 15000 });
  await page.locator('.tree-l3[data-code="MOM12_1"]').click();
  await page.locator('.tree-l3[data-code="DASTD"]').click();
  await page.waitForSelector("#combo-validation", { timeout: 60000 });
  await page.waitForFunction(() => {
    const text = document.querySelector("#combo-validation")?.innerText || "";
    return text.includes("多因子检验")
      && text.includes("RankIC")
      && text.includes("10组")
      && text.includes("样本切片")
      && text.includes("IC月数")
      && text.includes("收益月数")
      && text.includes("参数敏感性")
      && text.includes("TopN 敏感性")
      && text.includes("约束敏感性")
      && text.includes("权重扰动敏感性")
      && text.includes("因子贡献")
      && text.includes("剔除实验 / 边际贡献")
      && text.includes("组合内相对低流动性占比")
      && text.includes("相关性 / 拥挤度诊断");
  }, null, { timeout: 120000 });

  await page.locator(".combo-ablation-run").click();
  await page.waitForFunction(() => {
    const text = document.querySelector("#combo-ablation-result")?.innerText || "";
    return text.includes("剔除后IC_IR") && text.includes("剔除后年化");
  }, null, { timeout: 120000 });

  const text = await page.locator("#combo-validation").innerText();
  const forbidden = requests.filter(u => /factor_score_full|factor_score\.parquet|factor_score_neutral\.parquet/.test(u));
  await browser.close();

  if (errors.length) throw new Error(`页面错误：${errors.join("\n")}`);
  if (forbidden.length) throw new Error(`多因子检验请求了全量大文件：${forbidden.join(", ")}`);
  const required = [
    "组合内相关性",
    "与最佳单因子对比",
    "IC月数",
    "收益月数",
    "参数敏感性",
    "TopN 敏感性",
    "约束敏感性",
    "权重扰动敏感性",
    "剔除实验 / 边际贡献",
    "组合内相对低流动性占比",
    "相关性 / 拥挤度诊断",
  ];
  const missing = required.filter(item => !text.includes(item));
  if (missing.length) {
    throw new Error(`多因子检验缺少模块或表头：${missing.join(", ")}`);
  }
  if (!text.includes("组合内相关性") || !text.includes("与最佳单因子对比")) {
    throw new Error("多因子检验解释区块不完整");
  }
  console.log("✅ 多因子检验页面烟测通过");
})().catch(err => {
  console.log(`❌ 多因子检验页面烟测失败：${err.message}`);
  process.exit(1);
});
