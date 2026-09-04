import { chromium } from "playwright-core";

const url = process.argv[2] || process.env.ONLINE_E2E_URL || "http://127.0.0.1:8798/";
const options = { headless: process.env.PLAYWRIGHT_HEADLESS !== "0" };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
} else {
  options.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome";
}

const stableCodes = [
  "000001.SZ", "000002.SZ", "000006.SZ", "000007.SZ", "000008.SZ",
  "000009.SZ", "000011.SZ", "000012.SZ", "000014.SZ", "000019.SZ",
  "000020.SZ", "000021.SZ", "000025.SZ", "000026.SZ", "000027.SZ",
  "000028.SZ", "000029.SZ", "000030.SZ", "000031.SZ", "000032.SZ",
  "000034.SZ", "000035.SZ", "000036.SZ", "000037.SZ", "000039.SZ",
  "000042.SZ", "000045.SZ", "000048.SZ", "000049.SZ", "000050.SZ",
  "000058.SZ", "000059.SZ", "000060.SZ", "000061.SZ", "000062.SZ",
  "000063.SZ", "000065.SZ", "000066.SZ", "000068.SZ", "000069.SZ",
  "000070.SZ", "000088.SZ", "000089.SZ", "000090.SZ", "000096.SZ",
];
const months = [];
for (let year = 2023; year <= 2026; year += 1) {
  const lastMonth = year === 2026 ? 5 : 12;
  for (let month = 1; month <= lastMonth; month += 1) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
}
const csv = ["date,code", ...months.flatMap(month => stableCodes.map(code => `${month},${code}`))].join("\n");

const browser = await chromium.launch(options);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
const factorShards = [];
page.on("pageerror", error => pageErrors.push(error.stack || error.message));
page.on("request", request => {
  const match = request.url().match(/\/compose_scores\/([^/?]+\.parquet)/);
  if (match) factorShards.push(match[1]);
});

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('.mode-btn[data-mode="stock-pool"]').click();
  await page.waitForSelector("#stock-pool-view", { state: "visible", timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#pool-factor-table-body tr").length > 100,
    null,
    { timeout: 120000 },
  );
  await page.locator("#pool-type-custom").click();
  await page.waitForSelector("#pool-custom-upload", { state: "visible", timeout: 15000 });
  await page.locator("#pool-custom-name").fill("浏览器验收股票池");
  await page.locator("#pool-custom-file").setInputFiles({
    name: "custom-stock-pool.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.waitForFunction(
    () => (document.querySelector("#pool-custom-status")?.textContent || "").includes("读取"),
    null,
    { timeout: 15000 },
  );
  await page.locator("#pool-custom-factors").selectOption(["MOM20", "ROE"]);
  if (await page.locator("#pool-custom-run").isDisabled()) {
    throw new Error("上传有效名单并选择因子后，运行按钮仍不可用");
  }
  await page.locator("#pool-custom-run").click();
  await page.waitForFunction(
    () => (document.querySelector("#pool-custom-status")?.textContent || "").includes("检验完成"),
    null,
    { timeout: 300000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#pool-factor-table-body tr").length === 2,
    null,
    { timeout: 30000 },
  );

  const scope = await page.locator("#pool-scope-note").innerText();
  const status = await page.locator("#pool-custom-status").innerText();
  const rows = await page.locator("#pool-factor-table-body tr").count();
  const resultCodes = await page.locator("#pool-factor-table-body tr").evaluateAll(nodes => nodes.map(node => node.textContent || ""));
  if (!scope.includes("浏览器验收股票池") || !scope.includes("本次选择的 2 个因子内比较")) {
    throw new Error(`自定义池研究范围说明不完整：${scope}`);
  }
  if (!status.includes(`${months.length} 个月`) || !status.includes(`${months.length * stableCodes.length} 行成分`)) {
    throw new Error(`上传月份或成分行数与输入不一致：${status}`);
  }
  if (rows !== 2 || !resultCodes.some(value => value.includes("MOM20")) || !resultCodes.some(value => value.includes("ROE"))) {
    throw new Error(`所选因子未完整输出：${JSON.stringify(resultCodes)}`);
  }

  const loaded = [...new Set(factorShards)];
  const unexpected = loaded.filter(name => !["LNMV.parquet", "MOM20.parquet", "ROE.parquet"].includes(name));
  if (!loaded.includes("MOM20.parquet") || !loaded.includes("ROE.parquet") || unexpected.length) {
    throw new Error(`自定义池未按所选因子分片加载：${loaded}`);
  }

  await page.locator("#pool-factor-table-body .pool-row-check").first().check();
  await page.locator("#pool-send-compose").click();
  await page.waitForSelector("#compose-view", { state: "visible", timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector("#cps-universe-mode")?.value === "stock_pool",
    null,
    { timeout: 180000 },
  );
  const handoff = {
    mode: await page.locator("#cps-universe-mode").inputValue(),
    label: await page.locator("#cps-universe-mode option:checked").innerText(),
    factors: await page.locator("#cps-controls .cps-frow").count(),
  };
  if (handoff.mode !== "stock_pool" || !handoff.label.includes("浏览器验收股票池") || handoff.factors !== 1) {
    throw new Error(`自定义股票池未正确交接到组合：${JSON.stringify(handoff)}`);
  }

  await page.locator('.mode-btn[data-mode="stock-pool"]').click();
  await page.locator("#pool-type-custom").click();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    uploadWidth: document.querySelector("#pool-custom-upload")?.getBoundingClientRect().width || 0,
    contentWidth: document.querySelector("#content")?.getBoundingClientRect().width || 0,
  }));
  if (mobile.pageWidth > mobile.viewport + 2 || mobile.uploadWidth > mobile.contentWidth + 2) {
    throw new Error(`自定义上传区在移动端横向溢出：${JSON.stringify(mobile)}`);
  }

  if (pageErrors.length) throw new Error(`页面错误：${pageErrors.join("\n")}`);
  console.log(`✅ 自定义股票池闭环验收通过 · ${months.length} 个月 · ${stableCodes.length} 只股票 · ${rows} 个因子`);
} finally {
  await browser.close();
}
