import { chromium } from "playwright-core";

const url = process.argv[2] || "http://127.0.0.1:8798/";
const options = { headless: process.env.PLAYWRIGHT_HEADLESS !== "0" };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
else options.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome";

const browser = await chromium.launch(options);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.stack || error.message));

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('.tree-l3[data-code="MOM12_1"]').click();
  await page.waitForSelector("#single-open-ledger", { timeout: 120000 });
  await page.locator("#single-open-ledger").click();
  await page.waitForSelector("#compose-view", { state: "visible", timeout: 15000 });
  await page.waitForFunction(() => {
    const optionsCount = document.querySelectorAll("#cps-ledger-month option").length;
    const text = document.querySelector("#cps-stocks")?.textContent || "";
    return optionsCount > 100 && text.includes("实际持股") && text.includes("单边换手");
  }, null, { timeout: 300000 });

  const initial = await page.evaluate(() => ({
    factorCount: document.querySelectorAll("#cps-controls .cps-frow").length,
    monthCount: document.querySelectorAll("#cps-ledger-month option").length,
    selectedMonth: document.querySelector("#cps-ledger-month")?.value,
    holdingRows: document.querySelectorAll(".ledger-table tbody tr").length,
    kpiText: document.querySelector("#cps-kpi")?.textContent || "",
    ledgerText: document.querySelector("#cps-stocks")?.textContent || "",
  }));
  if (initial.factorCount !== 1 || initial.monthCount < 100 || initial.holdingRows < 1) {
    throw new Error(`单因子月度账本未完整载入：${JSON.stringify(initial)}`);
  }
  for (const required of ["月均换手", "年化换手"]) {
    if (!initial.kpiText.includes(required)) throw new Error(`KPI缺少${required}`);
  }
  for (const required of ["调入", "调出", "毛收益", "成本后收益", "入场"]) {
    if (!initial.ledgerText.includes(required)) throw new Error(`账本缺少${required}`);
  }

  await page.locator("#cps-ledger-prev").click();
  const previousMonth = await page.locator("#cps-ledger-month").inputValue();
  if (!(previousMonth < initial.selectedMonth)) throw new Error(`上一月导航无效：${initial.selectedMonth} -> ${previousMonth}`);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#cps-ledger-export").click();
  const download = await downloadPromise;
  if (!download.suggestedFilename().endsWith(".csv")) throw new Error("月度持仓导出不是CSV");

  await page.locator("#cps-cost-bps").selectOption("50");
  await page.waitForFunction(() => {
    const title = document.querySelector("#cps-nav-title")?.textContent || "";
    const ledger = document.querySelector("#cps-stocks")?.textContent || "";
    return title.includes("单边50bp") && ledger.includes("单边成本 50 bp");
  }, null, { timeout: 300000 });

  if (process.env.PORTFOLIO_LEDGER_SCREENSHOT) {
    await page.locator("#cps-stocks").screenshot({ path: process.env.PORTFOLIO_LEDGER_SCREENSHOT });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    viewport: innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    ledgerWidth: document.querySelector("#cps-stocks")?.getBoundingClientRect().width || 0,
    contentWidth: document.querySelector("#content")?.getBoundingClientRect().width || 0,
  }));
  if (mobile.pageWidth > mobile.viewport + 2 || mobile.ledgerWidth > mobile.contentWidth + 2) {
    throw new Error(`月度账本移动端页面级溢出：${JSON.stringify(mobile)}`);
  }

  page.once("dialog", dialog => dialog.accept("E2E冻结组合"));
  await page.locator("#cps-save-mine").click();
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("factorlib.compose.myCombos.v1");
    if (!raw) return false;
    const combo = JSON.parse(raw).find(item => item.name === "E2E冻结组合");
    return Boolean(combo?.decisionDate && combo?.dataCutoffDate && combo?.decisionSignalDate && combo?.realizedReturnEndDate && combo?.decisionMetrics);
  }, null, { timeout: 120000 });
  await page.locator("#combo-manager-btn").click();
  await page.locator('.combo-tab[data-tab="mine"]').click();
  const frozenCard = page.locator(".my-combo-card", { hasText: "E2E冻结组合" });
  await frozenCard.waitFor({ state: "visible", timeout: 15000 });
  await frozenCard.locator(".library-detail-toggle").click();
  const frozenText = await frozenCard.innerText();
  for (const required of ["冻结决策", "决策日", "因子数据截面", "最后已完成信号", "收益实现截止", "冻结时年化"]) {
    if (!frozenText.includes(required)) throw new Error(`冻结组合详情缺少${required}`);
  }
  if (process.env.FROZEN_COMBO_SCREENSHOT) {
    await frozenCard.screenshot({ path: process.env.FROZEN_COMBO_SCREENSHOT });
  }
  await frozenCard.getByRole("button", { name: "载入", exact: true }).click();
  await page.waitForFunction(() => {
    const text = document.querySelector("#cps-stocks")?.textContent || "";
    return text.includes("冻结跟踪口径")
      && text.includes("尚无新增已完成月份")
      && text.includes("决策前样本按当前数据与当前引擎复算");
  }, null, { timeout: 300000 });

  // 历史回放回归：把冻结边界回拨一个真实信号月，使现有最后一个完整持有期
  // 成为“新增月”，验证首次追加后重复载入不会用重算值覆盖已保存记录。
  await page.evaluate(({ comboName, replayCutoff }) => {
    const key = "factorlib.compose.myCombos.v1";
    const rows = JSON.parse(localStorage.getItem(key) || "[]");
    const combo = rows.find(item => item.name === comboName);
    if (!combo) throw new Error("未找到冻结组合");
    combo.decisionSignalDate = replayCutoff;
    combo.trackingLedger = [];
    localStorage.setItem(key, JSON.stringify(rows));
  }, { comboName: "E2E冻结组合", replayCutoff: previousMonth });

  const loadFrozenCombo = async () => {
    await page.locator("#combo-manager-btn").click();
    await page.locator('.combo-tab[data-tab="mine"]').click();
    const card = page.locator(".my-combo-card", { hasText: "E2E冻结组合" });
    await card.waitFor({ state: "visible", timeout: 15000 });
    await card.getByRole("button", { name: "载入", exact: true }).click();
    await page.waitForFunction(() => {
      const text = document.querySelector("#cps-stocks")?.textContent || "";
      return text.includes("已追加 1 个决策后月份");
    }, null, { timeout: 300000 });
  };

  await page.reload({ waitUntil: "networkidle", timeout: 90000 });
  await loadFrozenCombo();
  const firstAppend = await page.evaluate(comboName => {
    const rows = JSON.parse(localStorage.getItem("factorlib.compose.myCombos.v1") || "[]");
    const combo = rows.find(item => item.name === comboName);
    return combo?.trackingLedger || [];
  }, "E2E冻结组合");
  if (firstAppend.length !== 1 || firstAppend[0].signal_date !== initial.selectedMonth) {
    throw new Error(`冻结账本没有只追加真实下一期：${JSON.stringify(firstAppend)}`);
  }
  const firstAppendJson = JSON.stringify(firstAppend);

  await page.reload({ waitUntil: "networkidle", timeout: 90000 });
  await loadFrozenCombo();
  const secondAppend = await page.evaluate(comboName => {
    const rows = JSON.parse(localStorage.getItem("factorlib.compose.myCombos.v1") || "[]");
    const combo = rows.find(item => item.name === comboName);
    return combo?.trackingLedger || [];
  }, "E2E冻结组合");
  if (JSON.stringify(secondAppend) !== firstAppendJson) {
    throw new Error("重复载入改写了已冻结的跟踪月份");
  }
  if (pageErrors.length) throw new Error(`页面错误：${pageErrors.join("\n")}`);
  console.log(`✅ 月度组合账本浏览器验收通过 · ${initial.monthCount}个已完成调仓月 · 最新${initial.selectedMonth} · 历史回放追加1期且重复载入未覆盖`);
} finally {
  await browser.close();
}
