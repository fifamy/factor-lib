// 浏览器回归：多因子季度滚动参数样本外必须按需运行并给出六组窗口结果。
// 前提：frontend/serve.py 已在本地启动。用法：node e2e/compose_walk_forward_validation.mjs [url]
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://127.0.0.1:8000/";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.stack || error.message));
await page.route("https://tsyplhfshxzoduynzixk.supabase.co/**", route => route.fulfill({
  contentType: "application/json",
  body: "[]",
}));

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.locator('.mode-btn[data-mode="compose"]').click();
  await page.waitForSelector("#compose-view", { state: "visible", timeout: 15000 });
  await page.locator('.tree-l3[data-code="MOM12_1"]').click();
  await page.locator('.tree-l3[data-code="DASTD"]').click();
  await page.waitForFunction(() => {
    const text = document.querySelector("#combo-validation")?.innerText || "";
    return text.includes("严格时点化参数检验") && text.includes("联合选择非负权重、TopN 与阈值方案");
  }, null, { timeout: 300000 });

  const startedAt = Date.now();
  await page.locator("#combo-walk-forward-run").click();
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll(".combo-walk-forward-table tbody tr");
    const text = document.querySelector("#combo-walk-forward-result")?.innerText || "";
    return rows.length === 6 && text.includes("收益截止") && text.includes("训练期成本后夏普");
  }, null, { timeout: 300000 });
  const elapsedMs = Date.now() - startedAt;
  const summaryRows = await page.locator(".combo-walk-forward-table tbody tr").count();
  const foldRows = await page.locator(".combo-walk-forward-fold-table tbody tr").count();
  const leakageRows = await page.locator(".combo-walk-forward-fold-table tbody tr").evaluateAll(rows => rows.filter(row => {
    const cells = [...row.querySelectorAll("td")].map(cell => cell.textContent.trim());
    return cells[2] > cells[0] || cells[3] <= cells[0];
  }).length);
  const text = await page.locator("#combo-walk-forward-result").innerText();

  if (errors.length) throw new Error(`页面错误：${errors.join("\n")}`);
  if (summaryRows !== 6) throw new Error(`预期 6 组训练/未来窗口，实际 ${summaryRows}`);
  if (foldRows < 4) throw new Error(`有效折不足，实际 ${foldRows}`);
  if (leakageRows) throw new Error(`发现 ${leakageRows} 折训练/未来时点不合法`);
  if (!/参数候选\s*99\s*组/u.test(text)) throw new Error("两因子联合参数网格数量不是 99 组");
  if (!text.includes("权重 11 × TopN 3 × 阈值 3")) throw new Error("联合参数网格拆分不符合预期");
  if (!text.includes("最近 TopN") || !text.includes("最近阈值")) throw new Error("滚动结果未披露 TopN 或阈值方案");
  console.log(JSON.stringify({ summaryRows, foldRows, leakageRows, elapsedMs }));
} finally {
  await browser.close();
}
