#!/bin/bash
# 把 CDN 依赖下载到 frontend/vendor/，让 demo 可离线打开。
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p vendor
cd vendor

[ ! -f "duckdb-mvp.wasm" ] && curl -L "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/dist/duckdb-mvp.wasm" -o duckdb-mvp.wasm
[ ! -f "duckdb-browser-mvp.worker.js" ] && curl -L "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/dist/duckdb-browser-mvp.worker.js" -o duckdb-browser-mvp.worker.js
[ ! -f "duckdb-browser.mjs" ] && curl -L "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/dist/duckdb-browser.mjs" -o duckdb-browser.mjs

[ ! -f "echarts.min.js" ] && curl -L "https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js" -o echarts.min.js

# apache-arrow ESM 给 DuckDB-Wasm 用（peer dep）
[ ! -f "apache-arrow.mjs" ] && curl -L "https://cdn.jsdelivr.net/npm/apache-arrow@15.0.2/+esm" -o apache-arrow.mjs

[ ! -f "katex.min.js" ] && curl -L "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js" -o katex.min.js
[ ! -f "katex.min.css" ] && curl -L "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" -o katex.min.css

echo "Vendor files ready in $(pwd)"
