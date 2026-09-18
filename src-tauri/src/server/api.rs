//! REST API：对应 server.js 的全部 19 个路由，语义逐字段照抄。
//! JS 语义（|| / ?? / String() / +x）通过 util 里的助手复刻，防边缘分叉。

use std::collections::HashSet;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use crate::server::db::{
    clean_leave, clean_subs, norm_group, norm_groups, prune_backups, to_value, Class, Db, Session,
    Student, Submission,
};
use crate::server::util::*;
use crate::server::App;

pub fn router(app: Arc<App>) -> Router {
    let r = Router::new()
        .route("/server-info", get(server_info))
        .route("/bootstrap", get(bootstrap))
        .route("/classes", post(create_class))
        .route("/classes/{id}", axum::routing::delete(delete_class))
        .route(
            "/classes/{id}/students",
            get(list_students).post(create_student),
        )
        .route("/classes/{id}/import", post(import_class))
        .route("/classes/{id}/groups-import", post(groups_import))
        .route("/classes/{id}/groups-clear", post(groups_clear))
        .route(
            "/students/{id}",
            axum::routing::put(put_student).delete(delete_student),
        )
        .route("/export", get(export_db))
        .route("/import", post(import_db))
        .route("/settings/grades", axum::routing::put(set_grades))
        .route("/settings/subjects", axum::routing::put(set_subjects))
        .route("/sessions", post(create_session))
        .route("/sessions/{id}", get(get_session).delete(delete_session))
        .route("/sessions/{id}/title", post(set_title))
        .route("/sessions/{id}/subject", post(set_subject))
        .route("/sessions/{id}/scan", post(scan))
        .route("/sessions/{id}/unsubmit", post(unsubmit))
        .route("/sessions/{id}/setlate", post(setlate))
        .route("/sessions/{id}/leave", post(leave))
        .route("/sessions/{id}/grade", post(grade))
        .route("/sessions/{id}/grade-batch", post(grade_batch))
        .route("/sessions/{id}/closed", post(closed))
        .fallback(api_404)
        .with_state(app.clone());
    r
}

// ---------- 响应/请求工具 ----------

fn err(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "message": message }))).into_response()
}

/// express.json({ limit:'5mb', strict:true }) 语义：
/// 只有 application/json(+json) 才解析；空体 → {}；标量顶层/坏 JSON → 400；其他类型 → 未定义({})
async fn parse_body(bytes: &Bytes, headers: &HeaderMap) -> Result<Value, Response> {
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let main_type = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let is_json = main_type == "application/json" || main_type.ends_with("+json");
    if !is_json {
        return Ok(Value::Null);
    }
    if bytes_is_blank(bytes) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(v) if v.is_object() || v.is_array() => Ok(v),
        _ => Err(err(StatusCode::BAD_REQUEST, "请求体不是合法的 JSON")),
    }
}

fn bytes_is_blank(b: &Bytes) -> bool {
    b.iter().all(|c| c.is_ascii_whitespace())
}

fn port_val(m: &std::sync::Mutex<Option<u16>>) -> Value {
    match *m.lock().unwrap() {
        Some(p) => json!(p),
        None => Value::Null,
    }
}

// ---------- 基础信息 ----------

async fn server_info(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!({
        "ips": lan_ips(),
        "httpPort": port_val(&app.http_port),
        "httpsPort": port_val(&app.https_port),
        "today": today_str(),
        "app": app.app_flag,
    }))
}

async fn bootstrap(State(app): State<Arc<App>>) -> Json<Value> {
    let v = app.store.with(|db| {
        let mut obj = Map::new();
        obj.insert("counter".into(), json!(db.counter));
        obj.insert("classes".into(), to_value(&db.classes));
        obj.insert("students".into(), to_value(&db.students));
        let sessions: Vec<Value> = db
            .sessions
            .iter()
            .map(|s| {
                let mut v = to_value(s);
                v["stats"] = stats_value(db, s);
                v
            })
            .collect();
        obj.insert("sessions".into(), Value::Array(sessions));
        obj.insert("settings".into(), to_value(&db.settings));
        Value::Object(obj)
    });
    Json(v)
}

// ---------- 统计与 sessionFull ----------

fn leave_marked(sess: &Session, stu_id: i64) -> bool {
    sess.leave
        .as_ref()
        .map(|m| m.0.get(&stu_id.to_string()).is_some())
        .unwrap_or(false)
}

/// sessionStats：分母扣请假、分组场次只算所选组
pub fn stats_value(db: &Db, sess: &Session) -> Value {
    let ids = sess.submissions.0.len();
    let submitted = sess
        .submissions
        .0
        .values()
        .filter(|s| s.status == "ok")
        .count();
    let late = ids - submitted;
    let groups = norm_groups(Some(&sess.groups));
    let mut candidates: Vec<&Student> = db
        .students
        .iter()
        .filter(|s| s.class_id == sess.class_id)
        .collect();
    if !groups.is_empty() {
        candidates.retain(|s| {
            s.group
                .as_deref()
                .map(|g| groups.contains(&g.to_string()))
                .unwrap_or(false)
        });
    }
    // 请假只算没有提交记录的：请假了但本子也交了 → 算已交、留在分母里
    let leave = candidates
        .iter()
        .filter(|s| leave_marked(sess, s.id) && !sess.submissions.0.contains_key(&s.id.to_string()))
        .count();
    json!({ "submitted": submitted, "late": late, "total": candidates.len() - leave, "leave": leave })
}

/// sessionFull：学生列表按组过滤，附 sub/onLeave/stats
pub fn session_full_value(db: &Db, sess: &Session) -> Value {
    let groups = norm_groups(Some(&sess.groups));
    let mut list: Vec<&Student> = db
        .students
        .iter()
        .filter(|s| s.class_id == sess.class_id)
        .collect();
    if !groups.is_empty() {
        list.retain(|s| {
            s.group
                .as_deref()
                .map(|g| groups.contains(&g.to_string()))
                .unwrap_or(false)
        });
    }
    let students: Vec<Value> = list
        .iter()
        .map(|s| {
            let mut v = to_value(s);
            v["sub"] = sess
                .submissions
                .0
                .get(&s.id.to_string())
                .map(to_value)
                .unwrap_or(Value::Null);
            v["onLeave"] = json!(leave_marked(sess, s.id));
            v
        })
        .collect();
    let mut obj = match to_value(sess) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    obj.insert("stats".into(), stats_value(db, sess));
    obj.insert(
        "className".into(),
        json!(db
            .classes
            .iter()
            .find(|c| c.id == sess.class_id)
            .map(|c| c.name.clone())
            .unwrap_or_else(|| "?".into())),
    );
    obj.insert("students".into(), Value::Array(students));
    Value::Object(obj)
}

fn find_session(db: &Db, id: f64) -> Option<&Session> {
    db.sessions.iter().find(|s| s.id as f64 == id)
}

fn find_session_mut(db: &mut Db, id: f64) -> Option<&mut Session> {
    db.sessions.iter_mut().find(|s| s.id as f64 == id)
}

// ---------- 班级 ----------

async fn create_class(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let name = js_or_str(body.get("name"), "").trim().to_string();
    if name.is_empty() {
        return err(StatusCode::BAD_REQUEST, "班级名称不能为空");
    }
    let cls = app.store.with(|db| {
        let cls = Class {
            id: db.next_id(),
            name,
            created_at: now_ms(),
        };
        db.classes.push(cls.clone());
        cls
    });
    app.store.touch();
    app.bcast(json!({ "type": "classes_changed" }));
    Json(to_value(&cls)).into_response()
}

async fn delete_class(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let _ = parse_body(&body, &headers).await;
    let id = js_param_num(&id);
    let found = app.store.with(|db| {
        let Some(pos) = db.classes.iter().position(|c| c.id as f64 == id) else {
            return false;
        };
        db.classes.remove(pos);
        db.students.retain(|s| s.class_id as f64 != id);
        db.sessions.retain(|s| s.class_id as f64 != id);
        true
    });
    if !found {
        return err(StatusCode::NOT_FOUND, "班级不存在");
    }
    app.store.touch();
    app.bcast(json!({ "type": "classes_changed" }));
    Json(json!({ "ok": true })).into_response()
}

// ---------- 学生 ----------

async fn list_students(State(app): State<Arc<App>>, Path(id): Path<String>) -> Json<Value> {
    let id = js_param_num(&id);
    let v = app.store.with(|db| {
        Value::Array(
            db.students
                .iter()
                .filter(|s| s.class_id as f64 == id)
                .map(to_value)
                .collect(),
        )
    });
    Json(v)
}

async fn create_student(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let cid = js_param_num(&id);
    let cls = app
        .store
        .with(|db| db.classes.iter().find(|c| c.id as f64 == cid).map(|c| c.id));
    let Some(cls) = cls else {
        return err(StatusCode::NOT_FOUND, "班级不存在");
    };
    let name = js_or_str(body.get("name"), "").trim().to_string();
    if name.is_empty() {
        return err(StatusCode::BAD_REQUEST, "姓名不能为空");
    }
    let stu = app.store.with(|db| {
        let classmates: Vec<&Student> = db.students.iter().filter(|s| s.class_id == cls).collect();
        let mut stu_no = js_or_str(body.get("stuNo"), "").trim().to_string();
        if stu_no.is_empty() {
            stu_no = format!("{:02}", classmates.len() + 1);
        }
        while classmates.iter().any(|s| s.stu_no == stu_no) {
            stu_no.push('*');
        }
        let stu = Student {
            id: db.next_id(),
            class_id: cls,
            name,
            stu_no,
            group: None,
        };
        db.students.push(stu.clone());
        stu
    });
    app.store.touch();
    app.bcast(json!({ "type": "students_changed", "classId": cls }));
    Json(to_value(&stu)).into_response()
}

async fn put_student(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let id = js_param_num(&id);
    let result = app.store.with(|db| {
        // 先做不可变快照（校验），再可变更新，避免借用冲突
        let Some((class_id, old_name, old_no, old_group)) = db
            .students
            .iter()
            .find(|s| s.id as f64 == id)
            .map(|s| (s.class_id, s.name.clone(), s.stu_no.clone(), s.group.clone()))
        else {
            return Err((StatusCode::NOT_FOUND, "学生不存在".to_string()));
        };
        let name = js_nullish_str(body.get("name"), old_name)
            .trim()
            .to_string();
        let stu_no = js_nullish_str(body.get("stuNo"), old_no)
            .trim()
            .to_string();
        let group_raw = match body.get("group") {
            Some(v) if !v.is_null() => v.clone(),
            _ => old_group.clone().map(Value::String).unwrap_or(Value::Null),
        };
        let group = norm_group(Some(&group_raw));
        if name.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "姓名不能为空".to_string()));
        }
        if db
            .students
            .iter()
            .any(|s| s.class_id == class_id && s.id as f64 != id && s.stu_no == stu_no)
        {
            return Err((StatusCode::BAD_REQUEST, format!("学号 {stu_no} 已存在")));
        }
        let stu = db
            .students
            .iter_mut()
            .find(|s| s.id as f64 == id)
            .expect("student snapshot checked");
        stu.name = name;
        stu.stu_no = stu_no;
        stu.group = Some(group);
        Ok(to_value(&*stu))
    });
    match result {
        Ok(v) => {
            let class_id = v["classId"].as_i64().unwrap_or(0);
            app.store.touch();
            app.bcast(json!({ "type": "students_changed", "classId": class_id }));
            Json(v).into_response()
        }
        Err((status, msg)) => err(status, &msg),
    }
}

async fn delete_student(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let _ = parse_body(&body, &headers).await;
    let id = js_param_num(&id);
    let class_id = app.store.with(|db| {
        let Some(pos) = db.students.iter().position(|s| s.id as f64 == id) else {
            return None;
        };
        let stu = db.students.remove(pos);
        for sess in db.sessions.iter_mut() {
            sess.submissions.remove(&stu.id.to_string());
            if let Some(leave) = sess.leave.as_mut() {
                leave.remove(&stu.id.to_string());
            }
        }
        Some(stu.class_id)
    });
    let Some(class_id) = class_id else {
        return err(StatusCode::NOT_FOUND, "学生不存在");
    };
    app.store.touch();
    app.bcast(json!({ "type": "students_changed", "classId": class_id }));
    Json(json!({ "ok": true })).into_response()
}

// ---------- 名单导入 ----------

/// JS .replace(/\s+/g, '')：去掉所有空白字符
fn strip_all_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

async fn import_class(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let cid = js_param_num(&id);
    let cls = app
        .store
        .with(|db| db.classes.iter().find(|c| c.id as f64 == cid).map(|c| c.id));
    let Some(cls) = cls else {
        return err(StatusCode::NOT_FOUND, "班级不存在");
    };
    let rows: Vec<&Value> = body
        .get("students")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();

    let mut cleaned: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for row in rows {
        let name = strip_all_ws(&js_or_str(row.get("name"), ""));
        if name.is_empty() {
            continue;
        }
        let mut stu_no = js_nullish_str(row.get("stuNo"), String::new()).trim().to_string();
        if stu_no.is_empty() {
            stu_no = format!("{:02}", cleaned.len() + 1);
        }
        while seen.contains(&stu_no) {
            stu_no.push('*');
        }
        seen.insert(stu_no.clone());
        cleaned.push((name, stu_no));
    }
    if cleaned.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "没有解析到有效名单（需包含\"姓名\"列）",
        );
    }

    let result = app.store.with(|db| {
        if js_string(body.get("mode").unwrap_or(&Value::Null)) == "replace" {
            // 覆盖导入：旧名单连同本班各场次里的提交/请假记录一起清掉，否则孤儿记录会虚高统计
            let old_ids: Vec<i64> = db
                .students
                .iter()
                .filter(|s| s.class_id == cls)
                .map(|s| s.id)
                .collect();
            db.students.retain(|s| s.class_id != cls);
            for sess in db.sessions.iter_mut() {
                if sess.class_id != cls {
                    continue;
                }
                for sid in &old_ids {
                    sess.submissions.remove(&sid.to_string());
                    if let Some(leave) = sess.leave.as_mut() {
                        leave.remove(&sid.to_string());
                    }
                }
            }
            cleaned
        } else {
            // 追加时跳过「姓名+学号」完全重复的行
            let existing: HashSet<String> = db
                .students
                .iter()
                .filter(|s| s.class_id == cls)
                .map(|s| format!("{}|{}", s.name, s.stu_no))
                .collect();
            cleaned
                .into_iter()
                .filter(|(n, no)| !existing.contains(&format!("{n}|{no}")))
                .collect()
        }
    });
    let added_count = result.len();
    // 先写库再统计 total（Node 版 res.json 时名单已含新增）
    let total = app.store.with(|db| {
        for (name, stu_no) in result {
            let rec = Student {
                id: db.next_id(),
                class_id: cls,
                name,
                stu_no,
                group: Some(String::new()),
            };
            db.students.push(rec);
        }
        db.students.iter().filter(|s| s.class_id == cls).count()
    });
    app.store.touch();
    app.bcast(json!({ "type": "students_changed", "classId": cls }));
    Json(json!({ "added": added_count, "total": total })).into_response()
}

// ---------- 分组 ----------

async fn groups_import(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let cid = js_param_num(&id);
    let cls = app
        .store
        .with(|db| db.classes.iter().find(|c| c.id as f64 == cid).map(|c| c.id));
    let Some(cls) = cls else {
        return err(StatusCode::NOT_FOUND, "班级不存在");
    };
    let rows: Vec<&Value> = body
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();

    let result = app.store.with(|db| {
        let classmates: Vec<&Student> = db.students.iter().filter(|s| s.class_id == cls).collect();
        let mut assign: Vec<(i64, String)> = Vec::new();
        let mut unmatched: Vec<String> = Vec::new();
        for row in rows {
            let name = strip_all_ws(&js_or_str(row.get("name"), ""));
            let group = norm_group(row.get("group"));
            if name.is_empty() || group.is_empty() {
                continue;
            }
            let stu_no = js_nullish_str(row.get("stuNo"), String::new()).trim().to_string();
            let by_name: Vec<&&Student> = classmates.iter().filter(|s| s.name == name).collect();
            // 同名多时用学号消歧；学号为空则直接不匹配（JS: stuNo ? find : null）
            let hit = if by_name.len() == 1 {
                Some(by_name[0].id)
            } else if !stu_no.is_empty() {
                by_name.iter().find(|s| s.stu_no == stu_no).map(|s| s.id)
            } else {
                None
            };
            match hit {
                Some(id) => {
                    if let Some(slot) = assign.iter_mut().find(|(i, _)| *i == id) {
                        slot.1 = group.clone(); // JS Map.set：后写覆盖，位置不变
                    } else {
                        assign.push((id, group));
                    }
                }
                None => unmatched.push(name),
            }
        }
        for (id, group) in &assign {
            if let Some(stu) = db.students.iter_mut().find(|s| s.id == *id) {
                stu.group = Some(group.clone());
            }
        }
        let mut seen = HashSet::new();
        let uniq: Vec<String> = unmatched
            .into_iter()
            .filter(|n| seen.insert(n.clone()))
            .collect();
        (assign.len(), uniq)
    });
    let (updated, mut unmatched) = result;
    unmatched.truncate(20);
    app.store.touch();
    app.bcast(json!({ "type": "students_changed", "classId": cls }));
    Json(json!({ "updated": updated, "unmatched": unmatched })).into_response()
}

async fn groups_clear(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let _ = parse_body(&body, &headers).await;
    let cid = js_param_num(&id);
    let cls = app
        .store
        .with(|db| db.classes.iter().find(|c| c.id as f64 == cid).map(|c| c.id));
    let Some(cls) = cls else {
        return err(StatusCode::NOT_FOUND, "班级不存在");
    };
    let n = app.store.with(|db| {
        let mut n = 0;
        for s in db.students.iter_mut().filter(|s| s.class_id == cls) {
            if s.group.as_deref().map(|g| !g.is_empty()).unwrap_or(false) {
                s.group = Some(String::new());
                n += 1;
            }
        }
        n
    });
    if n > 0 {
        app.store.touch();
        app.bcast(json!({ "type": "students_changed", "classId": cls }));
    }
    Json(json!({ "cleared": n })).into_response()
}

// ---------- 备份/还原 ----------

async fn export_db(State(app): State<Arc<App>>) -> Response {
    let value = app.store.with(|db| to_value(&*db));
    let backup_dir = app.store.paths.backup_dir.clone();
    let mut header_saved = false;
    let _ = std::fs::create_dir_all(&backup_dir);
    let path = backup_dir.join(format!("export-{}.json", backup_ts()));
    match serde_json::to_vec(&value) {
        Ok(bytes) => {
            if std::fs::write(&path, bytes).is_ok() {
                prune_backups(&backup_dir);
                header_saved = true;
            } else {
                eprintln!("导出副本写入失败");
            }
        }
        Err(e) => eprintln!("导出副本写入失败: {e}"),
    }
    let mut res = Json(value).into_response();
    if header_saved {
        res.headers_mut().insert("X-Backup-Saved", "1".parse().unwrap());
    }
    res
}

fn is_safe_int(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9.007199254740992e15
}

fn date_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[4] == b'-'
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[7] == b'-'
        && b[8..].iter().all(|c| c.is_ascii_digit())
}

async fn import_db(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let classes_arr = body.get("classes");
    let students_arr = body.get("students");
    if !classes_arr.map(|v| v.is_array()).unwrap_or(false)
        || !students_arr.map(|v| v.is_array()).unwrap_or(false)
    {
        return err(
            StatusCode::BAD_REQUEST,
            "不是本系统的备份文件（缺少班级/名单数据）",
        );
    }
    // 三类数据共用一个 id 空间：全局去重 + 只收安全整数
    let mut seen: HashSet<i64> = HashSet::new();
    let mut unique_id = |v: Option<&Value>| -> Option<i64> {
        let n = super::jsnum::coerce(v);
        if is_safe_int(n) && n > 0.0 && seen.insert(n as i64) {
            Some(n as i64)
        } else {
            None
        }
    };

    let mut new_classes: Vec<Class> = Vec::new();
    for c in classes_arr.unwrap().as_array().unwrap() {
        if !c.is_object() {
            continue;
        }
        let Some(name) = c.get("name").and_then(|v| v.as_str()) else { continue };
        if name.trim().is_empty() {
            continue;
        }
        let Some(id) = unique_id(c.get("id")) else { continue };
        let created_at = c
            .get("createdAt")
            .and_then(|v| v.as_f64())
            .filter(|f| f.is_finite())
            .unwrap_or_else(now_ms);
        new_classes.push(Class {
            id,
            name: name.trim().to_string(),
            created_at,
        });
    }
    let mut new_students: Vec<Student> = Vec::new();
    for s in students_arr.unwrap().as_array().unwrap() {
        if !s.is_object() {
            continue;
        }
        let Some(class_id) = s
            .get("classId")
            .and_then(|v| v.as_f64())
            .filter(|f| is_safe_int(*f))
            .map(|f| f as i64)
        else {
            continue;
        };
        let Some(name) = s.get("name").and_then(|v| v.as_str()) else { continue };
        if name.trim().is_empty() {
            continue;
        }
        let Some(id) = unique_id(s.get("id")) else { continue };
        new_students.push(Student {
            id,
            class_id,
            name: name.trim().to_string(),
            stu_no: js_nullish_str(s.get("stuNo"), String::new()),
            group: Some(norm_group(s.get("group"))),
        });
    }
    let mut new_sessions: Vec<Session> = Vec::new();
    if let Value::Array(arr) = body.get("sessions").unwrap_or(&Value::Null) {
        for s in arr {
            if !s.is_object() {
                continue;
            }
            let Some(class_id) = s
                .get("classId")
                .and_then(|v| v.as_f64())
                .filter(|f| is_safe_int(*f))
                .map(|f| f as i64)
            else {
                continue;
            };
            let Some(subs) = s.get("submissions").filter(|v| v.is_object()) else {
                continue;
            };
            let Some(id) = unique_id(s.get("id")) else { continue };
            let subject = s
                .get("subject")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = s
                .get("title")
                .and_then(|v| v.as_str())
                .map(|t| js_slice(t, 50))
                .unwrap_or_default();
            let date = s
                .get("date")
                .map(js_string)
                .filter(|d| date_ok(d))
                .unwrap_or_default();
            let created_at = s
                .get("createdAt")
                .and_then(|v| v.as_f64())
                .filter(|f| f.is_finite())
                .unwrap_or_else(now_ms);
            new_sessions.push(Session {
                id,
                class_id,
                subject,
                title,
                date,
                created_at,
                closed: truthy_opt(s.get("closed")),
                groups: json!(norm_groups(s.get("groups"))),
                leave: Some(clean_leave(s.get("leave").unwrap_or(&Value::Null))),
                submissions: clean_subs(subs),
            });
        }
    }
    if new_classes.is_empty() {
        return err(StatusCode::BAD_REQUEST, "备份文件里没有班级数据");
    }
    // counter 至少取全部 id 的最大值，避免还原后新建班级/学生撞 id
    let mut counter = match body.get("counter").and_then(|v| v.as_f64()) {
        Some(n) if is_safe_int(n) && n > 0.0 => n,
        _ => 0.0,
    };
    for id in new_classes
        .iter()
        .map(|c| c.id as f64)
        .chain(new_students.iter().map(|s| s.id as f64))
        .chain(new_sessions.iter().map(|s| s.id as f64))
    {
        if id > counter {
            counter = id;
        }
    }
    let counter = counter.min(9.007199254740991e15) as i64;

    // 先把防抖中的最新数据落盘，"导入前备份"才是完整的
    app.store.save_now();
    let backup_dir = app.store.paths.backup_dir.clone();
    let _ = std::fs::create_dir_all(&backup_dir);
    let ts = backup_ts();
    let _ = std::fs::copy(
        &app.store.paths.db_file,
        backup_dir.join(format!("db-before-import-{ts}.json")),
    );
    prune_backups(&backup_dir);
    let counts = (new_classes.len(), new_students.len(), new_sessions.len());
    // 等级/科目体系跟导入文件走（保留当前 settings 的其他键）
    let new_settings = crate::server::db::normalize_grades(
        body.get("settings").and_then(|s| s.get("grades")),
    );
    let new_subjects = crate::server::db::normalize_subjects(
        body.get("settings").and_then(|s| s.get("subjects")),
    );
    app.store.with(|db| {
        let mut settings = db.settings.clone();
        settings.grades = new_settings;
        settings.subjects = new_subjects;
        *db = Db {
            counter,
            classes: new_classes,
            students: new_students,
            sessions: new_sessions,
            settings,
        };
    });
    app.store.save_now();
    app.bcast(json!({ "type": "db_changed" }));
    Json(json!({ "ok": true, "classes": counts.0, "students": counts.1, "sessions": counts.2 })).into_response()
}

// ---------- 设置 ----------

async fn set_grades(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(list) = body.get("grades").and_then(|v| v.as_array()) else {
        return err(StatusCode::BAD_REQUEST, "grades 需要是数组");
    };
    if list.is_empty() {
        return err(StatusCode::BAD_REQUEST, "至少保留一个等级");
    }
    if list.len() > 9 {
        return err(StatusCode::BAD_REQUEST, "等级最多 9 个（键盘 1~9 快捷批改）");
    }
    let mut grades: Vec<String> = Vec::new();
    for g in list {
        // 注意：这里只 trim，不剥零宽字符（与 normalizeGrades 不同，照抄 server.js）
        let s = js_nullish_str(Some(g), String::new())
            .trim()
            .chars()
            .take(12)
            .collect::<String>();
        if s.is_empty() {
            return err(StatusCode::BAD_REQUEST, "等级名称不能为空");
        }
        if grades.contains(&s) {
            return err(StatusCode::BAD_REQUEST, &format!("等级「{s}」重复了"));
        }
        grades.push(s);
    }
    app.store.with(|db| {
        db.settings.grades = grades.clone();
    });
    app.store.touch();
    app.bcast(json!({ "type": "settings_changed" }));
    Json(json!({ "grades": grades })).into_response()
}

/// PUT /settings/subjects：科目快捷列表，语义照抄 server.js 的 /settings/grades
async fn set_subjects(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(list) = body.get("subjects").and_then(|v| v.as_array()) else {
        return err(StatusCode::BAD_REQUEST, "subjects 需要是数组");
    };
    if list.is_empty() {
        return err(StatusCode::BAD_REQUEST, "至少保留一个科目");
    }
    if list.len() > 12 {
        return err(StatusCode::BAD_REQUEST, "科目最多 12 个");
    }
    let mut subjects: Vec<String> = Vec::new();
    for s in list {
        let t = js_nullish_str(Some(s), String::new())
            .trim()
            .chars()
            .take(12)
            .collect::<String>();
        if t.is_empty() {
            return err(StatusCode::BAD_REQUEST, "科目名称不能为空");
        }
        if subjects.contains(&t) {
            return err(StatusCode::BAD_REQUEST, &format!("科目「{t}」重复了"));
        }
        subjects.push(t);
    }
    app.store.with(|db| {
        db.settings.subjects = subjects.clone();
    });
    app.store.touch();
    app.bcast(json!({ "type": "settings_changed" }));
    Json(json!({ "subjects": subjects })).into_response()
}

// ---------- 场次 ----------

async fn create_session(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let cid = js_to_number(body.get("classId"));
    let sess = app.store.with(|db| {
        let Some(cls) = db.classes.iter().find(|c| c.id as f64 == cid) else {
            return None;
        };
        let cls = cls.id;
        let subject = {
            let s = js_or_str(body.get("subject"), "作业").trim().to_string();
            if s.is_empty() {
                "作业".to_string()
            } else {
                s
            }
        };
        let title = js_or_str(body.get("title"), "")
            .trim()
            .chars()
            .take(50)
            .collect::<String>();
        let date = {
            let raw = js_string(body.get("date").unwrap_or(&Value::Null));
            if date_ok(&raw) {
                raw
            } else {
                today_str()
            }
        };
        let groups = norm_groups(body.get("groups"));
        let sess = Session {
            id: db.next_id(),
            class_id: cls,
            subject,
            title,
            date,
            created_at: now_ms(),
            closed: false,
            groups: json!(groups),
            leave: None,
            submissions: Default::default(),
        };
        db.sessions.push(sess.clone());
        Some(sess)
    });
    let Some(sess) = sess else {
        return err(StatusCode::BAD_REQUEST, "请选择班级");
    };
    app.store.touch();
    app.bcast(json!({ "type": "sessions_changed" }));
    Json(to_value(&sess)).into_response()
}

async fn get_session(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let id = js_param_num(&id);
    let v = app.store.with(|db| match find_session(db, id) {
        Some(sess) => session_full_value(db, sess),
        None => Value::Null,
    });
    if v.is_null() {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    Json(v).into_response()
}

async fn set_title(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let id = js_param_num(&id);
    let sess = app.store.with(|db| {
        let Some(sess) = find_session_mut(db, id) else {
            return None;
        };
        sess.title = js_or_str(body.get("title"), "")
            .trim()
            .chars()
            .take(50)
            .collect();
        Some(to_value(&*sess))
    });
    let Some(sess) = sess else {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    };
    app.store.touch();
    app.bcast(json!({ "type": "sessions_changed" }));
    Json(sess).into_response()
}

/// POST /sessions/{id}/subject：改场次科目（留空恢复「作业」），语义照抄 server.js
async fn set_subject(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let id = js_param_num(&id);
    let sess = app.store.with(|db| {
        let Some(sess) = find_session_mut(db, id) else {
            return None;
        };
        let s = js_or_str(body.get("subject"), "").trim().to_string();
        sess.subject = if s.is_empty() { "作业".to_string() } else { s };
        Some(to_value(&*sess))
    });
    let Some(sess) = sess else {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    };
    app.store.touch();
    app.bcast(json!({ "type": "sessions_changed" }));
    Json(sess).into_response()
}

async fn delete_session(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let _ = parse_body(&body, &headers).await;
    let id = js_param_num(&id);
    let found = app.store.with(|db| {
        let Some(pos) = db.sessions.iter().position(|s| s.id as f64 == id) else {
            return false;
        };
        db.sessions.remove(pos);
        true
    });
    if !found {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    app.store.touch();
    app.bcast(json!({ "type": "sessions_changed" }));
    Json(json!({ "ok": true })).into_response()
}

// ---------- 扫码 ----------

/// parseCode：HW|classId|stuNo|name 四段
pub fn parse_code(code: &Value) -> Option<(f64, String, String)> {
    let s = code.as_str()?;
    let parts: Vec<&str> = s.trim().split('|').collect();
    if parts.len() != 4 || parts[0] != "HW" {
        return None;
    }
    let class_id = super::jsnum::coerce(Some(&Value::String(parts[1].into())));
    if !(class_id.is_finite() && class_id.fract() == 0.0) {
        return None;
    }
    if parts[2].is_empty() || parts[3].is_empty() {
        return None;
    }
    Some((class_id, parts[2].to_string(), parts[3].to_string()))
}

/// doScan：解析二维码 → 校验 → 去重 → 按顺序登记（语义照抄 server.js）
pub fn do_scan(db: &mut Db, sid: f64, code: Option<&Value>) -> Value {
    let Some((parsed_class, parsed_no, parsed_name)) = code.and_then(parse_code) else {
        return json!({ "ok": false, "reason": "bad_code", "message": "无法识别的二维码（不是本系统的学生码）" });
    };
    let sess = find_session(db, sid).expect("session exists (route-checked)");
    let cls_name = db
        .classes
        .iter()
        .find(|c| c.id as f64 == sess.class_id as f64)
        .map(|c| c.name.clone())
        .unwrap_or_else(|| "?".into());

    let mates: Vec<Student> = db
        .students
        .iter()
        .filter(|s| s.class_id == sess.class_id)
        .cloned()
        .collect();

    // 码与名单不符：尝试按姓名匹配（可能是旧贴纸/换学号）
    let mut note: Option<String> = None;
    let student: Student = {
        let hit = mates
            .iter()
            .find(|s| s.class_id as f64 == parsed_class && s.stu_no == parsed_no);
        match hit {
            Some(s) => s.clone(),
            None => {
                let by_name: Vec<&Student> =
                    mates.iter().filter(|s| s.name == parsed_name).collect();
                if by_name.len() == 1 {
                    note = Some("stale_code".into());
                    by_name[0].clone()
                } else {
                    return json!({ "ok": false, "reason": "not_found",
                        "message": format!("{} 不在「{}」名单中", parsed_name, cls_name) });
                }
            }
        }
    };

    // 分组检查：不属于所选组的学生拒收（按组名动态匹配，改名单里的组别即时生效）
    let session_groups = norm_groups(Some(&sess.groups));
    if !session_groups.is_empty()
        && !session_groups.contains(&student.group.as_deref().unwrap_or("").to_string())
    {
        return json!({
            "ok": false,
            "reason": "not_in_group",
            "student": to_value(&student),
            "message": format!("{} 不在本次分组（本次只收：{}）", student.name, session_groups.join("、")),
        });
    }

    let stu_key = student.id.to_string();
    if let Some(sub) = sess.submissions.0.get(&stu_key) {
        return json!({
            "ok": true,
            "duplicate": true,
            "note": note,
            "student": to_value(&student),
            "order": super::jsnum::value(sub.order),
            "status": sub.status,
            "stats": stats_value(db, sess),
        });
    }

    let status = if sess.closed { "late" } else { "ok" };
    let order = sess
        .submissions
        .0
        .values()
        .map(|s| s.order)
        .fold(0.0f64, f64::max)
        + 1.0;
    let time = now_ms();
    let sub = Submission {
        order,
        time,
        status: status.to_string(),
        grade: Value::Null,
    };
    // 拿可变引用插入（重新按 id 定位，避免与上面的不可变借用冲突）
    find_session_mut(db, sid)
        .expect("session exists")
        .submissions
        .0
        .insert(stu_key, sub);
    let stats = stats_value(db, find_session(db, sid).expect("session exists"));
    json!({
        "ok": true,
        "duplicate": false,
        "note": note,
        "student": to_value(&student),
        "order": super::jsnum::value(order),
        "status": status,
        "time": super::jsnum::value(time),
        "stats": stats,
    })
}

async fn scan(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let sid = js_param_num(&id);
    let exists = app.store.with(|db| find_session(db, sid).is_some());
    if !exists {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    let result = app.store.with(|db| do_scan(db, sid, body.get("code")));
    // 只在新增登记时广播（重复扫不推）
    if result["ok"] == json!(true) && result["duplicate"] != json!(true) {
        app.bcast(json!({
            "type": "scan",
            "sid": sid as i64,
            "studentId": result["student"]["id"],
            "name": result["student"]["name"],
            "stuNo": result["student"]["stuNo"],
            "order": result["order"],
            "status": result["status"],
            "time": result["time"],
            "stats": result["stats"],
        }));
    }
    Json(result).into_response()
}

// ---------- 收集操作 ----------

async fn unsubmit(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let sid = js_param_num(&id);
    let stu_id = js_to_number(body.get("studentId"));
    let key = num_key(stu_id);
    if app.store.with(|db| find_session(db, sid).is_none()) {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    let stats = app.store.with(|db| {
        find_session_mut(db, sid)
            .expect("session exists")
            .submissions
            .remove(&key);
        stats_value(db, find_session(db, sid).expect("session exists"))
    });
    app.store.touch();
    app.bcast(json!({
        "type": "unsubmit",
        "sid": sid as i64,
        "studentId": super::jsnum::value(stu_id),
        "stats": stats,
    }));
    Json(json!({ "ok": true, "stats": stats })).into_response()
}

async fn setlate(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let sid = js_param_num(&id);
    let stu_id = js_to_number(body.get("studentId"));
    let key = num_key(stu_id);
    let status = if truthy_opt(body.get("late")) { "late" } else { "ok" };
    if app.store.with(|db| find_session(db, sid).is_none()) {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    let hit = app.store.with(|db| {
        find_session_mut(db, sid)
            .expect("session exists")
            .submissions
            .0
            .get_mut(&key)
            .map(|sub| {
                sub.status = status.to_string();
            })
            .is_some()
    });
    if !hit {
        return err(StatusCode::BAD_REQUEST, "该学生尚未登记");
    }
    let stats = app
        .store
        .with(|db| stats_value(db, find_session(db, sid).expect("session exists")));
    app.store.touch();
    app.bcast(json!({
        "type": "setlate",
        "sid": sid as i64,
        "studentId": super::jsnum::value(stu_id),
        "status": status,
        "stats": stats,
    }));
    Json(json!({ "ok": true })).into_response()
}

/// 请假标记：请假学生当次作业默认不收取（分母剔除、未交里看不到）
/// 请假与已交可并存：请假后你又把本子扫进来了，提交记录正常保留并照样打等级
async fn leave(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let sid = js_param_num(&id);
    let stu_id = js_to_number(body.get("studentId"));
    let key = num_key(stu_id);
    if !app.store.with(|db| db.students.iter().any(|s| s.id as f64 == stu_id)) {
        return err(StatusCode::NOT_FOUND, "学生不存在");
    }
    if app.store.with(|db| find_session(db, sid).is_none()) {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    let marking = truthy_opt(body.get("leave"));
    app.store.with(|db| {
        let sess = find_session_mut(db, sid).expect("session exists");
        let m = sess.leave.get_or_insert_with(Default::default);
        if marking {
            m.insert(key.clone(), now_ms());
        } else {
            m.remove(&key);
        }
    });
    let stats = app
        .store
        .with(|db| stats_value(db, find_session(db, sid).expect("session exists")));
    app.store.touch();
    app.bcast(json!({
        "type": "leave",
        "sid": sid as i64,
        "studentId": super::jsnum::value(stu_id),
        "leave": marking,
        "stats": stats,
    }));
    Json(json!({ "ok": true, "stats": stats })).into_response()
}

/// 等级：单个。req.body.grade === null ? null : String(req.body.grade)
/// （未传 grade → String(undefined) = "undefined"，与 Node 版行为一致）
fn grade_value(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Null) => Value::Null,
        None => Value::String("undefined".into()),
        Some(other) => Value::String(js_string(other)),
    }
}

async fn grade(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let sid = js_param_num(&id);
    let stu_id = js_to_number(body.get("studentId"));
    let key = num_key(stu_id);
    let grade = grade_value(body.get("grade"));
    if app.store.with(|db| find_session(db, sid).is_none()) {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    let hit = app.store.with(|db| {
        let Some(sub) = find_session_mut(db, sid)
            .expect("session exists")
            .submissions
            .0
            .get_mut(&key)
        else {
            return false;
        };
        sub.grade = grade.clone();
        true
    });
    if !hit {
        return err(StatusCode::BAD_REQUEST, "该学生尚未登记，不能打等级");
    }
    app.store.touch();
    app.bcast(json!({
        "type": "grade",
        "sid": sid as i64,
        "studentId": super::jsnum::value(stu_id),
        "grade": grade,
    }));
    Json(json!({ "ok": true })).into_response()
}

async fn grade_batch(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let sid = js_param_num(&id);
    let ids: Vec<f64> = body
        .get("studentIds")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(|v| js_to_number(Some(v))).collect())
        .unwrap_or_default();
    let grade = grade_value(body.get("grade"));
    if app.store.with(|db| find_session(db, sid).is_none()) {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    let mut n = 0;
    app.store.with(|db| {
        let sess = find_session_mut(db, sid).expect("session exists");
        for id in &ids {
            if let Some(sub) = sess.submissions.0.get_mut(&num_key(*id)) {
                sub.grade = grade.clone();
                n += 1;
            }
        }
    });
    app.store.touch();
    app.bcast(json!({
        "type": "grade_batch",
        "sid": sid as i64,
        "studentIds": ids.iter().map(|v| super::jsnum::value(*v)).collect::<Vec<_>>(),
        "grade": grade,
    }));
    Json(json!({ "ok": true, "count": n })).into_response()
}

async fn closed(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = parse_body(&body, &headers).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let sid = js_param_num(&id);
    if app.store.with(|db| find_session(db, sid).is_none()) {
        return err(StatusCode::NOT_FOUND, "场次不存在");
    }
    let closed = truthy_opt(body.get("closed"));
    app.store.with(|db| {
        find_session_mut(db, sid).expect("session exists").closed = closed;
    });
    app.store.touch();
    app.bcast(json!({ "type": "session_closed", "sid": sid as i64, "closed": closed }));
    Json(json!({ "ok": true, "closed": closed })).into_response()
}

async fn api_404() -> Response {
    err(StatusCode::NOT_FOUND, "接口不存在")
}
