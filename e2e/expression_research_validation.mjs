import { chromium } from "playwright-core";

const baseUrl = process.argv[2] || process.env.FACTOR_LIB_URL || "http://127.0.0.1:8000";
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome",
});

const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
const fullSnapshotRequests = [];
page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
page.on("request", request => {
  if (request.url().includes("/data/single_snapshots/")) fullSnapshotRequests.push(request.url());
});
page.on("requestfailed", request => {
  const url = request.url();
  if (url.includes("expression_mining") || url.includes("factor_correlation_hints")) {
    errors.push(`requestfailed: ${url} ${request.failure()?.errorText || ""}`);
  }
});

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('.mode-btn[data-mode="expression"]', { timeout: 15000 });
  const title = await page.title();
  if (!title.includes("v2.4.19")) throw new Error(`unexpected title: ${title}`);

  await page.locator('.mode-btn[data-mode="expression"]').click();
  await page.waitForSelector("#expression-view .expression-table tbody tr", { timeout: 15000 });
  const summary = await page.evaluate(() => ({
    active: document.querySelector('.mode-btn[data-mode="expression"]')?.getAttribute("aria-selected"),
    selectedRows: document.querySelectorAll(".expression-fold-scroll tbody tr").length,
    gates: document.querySelectorAll(".expression-gates li").length,
    candidateCount: [...document.querySelectorAll(".expression-overview-grid strong")].map(item => item.textContent?.trim())[2],
    actionButtons: [...document.querySelectorAll("#expression-view button")].map(item => item.textContent?.trim()),
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  if (summary.active !== "true") throw new Error("expression tab is not active");
  if (summary.selectedRows !== 18) throw new Error(`expected 18 selected rows, got ${summary.selectedRows}`);
  if (summary.gates !== 5) throw new Error(`expected 5 promotion gates, got ${summary.gates}`);
  if (summary.candidateCount !== "75") throw new Error(`expected 75 candidates, got ${summary.candidateCount}`);
  if (summary.actionButtons.length) throw new Error(`read-only view exposed action buttons: ${summary.actionButtons.join(",")}`);
  if (summary.bodyOverflow) throw new Error("desktop expression view overflows the document viewport");

  await page.locator('.mode-btn[data-mode="ranking"]').click();
  await page.waitForSelector("#rank-table table.rank-table tbody tr", { timeout: 30000 });
  const amountRow = page.locator("#rank-table tbody tr").filter({ hasText: "AMOUNT20" }).first();
  await amountRow.waitFor({ state: "visible", timeout: 15000 });
  const correlationText = await amountRow.locator(".rank-corr-hint").innerText();
  if (!correlationText.includes("MFLOW20") || !correlationText.includes("+1.000")) {
    throw new Error(`AMOUNT20 correlation hint mismatch: ${correlationText}`);
  }
  const stomCorrelationText = await page.locator("#rank-table tbody tr").filter({ hasText: "STOM" }).first().locator(".rank-corr-hint").innerText();
  if (!stomCorrelationText.includes("连通簇3项")) {
    throw new Error(`STOM correlation cluster disclosure mismatch: ${stomCorrelationText}`);
  }
  await page.locator('.rank-chk[data-code="AMOUNT20"]').check();
  await page.locator('.rank-chk[data-code="MFLOW20"]').check();
  const rankSelectionWarning = await page.locator("#rank-sel-count").innerText();
  if (!rankSelectionWarning.includes("组合约束")) {
    throw new Error(`ranking selection constraint warning missing: ${rankSelectionWarning}`);
  }
  await page.locator("#rank-clear-sel").click();

  const trackingBoundary = await page.evaluate(() => ({
    status: document.querySelector("#tracking-remote-status")?.textContent?.trim(),
    importDisabled: document.querySelector("#tracking-import")?.disabled,
  }));
  if (!trackingBoundary.importDisabled || !trackingBoundary.status?.includes("未启用")) {
    throw new Error(`tracking capability boundary mismatch: ${JSON.stringify(trackingBoundary)}`);
  }

  await page.locator('.mode-btn[data-mode="single"]').click();
  await page.locator('.tree-l3[data-code="AMOUNT20"]').click();
  await page.waitForFunction(() => (
    document.querySelector("#factor-detail h3")?.textContent?.includes("AMOUNT20")
    && !document.querySelector("#single-score-neutral")?.disabled
    && !document.querySelector("#single-constraint-industry")?.disabled
  ), null, { timeout: 30000 });
  await page.locator("#single-score-neutral").click();
  await page.waitForFunction(() => document.querySelector("#single-score-neutral")?.classList.contains("active"), null, { timeout: 30000 });
  await page.locator("#single-constraint-industry").click();
  await page.waitForFunction(() => (
    document.querySelector("#single-constraint-industry")?.classList.contains("active")
    && document.querySelector("#kpi table")
  ), null, { timeout: 30000 });
  const singleModes = await page.evaluate(() => ({
    neutralDisabled: document.querySelector("#single-score-neutral")?.disabled,
    industryDisabled: document.querySelector("#single-constraint-industry")?.disabled,
    neutralActive: document.querySelector("#single-score-neutral")?.classList.contains("active"),
    industryActive: document.querySelector("#single-constraint-industry")?.classList.contains("active"),
  }));
  if (singleModes.neutralDisabled || singleModes.industryDisabled || !singleModes.neutralActive || !singleModes.industryActive) {
    throw new Error(`single slim mode mismatch: ${JSON.stringify(singleModes)}`);
  }
  fullSnapshotRequests.length = 0;
  await page.locator('.scan-btn[data-metric="sharpe"]').click();
  await page.waitForFunction(() => {
    const title = document.querySelector("#scan-title")?.textContent || "";
    const chart = document.querySelector("#scan-chart");
    return title.includes("行业市值中性 / 行业中性 夏普比率") && chart && !chart.textContent.includes("正在加载");
  }, null, { timeout: 30000 });
  const scanTitle = await page.locator("#scan-title").innerText();
  if (fullSnapshotRequests.length) {
    throw new Error(`metric switch requested unpublished full snapshots: ${fullSnapshotRequests.join(", ")}`);
  }

  await page.locator('.mode-btn[data-mode="compare"]').click();
  await page.locator('.tree-l3[data-code="AMOUNT20"]').click();
  await page.waitForSelector("#cmp-controls .cmp-score-mode", { timeout: 30000 });
  const scoreSelect = page.locator("#cmp-controls .cmp-score-mode").first();
  const constraintSelect = page.locator("#cmp-controls .cmp-constraint-mode").first();
  if (await scoreSelect.isDisabled() || await constraintSelect.isDisabled()) {
    throw new Error("single_slim_snapshots capability did not enable advanced compare controls");
  }
  await scoreSelect.selectOption("neutral");
  await page.waitForSelector("#cmp-controls .cmp-score-mode", { timeout: 30000 });
  await page.locator("#cmp-controls .cmp-constraint-mode").first().selectOption("industry");
  await page.waitForFunction(() => {
    const text = document.querySelector("#cmp-table")?.textContent || "";
    const scoreMode = document.querySelector("#cmp-controls .cmp-score-mode")?.value;
    const constraintMode = document.querySelector("#cmp-controls .cmp-constraint-mode")?.value;
    return scoreMode === "neutral" && constraintMode === "industry" && document.querySelector("#cmp-table table") && !text.includes("未渲染");
  }, null, { timeout: 30000 });
  await page.locator('.tree-l3[data-code="MOM12_1"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#cmp-controls .cmp-score-mode").length === 2, null, { timeout: 30000 });
  await page.locator("#cmp-controls .cmp-score-mode").nth(1).selectOption("neutral");
  await page.waitForFunction(() => document.querySelectorAll("#cmp-controls .cmp-score-mode").length === 2, null, { timeout: 30000 });
  await page.locator("#cmp-controls .cmp-constraint-mode").nth(1).selectOption("industry");
  await page.waitForFunction(() => {
    const controls = [...document.querySelectorAll("#cmp-controls .cmp-frow")];
    const text = document.querySelector("#cmp-table")?.textContent || "";
    return controls.length === 2 && text.includes("AMOUNT20") && text.includes("MOM12_1") && document.querySelector("#cmp-table table");
  }, null, { timeout: 30000 });
  const compareModes = await page.evaluate(() => ({
    capabilityNote: document.querySelector("#cmp-capability-note")?.textContent?.trim() || "",
    scoreModes: [...document.querySelectorAll("#cmp-controls .cmp-score-mode")].map(item => item.value),
    constraintModes: [...document.querySelectorAll("#cmp-controls .cmp-constraint-mode")].map(item => item.value),
    tableText: document.querySelector("#cmp-table")?.textContent?.trim() || "",
  }));
  if (compareModes.capabilityNote || compareModes.scoreModes.some(mode => mode !== "neutral") || compareModes.constraintModes.some(mode => mode !== "industry")
      || compareModes.tableText.includes("当前发布包未包含") || compareModes.tableText.includes("原始错误")) {
    throw new Error(`advanced compare slim mode mismatch: ${JSON.stringify(compareModes)}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.mode-btn[data-mode="expression"]').click();
  await page.waitForSelector("#expression-view .expression-table", { timeout: 15000 });
  const mobile = await page.evaluate(() => ({
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    tabVisible: getComputedStyle(document.querySelector("#expression-view")).display !== "none",
  }));
  if (!mobile.tabVisible) throw new Error("mobile expression view is hidden");
  if (mobile.bodyOverflow) throw new Error("mobile expression view overflows the document viewport");

  const failurePage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await failurePage.route("**/data/factor_correlation_hints.json*", route => route.abort());
  await failurePage.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await failurePage.locator('.mode-btn[data-mode="ranking"]').click();
  await failurePage.waitForSelector(".rank-corr-unavailable", { timeout: 30000 });
  const correlationFailureText = await failurePage.locator(".rank-corr-unavailable").first().innerText();
  if (!correlationFailureText.includes("不可用")) {
    throw new Error(`correlation failure state mismatch: ${correlationFailureText}`);
  }
  await failurePage.close();

  const auditUrl = new URL("factor_audit.html", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
  const auditPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await auditPage.goto(auditUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await auditPage.waitForSelector('.fa-row[data-code="PE"]', { timeout: 30000 });
  const coverageFilter = auditPage.locator('[data-filter="recon_coverage_difference"]');
  if (!(await coverageFilter.isDisabled())) {
    throw new Error("zero-count coverage-difference filter should be disabled");
  }
  await auditPage.locator('.fa-row[data-code="PE"]').click();
  await auditPage.waitForFunction(() => (document.querySelector("#fa-detail")?.textContent || "").includes("共同键一致 500/500"), null, { timeout: 30000 });
  const auditDetailText = await auditPage.locator("#fa-detail").innerText();
  if (auditDetailText.includes("500/200")) throw new Error("audit detail still exposes stale 500/200 denominator");
  await auditPage.close();

  if (process.env.EXPRESSION_RESEARCH_SCREENSHOT) {
    await page.screenshot({ path: process.env.EXPRESSION_RESEARCH_SCREENSHOT, fullPage: true });
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ baseUrl, summary, correlationText, stomCorrelationText, rankSelectionWarning, trackingBoundary, singleModes, scanTitle, compareModes, mobile, correlationFailureText }, null, 2));
} finally {
  await browser.close();
}
