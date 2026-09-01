# scripts/ — 构建/打包/测试脚本

自包含 ESM `.mjs` 脚本集合，直接 `node scripts/xxx.mjs` 运行。**无测试框架**（无 jest/vitest），"测试"即这些独立脚本。

## WHERE TO LOOK

| Script | Purpose | 运行条件 |
|--------|---------|----------|
| `api-test.mjs` | server.js REST API 回归（班级/学生/场次/扫码/批改全流程） | **需服务已运行**（= `npm test`） |
| `qr-hunt-test.mjs` | `findMulti()` 一帧多码算法测试 | 独立运行 |
| `accuracy-test.mjs` | ZXing vs jsQR 识别率基准（多码场景判据：ZXing ≥ 9/10） | 独立运行 |
| `layout-test.mjs` | qr-pdf.js 贴纸排版几何校验 | 独立运行 |
| `glare-test.mjs` | 反光/对比度鲁棒性测试 | 独立运行 |
| `vendor.js` | 把 devDependencies 里的前端库本地化到 `public/vendor/` | 独立运行 |
| `tauri-prepare.mjs` | 归拢 server.js + public + 生产依赖 + node sidecar → `src-tauri/resources/` | cargo tauri build 前必跑 |
| `make-win-portable.mjs` | Windows 免安装绿色包：下载 Node 22 win-x64 便携版 → 装生产依赖 → 拷资源 → zip → `dist/` | 独立运行 |
| `make-icon.mjs` | 从 `icon-src.png` 生成全套应用图标（macOS/Android/iOS） | 独立运行 |
| `canvas-shim.mjs` | Node 环境下模拟 canvas，供识别测试用 | 被其他脚本 import |
| `forensic.mjs` | 抓帧诊断样本取证分析 | 独立运行 |

## CONVENTIONS

- 一律 ESM `.mjs`（package.json 是 commonjs，所以必须用 .mjs 后缀）。
- 每个脚本自包含、可直接 node 运行，测试用 `node:assert`，无共享 runner。
- Node 环境跑浏览器算法（qr-hunt/scan-engine）依赖 `canvas-shim.mjs` + devDeps 里的 pngjs/jsqr/zxing-wasm。

## NOTES

- `api-test.mjs` 覆盖 server.js 大部分 API；未覆盖：证书重签（loadCert）、WS 广播、持久化防抖。
- Rust 层（src-tauri）无任何测试 —— `cargo test` 会报 no test target。
- 打包链路：改 `public/` 或 `server.js` → `node scripts/tauri-prepare.mjs` → `cargo tauri build`；Windows 包单独走 `make-win-portable.mjs`。
