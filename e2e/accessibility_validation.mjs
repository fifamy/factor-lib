// 主页面无障碍与响应式回归：使用系统 Chrome，不依赖 ChatGPT App。
// 用法：node e2e/accessibility_validation.mjs [url]
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const TARGET_URL = process.argv[2] || "http://127.0.0.1:8000/";
const LOCAL_FRONTEND_ROOT = process.env.LOCAL_FRONTEND_ROOT
  ? resolve(process.env.LOCAL_FRONTEND_ROOT)
  : null;
const failures = [];
const check = (condition, label) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
};

function launchOptions() {
  const options = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  } else {
    options.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome";
  }
  return options;
}

async function mockOptionalServices(page) {
  await page.route("https://tsyplhfshxzoduynzixk.supabase.co/**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
}

async function serveLocalFrontend(page) {
  if (!LOCAL_FRONTEND_ROOT) return;
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".parquet": "application/octet-stream",
  };
  await page.route("http://factor.local/**", async route => {
    const url = new URL(route.request().url());
    const relativePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const localPath = resolve(LOCAL_FRONTEND_ROOT, `.${relativePath}`);
    const insideRoot = localPath === LOCAL_FRONTEND_ROOT || localPath.startsWith(`${LOCAL_FRONTEND_ROOT}${sep}`);
    if (!insideRoot) {
      await route.fulfill({ status: 403, body: "forbidden" });
      return;
    }
    try {
      const body = await readFile(localPath);
      await route.fulfill({
        status: 200,
        contentType: mimeTypes[extname(localPath).toLowerCase()] || "application/octet-stream",
        body,
      });
    } catch {
      await route.fulfill({ status: 404, body: "not found" });
    }
  });
}

async function contrastRatios(page) {
  return page.evaluate(() => {
    const channels = value => {
      const match = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [0, 0, 0];
      return match.map(v => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    };
    const luminance = value => {
      const [r, g, b] = channels(value);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (fg, bg) => {
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return [document.querySelector(".nav-link"), ...document.querySelectorAll(".rank-explainer .ftag")]
      .filter(Boolean)
      .map(el => {
        const style = getComputedStyle(el);
        return { label: el.textContent.trim(), ratio: ratio(style.color, style.backgroundColor) };
      });
  });
}

const browser = await chromium.launch(launchOptions());
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await mockOptionalServices(desktop);
  await serveLocalFrontend(desktop);
  await desktop.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await desktop.waitForSelector(".tree-l3", { timeout: 30000 });

  check(await desktop.locator('meta[name="viewport"]').getAttribute("content") === "width=device-width, initial-scale=1, viewport-fit=cover", "移动端 viewport 已声明");
  check(await desktop.locator(".skip-link").count() === 1, "存在跳到主要内容链接");
  check(await desktop.locator("#factor-search").evaluate(el => el.labels?.length === 1), "搜索框有程序化标签");
  check(await desktop.locator(".tree-l1, .tree-l2, .tree-l3").evaluateAll(els => els.every(el => el.tagName === "BUTTON")), "目录交互项均为原生按钮");
  check(await desktop.locator(".mode-btn").evaluateAll(els => els.every(el => el.getAttribute("role") === "tab")), "分析模式使用标签页语义");

  const firstGroup = desktop.locator(".tree-l1").first();
  const expandedBefore = await firstGroup.getAttribute("aria-expanded");
  await firstGroup.focus();
  await desktop.keyboard.press("Space");
  check(await firstGroup.getAttribute("aria-expanded") !== expandedBefore, "目录分组可用空格键展开/折叠");
  await desktop.keyboard.press("Space");

  await desktop.locator('.mode-btn[data-mode="single"]').focus();
  await desktop.keyboard.press("ArrowRight");
  check(await desktop.locator('.mode-btn[data-mode="compare"]').getAttribute("aria-selected") === "true", "标签页支持方向键切换");
  await desktop.locator('.mode-btn[data-mode="single"]').click();

  const factor = desktop.locator('.tree-l3[data-code="MOM12_1"]').first();
  await factor.focus();
  await desktop.keyboard.press("Enter");
  await desktop.waitForSelector("#top-stocks .stock-detail-btn", { timeout: 70000 });
  const detailButton = desktop.locator("#top-stocks .stock-detail-btn").first();
  await detailButton.focus();
  await desktop.keyboard.press("Enter");
  await desktop.waitForSelector("#stock-modal:not([hidden])", { timeout: 15000 });
  check(await desktop.locator(".sd-close").evaluate(el => document.activeElement === el), "弹窗打开后焦点进入关闭按钮");
  check(await desktop.locator("#main").evaluate(el => el.inert), "弹窗打开时背景内容不可交互");
  await desktop.keyboard.press("Tab");
  check(await desktop.locator("#stock-modal").evaluate(el => el.contains(document.activeElement)), "Tab 焦点限制在弹窗内");
  await desktop.keyboard.press("Escape");
  check(await desktop.locator("#stock-modal").evaluate(el => el.hidden), "Escape 可关闭弹窗");
  check(await detailButton.evaluate(el => document.activeElement === el), "关闭弹窗后焦点回到触发按钮");

  const ratios = await contrastRatios(desktop);
  check(ratios.every(item => item.ratio >= 4.5), `导航与标签文字对比度达到 4.5:1（最低 ${Math.min(...ratios.map(item => item.ratio)).toFixed(2)}）`);
  check(await desktop.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "桌面端无页面级横向溢出");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mockOptionalServices(mobile);
  await serveLocalFrontend(mobile);
  await mobile.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await mobile.waitForSelector(".tree-l3", { timeout: 30000 });
  const mobileLayout = await mobile.evaluate(() => ({
    mainDisplay: getComputedStyle(document.getElementById("main")).display,
    sidebarPosition: getComputedStyle(document.getElementById("sidebar")).position,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    columns: getComputedStyle(document.getElementById("mode-switch")).gridTemplateColumns.split(" ").length,
  }));
  check(mobileLayout.mainDisplay === "block", "手机端主布局改为单栏");
  check(mobileLayout.sidebarPosition === "static", "手机端目录不再固定占据侧栏");
  check(mobileLayout.bodyOverflowY !== "hidden", "手机端允许页面纵向滚动");
  check(mobileLayout.fits, "390px 手机宽度无页面级横向溢出");
  check(mobileLayout.columns === 2, "手机端模式按钮使用两列布局");

  if (failures.length) throw new Error(`未通过 ${failures.length} 项：${failures.join("；")}`);
  console.log("✅ 主页面无障碍与响应式验收通过");
} catch (error) {
  console.error(`❌ 主页面无障碍与响应式验收失败：${error.message || error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
