//! 作业扫码登记 — 服务核心（与 Tauri 壳解耦）
//!
//! `server` 模块实现原 server.js 的全部对外契约：
//! HTTP API / WebSocket 消息 / db.json 结构 / HTTPS 证书策略。
//! Phase 1 由 `src/bin/devserve.rs` 独立驱动（非 Tauri 环境），
//! Phase 2 起由 main.rs 在 setup 阶段拉起。

pub mod server;
