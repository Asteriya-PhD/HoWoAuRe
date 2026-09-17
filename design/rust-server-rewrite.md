# Rust 全栈重写说明：把 server.js 层收进 Tauri core

> **状态：Phase 1~3 已完成（2026-09-17），待真实环境验证（真机扫码/换 WiFi）后发版。**
>
> - **Phase 1**（独立可跑）：`src-tauri/src/server/`（mod/api/db/cert/ws/util/jsnum 七个模块）+ `src-tauri/examples/devserve.rs` dev bin（`cargo run --example devserve -- --http 3110 --https 3610 --data-dir /tmp/x --public ../public`）。
>   验证：`BASE=http://localhost:<rust口>/api npm test` 36/36 全绿；`node scripts/api-diff.mjs` 双服务逐字段对比 61/61（含最终 db.json 结构对比）。
>   放 examples/ 而非 src/bin/：Tauri CLI 会把字典序靠前的 bin 当应用主程序（曾把 devserve 打进 .app），examples 不参与 bin 选择。
> - **Phase 2**：main.rs 单进程化——删 sidecar/握手（HWSCAN_READY）/SIGTERM 子进程管理/kill_stale_servers/restart_server，setup 里 `server::run()` 就绪后直接导航窗口；`RunEvent::Exit` flush 落盘；菜单「导入旧数据」改为免重启（备份→拷文件→`value_to_db` 内存替换→save_now→广播 db_changed）。`server::run` 返回 `Arc<App>`（含 store/broadcast/ports）供壳管理。
> - **Phase 3**：删 `tauri-plugin-shell`、`externalBin`、resources 里 server.js/node_modules/package.json、`src-tauri/binaries/`（114MB）；tauri-prepare.mjs 只归拢 public/；`sync-app` 只同步前端（server 已内建）；tauri.conf.json 显式 `mainBinaryName: homework-scan`。
>   按此前决定**保留** Node CLI 脚本版（server.js/启动脚本）与 Windows 便携包（make-win-portable，仍 Node 内核），跑稳定一段时间后再决定删。
> - **产物体积**：.app 145MB → **21MB**，DMG 50MB → **13MB**（验收目标 .app<35MB ✓）。
> - **实测通过**：打包产物两次启动 smoke——服务就绪→窗口导航→app:true→HTTPS 200→SIGTERM 落盘退出；证书 SAN 匹配复用（第二次启动 0 重签）。
> - **记录在案的有意偏差**：请求体非 JSON Content-Type 时 Node 版 req.body undefined 500 崩溃，Rust 版统一 400（Node 是 bug，不照抄）；db.json 里 `leave` 键序在 `submissions` 前（JS 动态追加在末尾），结构等价。新增 Cargo 依赖见 `src-tauri/Cargo.toml`（axum/tokio/rustls/rcgen 等）。
> - **修复的一致性 bug**：Rust 网卡枚举曾混入 utun/VPN 的 /32 点对点地址（Node 以 internal=true 排除）——已对齐过滤，否则断 VPN 会反复重签证书导致手机反复放行。
> - **遗留待办**：真机 HTTPS 扫码全流程、换 WiFi 重签实测；Windows 便携包是否迁移 Rust 版（需 GH Actions 构建，见「worker」流程）；AGENTS.md 的服务端描述仍是 Node 单文件口径，发版时同步更新。

目标：删除 `hwscan-node` sidecar（114MB）、`server.js`、打包内的 `node_modules`（12MB），
HTTP/HTTPS/WS/数据层全部用 Rust 实现在 Tauri 主进程里。**对外契约（HTTP API、WS 消息、db.json 结构）保持逐字节兼容**，
`public/` 前端与手机扫码页零改动。预期 .app 145MB → 25~30MB，DMG 50MB → 15~20MB，Windows zip 同幅下降。

---

## 一、要移植什么（对照 server.js 796 行）

### 1. 数据层（server.js L47~118）
- `data/db.json`：`{ counter, classes[], students[], sessions[], settings.grades[] }`。
- 三类数据**共用一个 id 空间**（`nextId = ++counter`），Rust 里就是一个 `Db` struct + 全局 `Mutex`。
- 写盘：`tmp + rename` 原子写；**150ms 防抖**（后台任务检查 dirty 标记即可，不必逐字复刻 timer 语义）。
- 启动时自动备份 db.json 到 `backups/`；清理上限：`db-` 20 份、`export-` 10 份、`db-before-import-` 10 份。
- 解析失败 → 改名为 `db.json.corrupt-<ts>` 隔离，空数据启动。
- 归一化逻辑照抄，注意细节：
  - `normalizeGrades`：剥零宽字符（`\u200B-\u200D\u2060\uFEFF`）、trim、限 12 字、去重、1~9 档、空则回退 `DEFAULT_GRADES`。
  - `normGroup`/`normGroups` 同一套卫生标准，groups 限 20 个。
  - `sessions[].submissions` 是**键为数字字符串的 map**（`{"103": {order,time,status,grade}}`）——Rust 用 `HashMap<String, Submission>` 或自定义反序列化，序列化后键必须是 `"103"` 这种形态，旧数据才能直接加载。

### 2. HTTP API（19 个路由，express.json 限制 5MB → axum DefaultBodyLimit::max(5MB)）

```
GET  /api/server-info            → { ips[], httpPort, httpsPort, today, app:true }
GET  /api/bootstrap              → 全量 db，sessions 附 stats
POST /api/classes                / DELETE /api/classes/:id
GET  /api/classes/:id/students   / POST /api/classes/:id/students（学号自动补 + 撞号加 '*'）
PUT  /api/students/:id           / DELETE /api/students/:id（级联清 submissions/leave）
POST /api/classes/:id/import     → { students:[{name,stuNo}], mode:'append'|'replace' }
POST /api/classes/:id/groups-import（按姓名匹配、同名用学号消歧、unmatched 回报）
POST /api/classes/:id/groups-clear
GET  /api/export                 → 写 backups/export-*.json，带 X-Backup-Saved 头
POST /api/import                 → 校验 + db-before-import 备份 + 全量还原（保留原 id，counter 取 max）
PUT  /api/settings/grades        → 1~9 档、非空、不重复
POST /api/sessions               / GET /api/sessions/:id（sessionFull 口径）
POST /api/sessions/:id/title | scan | unsubmit | setlate | leave | grade | grade-batch | closed
DELETE /api/sessions/:id
其余 /api/* → 404 { message: '接口不存在' }
```

业务逻辑照抄不改语义：`parseCode`（`HW|classId|stuNo|name` 四段）、`doScan`（去重返回 duplicate、
码与名单不符按姓名匹配报 `stale_code`、分组外拒收 `not_in_group`、closed 后记 late）、
`sessionStats`（分母扣请假、分组场次只算所选组）、`sessionFull`（学生列表按组过滤，附 sub/onLeave/stats）。

### 3. 静态资源（L264）
`public/` 目录用 Tauri resource_dir 定位（沿用 main.rs 里 `find_resource` 的双布局兼容），
每个响应带 `Cache-Control: no-cache`（WebView 缓存旧 JS 会挡更新，这条不能丢）。

### 4. 自签证书（L140~170）
- 逻辑：读 `cert.pem` + `cert.pem.meta.json`，比对当前 SAN 集合（localhost、127.0.0.1、全部局域网 IPv4）；
  一致就复用，不一致（换 WiFi）重新生成。key 文件 chmod 0600（Windows 忽略）。
- Rust 方案：**rcgen**。SAN 集合逻辑照抄；有效期 3650 天。
  - 新证书可直接用 ECDSA P-256（浏览器全支持，密钥生成快，包体小），不必复刻 RSA 2048。
  - 兼容性要点：旧版生成的 key.pem 是 RSA PKCS#8，rustls/ring 可直接加载——**优先复用现有 key.pem/cert.pem**，
    只有 SAN 不匹配时才用 rcgen 重新签。这样升级后手机不需要再做一次"不安全→继续访问"。
- TLS 服务端：`tokio-rustls`（或 axum-server + rustls）。

### 5. 服务器语义（L681~765，这几条是安全边界，逐条保留）
- 端口顺延：HTTP 3000~3009、HTTPS 3443~3452，逐个试 bind；全占则启动失败。
- **HTTP 口按 Host 分流**：`localhost/127.0.0.1` → 走正常 app（本机无证书问题）；
  自身局域网 IP → 302 到 `https://<host>:<httpsPort>`（只允许跳自己的地址，防开放重定向）；
  其他 Host → 400 文本。绝不能先挂 app 再"事后校验"——axum 里用最外层 middleware/独立 service 实现，顺序要对。
- **WS 升级校验**（L739~760）：只收 `/ws`；Host 必须是本机地址；浏览器 Origin 必须在
  `http(s)://<host>:<port>` 允许列表里（loopback 两种协议都放，局域网 IP 只放 https）；不满足直接断连。
- 广播：`Mutex<Vec<WsSink>>` 或 `tokio::sync::broadcast`；消息类型与字段**原样保留**：
  `classes_changed`、`students_changed{classId}`、`sessions_changed`、
  `scan{sid,studentId,name,stuNo,order,status,time,stats}`、`unsubmit`、`setlate`、`grade`、
  `grade_batch`、`leave`、`settings_changed`、`session_closed{closed}`、`db_changed`。

### 6. server-info
`app` 字段桌面版恒为 `true`（前端据此隐藏 Node CLI 相关提示的话再核对 public/ 里怎么用它）。

## 二、明确不做（随 Node 一起消失）
- Node CLI 模式：`--open`、防火墙提示文案、`npm start`、`HWSCAN_READY` 握手。
- main.rs 里的：`spawn_and_wait`、`parse_ready`、`stop_server`（SIGTERM/SIGKILL）、
  `restart_server`、`kill_stale_servers`（lsof/ps 清残留——单进程后不存在残留进程问题）、
  `ServerState` 的 child/pid 字段、`tauri-plugin-shell` 依赖。
- 打包：`externalBin`、resources 里的 `server.js`/`node_modules`；`sync-app` npm script 删除。

## 三、main.rs 改法
- `setup` 里起 tokio 任务跑服务，端口就绪后通过 channel 回主线程 → `w.navigate(http://127.0.0.1:<port>)` → show/focus。
  失败路径保留现有 `window.__appError` 提示逻辑。
- 服务模块放 `src-tauri/src/server/`（建议拆 db.rs / api.rs / cert.rs / ws.rs，别单文件塞 800 行）。
- `RunEvent::Exit` 里改为：flush 未落盘数据（原 SIGTERM 语义）。
- 菜单「导入旧数据」不再需要重启服务：拷文件 → 备份现有 → 读入内存替换 `Db` → broadcast `db_changed`。
  webview 导航逻辑和 splash_url 也可简化（服务不重启，页面不用跳回）。
- 依赖新增：`axum`、`tokio`（features: macros, rt-multi-thread）、`tower`、`tokio-rustls`/`rustls`、
  `rcgen`、`chrono`（本地日期 todayStr）、`serde/serde_json`（已有）。
  移除：`tauri-plugin-shell`。

## 四、tauri.conf.json 改法
```diff
-  "externalBin": ["binaries/hwscan-node"],
   "resources": {
-    "resources/server.js": ".",
-    "resources/node_modules": "node_modules",
     "resources/public": "public"
   }
```
`build.frontendDist: ../app-ui` 保留（splash 页仍用它，服务就绪后导航走真 HTTP，
手机端才能访问同一套页面）。

## 五、分期落地
1. **Phase 1 — 独立可跑**：`server/` 模块 + 一个 `cargo run` 的 dev bin（非 Tauri 环境），
   用 `scripts/api-test.mjs` 改端口打全部接口，和现 Node 版逐字段对比响应。
2. **Phase 2 — 接入 Tauri**：setup 起服务、导航窗口、Exit flush；改 tauri.conf.json；删 sidecar 相关代码。
3. **Phase 3 — 清理**：删 `hwscan-node` 二进制、`resources/server.js`、`node_modules` 里的 express/ws/selfsigned
   （devDeps 里的 vue 等与打包无关，不动）、`sync-app` 脚本；README 安装说明里防火墙/体积描述更新。

## 六、验收清单
- [ ] `api-test.mjs` 全绿（Rust 服务）
- [ ] 手机 HTTPS 扫码全流程：连续扫码登记、重复扫去重、补交、分组拒收、请假、批改 1~9、撤销、导出 Excel
- [ ] 换 WiFi（IP 变化）→ 证书自动重签；升级安装后旧证书直接复用（不再弹一次性放行）
- [ ] 3000/3443 被占 → 自动顺延；全占 → 启动失败提示
- [ ] 明文口安全边界：curl 局域网 IP 得 302 到 https；伪造 Host 得 400；WS 假 Origin 被断
- [ ] 数据兼容：现有 `db.json`（Node 版产出）无损加载；导出→导入回环；损坏文件隔离；备份清理上限生效
- [ ] Windows：`启动作业扫码.bat` 流程改为一键（单 exe，无需 zip 内 Node）；chmod 相关代码 no-op 无报错
- [ ] .app/DMG/zip 体积达到预期量级（.app < 35MB）
