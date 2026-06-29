// 自动启动本地前端服务并运行多因子检验 e2e。
// 用法：node e2e/run_compose_validation.mjs [port]
import { spawn } from "node:child_process";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const frontendDir = resolve(rootDir, "frontend");
const serverScriptLabel = "frontend/serve.py";
const serverScript = resolve(rootDir, serverScriptLabel);
const port = Number(process.argv[2] || process.env.FACTOR_LIB_E2E_PORT || 8878);
const url = `http://127.0.0.1:${port}/`;

function waitForHttp(targetUrl, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolveReady, rejectReady) => {
    const probe = () => {
      const req = request(targetUrl, { method: "HEAD", timeout: 2000 }, res => {
        res.resume();
        resolveReady();
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", err => {
        if (Date.now() - started > timeoutMs) {
          rejectReady(new Error(`前端服务启动超时：${err.message}`));
          return;
        }
        setTimeout(probe, 250);
      });
      req.end();
    };
    probe();
  });
}

async function main() {
  const server = spawn("python3", [serverScript, String(port)], {
    cwd: frontendDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverLog = "";
  server.stdout.on("data", chunk => { serverLog += chunk.toString(); });
  server.stderr.on("data", chunk => { serverLog += chunk.toString(); });

  const stopServer = () => {
    if (!server.killed) server.kill("SIGTERM");
  };
  process.on("exit", stopServer);
  process.on("SIGINT", () => { stopServer(); process.exit(130); });
  process.on("SIGTERM", () => { stopServer(); process.exit(143); });

  try {
    await waitForHttp(url);
    const e2e = spawn(process.execPath, [resolve(__dirname, "compose_validation.mjs"), url], {
      cwd: rootDir,
      stdio: "inherit",
    });
    const code = await new Promise(resolveDone => e2e.on("exit", resolveDone));
    if (code !== 0) process.exitCode = code || 1;
  } catch (err) {
    console.error(`❌ 多因子检验自托管验收失败：${err.message}`);
    console.error(`服务脚本：${serverScriptLabel}`);
    if (serverLog.trim()) console.error(serverLog.trim());
    process.exitCode = 1;
  } finally {
    stopServer();
  }
}

main();
