@echo off
chcp 65001 >nul
title 作业扫码登记
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装：https://nodejs.org （装 LTS 版即可）
  echo 安装完成后重新双击本文件。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行，正在安装依赖（约1分钟）...
  call npm install --omit=dev
  if errorlevel 1 ( echo 依赖安装失败，请检查网络后重试 & pause & exit /b 1 )
  node scripts\vendor.js
)

echo 正在启动服务...
node server.js --open
pause
