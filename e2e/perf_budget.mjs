// Performance budget regression for the common workflows.
// Usage: node e2e/perf_budget.mjs [url] [--enforce]
import { chromium } from "playwright-core";

const TARGET_URL = process.argv.find(arg => /^https?:\/\//.test(arg)) || "http://localhost:8000";
const enforce = process.argv.includes("--enforce");
const budgetMultiplier = positiveNumberEnv("PERF_BUDGET_MULTIPLIER", 1);
const launchOptions = {
  headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
};
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
} else {
  launchOptions.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome";
}
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage();

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const requests = [];
const jsErrors = [];
page.on("request", req => {
  requests.push({ url: req.url(), ts: Date.now(), resourceType: req.resourceType() });
});
page.on("console", msg => {
  if (msg.type() === "error" && !msg.text().includes("Failed to load resource")) jsErrors.push(msg.text());
});
page.on("pageerror", err => jsErrors.push("PAGEERROR: " + err.message));

function since(start) {
  return Math.round(performance.now() - start);
}

function dataRequestsAfter(startTs) {
  return requests.filter(r => r.ts >= startTs && r.url.includes("/data/"));
}

async function measure(name, action, waitFor) {
  const startTs = Date.now();
  const start = performance.now();
  await action();
  await waitFor();
  await page.waitForTimeout(300);
  return {
    name,
    ms: since(start),
    dataRequests: dataRequestsAfter(startTs).map(r => r.url),
  };
}

const results = [];
try {
  const start = performance.now();
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(".tree-l3", { timeout: 30000 });
  results.push({
    name: "startup",
    ms: since(start),
    dataRequests: dataRequestsAfter(0).map(r => r.url),
  });

  results.push(await measure(
    "single-first-factor",
    async () => page.locator('.tree-l3[data-code="MOM12_1"]').click(),
    async () => {
      await page.waitForSelector("#kpi table tbody tr", { timeout: 50000 });
      await page.waitForSelector("#top-stocks table tbody tr", { timeout: 50000 });
    },
  ));

  results.push(await measure(
    "compose-two-factors",
    async () => {
      await page.locator('.mode-btn[data-mode="compose"]').click();
      await page.locator('.tree-l3[data-code="MOM12_1"]').click();
      await page.locator('.tree-l3[data-code="REV1M"]').click();
    },
    async () => {
      await page.waitForSelector("#cps-kpi table tbody tr", { timeout: 70000 });
      await page.waitForSelector("#cps-stocks table tbody tr", { timeout: 70000 });
    },
  ));

  results.push(await measure(
    "ranking",
    async () => page.locator('.mode-btn[data-mode="ranking"]').click(),
    async () => page.waitForSelector("#rank-table table tbody tr", { timeout: 90000 }),
  ));

  if (jsErrors.length) throw new Error(jsErrors.join("\n"));

  console.log(JSON.stringify(results.map(r => ({
    name: r.name,
    ms: r.ms,
    dataRequests: r.dataRequests.map(u => new URL(u).pathname),
  })), null, 2));

  if (enforce) {
    const baseBudgets = {
      startup: 2500,
      "single-first-factor": 1500,
      "compose-two-factors": 3500,
      ranking: 2500,
    };
    const budgets = Object.fromEntries(
      Object.entries(baseBudgets).map(([name, ms]) => [name, Math.round(ms * budgetMultiplier)]),
    );
    const failures = results.filter(r => r.ms > budgets[r.name]);
    if (failures.length) {
      throw new Error("Performance budget exceeded: " + failures.map(r => `${r.name} ${r.ms}ms>${budgets[r.name]}ms`).join("; "));
    }
    const composeReqs = results.find(r => r.name === "compose-two-factors")?.dataRequests || [];
    const forbidden = composeReqs.filter(u =>
      u.includes("factor_score_full.parquet")
      || u.includes("monthly_return.parquet")
      || u.includes("stock_meta.parquet")
      || u.includes("stock_descriptors.parquet")
    );
    if (forbidden.length) throw new Error("Compose requested slow data files: " + forbidden.join(", "));
    for (const code of ["MOM12_1", "REV1M"]) {
      const hits = composeReqs.filter(u => new URL(u).pathname.endsWith(`/compose_scores/${code}.parquet`)).length;
      if (hits !== 1) throw new Error(`Compose shard ${code} requested ${hits} times, expected once`);
    }
  }
} catch (err) {
  console.error("perf_budget failed:", err.message || err);
  process.exit(1);
} finally {
  await browser.close();
}
