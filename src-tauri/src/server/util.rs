//! JS 语义工具：字符串/数值 coercion、真值判断、日期时间、局域网 IP。
//! server.js 的行为以 JS 为准，移植处一律按 JS 规则实现，避免边缘分叉。

use serde_json::Value;

/// String(v)：对象 → '[object Object]'；数组 → 逗号连接；数字 → JS 格式（整数无小数点）
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => (if *b { "true" } else { "false" }).into(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(f) = n.as_f64() {
                js_num_to_string(f)
            } else {
                n.to_string()
            }
        }
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(), // String(undefined)/String(null)... 数组内 null → 空串（join 语义）
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS String(number)：整数形态无小数点，NaN/Infinity 特殊串
pub fn js_num_to_string(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if n == n.trunc() && n.abs() < 9.007199254740992e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// v || ''：JS 假值（null/undefined/''/0/false/NaN）→ 默认值，其余 String(v)
pub fn js_or_str(v: Option<&Value>, default: &str) -> String {
    if truthy_opt(v) {
        js_string(v.unwrap())
    } else {
        default.into()
    }
}

/// v ?? def：仅 null/undefined（缺键）用默认值
pub fn js_nullish_str(v: Option<&Value>, default: String) -> String {
    match v {
        None | Some(Value::Null) => default,
        Some(other) => js_string(other),
    }
}

/// Number(v)：undefined → NaN；null → 0；见 jsnum::coerce
pub fn js_to_number(v: Option<&Value>) -> f64 {
    super::jsnum::coerce(v)
}

/// +req.params.id：路径参数是字符串
pub fn js_param_num(s: &str) -> f64 {
    super::jsnum::coerce(Some(&Value::String(s.to_string())))
}

/// JS truthy
pub fn truthy_opt(v: Option<&Value>) -> bool {
    match v {
        None => false,
        Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// JS slice(0, n)（按 UTF-16 码元近似为按 char 计数；仅 title 等展示字段用到）
pub fn js_slice(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for ch in s.chars() {
        if count >= n {
            break;
        }
        out.push(ch);
        count += 1;
    }
    out
}

/// Date.now()
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 本机日期 YYYY-MM-DD（todayStr）
pub fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// new Date().toISOString() → replace([:.],'-') → slice(0,19)：
/// "2026-09-17T08-15-30"（UTC）
pub fn backup_ts() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string()
}

/// Date.now()（毫秒整数）——corrupt 文件名用
pub fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 局域网 IPv4 列表（lanIps）
pub fn lan_ips() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for iface in interfaces {
            // 对齐 Node os.networkInterfaces() 的 internal 判定：排除 loopback 接口
            // 与 /32 点对点隧道（utun/VPN，手机不可达，混进 SAN 会导致换网/断 VPN 反复重签证书）
            let if_addrs::IfAddr::V4(v4) = iface.addr else { continue };
            if v4.ip.is_loopback() || iface.name.starts_with("lo") {
                continue;
            }
            if v4.netmask == std::net::Ipv4Addr::new(255, 255, 255, 255) {
                continue;
            }
            let s = v4.ip.to_string();
            if !ips.contains(&s) {
                ips.push(s);
            }
        }
    }
    ips
}

/// 本机可作 Host/证书 SAN 的地址：localhost、127.0.0.1、全部局域网 IPv4（去重）
pub fn my_hosts() -> Vec<String> {
    let mut out = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    for ip in lan_ips() {
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

/// 数值作为对象键：String(1.5)="1.5"、NaN → "NaN"、整数 → "103"
pub fn num_key(n: f64) -> String {
    super::jsnum::num_key(n)
}
