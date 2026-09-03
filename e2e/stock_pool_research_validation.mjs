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
const stockPoolRequests = [];
page.on("pageerror", error => pageErrors.push(error.stack || error.message));
page.on("request", request => {
  if (request.url().includes("/stock_pool_research/")) stockPoolRequests.push(request.url());
});

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

  const initialRedundancyFiles = [...new Set(stockPoolRequests
    .filter(value => value.includes("/stock_pool_research/redundancy/"))
    .map(value => value.split("/").at(-1).split("?")[0]))];
  if (initialRedundancyFiles.length !== 1 || initialRedundancyFiles[0] !== "HS300.parquet") {
    throw new Error(`初始视图应只懒加载沪深300冗余分片，实际：${initialRedundancyFiles}`);
  }
  if (stockPoolRequests.some(value => /\/stock_pool_research\/redundancy\.parquet(?:\?|$)/.test(value))) {
    throw new Error("初始视图仍在下载全量冗余表");
  }

  const hs300Rows = await page.locator("#pool-factor-table-body tr").count();
  if (hs300Rows !== 146) throw new Error(`沪深300因子结果应完整列示 146 个，实际：${hs300Rows}`);
  const controls = await page.locator("#pool-as-of, #pool-window, #pool-cost-bps, #pool-train-window, #pool-forward-horizon").count();
  if (controls !== 5) throw new Error(`时间、成本和样本外控件不完整：${controls}`);
  const candidateCells = await page.locator(".pool-candidate-score").count();
  if (candidateCells !== 146) throw new Error(`候选分列未完整渲染：${candidateCells}`);
  const defaultAsOf = await page.locator("#pool-as-of").inputValue();
  const asOfOptions = await page.locator("#pool-as-of option").allTextContents();
  if (defaultAsOf !== "2026-07-01" || asOfOptions.includes("2026-07-31")) {
    throw new Error(`收益截止日混入冗余截面：default=${defaultAsOf}, options=${asOfOptions}`);
  }
  const defaultScope = await page.locator("#pool-scope-note").innerText();
  if (!defaultScope.includes("收益截止 2026-07-01") || !defaultScope.includes("冗余截面 2026-05-29")) {
    throw new Error(`收益截止与冗余截面未分开说明：${defaultScope}`);
  }
  const defaultUniqueness = await page.locator("#pool-factor-table-body tr td:nth-child(13)").allTextContents();
  const defaultUniquenessCount = defaultUniqueness.filter(value => !value.trim().startsWith("—")).length;
  if (defaultUniquenessCount !== 137) {
    throw new Error(`沪深300默认独特性应有 137 行可计算，实际：${defaultUniquenessCount}`);
  }

  await page.locator("#pool-as-of").selectOption("2025-01-02");
  const historicalScope = await page.locator("#pool-scope-note").innerText();
  const historicalUniqueness = await page.locator("#pool-factor-table-body tr td:nth-child(13)").allTextContents();
  const historicalUniquenessCount = historicalUniqueness.filter(value => !value.trim().startsWith("—")).length;
  if (!historicalScope.includes("冗余截面") || historicalScope.includes("无可用数据") || historicalUniquenessCount < 100) {
    throw new Error(`历史收益截止缺少冗余快照：scope=${historicalScope}, uniqueness=${historicalUniquenessCount}`);
  }
  await page.locator("#pool-as-of").selectOption("2026-07-01");

  await page.locator("#pool-window").selectOption("12");
  await page.waitForTimeout(300);
  const window12Months = await page.locator("#pool-factor-table-body tr td:nth-child(6)").evaluateAll(nodes => nodes.map(node => Number(node.textContent) || 0));
  const full12Count = window12Months.filter(value => value === 12).length;
  if (Math.max(...window12Months) !== 12 || full12Count !== 136) throw new Error(`12 月窗口未取满最近有效信号月：max=${Math.max(...window12Months)}, full=${full12Count}`);
  await page.locator("#pool-window").selectOption("36");
  await page.waitForTimeout(300);
  const window36Months = await page.locator("#pool-factor-table-body tr td:nth-child(6)").evaluateAll(nodes => nodes.map(node => Number(node.textContent) || 0));
  const full36Count = window36Months.filter(value => value === 36).length;
  if (Math.max(...window36Months) !== 36 || full36Count !== 131) throw new Error(`36 月窗口未取满最近有效信号月：max=${Math.max(...window36Months)}, full=${full36Count}`);
  await page.locator("#pool-window").selectOption("full");

  await page.locator("#pool-cost-bps").selectOption("0");
  const grossNetValues = await page.locator("#pool-factor-table-body tr td:nth-child(9)").allTextContents();
  await page.locator("#pool-cost-bps").selectOption("50");
  const highCostValues = await page.locator("#pool-factor-table-body tr td:nth-child(9)").allTextContents();
  if (grossNetValues.join("|") === highCostValues.join("|")) throw new Error("交易成本情景未改变成本后收益");
  await page.locator("#pool-cost-bps").selectOption("10");

  await page.locator("#pool-selector").selectOption("CSI2000");
  await waitForResults();
  const csi2000Scope = await page.locator("#pool-scope-note").innerText();
  if (!csi2000Scope.includes("中证2000") || !csi2000Scope.includes("2023-08-31") || !csi2000Scope.includes("收益截止")) {
    throw new Error(`中证2000独立历史范围异常：${csi2000Scope}`);
  }

  await page.locator("#pool-type-sw1").click();
  await page.locator("#pool-selector").selectOption("SW1_801780");
  await waitForResults();
  await page.locator("#pool-status-filter").selectOption("no_data");
  const noDataRows = await page.locator("#pool-factor-table-body tr").count();
  const noDataStatuses = await page.locator("#pool-factor-table-body .pool-status").allTextContents();
  if (!noDataRows || noDataStatuses.some(status => status !== "无有效样本")) {
    throw new Error(`银行无有效样本筛选异常：rows=${noDataRows}, statuses=${noDataStatuses}`);
  }

  await page.locator("#pool-selector").selectOption("SW1_801080");
  await waitForResults();
  const resetStatus = await page.locator("#pool-status-filter").inputValue();
  const resetRows = await page.locator("#pool-factor-table-body tr").count();
  if (resetStatus !== "all" || resetRows !== 146) {
    throw new Error(`切换股票池后有效性筛选未复位：status=${resetStatus}, rows=${resetRows}`);
  }
  const industryScope = await page.locator("#pool-scope-note").innerText();
  if (!industryScope.includes("电子") || !industryScope.includes("严格") && !industryScope.includes("只使用截止日以前已实现的收益") || !industryScope.includes("各股票池不强行统一起点")) {
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
  if (!detailText.includes("能否用于未来候选") || !detailText.includes("12/36/60 月滚动均值") || !detailText.includes("样本外证据")) {
    throw new Error("因子下钻详情内容不完整");
  }

  await page.locator("#pool-detail-close").click();
  await page.locator("#pool-type-index").click();
  await page.locator("#pool-selector").selectOption("HS300");
  await page.locator("#pool-status-filter").selectOption("all");
  await page.waitForFunction(() => {
    const scope = document.querySelector("#pool-scope-note")?.textContent || "";
    const count = document.querySelectorAll("#pool-factor-table-body tr").length;
    return scope.includes("沪深300") && count === 146;
  }, null, { timeout: 120000 });
  await page.locator("#pool-select-top").click();
  const selectedCandidates = await page.locator(".pool-row-check:checked").count();
  if (selectedCandidates !== 10) throw new Error(`沪深300前瞻候选应选中 10 个，实际：${selectedCandidates}`);
  const selectedClusters = await page.locator(".pool-row-check:checked").evaluateAll(nodes => nodes.map(node => node.dataset.cluster));
  if (selectedClusters.some(cluster => !cluster) || new Set(selectedClusters).size !== selectedClusters.length) {
    throw new Error(`沪深300前 10 候选未按相关簇去重：${selectedClusters}`);
  }
  await page.locator("#pool-send-compose").click();
  await page.waitForSelector("#compose-view", { state: "visible", timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#cps-controls .cps-frow").length === 10,
    null,
    { timeout: 120000 },
  );
  const composeFactors = await page.locator("#cps-controls .cps-frow").count();
  if (composeFactors !== 10) throw new Error(`股票池候选未完整带入多因子合成：${composeFactors}`);
  const composeHandoff = {
    universeMode: await page.locator("#cps-universe-mode").inputValue(),
    indexAlias: await page.locator("#cps-universe-index").inputValue(),
    costBps: await page.locator("#cps-cost-bps").inputValue(),
  };
  if (composeHandoff.universeMode !== "index_only" || composeHandoff.indexAlias !== "HS300" || composeHandoff.costBps !== "10") {
    throw new Error(`沪深300研究上下文未完整带入合成：${JSON.stringify(composeHandoff)}`);
  }
  await page.locator('.mode-btn[data-mode="stock-pool"]').click();
  await waitForResults();

  await page.locator("#pool-type-sw1").click();
  await page.locator("#pool-selector").selectOption("SW1_801080");
  await waitForResults();
  await page.locator("#pool-factor-table-body .pool-row-check").first().check();
  const industryMembershipRequest = page.waitForRequest(
    request => request.url().includes("/stock_pool_research/membership/SW1_801080.parquet"),
    { timeout: 120000 },
  );
  await page.locator("#pool-send-compose").click();
  await page.waitForSelector("#compose-view", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => {
    const mode = document.querySelector("#cps-universe-mode")?.value;
    const text = document.querySelector("#cps-universe-mode option:checked")?.textContent || "";
    return mode === "stock_pool" && text.includes("电子");
  }, null, { timeout: 120000 });
  await industryMembershipRequest;
  await page.waitForFunction(() => document.querySelectorAll("#cps-ledger-month option").length > 100, null, { timeout: 300000 });
  await page.locator('.mode-btn[data-mode="stock-pool"]').click();
  await waitForResults();

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
  console.log(`✅ 股票池研究浏览器验收通过 · 沪深300 ${hs300Rows} 个因子 · 银行无有效样本 ${noDataRows} 个 · 电子行业稳健有效 ${robustRows} 个`);
} finally {
  await browser.close();
}
