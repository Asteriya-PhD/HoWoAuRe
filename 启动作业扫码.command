#!/bin/bash
# 作业扫码登记 — macOS 启动脚本（双击运行）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装：https://nodejs.org （装 LTS 版即可）"
  echo "安装完成后重新双击本文件。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖（约1分钟）…"
  npm install --omit=dev || { echo "依赖安装失败，请检查网络后重试"; read -n 1 -s -r; exit 1; }
  node scripts/vendor.js
fi

echo "正在启动服务…"
node server.js --open
read -n 1 -s -r -p "服务已停止，按任意键关闭…"
