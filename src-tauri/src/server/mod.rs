//! 服务入口：HTTP/HTTPS 双监听、Host 分流、端口顺延、静态资源、WS。
//! 对应 server.js 的 start()/listen()/静态资源/Host 分流逻辑。

mod api;
mod cert;
pub mod db;
mod jsnum;
mod util;
mod ws;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tokio_rustls::TlsAcceptor;
use tower_http::services::ServeDir;

use crate::server::db::{Paths, Store};
use crate::server::util::lan_ips;

pub struct Config {
    pub http_base: u16,
    pub https_base: u16,
    pub data_dir: PathBuf,
    pub public_dir: PathBuf,
    pub app_flag: bool,
}

/// 共享状态：所有 handler 通过 State<Arc<App>> 拿
pub struct App {
    pub store: Arc<Store>,
    pub broadcast: tokio::sync::broadcast::Sender<String>,
    /// 实际监听端口（bind 成功后填入；server-info / WS 校验 / 302 用）
    pub http_port: Mutex<Option<u16>>,
    pub https_port: Mutex<Option<u16>>,
    pub public_dir: PathBuf,
    pub app_flag: bool,
}

impl App {
    pub fn bcast(&self, v: serde_json::Value) {
        let _ = self.broadcast.send(v.to_string());
    }
}

const DEBOUNCE_MS: u64 = 150;
const MAX_BODY: usize = 5 * 1024 * 1024; // express.json({ limit: '5mb' })

/// 拉起 HTTP/HTTPS 双口服务并返回共享状态。
/// Tauri 壳用它拿到端口后导航窗口；菜单「导入旧数据」用 store/broadcast 做免重启导入。
pub async fn run(cfg: Config) -> Result<Arc<App>, String> {
    let paths = Paths::new(cfg.data_dir.clone());
    let (btx, _) = tokio::sync::broadcast::channel::<String>(256);
    let store = Arc::new(Store::load(cfg.data_dir.clone(), cfg.app_flag));
    let app = Arc::new(App {
        store: store.clone(),
        broadcast: btx,
        http_port: Mutex::new(None),
        https_port: Mutex::new(None),
        public_dir: cfg.public_dir.clone(),
        app_flag: cfg.app_flag,
    });

    // 证书先于监听准备就绪（Node 亦然）
    let bundle = cert::load_cert(&paths).map_err(|e| format!("HTTPS 证书准备失败: {e}"))?;
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(bundle.certs, bundle.key)
        .map_err(|e| format!("HTTPS 证书加载失败: {e}"))?;
    let tls_acceptor = TlsAcceptor::from(Arc::new(tls));

    let api_routes = api::router(app.clone());

    let ws_router = Router::new()
        .route("/ws", get(ws::ws_handler))
        .with_state(app.clone());
    let static_router =
        Router::new().fallback_service(ServeDir::new(cfg.public_dir.clone()));
    let inner = Router::new()
        .nest("/api", api_routes)
        .merge(ws_router)
        .fallback_service(static_router.layer(middleware::from_fn(cache_control)))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY));

    // HTTP 明文口：最外层按 Host 分流（loopback → app；本机局域网 IP → 302 HTTPS；其余 → 400）。
    // 不能把业务 app 挂上去再"事后校验"——对应 server.js 里 httpSrv 不挂 app 的安全边界。
    let plain = inner.clone().layer(middleware::from_fn_with_state(
        app.clone(),
        host_guard,
    ));

    // 防抖落盘后台任务
    tokio::spawn(debounce_task(app.store.clone()));

    // HTTP：3000~3009 逐个试
    let mut http_port: Option<u16> = None;
    for i in 0..10u16 {
        match tokio::net::TcpListener::bind(("0.0.0.0", cfg.http_base + i)).await {
            Ok(l) => {
                let port = cfg.http_base + i;
                http_port = Some(port);
                let plain = plain.clone();
                tokio::spawn(async move {
                    if let Err(e) = axum::serve(l, plain).await {
                        eprintln!("HTTP 服务异常: {e}");
                    }
                });
                break;
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::AddrInUse {
                    eprintln!("HTTP 启动失败: {e}");
                }
            }
        }
    }
    *app.http_port.lock().unwrap() = http_port;

    // HTTPS：3443~3452 逐个试
    let mut https_port: Option<u16> = None;
    for i in 0..10u16 {
        match tokio::net::TcpListener::bind(("0.0.0.0", cfg.https_base + i)).await {
            Ok(l) => {
                let port = cfg.https_base + i;
                https_port = Some(port);
                let acceptor = tls_acceptor.clone();
                let tls_router = inner.clone();
                tokio::spawn(async move {
                    loop {
                        let (tcp, _) = match l.accept().await {
                            Ok(v) => v,
                            Err(e) => {
                                eprintln!("HTTPS 接受连接失败: {e}");
                                break;
                            }
                        };
                        let acceptor = acceptor.clone();
                        let tls_router = tls_router.clone();
                        tokio::spawn(async move {
                            if let Ok(tls) = acceptor.accept(tcp).await {
                                // Router 本身是 tower Service，套一层适配 hyper 的 Service trait
                                let svc = hyper_util::service::TowerToHyperService::new(tls_router);
                                if let Err(e) = hyper_util::server::conn::auto::Builder::new(
                                    hyper_util::rt::TokioExecutor::new(),
                                )
                                .serve_connection_with_upgrades(
                                    hyper_util::rt::TokioIo::new(tls),
                                    svc,
                                )
                                .await
                                {
                                    eprintln!("HTTPS 连接异常: {e}");
                                }
                            }
                        });
                    }
                });
                break;
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::AddrInUse {
                    eprintln!("HTTPS 启动失败: {e}");
                }
            }
        }
    }
    *app.https_port.lock().unwrap() = https_port;

    if http_port.is_none() && https_port.is_none() {
        return Err(format!(
            "端口 {}~{} 均被占用，无法启动。",
            cfg.http_base,
            cfg.http_base + 9
        ));
    }

    // 启动横幅（与 Node 版同口径，便于人工核对端口/数据目录）
    println!("==============================================");
    println!("  作业扫码登记 已启动 (rust)");
    if let Some(p) = http_port {
        println!("  电脑端界面:  http://localhost:{p}");
    } else {
        println!("  HTTP 端口全部被占用，电脑端界面不可用");
    }
    if let Some(p) = https_port {
        let ip = lan_ips().first().cloned().unwrap_or_else(|| "本机IP".into());
        println!("  手机扫码页:  https://{ip}:{p}  （用电脑端页面上的二维码打开）");
    } else {
        println!("  HTTPS 端口被占用，手机扫码功能不可用");
    }
    println!("  数据文件:    {}", paths.db_file.display());
    println!("==============================================");

    Ok(app)
}

/// HTTP 明文口的 Host 分流（对应 server.js httpSrv request 监听器）。
/// 逐请求现取局域网 IP：换网络后无需重启即能正确分流/跳转。
async fn host_guard(
    State(app): State<Arc<App>>,
    req: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_string();

    if host == "localhost" || host == "127.0.0.1" {
        return next.run(req).await;
    }
    let my_hosts = crate::server::util::my_hosts();
    if my_hosts.iter().any(|h| h == &host) {
        if let Some(p) = *app.https_port.lock().unwrap() {
            let loc = format!("https://{host}:{p}{}", path_and_query(&req));
            return (
                StatusCode::FOUND,
                [(header::LOCATION, loc)],
            )
                .into_response();
        }
    }
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "请使用电脑端页面上的二维码地址访问",
    )
        .into_response()
}

fn path_and_query(req: &axum::http::Request<axum::body::Body>) -> String {
    match req.uri().path_and_query() {
        Some(pq) => pq.to_string(),
        None => req.uri().path().to_string(),
    }
}

/// 静态资源响应统一 no-cache（WebView 缓存旧 JS 会挡更新，这条不能丢）
async fn cache_control(req: axum::http::Request<axum::body::Body>, next: Next) -> Response {
    let mut res = next.run(req).await;
    res.headers_mut()
        .insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
    res
}

/// 150ms 防抖落盘：等静默期后写一次（语义对齐 saveDb 的 clearTimeout+setTimeout）
async fn debounce_task(store: Arc<Store>) {
    loop {
        store.notified().await;
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
        if store.take_dirty() {
            store.save_now();
        }
    }
}
