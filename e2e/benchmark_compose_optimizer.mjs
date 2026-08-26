import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceApp = path.join(here, "..", "frontend", "app.js");
const publishedApp = path.join(here, "..", "app.js");
const source = fs.readFileSync(fs.existsSync(sourceApp) ? sourceApp : publishedApp, "utf8");
const start = source.indexOf("function nthLargestFinite");
const end = source.indexOf("function yieldToEventLoop", start);
if (start < 0 || end < 0) throw new Error("无法从 frontend/app.js 提取 nthLargestFinite");
const nthLargestFinite = new Function(`${source.slice(start, end)}; return nthLargestFinite;`)();

const monthCount = Number(process.env.BENCH_MONTHS || 139);
const universeSize = Number(process.env.BENCH_UNIVERSE || 3200);
const gridCount = Number(process.env.BENCH_GRIDS || 10);
const topN = Number(process.env.BENCH_TOPN || 30);
let seed = 20260826;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const months = Array.from({ length: monthCount }, (_, month) => {
  const values = new Float64Array(universeSize);
  for (let i = 0; i < universeSize; i += 1) {
    // 六位小数与生产合成分数 ROUND(..., 6) 一致，并保留少量边界同分。
    values[i] = Math.round((random() * 6 - 3 + (month % 7) * 0.00001) * 1e6) / 1e6;
  }
  return values;
});

const sortedBoundary = values => Array.from(values).sort((a, b) => b - a)[topN - 1];
for (let i = 0; i < 3; i += 1) nthLargestFinite(months[i], topN);

let heapChecksum = 0;
const heapStart = performance.now();
for (let grid = 0; grid < gridCount; grid += 1) {
  for (const values of months) heapChecksum += nthLargestFinite(values, topN);
}
const heapMs = performance.now() - heapStart;

let sortChecksum = 0;
const sortStart = performance.now();
for (let grid = 0; grid < gridCount; grid += 1) {
  for (const values of months) sortChecksum += sortedBoundary(values);
}
const sortMs = performance.now() - sortStart;

if (Math.abs(heapChecksum - sortChecksum) > 1e-9) {
  throw new Error(`边界结果不一致：heap=${heapChecksum}, sort=${sortChecksum}`);
}
console.log(JSON.stringify({
  monthCount,
  universeSize,
  gridCount,
  topN,
  observations: monthCount * universeSize * gridCount,
  heapMs: Number(heapMs.toFixed(1)),
  fullSortMs: Number(sortMs.toFixed(1)),
  speedup: Number((sortMs / Math.max(heapMs, 0.001)).toFixed(2)),
  checksum: Number(heapChecksum.toFixed(6)),
}, null, 2));
