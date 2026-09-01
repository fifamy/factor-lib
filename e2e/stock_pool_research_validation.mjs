import { chromium } from "playwright-core";

const url = process.argv[2] || process.env.ONLINE_E2E_URL || "http://127.0.0.1:8798/";
const options = { headless: process.env.PLAYWRIGHT_HEADLESS !== "0" };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
} else {
  options.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome";
}

const browser = await chromium.launch(options);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.stack || error.message));

async function waitForResults() {
  await page.waitForFunction(() => {
    const count = document.querySelectorAll("#pool-factor-table-body tr").length;
    const loading = document.querySelector("#pool-factor-table-body")?.textContent || "";
    return count > 100 && !loading.includes("加载中");
  }, null, { timeout: 120000 });
}

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('.mode-btn[data-mode="stock-pool"]').click();
  await page.waitForSelector("#stock-pool-view", { state: "visible", timeout: 15000 });
  await waitForResults();

  const hs300Rows = await page.locator("#pool-factor-table-body tr").count();
  if (hs300Rows < 140) throw new Error(`沪深300因子结果不足：${hs300Rows}`);

  await page.locator("#pool-selector").selectOption("CSI2000");
  await waitForResults();
  const csi2000Scope = await page.locator("#pool-scope-note").innerText();
  if (!csi2000Scope.includes("中证2000") || !csi2000Scope.includes("2023-08-31")) {
    throw new Error(`中证2000独立历史范围异常：${csi2000Scope}`);
  }

  await page.locator("#pool-type-sw1").click();
  await page.locator("#pool-selector").selectOption("SW1_801080");
  await waitForResults();
  const industryScope = await page.locator("#pool-scope-note").innerText();
  if (!industryScope.includes("电子") || !industryScope.includes("139 个成分时点") || !industryScope.includes("股票池等权收益")) {
    throw new Error(`申万一级行业口径提示异常：${industryScope}`);
  }

  await page.locator("#pool-status-filter").selectOption("robust");
  const robustRows = await page.locator("#pool-factor-table-body tr").count();
  if (!robustRows || robustRows >= hs300Rows) throw new Error(`稳健有效筛选异常：${robustRows}`);
  const statuses = await page.locator("#pool-factor-table-body .pool-status").allTextContents();
  if (statuses.some(status => status !== "稳健有效")) throw new Error(`有效性筛选混入其他状态：${statuses}`);

  await page.locator("#pool-factor-table-body .pool-factor-open").first().click();
  await page.waitForSelector("#pool-factor-detail:not([hidden])", { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll("#pool-monthly-chart canvas").length > 0, null, { timeout: 120000 });
  const detailText = await page.locator("#pool-factor-detail").innerText();
  if (!detailText.includes("Alpha 贡献拆分") || !detailText.includes("月度 RankIC")) {
    throw new Error("因子下钻详情内容不完整");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    toolbarWidth: document.querySelector(".pool-toolbar")?.getBoundingClientRect().width || 0,
    contentWidth: document.querySelector("#content")?.getBoundingClientRect().width || 0,
  }));
  if (mobileLayout.pageWidth > mobileLayout.viewport + 2 || mobileLayout.toolbarWidth > mobileLayout.contentWidth + 2) {
    throw new Error(`移动端出现页面级横向溢出：${JSON.stringify(mobileLayout)}`);
  }

  if (process.env.STOCK_POOL_SCREENSHOT) {
    await page.screenshot({ path: process.env.STOCK_POOL_SCREENSHOT, fullPage: true });
  }
  if (pageErrors.length) throw new Error(`页面错误：${pageErrors.join("\n")}`);
  console.log(`✅ 股票池研究浏览器验收通过 · 沪深300 ${hs300Rows} 个因子 · 电子行业稳健有效 ${robustRows} 个`);
} finally {
  await browser.close();
}
