//! 自签证书：SAN 覆盖 localhost + 127.0.0.1 + 全部局域网 IPv4；
//! meta.json 里记录上次 SAN 集合，一致则复用（升级安装后手机不需要重新放行），
//! 不一致（换 WiFi）重新生成。对应 server.js loadCert()。

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::server::db::Paths;
use crate::server::util::my_hosts;

pub struct CertBundle {
    pub certs: Vec<rustls_pki_types::CertificateDer<'static>>,
    pub key: rustls_pki_types::PrivateKeyDer<'static>,
}

use rustls_pki_types::pem::PemObject;

pub fn load_cert(paths: &Paths) -> Result<CertBundle, String> {
    let sans = my_hosts();
    if paths.cert_key.exists() && paths.cert_crt.exists() {
        let cert = fs::read_to_string(&paths.cert_crt).unwrap_or_default();
        let meta = fs::read_to_string(paths.cert_crt.with_file_name("cert.pem.meta.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        if let Some(meta) = meta {
            let stored: Vec<String> = meta
                .get("sans")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if stored.len() == sans.len() && sans.iter().all(|ip| stored.contains(ip)) {
                let key = fs::read_to_string(&paths.cert_key).unwrap_or_default();
                chmod_600(&paths.cert_key);
                return parse_bundle(&key, &cert);
            }
            println!("局域网 IP 已变化，重新生成 HTTPS 证书…");
        }
    }

    // 重新生成：ECDSA P-256（浏览器全支持，密钥生成快、包体小），有效期 3650 天
    let sans = sans;
    let mut dns_names: Vec<String> = Vec::new();
    let mut ip_sans: Vec<std::net::Ipv4Addr> = Vec::new();
    for s in &sans {
        if s.parse::<std::net::Ipv4Addr>().is_ok() {
            ip_sans.push(s.parse().unwrap());
        } else {
            dns_names.push(s.clone());
        }
    }
    let key_pair = rcgen::KeyPair::generate().map_err(|e| format!("生成密钥失败: {e}"))?;
    let mut params = rcgen::CertificateParams::new(dns_names)
        .map_err(|e| format!("证书参数无效: {e}"))?;
    for ip in &ip_sans {
        params
            .subject_alt_names
            .push(rcgen::SanType::IpAddress(std::net::IpAddr::V4(*ip)));
    }
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "homework-scan.local");
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now;
    params.not_after = now + time::Duration::days(3650);
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("自签证书失败: {e}"))?;
    let key_pem = key_pair.serialize_pem();
    let cert_pem = cert.pem();

    fs::write(&paths.cert_key, &key_pem).map_err(|e| format!("写 key.pem 失败: {e}"))?;
    fs::write(&paths.cert_crt, &cert_pem).map_err(|e| format!("写 cert.pem 失败: {e}"))?;
    fs::write(
        paths.cert_crt.with_file_name("cert.pem.meta.json"),
        serde_json::to_vec(&json!({ "sans": sans })).unwrap(),
    )
    .map_err(|e| format!("写证书元数据失败: {e}"))?;
    chmod_600(&paths.cert_key);
    parse_bundle(&key_pem, &cert_pem)
}

fn parse_bundle(key_pem: &str, cert_pem: &str) -> Result<CertBundle, String> {
    // 兼容旧版 Node 生成的 RSA PKCS#8 key 与新版 ECDSA key（rustls-pemfile 均可解析）
    let certs: Vec<rustls_pki_types::CertificateDer<'static>> =
        rustls_pki_types::CertificateDer::pem_slice_iter(cert_pem.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("证书 PEM 解析失败: {e}"))?;
    let key = rustls_pki_types::PrivateKeyDer::pem_slice_iter(key_pem.as_bytes())
        .next()
        .ok_or_else(|| "密钥 PEM 为空".to_string())?
        .map_err(|e| format!("密钥 PEM 解析失败: {e}"))?;
    Ok(CertBundle { certs, key })
}

fn chmod_600(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perm) = fs::metadata(path).map(|m| m.permissions()) {
            perm.set_mode(0o600);
            let _ = fs::set_permissions(path, perm);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}
