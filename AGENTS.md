# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-01
**Commit:** 9172d72
**Branch:** main

## OVERVIEW

作业扫码登记 —— 纯局域网作业收集系统：教师电脑显示大二维码，学生手机扫码自动登记，支持按扫码顺序批改打等级。Node.js/Express 单文件服务端 + Vue 3 无构建前端 + Tauri 2 macOS 壳。

## STRUCTURE

```
HoWoAuRe/
├── server.js               # 唯一后端入口：HTTP 3000 + HTTPS 3443 + WebSocket(/ws)，全部 REST API
├── public/                 # 前端 SPA（Vue 3 无构建，vendor 已本地化）→ 有独立 AGENTS.md
├── scripts/                # 构建/打包/测试脚本（自包含 .mjs，无测试框架）→ 有独立 AGENTS.md
├── src-tauri/              # macOS App 壳（Rust/Tauri 2，node sidecar）→ 有独立 AGENTS.md
├── app-ui/                 # App 启动等待页（Tauri frontendDist，服务就绪前显示）
├── data/                   # 运行时数据 db.json + backups/ + 自签证书（gitignored，含隐私）
├── dist/                   # Windows 免安装包产物（gitignored）
├── 启动作业扫码.command/.bat # 双击启动脚本版
└── package.json            # "type": "commonjs"（server.js 是 CJS；scripts/ 全是 ESM .mjs）
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| 新增/修改 API | `server.js` 的 `api` router（L195 起） | 单文件，全部路由都在这 |
| 扫码登记核心逻辑 | `server.js` `doScan()` (L159) | 重复扫码去重、截止后记补交 |
| 二维码内容格式 | `server.js` `parseCode()` (L136) | `HW\|classId\|stuNo\|name` 竖线分隔 |
| 扫码识别算法 | `public/js/qr-hunt.js` `findMulti()` | 三级回退：BarcodeDetector → ZXing WASM → jsQR |
| 摄像头/补光/变焦 | `public/js/scan-engine.js` | 浏览器端，需真机摄像头，无法 headless 测 |
| 前端页面 | `public/js/views/*.js` | 每个视图一个自包含 JS 对象 |
| 实时刷新 | `server.js` `broadcast` + `public/js/store.js` | WebSocket 推送 sessionFull |
| 数据持久化 | `server.js` `saveDb()`（防抖）→ `data/db.json` | 启动时备份保留最近 20 份 |
| App 壳行为 | `src-tauri/src/main.rs` | sidecar 握手、菜单、数据目录 |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `api` | express.Router | server.js:195 | 全部 REST API（/classes /students /sessions /scan /grade 等） |
| `doScan` | function | server.js:159 | 扫码登记核心：查学生→去重→记录→返回结果 |
| `parseCode` | function | server.js:136 | 解析二维码 payload → {classId, stuNo, name} |
| `loadCert` | function | server.js:106 | 自签证书加载，IP SAN 不匹配自动重签 |
| `sessionStats` | function | server.js:151 | 已交/迟交统计（`s.stats.submitted/late`，前端进度条数据源） |
| `start` | function | server.js:450 | 启动 HTTP+HTTPS+WS，端口占用自动顺延 |
| `findMulti` | function | public/js/qr-hunt.js | 一帧多码识别（ZXing 为主力，jsQR 多码会互相干扰） |
| `broadcast` | variable | server.js:82 | WS 全员推送 |

前端无打包：`public/index.html` 直接 `<script type="module">` 加载，Vue 路由 hash 模式（8 条：/ roster /qr /scan /live/:sid /grade/:sid /history）。

## CONVENTIONS

- **server.js 是 CommonJS**（package.json `"type": "commonjs"`）；**scripts/ 全部是 ESM `.mjs`**。新脚本放 scripts/ 用 .mjs。
- **前端无构建工具**：不引入 bundler/TS，库靠 `npm run vendor` 本地化进 `public/vendor/`。
- **无 ESLint/Prettier/rustfmt 配置**，遵循各语言默认风格即可。
- Commit message 用中文、描述用户可感知的变化（看 git log）。
- 数据结构：单文件 JSON `data/db.json` = `{counter, classes, students, sessions}`，session.submissions 记录扫码顺序与等级。

## ANTI-PATTERNS (THIS PROJECT)

- **禁止编辑 `public/vendor/`** —— 由 `npm run vendor` 生成，会被覆盖。升级库改 `scripts/vendor.js`。
- **禁止直接编辑 `src-tauri/resources/` 和 `dist/` 里的副本** —— 由 `tauri-prepare.mjs` / `make-win-portable.mjs` 从根目录归拢生成（resources/ 已被 src-tauri/.gitignore 忽略，不入库）。改完 `public/` 或 `server.js` 打包前必须重跑 `tauri-prepare.mjs`。
- **禁止在前端用 `prompt()`/`alert()`/`confirm()`** —— Tauri 壳不支持（见 commit 640fb17，看板 ✏️ 弹窗因此失效），用就地编辑。
- **禁止把 `data/` 内容入库** —— 学生名单含隐私，已 gitignore。
- **jsQR 不用于一帧多码场景** —— 多码互相干扰（实测连第一个都解不出），多码走 ZXing WASM；不要把识别优先级改回去。
- **不要引入构建步骤**（vite/webpack）—— 前端刻意无构建、全离线可用。

## COMMANDS

```bash
npm start                          # 启动服务（HTTP 3000 / HTTPS 3443，端口占用自动顺延）
npm test                           # API 回归测试（需服务已运行）
npm run vendor                     # 前端库本地化到 public/vendor/
npm run sync-app                   # 热同步 public/ → 已安装的 macOS App bundle
node scripts/tauri-prepare.mjs     # 归拢资源（改完 public/server.js 后打包前必跑）
cargo tauri build                  # 打包 macOS .app/.dmg（需 Rust + tauri-cli）
node scripts/make-win-portable.mjs # Windows 免安装绿色包 → dist/
node scripts/api-test.mjs          # = npm test
```

## NOTES

- **三份前端副本**：`public/`（源）→ `src-tauri/resources/public/`（macOS App）→ `dist/.../public/`（Windows 包）。源永远是 `public/`。
- **App 版数据隔离**：macOS App 数据在 `~/Library/Application Support/com.homeworkscan.local/`（sidecar 带 `--data-dir`），与脚本版 `data/db.json` 互不影响；App 通过 stdout 握手获知实际端口。
- **HTTPS 是硬需求**：摄像头只在 HTTPS 页面可用；证书含局域网 IP SAN，IP 变化自动重签，手机需重新放行一次。
- **无 CI**：构建/测试全靠本机手动跑。
- 测试覆盖现状：API 和二维码算法有脚本级测试；Rust 层、Vue 视图、WebSocket 广播、持久化防抖均无测试。
