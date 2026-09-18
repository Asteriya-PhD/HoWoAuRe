//! 数据层：db.json 结构、容错加载、原子写盘、防抖触发、启动备份与清理、归一化。
//! 对应 server.js L47~118 + normalize 系列函数。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::de::Deserializer;
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::server::jsnum::JsNum;
use crate::server::util;

pub const DEFAULT_GRADES: [&str; 4] = ["A+", "A", "A-", "不合格"];
pub const DEFAULT_SUBJECTS: [&str; 10] = [
    "语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治", "科学",
];
pub const MAX_SAFE_INT: f64 = 9.007199254740992e15;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Class {
    pub id: i64,
    pub name: String,
    #[serde(rename = "createdAt", with = "jsnum")]
    pub created_at: JsNum,
}

/// 学生：group 是 Option —— Node 里部分学生（POST /students 创建）没有 group 键，
/// PUT/import 后才出现。Option 保留这一形态差异。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Student {
    pub id: i64,
    pub class_id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub stu_no: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Submission {
    #[serde(with = "jsnum")]
    pub order: JsNum,
    #[serde(with = "jsnum")]
    pub time: JsNum,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub grade: Value, // null | string（脏数据可能残留数字，透传）
}

/// 场次。groups/leave 保持原始形态：
/// - groups 未归一化存在旧数据里，业务逻辑用 norm_groups() 现场洗；
/// - leave 是 Option：老场次没有这个键（Node 序列化时保持缺席）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: i64,
    #[serde(rename = "classId")]
    pub class_id: i64,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub date: String,
    #[serde(rename = "createdAt", with = "jsnum")]
    pub created_at: JsNum,
    #[serde(default)]
    pub closed: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub groups: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave: Option<LeaveMap>,
    #[serde(default)]
    pub submissions: SubMap,
}

/// 等级体系设置。额外键（未来兼容）flatten 保留 —— Node 的 normalizeSettings 会保留未知键。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub grades: Vec<String>,
    #[serde(default)]
    pub subjects: Vec<String>,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Db {
    pub counter: i64,
    #[serde(default)]
    pub classes: Vec<Class>,
    #[serde(default)]
    pub students: Vec<Student>,
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub settings: Settings,
}

impl Db {
    /// nextId = ++counter（三类数据共用一个 id 空间）
    pub fn next_id(&mut self) -> i64 {
        self.counter += 1;
        self.counter
    }
}

mod jsnum {
    pub use super::super::jsnum::{deserialize, serialize};
}

// ---------- 带键序的 map（JS 对象：整数键升序在前，其余按字典序） ----------

fn key_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<i64>(), b.parse::<i64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        (Ok(_), Err(_)) => std::cmp::Ordering::Less,
        (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
        (Err(_), Err(_)) => a.cmp(b),
    }
}

/// submissions：键为学生 id 的数字字符串（{"103": {...}}），旧数据直接加载。
#[derive(Debug, Clone, Default)]
pub struct SubMap(pub BTreeMap<String, Submission>);

impl SubMap {
    pub fn get(&self, k: &str) -> Option<&Submission> {
        self.0.get(k)
    }
    pub fn insert(&mut self, k: impl Into<String>, v: Submission) {
        self.0.insert(k.into(), v);
    }
    pub fn remove(&mut self, k: &str) {
        self.0.remove(k);
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for SubMap {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let entries = self.0.iter().map(|(k, v)| (k.clone(), to_value(v)));
        ordered_map(entries).serialize(s)
    }
}
impl<'de> Deserialize<'de> for SubMap {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let m: Map<String, Value> = Map::deserialize(d)?;
        let mut out = BTreeMap::new();
        for (k, v) in m {
            if let Ok(sub) = serde_json::from_value::<Submission>(v) {
                out.insert(k, sub);
            }
        }
        Ok(SubMap(out))
    }
}

/// leave：{ [studentId]: 时间戳 }
#[derive(Debug, Clone, Default)]
pub struct LeaveMap(pub BTreeMap<String, JsNum>);

impl LeaveMap {
    pub fn get(&self, k: &str) -> Option<&JsNum> {
        self.0.get(k)
    }
    pub fn insert(&mut self, k: impl Into<String>, v: JsNum) {
        self.0.insert(k.into(), v);
    }
    pub fn remove(&mut self, k: &str) {
        self.0.remove(k);
    }
}

impl Serialize for LeaveMap {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let entries = self.0.iter().map(|(k, v)| (k.clone(), jsnum_val(v)));
        ordered_map(entries).serialize(s)
    }
}
impl<'de> Deserialize<'de> for LeaveMap {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let m: Map<String, Value> = Map::deserialize(d)?;
        let mut out = BTreeMap::new();
        for (k, v) in m {
            let n = super::jsnum::coerce(Some(&v));
            if n.is_finite() {
                out.insert(k, n);
            }
        }
        Ok(LeaveMap(out))
    }
}

fn jsnum_val(v: &JsNum) -> Value {
    let mut s = serde_json::Serializer::new(Vec::new());
    super::jsnum::serialize(v, &mut s).ok();
    serde_json::from_slice(&s.into_inner()).unwrap_or(Value::Null)
}

/// JS 对象键序：整数键升序在前，其余字典序
fn ordered_map(entries: impl IntoIterator<Item = (String, Value)>) -> Map<String, Value> {
    let mut list: Vec<(String, Value)> = entries.into_iter().collect();
    list.sort_by(|a, b| key_cmp(&a.0, &b.0));
    let mut m = Map::new();
    for (k, v) in list {
        m.insert(k, v);
    }
    m
}

pub fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

// ---------- 归一化（照抄 server.js） ----------

/// normalizeGrades：剥零宽字符、trim、限 12 字、去重、1~9 档；空则回退默认
pub fn normalize_grades(list: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = list {
        for g in items.iter() {
            if !g.is_string() {
                continue; // 只收字符串
            }
            let s = strip_zero_width(g.as_str().unwrap());
            let s = s.trim().chars().take(12).collect::<String>();
            if !s.is_empty() && !out.contains(&s) {
                out.push(s);
            }
        }
    }
    if out.is_empty() {
        DEFAULT_GRADES.iter().map(|s| s.to_string()).collect()
    } else {
        out.truncate(9);
        out
    }
}

/// normalizeSubjects：同 normalizeGrades 的卫生标准，1~12 个；空则回退默认
pub fn normalize_subjects(list: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = list {
        for g in items.iter() {
            if !g.is_string() {
                continue; // 只收字符串
            }
            let s = strip_zero_width(g.as_str().unwrap());
            let s = s.trim().chars().take(12).collect::<String>();
            if !s.is_empty() && !out.contains(&s) {
                out.push(s);
            }
        }
    }
    if out.is_empty() {
        DEFAULT_SUBJECTS.iter().map(|s| s.to_string()).collect()
    } else {
        out.truncate(12);
        out
    }
}

/// 剥零宽/格式字符（\u200B-\u200D \u2060 \uFEFF）
pub fn strip_zero_width(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(*c, '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}'))
        .collect()
}

/// normGroup：剥零宽、收空白、限长 12（与等级名同一套卫生标准）
pub fn norm_group(v: Option<&Value>) -> String {
    let raw = match v {
        None | Some(Value::Null) => String::new(),
        Some(other) => util::js_string(other),
    };
    let s = strip_zero_width(&raw).trim().split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(12).collect()
}

    /// normGroups：去重去空、限 20 个；非数组 → []
pub fn norm_groups(v: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = v {
        for item in items {
            let g = norm_group(Some(item));
            if !g.is_empty() && !out.contains(&g) {
                out.push(g);
            }
        }
    }
    out.truncate(20);
    out
}

/// cleanLeave：只收安全整数键 + 有限时间戳
pub fn clean_leave(v: &Value) -> LeaveMap {
    let mut out = BTreeMap::new();
    if let Value::Object(m) = v {
        for (k, val) in m {
            let id = super::jsnum::coerce(Some(&Value::String(k.clone())));
            let ts = super::jsnum::coerce(Some(val));
            if id.is_finite() && id.fract() == 0.0 && id > 0.0 && id.abs() <= MAX_SAFE_INT && ts.is_finite() {
                out.insert(super::jsnum::num_key(id), ts);
            }
        }
    }
    LeaveMap(out)
}

/// cleanSubs：只收非空对象（null/数组等脏值丢弃，否则统计会崩）
pub fn clean_subs(v: &Value) -> SubMap {
    let mut out = BTreeMap::new();
    if let Value::Object(m) = v {
        for (k, val) in m {
            if val.is_object() {
                if let Ok(sub) = serde_json::from_value::<Submission>(val.clone()) {
                    out.insert(k.clone(), sub);
                }
            }
        }
    }
    SubMap(out)
}

// ---------- 存储与防抖 ----------

pub struct Paths {
    pub data_dir: PathBuf,
    pub backup_dir: PathBuf,
    pub db_file: PathBuf,
    pub cert_key: PathBuf,
    pub cert_crt: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> Self {
        Paths {
            backup_dir: data_dir.join("backups"),
            db_file: data_dir.join("db.json"),
            cert_key: data_dir.join("key.pem"),
            cert_crt: data_dir.join("cert.pem"),
            data_dir,
        }
    }
}

pub struct Store {
    pub paths: Paths,
    db: Mutex<Db>,
    dirty: Mutex<bool>,
    notify: Arc<tokio::sync::Notify>,
    pub app_flag: bool,
}

impl Store {
    /// loadDb：解析失败 → 隔离为 db.json.corrupt-<ts> 后空数据启动；成功 → 启动备份 + 清理
    pub fn load(data_dir: PathBuf, app_flag: bool) -> Store {
        let paths = Paths::new(data_dir);
        let _ = std::fs::create_dir_all(&paths.backup_dir);
        // 空数据启动时也要带上默认等级/科目体系（对应 Node 里初始 db 字面量）
        let mut db = Db {
            settings: Settings {
                grades: DEFAULT_GRADES.iter().map(|s| s.to_string()).collect(),
                subjects: DEFAULT_SUBJECTS.iter().map(|s| s.to_string()).collect(),
                extra: Map::new(),
            },
            ..Default::default()
        };

        if paths.db_file.exists() {
            let raw = std::fs::read_to_string(&paths.db_file).unwrap_or_default();
            match serde_json::from_str::<Value>(&raw) {
                Ok(v) => {
                    db = value_to_db(&v);
                    // 每次启动自动备份，保留最近 20 份
                    let backup = paths
                        .backup_dir
                        .join(format!("db-{}.json", util::backup_ts()));
                    let _ = std::fs::copy(&paths.db_file, &backup);
                    prune_backups(&paths.backup_dir);
                }
                Err(_) => {
                    let corrupt = paths
                        .db_file
                        .with_file_name(format!("db.json.corrupt-{}", util::epoch_ms()));
                    // Node 版在这里 rename 后 copyFileSync 会因文件缺失而崩溃（历史 bug）；
                    // 这里的意图（验收清单：损坏文件隔离）是隔离后以空数据继续
                    let _ = std::fs::rename(&paths.db_file, &corrupt);
                    eprintln!(
                        "数据文件损坏，已备份到 {}，将以空数据启动",
                        corrupt.display()
                    );
                }
            }
        }

        Store {
            paths,
            db: Mutex::new(db),
            dirty: Mutex::new(false),
            notify: Arc::new(tokio::sync::Notify::new()),
            app_flag,
        }
    }

    pub fn notified(&self) -> impl std::future::Future<Output = ()> {
        let n = self.notify.clone();
        async move { n.notified().await }
    }

    /// saveDb()：标记脏 + 唤醒防抖任务
    pub fn touch(&self) {
        *self.dirty.lock().unwrap() = true;
        self.notify.notify_one();
    }

    pub fn take_dirty(&self) -> bool {
        let mut guard = self.dirty.lock().unwrap();
        std::mem::replace(&mut *guard, false)
    }

    /// saveDbNow()：tmp + rename 原子写
    pub fn save_now(&self) {
        let json = {
            let db = self.db.lock().unwrap();
            serde_json::to_vec(&*db).unwrap_or_default()
        };
        let tmp = self.paths.db_file.with_extension("json.tmp");
        if std::fs::write(&tmp, &json).is_ok() {
            let _ = std::fs::rename(&tmp, &self.paths.db_file);
        }
        *self.dirty.lock().unwrap() = false;
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut Db) -> R) -> R {
        let mut db = self.db.lock().unwrap();
        f(&mut db)
    }
}

/// 备份目录统一清理：db-*/export-*/db-before-import-* 各保留最近 N 份
pub fn prune_backups(backup_dir: &Path) {
    const CAPS: [(&str, usize); 3] = [
        ("db-before-import-", 10),
        ("export-", 10),
        ("db-", 20),
    ];
    let Ok(files) = std::fs::read_dir(backup_dir) else { return };
    let names: Vec<String> = files
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    for (prefix, keep) in CAPS {
        let mut list: Vec<String> = names
            .iter()
            .filter(|f| {
                f.starts_with(prefix)
                    && f.ends_with(".json")
                    && (prefix != "db-" || !f.starts_with("db-before-import-"))
            })
            .cloned()
            .collect();
        list.sort();
        while list.len() > keep {
            let _ = std::fs::remove_file(backup_dir.join(list.remove(0)));
        }
    }
}

/// value → Db：容错转换（数组逐项解析，脏项丢弃；counter/grades 按 Node 不变量归一化）。
/// 供启动加载与 App 菜单「导入旧数据」共用（导入不再重启服务）。
pub fn value_to_db(v: &Value) -> Db {
    let counter = match v.get("counter") {
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|f| f.fract() == 0.0 && *f > 0.0 && f.abs() <= MAX_SAFE_INT)
            .map(|f| f as i64)
            .unwrap_or(0),
        _ => 0,
    };
    let mut db = Db {
        counter,
        ..Default::default()
    };
    if let Value::Array(arr) = v.get("classes").unwrap_or(&Value::Null) {
        for item in arr {
            if let Ok(c) = serde_json::from_value::<Class>(item.clone()) {
                db.classes.push(c);
            }
        }
    }
    if let Value::Array(arr) = v.get("students").unwrap_or(&Value::Null) {
        for item in arr {
            if let Ok(s) = serde_json::from_value::<Student>(item.clone()) {
                db.students.push(s);
            }
        }
    }
    if let Value::Array(arr) = v.get("sessions").unwrap_or(&Value::Null) {
        for item in arr {
            if let Ok(s) = serde_json::from_value::<Session>(item.clone()) {
                db.sessions.push(s);
            }
        }
    }
    // normalizeSettings + normalizeGrades + normalizeSubjects
    let settings = v.get("settings").cloned().unwrap_or(Value::Null);
    db.settings.grades = normalize_grades(settings.get("grades"));
    db.settings.subjects = normalize_subjects(settings.get("subjects"));
    if let Value::Object(m) = &settings {
        for (k, val) in m {
            if k != "grades" && k != "subjects" {
                db.settings.extra.insert(k.clone(), val.clone());
            }
        }
    }
    db
}
