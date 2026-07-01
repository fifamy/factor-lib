// Online validation for the published factor library.
// Default mode checks live HTML/app.js resources. Set ONLINE_E2E_BROWSER=1 to
// additionally run the browser interaction flow against the live site.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const liveUrl = process.argv[2] || "https://fifamy.github.io/factor-lib/";

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

async function validateLiveResources() {
  const index = await fetchText(`${liveUrl}${liveUrl.includes("?") ? "&" : "?"}cb=${Date.now()}`);
  const appMatch = index.match(/app\.js\?v=\d+/);
  if (!index.includes("因子库 v1.3.6")) throw new Error("线上首页未显示 v1.3.6");
  if (!appMatch) throw new Error("线上首页未引用带版本号的 app.js");
  const appUrl = new URL(appMatch[0], liveUrl).toString();
  const app = await fetchText(appUrl);
  const required = [
    "comboBestSingleComparison(factors, N, constraintMode, startMonth, endMonth)",
    "factor_corr_neutral",
    "组合内相对低流动性占比",
    "htmlText(JSON.stringify(payload, null, 2))",
  ];
  const missing = required.filter(item => !app.includes(item));
  if (missing.length) throw new Error(`线上 app.js 缺少关键修复标记：${missing.join(", ")}`);
  return { appUrl };
}

function runBrowserValidation(url) {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(process.execPath, [resolve(__dirname, "compose_validation.mjs"), url], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", rejectDone);
    child.on("exit", code => {
      if (code === 0) resolveDone();
      else rejectDone(new Error(`线上浏览器验收失败，退出码 ${code}`));
    });
  });
}

(async () => {
  const { appUrl } = await validateLiveResources();
  if (process.env.ONLINE_E2E_BROWSER === "1") {
    await runBrowserValidation(liveUrl);
  }
  console.log(`✅ 线上多因子检验资源验收通过：${appUrl}`);
})().catch(err => {
  console.log(`❌ 线上多因子检验验收失败：${err.message}`);
  process.exit(1);
});
