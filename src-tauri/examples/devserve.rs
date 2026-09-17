//! Phase 1 dev bin：非 Tauri 环境独立跑 Rust 服务，用于与 Node 版逐字段对比。
//!
//! 用法：cargo run --example devserve -- \
//!   --http 3110 --https 3610 --data-dir /tmp/hw-rust --public ../public
//!
//! 放在 examples/ 而非 src/bin/：Tauri CLI 会把字典序靠前的 bin 当作应用主程序，
//! examples 不参与 bin 选择，避免打包歧义。

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg_num = |name: &str| -> Option<u16> {
        args.iter().position(|a| a == &format!("--{name}")).and_then(|i| {
            args.get(i + 1)
                .and_then(|v| v.parse::<u16>().ok())
        })
    };
    let arg_str = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == &format!("--{name}"))
            .and_then(|i| args.get(i + 1).cloned())
    };

    let http_base = arg_num("http").unwrap_or(3000);
    let https_base = arg_num("https").unwrap_or(3443);
    let data_dir = std::path::PathBuf::from(
        arg_str("data-dir").unwrap_or_else(|| "data".into()),
    );
    let public_dir = match arg_str("public") {
        Some(p) => std::path::PathBuf::from(p),
        None => ["public", "../public", "../../public", "../../../public"]
            .iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.join("index.html").exists())
            .expect("找不到 public/ 目录，请用 --public 指定"),
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(async move {
        if let Err(e) = homework_scan::server::run(homework_scan::server::Config {
            http_base,
            https_base,
            data_dir: data_dir.clone(),
            public_dir,
            app_flag: false,
        })
        .await
        {
            eprintln!("{e}");
            std::process::exit(1);
        }
        // run() 只是拉起服务；继续等退出信号（Ctrl+C / SIGTERM → 落盘后退出）
        wait_exit_signal().await;
        // 等防抖静默期，把最后一次未落盘的数据写掉
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        std::process::exit(0);
    });
}

async fn wait_exit_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM 监听");
        tokio::select! {
            _ = ctrl_c => println!("收到退出信号"),
            _ = sigterm.recv() => println!("收到 SIGTERM"),
        }
    }
    #[cfg(not(unix))]
    {
        ctrl_c.await.expect("ctrl_c");
        println!("收到退出信号");
    }
}
