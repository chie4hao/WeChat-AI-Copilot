#!/usr/bin/env bash
# VPS 首次部署：装 Node/pm2（缺什么装什么）、装依赖、生成 config.yaml、用 pm2 常驻。
# 在仓库根目录运行：bash tools/deploy_vps.sh
set -euo pipefail
cd "$(dirname "$0")/.."
APP=wechat-copilot

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "== 安装 Node.js 22（NodeSource）=="
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node $(node -v)"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "== 安装 pm2 =="
  npm install -g pm2
fi

echo "== 安装依赖 =="
npm install --omit=dev --no-audit --no-fund

if [ ! -f config.yaml ]; then
  cp config.yaml.example config.yaml
  echo "== 已生成 config.yaml，请编辑后再启动：nano config.yaml =="
  echo "   至少填写：server.sync_secret、一种 AI 通道（claude_code / claude / gemini）、my_name"
  exit 0
fi

echo "== 用 pm2 启动 =="
pm2 describe "$APP" >/dev/null 2>&1 && pm2 restart "$APP" || pm2 start src/server.js --name "$APP"
pm2 save >/dev/null
pm2 startup 2>/dev/null | tail -1 || true
sleep 3
pm2 list | grep -E "$APP|name"
pm2 logs "$APP" --lines 5 --nostream 2>/dev/null | tail -5
