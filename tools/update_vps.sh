#!/usr/bin/env bash
# VPS 日常更新：拉代码、装依赖、重启、看启动日志。在仓库根目录运行：bash tools/update_vps.sh
set -euo pipefail
cd "$(dirname "$0")/.."
APP=wechat-copilot

echo "== 备份数据库 =="
[ -f data.db ] && node -e 'import("better-sqlite3").then(m=>{const db=new m.default("data.db");return db.backup("data.db.bak-"+new Date().toISOString().slice(0,16).replace(/[-:T]/g,"")).then(()=>{db.close();console.log("backup ok")})})'
ls -t data.db.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f   # 只留最近 5 份

echo "== 拉取代码 =="
git pull --ff-only
git log --oneline -1

echo "== 安装依赖 =="
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1

echo "== 重启 =="
pm2 restart "$APP" >/dev/null
sleep 4
pm2 list | grep -E "$APP"
pm2 logs "$APP" --lines 6 --nostream 2>/dev/null | grep -E "server|push|Error|error" | tail -6 || true
