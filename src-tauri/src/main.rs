/*
 * 作业扫码登记 — macOS 桌面壳（Tauri 2，单进程）
 * 职责：
 *   1. setup 阶段拉起内建的 Rust 服务（HTTP/HTTPS/WS，数据目录在 ~/Library/Application Support）
 *   2. 服务就绪后把主窗口导航到 http://127.0.0.1:<port>，show/focus
 *   3. 退出时 flush 未落盘数据（原 SIGTERM 语义）
 *   4. 菜单：打开数据文件夹 / 导入旧数据(db.json)——免重启，内存替换后广播 db_changed
 */
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, RunEvent, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

use homework_scan::server::{self, App as ServerApp};

const HTTP_PORT_BASE: u16 = 3000;
const HTTPS_PORT_BASE: u16 = 3443;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            build_menu(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || start_server(&handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // flush 未落盘数据（防抖中的最后一次写入；原 sidecar SIGTERM 语义）
                if let Some(state) = app.try_state::<Arc<ServerApp>>() {
                    println!("退出前落盘数据…");
                    state.store.save_now();
                }
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

/// public/ 资源定位：兼容 bundler 两种落盘布局；dev 模式下退回仓库源目录
fn find_public_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(base) = app.path().resource_dir() {
        for cand in [base.join("public"), base.join("resources").join("public")] {
            if cand.join("index.html").exists() {
                return Ok(cand);
            }
        }
    }
    // cargo tauri dev 时资源未打包，退回仓库根的 public/
    for cand in ["../public", "../../public", "public"] {
        let cand = std::path::PathBuf::from(cand).canonicalize();
        if let Ok(p) = cand {
            if p.join("index.html").exists() {
                return Ok(p);
            }
        }
    }
    Err("找不到内置页面资源（public/），请重新安装".into())
}

// ---------- 服务生命周期 ----------

fn start_server(app: &AppHandle) {
    let result = (|| -> Result<(), String> {
        let data_dir = data_dir(app);
        std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
        let public_dir = find_public_dir(app)?;
        let cfg = server::Config {
            http_base: HTTP_PORT_BASE,
            https_base: HTTPS_PORT_BASE,
            data_dir,
            public_dir,
            app_flag: true,
        };
        let state = tauri::async_runtime::block_on(server::run(cfg))?;
        app.manage(state.clone());
        let http_port = *state.http_port.lock().unwrap();
        let Some(http_port) = http_port else {
            return Err("本地 HTTP 端口（3000~3009）全部被占用".into());
        };
        println!(
            "本地服务已就绪: http://127.0.0.1:{} (https:{})",
            http_port,
            state.https_port.lock().unwrap().map(|p| p.to_string()).unwrap_or_else(|| "无".into())
        );
        if let Some(w) = app.get_webview_window("main") {
            let url: Url = format!("http://127.0.0.1:{http_port}/")
                .parse()
                .expect("valid url");
            match w.navigate(url) {
                Ok(_) => println!("已导航到服务页面"),
                Err(e) => eprintln!("导航失败: {e}"),
            }
            let _ = w.show();
            let _ = w.set_focus();
        }
        Ok(())
    })();

    if let Err(e) = result {
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

/// 导入：备份现有 db.json → 拷文件 → 读入内存替换 Db → 落盘 + 广播 db_changed。
/// 服务不再重启，前端收到 db_changed 后自行刷新。
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
    let content = match std::fs::read_to_string(&dst) {
        Ok(c) => c,
        Err(e) => {
            alert(app, format!("导入失败：无法读取文件 {e}"));
            return;
        }
    };
    let value = match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(v) => v,
        Err(e) => {
            alert(app, format!("导入失败：文件内容不是合法 JSON（{e}）"));
            return;
        }
    };
    let state = app.state::<Arc<ServerApp>>();
    let new_db = server::db::value_to_db(&value);
    state.store.with(|db| *db = new_db);
    state.store.save_now();
    state.bcast(json!({ "type": "db_changed" }));
}

fn alert(app: &AppHandle, msg: String) {
    app.dialog().message(msg).title("作业扫码登记").show(|_| {});
}
