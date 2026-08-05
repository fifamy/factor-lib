// Validate the published Pages release without relying on ChatGPT Browser Use.
//
// The script first waits until the live release_manifest deploy_version matches
// the checked-out Pages commit. In browser mode it then runs the functional
// compose smoke test and the performance budget against the live site.
//
// Usage:
//   node e2e/online_compose_validation.mjs [url]
//   ONLINE_E2E_BROWSER=1 node e2e/online_compose_validation.mjs [url]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const liveUrl = ensureTrailingSlash(
  process.argv[2]
    || process.env.ONLINE_E2E_URL
    || "https://fifamy.github.io/factor-lib/",
);
const waitTimeoutMs = positiveNumberEnv("ONLINE_WAIT_TIMEOUT_MS", 15 * 60 * 1000);
const waitIntervalMs = positiveNumberEnv("ONLINE_WAIT_INTERVAL_MS", 15 * 1000);

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function localFrontendRoot() {
  const sourceFrontend = resolve(rootDir, "frontend");
  return existsSync(resolve(sourceFrontend, "data", "release_manifest.json"))
    ? sourceFrontend
    : rootDir;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fetchText(relativePath) {
  const url = new URL(relativePath, liveUrl);
  url.searchParams.set("e2e", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const res = await fetch(url, {
    headers: {
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

async function fetchJson(relativePath) {
  return JSON.parse(await fetchText(relativePath));
}

function sleep(ms) {
  return new Promise(resolveDone => setTimeout(resolveDone, ms));
}

async function waitForLiveRelease(expectedVersion) {
  const started = Date.now();
  let lastSeen = "尚未取得线上 release_manifest";
  while (Date.now() - started < waitTimeoutMs) {
    try {
      const liveManifest = await fetchJson("data/release_manifest.json");
      lastSeen = liveManifest.deploy_version || "缺少 deploy_version";
      if (lastSeen === expectedVersion) return liveManifest;
    } catch (err) {
      lastSeen = err?.message || String(err);
    }
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    console.log(`等待 Pages 发布生效：期望 ${expectedVersion}，当前 ${lastSeen}，已等待 ${elapsedSeconds}s`);
    await sleep(waitIntervalMs);
  }
  throw new Error(
    `等待 Pages 发布超时：期望 deploy_version=${expectedVersion}，最后看到 ${lastSeen}`,
  );
}

async function validateLiveResources(expectedManifest) {
  const version = expectedManifest.deploy_version;
  const [index, app, dataManifest, catalog, auditIndex] = await Promise.all([
    fetchText("index.html"),
    fetchText(`app.js?v=${version}`),
    fetchJson("data/data_manifest.json"),
    fetchJson("data/factor_catalog.json"),
    fetchJson("data/factor_audit/index.json"),
  ]);
  for (const asset of [`app.js?v=${version}`, `styles.css?v=${version}`]) {
    if (!index.includes(asset)) throw new Error(`线上首页未引用本次发布资源：${asset}`);
  }
  if (index.includes("DEPLOY_VERSION")) throw new Error("线上首页仍含 DEPLOY_VERSION 占位符");
  const appMarkers = [
    "组合内相对低流动性占比",
    "comboBestSingleComparison(factors, N, constraintMode, startMonth, endMonth)",
    "factor_corr_neutral",
    "htmlText(JSON.stringify(payload, null, 2))",
  ];
  const missingAppMarkers = appMarkers.filter(marker => !app.includes(marker));
  if (missingAppMarkers.length) {
    throw new Error(`线上 app.js 缺少关键功能标记：${missingAppMarkers.join(", ")}`);
  }
  if (catalog.length !== expectedManifest.factor_count) {
    throw new Error(`线上目录因子数不一致：${catalog.length} != ${expectedManifest.factor_count}`);
  }
  if (
    auditIndex.n_factors !== expectedManifest.audit_factor_count
    || auditIndex.factors?.length !== expectedManifest.audit_factor_rows
  ) {
    throw new Error("线上因子核对索引与发布清单不一致");
  }
  if (dataManifest.factor_count !== expectedManifest.factor_count) {
    throw new Error("线上 data_manifest 因子数与发布清单不一致");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataManifest.return_end_date || "")) {
    throw new Error("线上 data_manifest 缺少有效 return_end_date");
  }
  return { dataManifest };
}

function runNodeScript(scriptName, args = [], extraEnv = {}) {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(process.execPath, [resolve(__dirname, scriptName), ...args], {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.on("error", rejectDone);
    child.on("exit", code => {
      if (code === 0) resolveDone();
      else rejectDone(new Error(`${scriptName} 失败，退出码 ${code}`));
    });
  });
}

async function runBrowserValidation() {
  await runNodeScript("compose_validation.mjs", [liveUrl]);
  await runNodeScript("perf_budget.mjs", [liveUrl, "--enforce"]);
}

(async () => {
  const frontendRoot = localFrontendRoot();
  const expectedManifest = await readJson(resolve(frontendRoot, "data", "release_manifest.json"));
  if (!/^\d{14}$/.test(expectedManifest.deploy_version || "")) {
    throw new Error("本地发布清单缺少有效的 14 位 deploy_version");
  }

  const liveManifest = await waitForLiveRelease(expectedManifest.deploy_version);
  const { dataManifest } = await validateLiveResources(expectedManifest);
  if (process.env.ONLINE_E2E_BROWSER === "1") await runBrowserValidation();

  console.log([
    "✅ 线上发布验收通过",
    `deploy_version=${liveManifest.deploy_version}`,
    `factor_count=${liveManifest.factor_count}`,
    `return_end_date=${dataManifest.return_end_date}`,
    process.env.ONLINE_E2E_BROWSER === "1" ? "browser_e2e=passed" : "browser_e2e=skipped",
  ].join(" · "));
})().catch(err => {
  console.error(`❌ 线上发布验收失败：${err?.message || err}`);
  process.exit(1);
});
