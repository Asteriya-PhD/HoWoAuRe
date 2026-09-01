# public/ — 前端 SPA

Vue 3 无构建 SPA，hash 路由。`index.html` 直接 `<script type="module">` 加载一切，全库本地化、纯离线可用。

## STRUCTURE

```
public/
├── index.html        # 唯一 HTML 入口，在此挂全部 script 标签
├── css/app.css       # 全局样式
├── js/
│   ├── app.js        # Vue Router 装配（8 条 hash 路由）
│   ├── store.js      # 全局状态 + WebSocket 实时同步（connectWs/broadcast handle）
│   ├── scan-engine.js# 摄像头引擎：补光/变焦/换镜头/广角预览/抓帧诊断
│   ├── qr-hunt.js    # 一帧多码识别核心 findMulti()（BarcodeDetector→ZXing→jsQR 回退）
│   ├── qr-pdf.js     # jsPDF 二维码贴纸排版（1份/人、1行6个、1页36个）
│   ├── audio.js      # 识别成功提示音
│   ├── util.js       # 通用工具
│   └── views/        # 每视图一个自包含 JS 对象：home 工作台 / roster 名单 / qr 生成 / scan 手机扫码 / live 大屏 / grade 批改 / history 历史
└── vendor/           # 本地化第三方库（生成的，勿手改）
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| 加新页面 | `views/` 新建文件 + `app.js` 加路由 + `index.html` 加 script 标签 |
| 跨页实时数据 | `store.js`（WS 消息 → store → 各视图响应式更新） |
| 识别率问题 | `qr-hunt.js`；用页面 🐞 抓帧诊断看各引擎实际结果 |
| 扫码交互/相机档位 | `scan-engine.js`（8 秒超时自动换挡重试在 App 层） |
| 贴纸排版 | `qr-pdf.js` |

## CONVENTIONS

- 每个视图是自包含 JS 对象（无 .vue SFC、无组件编译），模板用字符串/渲染函数写在 JS 里。
- 新增第三方库：装 devDependency → 在 `scripts/vendor.js` 登记 → `npm run vendor`，页面引用 `vendor/` 下的本地文件，**不引 CDN**。
- 库版本与依赖以 `scripts/vendor.js` 为准（vendor/ 是产物）。

## ANTI-PATTERNS

- 页面引用库**只走本地 `vendor/` 文件，不引 CDN**（离线是硬需求）。
- 其余全局禁令（勿改 vendor、勿引入构建器、勿用 prompt 等）见根目录 AGENTS.md。
