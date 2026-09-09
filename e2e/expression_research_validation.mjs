import { chromium } from "playwright-core";

const baseUrl = process.argv[2] || process.env.FACTOR_LIB_URL || "http://127.0.0.1:8000";
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome",
});

const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
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
  if (!title.includes("v2.4.16")) throw new Error(`unexpected title: ${title}`);

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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.mode-btn[data-mode="expression"]').click();
  await page.waitForSelector("#expression-view .expression-table", { timeout: 15000 });
  const mobile = await page.evaluate(() => ({
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    tabVisible: getComputedStyle(document.querySelector("#expression-view")).display !== "none",
  }));
  if (!mobile.tabVisible) throw new Error("mobile expression view is hidden");
  if (mobile.bodyOverflow) throw new Error("mobile expression view overflows the document viewport");

  if (process.env.EXPRESSION_RESEARCH_SCREENSHOT) {
    await page.screenshot({ path: process.env.EXPRESSION_RESEARCH_SCREENSHOT, fullPage: true });
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ baseUrl, summary, correlationText, mobile }, null, 2));
} finally {
  await browser.close();
}
