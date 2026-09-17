//! WebSocket：握手校验 + 广播。对应 server.js 的 upgrade 监听器语义：
//! 只收 /ws；Host 必须是本机地址；浏览器 Origin 必须在允许列表里，否则断连。

use std::sync::Arc;

use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};

use crate::server::util::my_hosts;
use crate::server::App;

pub async fn ws_handler(
    State(app): State<Arc<App>>,
    ws: WebSocketUpgrade,
    headers: HeaderMap,
) -> Response {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_string();
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let hosts = my_hosts();
    let http_port = *app.http_port.lock().unwrap();
    let https_port = *app.https_port.lock().unwrap();

    // 手机扫码页走 https://局域网IP:端口；老师电脑/Tauri 壳走 http://localhost:HTTP端口
    let ok_origins: Vec<String> = if host == "localhost" || host == "127.0.0.1" {
        let mut v = Vec::new();
        if let Some(p) = http_port {
            v.push(format!("http://{host}:{p}"));
        }
        if let Some(p) = https_port {
            v.push(format!("https://{host}:{p}"));
        }
        v
    } else if let Some(p) = https_port {
        vec![format!("https://{host}:{p}")]
    } else {
        Vec::new()
    };

    if !hosts.iter().any(|h| h == &host)
        || (!origin.is_empty() && !ok_origin(&ok_origins, &origin))
    {
        // 拒绝：与 Node 的 socket.destroy() 同效 —— 握手失败
        return StatusCode::FORBIDDEN.into_response();
    }

    ws.on_upgrade(move |socket| ws_loop(app, socket))
}

fn ok_origin(list: &[String], origin: &str) -> bool {
    list.iter().any(|o| o == origin)
}

async fn ws_loop(app: Arc<App>, socket: WebSocket) {
    let (mut tx, mut rx) = socket.split();
    let mut bcast_rx = app.broadcast.subscribe();
    loop {
        tokio::select! {
            msg = bcast_rx.recv() => {
                match msg {
                    Ok(text) => {
                        if tx.send(axum::extract::ws::Message::Text(text.into())).await.is_err() {
                            break; // B1：连接断了及时退出，否则死连接常驻内存
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue, // 跳过积压
                    Err(_) => break,
                }
            }
            incoming = rx.next() => match incoming {
                Some(Ok(_)) => {}                       // 客户端不发消息，忽略
                Some(Err(_)) | None => break,           // 关闭/错误 → 结束
            },
        }
    }
}
