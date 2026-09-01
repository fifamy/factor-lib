// 五指数股票池约束浏览器验收。用法：node e2e/index_universe_validation.mjs [url]
import { chromium } from "playwright-core";

const url = process.argv[2] || process.env.ONLINE_E2E_URL || "http://127.0.0.1:8798/";

async function launchBrowser() {
  const options = { headless: process.env.PLAYWRIGHT_HEADLESS !== "0" };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  } else {
    options.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome";
  }
  return chromium.launch(options);
}

async function waitForUniverse(page, label) {
  try {
    await page.waitForFunction(expected => {
      const title = document.querySelector("#cps-nav-title")?.textContent || "";
      const note = document.querySelector("#cps-stocks .holding-count-note")?.textContent || "";
      return title.includes(expected) && note.includes("约束已满足");
    }, label, { timeout: 180000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      title: document.querySelector("#cps-nav-title")?.textContent || "",
      stocks: document.querySelector("#cps-stocks")?.textContent?.slice(0, 1200) || "",
      controls: document.querySelector("#cps-controls")?.textContent?.slice(0, 600) || "",
    }));
    throw new Error(`${error.message}\n页面诊断：${JSON.stringify(diagnostics)}`);
  }
}

async function holdingMemberStats(page) {
  return page.evaluate(() => {
    const yes = document.querySelectorAll("#cps-stocks td.index-member-yes").length;
    const no = document.querySelectorAll("#cps-stocks td.index-member-no").length;
    return { yes, no, total: yes + no, share: yes + no ? yes / (yes + no) : null };
  });
}

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
// 股票池验收只检查关键持仓和主回测；取消1.2秒后启动的完整参数敏感性后台任务，
// 避免它占用单一DuckDB连接并把后续股票池切换排队数分钟。
await page.addInitScript(() => {
  const originalSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) === 1200) return 0;
    return originalSetTimeout(callback, delay, ...args);
  };
});
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.stack || error.message));

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('.mode-btn[data-mode="compose"]').click();
  await page.waitForSelector("#compose-view", { state: "visible", timeout: 15000 });
  await page.locator("#cps-universe-mode").selectOption("min_share");
  await page.locator("#cps-universe-index").selectOption("CSI1000");
  await page.locator("#cps-universe-share").selectOption("0.8");
  await page.locator('.tree-l3[data-code="MOM12_1"]').click();
  await waitForUniverse(page, "至少80%来自中证1000");
  const minimumShare = await holdingMemberStats(page);
  if (!minimumShare.total || minimumShare.share < 0.8) {
    throw new Error(`最低80%成分占比约束异常：${JSON.stringify(minimumShare)}`);
  }

  await page.locator("#cps-universe-mode").selectOption("index_only");
  await page.locator("#cps-universe-index").selectOption("CSIA500");
  await waitForUniverse(page, "仅中证A500成分");
  await page.waitForFunction(() => {
    const yes = document.querySelectorAll("#cps-stocks td.index-member-yes").length;
    const no = document.querySelectorAll("#cps-stocks td.index-member-no").length;
    const note = document.querySelector("#cps-stocks .holding-count-note")?.textContent || "";
    return yes > 0 && no === 0 && note.includes("中证A500成分");
  }, null, { timeout: 180000 });
  const a500 = await holdingMemberStats(page);
  if (!a500.total || a500.no !== 0) {
    throw new Error(`仅中证A500成分约束异常：${JSON.stringify(a500)}`);
  }

  const benchmarkLegend = await page.locator("#cps-nav-chart").innerText().catch(() => "");
  if (process.env.INDEX_UNIVERSE_SCREENSHOT) {
    await page.screenshot({ path: process.env.INDEX_UNIVERSE_SCREENSHOT, fullPage: true });
  }
  if (pageErrors.length) throw new Error(`页面错误：${pageErrors.join("\n")}`);
  console.log(`✅ 五指数股票池浏览器验收通过 · 中证1000最低占比=${(minimumShare.share * 100).toFixed(0)}% · 中证A500=${a500.total}只${benchmarkLegend.includes("中证A500") ? " · A500基准已显示" : ""}`);
} finally {
  await browser.close();
}
