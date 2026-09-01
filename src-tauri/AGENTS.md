# src-tauri/ — macOS App 壳（Tauri 2）

Rust 壳：以 sidecar 方式拉起内置 Node 跑根目录同一个 `server.js`，stdout 握手获知实际端口，数据目录指向 `~/Library/Application Support/com.homeworkscan.local/`，退出时优雅停服。

## STRUCTURE

```
src-tauri/
├── src/main.rs      # 全部 Rust 逻辑（~425 行）：start_server / spawn_and_wait / stop_server /
│                    #   kill_stale_servers / 菜单（含导入旧 db.json）/ 窗口管理
├── tauri.conf.json  # frontendDist=../app-ui；externalBin=binaries/hwscan-node；
│                    #   resources 指向 server.js+public+node_modules；identifier=com.homeworkscan.local
├── resources/       # tauri-prepare.mjs 的产物（server.js + public/ + node_modules 副本，gitignored）
├── binaries/        # node sidecar 二进制（gitignored，tauri-prepare 生成）
├── app-ui → ../app-ui 是 frontendDist（启动等待页，服务就绪前显示）
└── target/          # cargo 产物（gitignored）；bundle/dmg/ 里是最终 .dmg
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| sidecar 启动/握手 | `main.rs` `spawn_and_wait`（stdout 读端口） |
| 端口残留清理 | `main.rs` `kill_stale_servers` |
| 数据目录/导入旧数据 | `main.rs` `import_db` / `do_import_impl`（导入前自动备份） |
| 菜单项/窗口行为 | `main.rs` 菜单 handlers |
| App 图标 | `icons/`（由 `scripts/make-icon.mjs` 生成，勿手改单个图标） |

## CONVENTIONS

- Cargo release profile：`strip=true, lto=true, codegen-units=1`，edition 2021。
- 前端资源永远从根目录 `public/` 归拢而来，打包前跑 `node scripts/tauri-prepare.mjs`。
- `resources/` 是 gitignored 的产物副本 —— 改了源必须在打包前重新归拢，否则 App 里跑的是旧前端。

## ANTI-PATTERNS

- 不手改 `binaries/`、`target/`、`gen/schemas/`、`icons/`（生成物）。
- Rust 层目前**零测试**，改动 main.rs 后只能靠真机跑 App 验证（`cargo tauri build` → 安装 dmg）。

## COMMANDS

```bash
node scripts/tauri-prepare.mjs   # 先归拢资源
cargo tauri build                # 产物 src-tauri/target/release/bundle/{macos,dmg}/
npm run sync-app                 # 开发期热同步 public/ → 已安装 App bundle（免重打包）
```
