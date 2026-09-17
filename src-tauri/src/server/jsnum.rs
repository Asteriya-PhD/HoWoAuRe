//! JS Number 语义的数值字段：JSON 里始终输出整数形态（无小数点），
//! 但兼容脏数据里的小数/字符串数值。对应 server.js 里 createdAt/time/order 等
//! 直接透传的 Number 字段（Date.now() 均为整数毫秒）。

use serde::de::{Deserializer, Visitor};
use serde::ser::Serializer;

pub type JsNum = f64;

pub fn serialize<S: Serializer>(v: &JsNum, s: S) -> Result<S::Ok, S::Error> {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.007199254740992e15 {
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<JsNum, D::Error> {
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = JsNum;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a number")
        }
        fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
            Ok(v)
        }
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(v as f64)
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(v as f64)
        }
    }
    d.deserialize_any(V)
}

/// 从任意 JSON 值按 JS 语义取数值（Number(v)）：
/// undefined/缺键 → NaN；null → 0；字符串 trim 后解析（空串 → 0）；数组 [x] → x，[] → 0
pub fn coerce(v: Option<&serde_json::Value>) -> JsNum {
    let Some(v) = v else { return f64::NAN };
    match v {
        serde_json::Value::Null => 0.0,
        serde_json::Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        serde_json::Value::String(s) => str_to_num(s),
        serde_json::Value::Array(a) => match a.len() {
            0 => 0.0,
            1 => coerce(a.first()),
            _ => f64::NAN,
        },
        serde_json::Value::Object(_) => f64::NAN,
    }
}

fn str_to_num(s: &str) -> JsNum {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<JsNum>().unwrap_or(f64::NAN)
}

/// JSON 输出值：NaN/Infinity → null（JSON.stringify 语义），整数形态输出整数
pub fn value(n: JsNum) -> serde_json::Value {
    if !n.is_finite() {
        return serde_json::Value::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9.007199254740992e15 {
        serde_json::json!(n as i64)
    } else {
        serde_json::json!(n)
    }
}

/// JS 对象键 coercion：String(number)。学生 id 都是安全整数 → 十进制串；NaN → "NaN"
pub fn num_key(n: JsNum) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.fract() == 0.0 && n.abs() < 9.007199254740992e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

#[allow(dead_code)]
pub fn from_value(v: &serde_json::Value) -> JsNum {
    coerce(Some(v))
}

