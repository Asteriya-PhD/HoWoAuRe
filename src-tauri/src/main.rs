/*
 * 作业扫码登记 — macOS 桌面壳（Tauri 2）
 * 职责：
 *   1. 以 sidecar 方式启动打包在内的 node + server.js（数据目录在 ~/Library/Application Support）
 *   2. 监听子进程 stdout 的 HWSCAN_READY 握手拿到实际端口（端口冲突会自动顺延）
 *   3. 把主窗口导航到 http://127.0.0.1:<port>，退出时优雅停掉服务（SIGTERM→SIGKILL）
 *   4. 菜单：打开数据文件夹 / 导入旧数据(db.json)
 */
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, RunEvent, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct ServerState {
    child: Mutex<Option<CommandChild>>,
    pid: Mutex<Option<u32>>,
    splash_url: Mutex<Option<Url>>,
}

const HTTP_PORT_BASE: &str = "3000";
const HTTPS_PORT_BASE: &str = "3443";

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(ServerState {
                child: Mutex::new(None),
                pid: Mutex::new(None),
                splash_url: Mutex::new(None),
            });
            build_menu(app.handle())?;

            // 记住启动页地址（导入数据重启服务后要跳回来）
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(url) = w.url() {
                    *app.state::<ServerState>().splash_url.lock().unwrap() = Some(url);
                }
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || start_server(&handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}

// ---------- 菜单 ----------

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let open_data =
        tauri::menu::MenuItem::with_id(app, "open_data", "打开数据文件夹", true, None::<&str>)?;
    let import_item = tauri::menu::MenuItem::with_id(
        app,
        "import_db",
        "导入旧数据（db.json）…",
        true,
        None::<&str>,
    )?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &SubmenuBuilder::new(app, "作业扫码登记")
                .about(None)
                .separator()
                .item(&open_data)
                .item(&import_item)
                .separator()
                .quit()
                .build()?,
            &SubmenuBuilder::new(app, "编辑")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?,
            &SubmenuBuilder::new(app, "窗口")
                .minimize()
                .separator()
                .close_window()
                .build()?,
        ])
        .build()?;
    let _ = app.set_menu(menu);

    app.on_menu_event(|app, event| match event.id().as_ref() {
        "open_data" => open_data_folder(app),
        "import_db" => import_db(app),
        _ => {}
    });
    Ok(())
}

// ---------- 路径 ----------

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("homework-scan"))
}

fn find_resource(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    let base = app.path().resource_dir().ok()?;
    // 兼容 bundler 对 resources 的两种落盘布局
    for cand in [base.join(rel), base.join("resources").join(rel)] {
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

// ---------- 服务生命周期 ----------

#[derive(Deserialize, Clone, Copy)]
struct ReadyInfo {
    #[serde(rename = "httpPort")]
    http_port: u16,
    #[serde(rename = "httpsPort")]
    https_port: u16,
}

fn start_server(app: &AppHandle) {
    match spawn_and_wait(app) {
        Ok(ports) => {
            println!(
                "本地服务已就绪: http://127.0.0.1:{} (https:{})",
                ports.http_port, ports.https_port
            );
            if let Some(w) = app.get_webview_window("main") {
                let url: Url = format!("http://127.0.0.1:{}/", ports.http_port)
                    .parse()
                    .expect("valid url");
                match w.navigate(url) {
                    Ok(_) => println!("已导航到服务页面"),
                    Err(e) => eprintln!("导航失败: {e}"),
                }
                let cur = w.url().map(|u| u.to_string()).unwrap_or_default();
                println!("窗口当前地址: {cur}");
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        Err(e) => {
            eprintln!("本地服务启动失败: {e}");
            if let Some(w) = app.get_webview_window("main") {
                let js = format!(
                    "window.__appError && window.__appError({})",
                    serde_json::to_string(&format!("本地服务启动失败：{e}")).unwrap_or_default()
                );
                let _ = w.eval(&js);
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    }
}

fn spawn_and_wait(app: &AppHandle) -> Result<ReadyInfo, String> {
    let data_dir = data_dir(app);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    kill_stale_servers(&data_dir);

    let server_js = find_resource(app, "server.js")
        .ok_or("找不到内置的 server.js（应用资源不完整，请重新安装）")?;

    let (tx, rx_ready) = std::sync::mpsc::channel::<ReadyInfo>();
    let cmd = app
        .shell()
        // bundler 会把 externalBin 平铺到 Contents/MacOS/hwscan-node（无三元组后缀）
        .sidecar("hwscan-node")
        .map_err(|e| format!("内置 Node 运行时缺失: {e}"))?
        .args([
            server_js.as_os_str(),
            std::ffi::OsStr::new("--data-dir"),
            data_dir.as_os_str(),
            std::ffi::OsStr::new("--http"),
            std::ffi::OsStr::new(HTTP_PORT_BASE),
            std::ffi::OsStr::new("--https"),
            std::ffi::OsStr::new(HTTPS_PORT_BASE),
        ])
        .env("HWSCAN_APP", "1");

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("启动本地服务失败: {e}"))?;
    let pid = child.pid();
    {
        let state = app.state::<ServerState>();
        *state.pid.lock().unwrap() = Some(pid);
        *state.child.lock().unwrap() = Some(child);
    }
    println!("本地服务进程已启动 pid={pid}");

    // 读取子进程输出：日志透传 + 解析 HWSCAN_READY 握手
    std::thread::spawn(move || {
        let mut buffer = String::new();
        loop {
            let Some(event) = tauri::async_runtime::block_on(rx.recv()) else {
                break;
            };
            match event {
                CommandEvent::Stdout(line) => {
                    let s = String::from_utf8_lossy(&line);
                    print!("{s}");
                    buffer.push_str(&s);
                    if let Some(info) = parse_ready(&buffer) {
                        let _ = tx.send(info);
                        break;
                    }
                }
                CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(_s) => break,
                CommandEvent::Error(e) => {
                    eprintln!("本地服务错误: {e}");
                    break;
                }
                _ => {}
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(info) = rx_ready.try_recv() {
            return Ok(info);
        }
        if !pid_alive(pid) {
            return Err("本地服务进程已退出（端口可能被长期占用）".into());
        }
        if Instant::now() > deadline {
            return Err("等待本地服务启动超时".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn parse_ready(buf: &str) -> Option<ReadyInfo> {
    const TAG: &str = "HWSCAN_READY ";
    let idx = buf.rfind(TAG)?;
    let rest = &buf[idx + TAG.len()..];
    let end = rest.find('\n').unwrap_or(rest.len());
    serde_json::from_str(rest[..end].trim()).ok()
}

fn stop_server(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let Some(pid) = state.pid.lock().unwrap().take() else {
        return;
    };
    *state.child.lock().unwrap() = None; // 释放句柄，改用信号优雅退出（服务端 SIGTERM 会落盘）
    println!("正在停止本地服务 pid={pid}");
    let _ = std::process::Command::new("/bin/kill")
        .arg(pid.to_string())
        .output();
    for _ in 0..20 {
        if !pid_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    eprintln!("本地服务未响应 SIGTERM，强制结束");
    let _ = std::process::Command::new("/bin/kill")
        .args(["-9", &pid.to_string()])
        .output();
}

fn restart_server(app: &AppHandle) {
    stop_server(app);
    if let Some(w) = app.get_webview_window("main") {
        if let Some(url) = app
            .state::<ServerState>()
            .splash_url
            .lock()
            .unwrap()
            .clone()
        {
            let _ = w.navigate(url);
        }
    }
    let handle = app.clone();
    std::thread::spawn(move || start_server(&handle));
}

// ---------- 菜单动作 ----------

fn open_data_folder(app: &AppHandle) {
    let dir = data_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let db = dir.join("db.json");
    let target = if db.exists() { db } else { dir };
    if let Err(e) = app.opener().reveal_item_in_dir(target) {
        eprintln!("打开数据文件夹失败: {e}");
    }
}

fn import_db(app: &AppHandle) {
    let app = app.clone();
    let data_dir = data_dir(&app);
    let _ = std::fs::create_dir_all(&data_dir);
    app.dialog()
        .file()
        .add_filter("JSON 数据文件", &["json"])
        .pick_file(move |path| {
            let Some(path) = path else { return };
            let Ok(src) = path.into_path() else { return };
            let Ok(content) = std::fs::read_to_string(&src) else {
                alert(&app, "无法读取该文件".into());
                return;
            };
            let looks_like_db = serde_json::from_str::<serde_json::Value>(&content)
                .map(|v| v.get("classes").is_some() || v.get("sessions").is_some())
                .unwrap_or(false);
            if !looks_like_db {
                alert(&app, "这不是本系统的数据文件（缺少 classes/sessions 字段）".into());
                return;
            }
            let app2 = app.clone();
            let src2 = src.clone();
            let dir2 = data_dir.clone();
            let do_import = move || do_import_impl(&app2, src2, dir2);
            if data_dir.join("db.json").exists() {
                app.dialog()
                    .message("当前已有数据，导入会覆盖（会先自动备份现有数据）。要继续吗？")
                    .title("导入旧数据")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "导入并覆盖".into(),
                        "取消".into(),
                    ))
                    .show(move |ok| {
                        if ok {
                            do_import();
                        }
                    });
            } else {
                do_import();
            }
        });
}

fn do_import_impl(app: &AppHandle, src: PathBuf, data_dir: PathBuf) {
    let dst = data_dir.join("db.json");
    if dst.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let bak = data_dir.join(format!("db-import-backup-{ts}.json"));
        let _ = std::fs::copy(&dst, &bak);
    }
    if let Err(e) = std::fs::copy(&src, &dst) {
        alert(app, format!("导入失败：{e}"));
        return;
    }
    restart_server(app);
}

fn alert(app: &AppHandle, msg: String) {
    app.dialog().message(msg).title("作业扫码登记").show(|_| {});
}

// ---------- 进程工具 ----------

fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 清理上次异常退出残留的本 App 服务进程（命令行里带本 App 数据目录的 server.js）
fn kill_stale_servers(data_dir: &std::path::Path) {
    let tag = data_dir.to_string_lossy().to_string();
    for base in [3000u16, 3443u16] {
        for port in base..base + 10 {
            let Ok(out) = std::process::Command::new("/usr/sbin/lsof")
                .args(["-nP", "-t", "-i", &format!("tcp:{port}")])
                .output()
            else {
                return;
            };
            for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
                let Ok(ps) = std::process::Command::new("/bin/ps")
                    .args(["-o", "command=", "-p", pid])
                    .output()
                else {
                    continue;
                };
                let cmd = String::from_utf8_lossy(&ps.stdout);
                if cmd.contains("server.js") && cmd.contains(&*tag) {
                    println!("清理残留服务 pid={pid} port={port}");
                    let _ = std::process::Command::new("/bin/kill")
                        .arg(pid)
                        .output();
                }
            }
        }
    }
    // 给 SIGTERM 一点时间释放端口
    std::thread::sleep(Duration::from_millis(600));
}
