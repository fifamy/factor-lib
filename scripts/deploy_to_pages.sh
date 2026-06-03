#!/bin/bash
# 把 frontend/ 同步到公开 GitHub Pages 仓库 fifamy/factor-lib-demo。
# 用法：bash frontend/scripts/deploy_to_pages.sh
set -euo pipefail
cd "$(dirname "$0")/.."          # 进入 frontend/
SRC="$(pwd)"
DEPLOY=/tmp/factor-lib-demo-sync
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2)

rm -rf "$DEPLOY"
git clone -q "https://${TOKEN}@github.com/fifamy/factor-lib-demo.git" "$DEPLOY"

# 同步部署文件（保留 .git / README.md / .nojekyll）
rsync -a --delete \
  --exclude='.git' --exclude='README.md' --exclude='.nojekyll' \
  --exclude='serve.py' --exclude='serve_abs.py' --exclude='scripts' \
  --exclude='.DS_Store' \
  "$SRC/index.html" "$SRC/app.js" "$SRC/styles.css" "$SRC/vendor" "$SRC/data" \
  "$DEPLOY/"
find "$DEPLOY" -name '.DS_Store' -delete

# cache-busting：把 index.html 里的 DEPLOY_VERSION 占位替换成时间戳，
# 强制浏览器重新拉取改动后的 app.js / styles.css（否则 GitHub Pages 缓存旧版）。
VER=$(date +%Y%m%d%H%M%S)
sed -i.bak "s/DEPLOY_VERSION/${VER}/g" "$DEPLOY/index.html" && rm -f "$DEPLOY/index.html.bak"

cd "$DEPLOY"
if git diff --quiet && git diff --cached --quiet; then
  echo "无变化，跳过。"; exit 0
fi
git add -A
git -c user.email="menyao520@gmail.com" -c user.name="fifamy" \
  commit -q -m "sync: update demo from factor-lib $(date +%Y-%m-%d)"
git push -q origin main
echo "✅ 已同步到 https://fifamy.github.io/factor-lib-demo/"
