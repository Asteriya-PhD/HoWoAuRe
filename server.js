/*
 * 作业扫码登记 — 本地服务
 * - HTTP(3000)：电脑端界面与 API（localhost 无需证书）
 * - HTTPS(3443)：手机/平板扫码页（浏览器摄像头权限要求 HTTPS，使用自签证书）
 * - WebSocket：扫码端、大屏看板实时同步
 * - 数据：data/db.json 单文件，启动时自动备份
 */
'use strict';

const MIN_NODE = 18;
const [major] = process.versions.node.split('.').map(Number);
if (major < MIN_NODE) {
  console.error(`需要 Node.js ${MIN_NODE} 或更高版本（当前 ${process.versions.node}）`);
  process.exit(1);
}

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');

// ---------- 命令行参数 ----------
function argNum(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && Number.isInteger(+process.argv[i + 1]) ? +process.argv[i + 1] : def;
}
function argStr(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && typeof process.argv[i + 1] === 'string' ? process.argv[i + 1] : null;
}
const HTTP_PORT_BASE = argNum('http', 3000);
const HTTPS_PORT_BASE = argNum('https', 3443);
// --open：启动完成后用系统默认浏览器打开电脑端界面（端口以实际监听为准，
// 双击启动脚本用这个参数，避免脚本里硬编码端口在顺延后打不开）
const OPEN_BROWSER = process.argv.includes('--open');
// 桌面 App 模式用 --data-dir 把数据指到用户目录（.app 包内只读）；默认仍是项目内 data/
const DATA_DIR = path.resolve(argStr('data-dir') || process.env.HWSCAN_DATA_DIR || path.join(__dirname, 'data'));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CERT_KEY = path.join(DATA_DIR, 'key.pem');
const CERT_CRT = path.join(DATA_DIR, 'cert.pem');

// ---------- 数据存储 ----------
const DEFAULT_GRADES = ['A+', 'A', 'A-', '不合格'];
// 等级体系存 db.settings.grades（随备份导出导入）；提交记录上的等级是自由字符串，改配置不影响旧记录
function normalizeGrades(list) {
  const out = [];
  for (const g of (Array.isArray(list) ? list : [])) {
    // 只收字符串：对象/数字等脏元素直接丢弃，而非洗成 '[object Object]' 之类的垃圾名
    if (typeof g !== 'string') continue;
    // 剥零宽/格式字符（trim() 管不到），避免产出显示为空的隐形等级名
    const s = g.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim().slice(0, 12);
    if (s && !out.includes(s)) out.push(s);
  }
  // 与 PUT /settings/grades 同一不变量：1~9 档；脏文件超量时截断而非整体回退默认
  return out.length ? out.slice(0, 9) : DEFAULT_GRADES.slice();
}
const normalizeSettings = (s) => (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};

let db = { counter: 0, classes: [], students: [], sessions: [], settings: { grades: DEFAULT_GRADES.slice() } };
let saveTimer = null;

function loadDb() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const key of ['classes', 'students', 'sessions']) if (!Array.isArray(db[key])) db[key] = [];
      if (!Number.isInteger(db.counter)) db.counter = 0;
      db.settings = { ...normalizeSettings(db.settings), grades: normalizeGrades(db.settings && db.settings.grades) };
    } catch (e) {
      const corrupt = DB_FILE + '.corrupt-' + Date.now();
      fs.renameSync(DB_FILE, corrupt);
      console.error(`数据文件损坏，已备份到 ${corrupt}，将以空数据启动`);
    }
    // 每次启动自动备份，保留最近 20 份
    const backup = path.join(BACKUP_DIR, 'db-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json');
    fs.copyFileSync(DB_FILE, backup);
    pruneBackups();
  }
}

function saveDbNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDbNow, 150);
}

const nextId = () => ++db.counter;

// 备份目录统一清理（B2）：db-*/export-*/db-before-import-* 各保留最近 N 份，防止长期使用撑满磁盘
function pruneBackups() {
  try {
    const CAP = { 'db-before-import-': 10, 'export-': 10, 'db-': 20 };
    const files = fs.readdirSync(BACKUP_DIR);
    for (const [prefix, keep] of Object.entries(CAP)) {
      const list = files.filter(f => f.startsWith(prefix) && f.endsWith('.json')
        && (prefix !== 'db-' || !f.startsWith('db-before-import-'))).sort();
      while (list.length > keep) fs.unlinkSync(path.join(BACKUP_DIR, list.shift()));
    }
  } catch (e) { console.error('备份清理失败:', e.message); }
}

// WebSocket 广播（启动后替换为实际实现）
let broadcast = () => {};

// ---------- 工具 ----------
function lanIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 自签证书（含局域网 IP SAN，IP 变化时自动重新生成） ----------
function certSans() {
  return [...new Set(['localhost', '127.0.0.1', ...lanIps()])];
}

async function loadCert() {
  const sans = certSans();
  if (fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CRT)) {
    try {
      const crt = fs.readFileSync(CERT_CRT, 'utf8');
      const meta = JSON.parse(fs.readFileSync(CERT_CRT + '.meta.json', 'utf8'));
      if (meta.sans && meta.sans.length === sans.length && sans.every(ip => meta.sans.includes(ip))) {
        try { fs.chmodSync(CERT_KEY, 0o600); } catch { /* 忽略 */ }
        return { key: fs.readFileSync(CERT_KEY, 'utf8'), cert: crt };
      }
      console.log('局域网 IP 已变化，重新生成 HTTPS 证书…');
    } catch { /* 重新生成 */ }
  }
  const altNames = sans.map(ip => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? { type: 7, ip } : { type: 2, value: ip }));
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'homework-scan.local' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.writeFileSync(CERT_KEY, pems.private);
  fs.writeFileSync(CERT_CRT, pems.cert);
  fs.writeFileSync(CERT_CRT + '.meta.json', JSON.stringify({ sans }));
  try { fs.chmodSync(CERT_KEY, 0o600); } catch { /* Windows 上无 POSIX 权限，忽略 */ }
  return { key: pems.private, cert: pems.cert };
}

// ---------- 业务逻辑 ----------
function classById(id) { return db.classes.find(c => c.id === id); }
function studentsOfClass(id) { return db.students.filter(s => s.classId === id); }
function sessionById(id) { return db.sessions.find(s => s.id === id); }

function parseCode(code) {
  if (typeof code !== 'string') return null;
  const parts = code.trim().split('|');
  if (parts.length !== 4 || parts[0] !== 'HW') return null;
  const classId = Number(parts[1]);
  if (!Number.isInteger(classId) || !parts[2] || !parts[3]) return null;
  return { classId, stuNo: parts[2], name: parts[3] };
}

function maxOrder(session) {
  let max = 0;
  for (const sub of Object.values(session.submissions)) if (sub.order > max) max = sub.order;
  return max;
}

function sessionStats(session) {
  const ids = Object.keys(session.submissions);
  const submitted = ids.filter(id => session.submissions[id].status === 'ok').length;
  const late = ids.length - submitted;
  return { submitted, late, total: studentsOfClass(session.classId).length };
}

// 扫码登记：解析二维码 → 校验 → 去重 → 按顺序登记
function doScan(session, code) {
  const parsed = parseCode(code);
  if (!parsed) return { ok: false, reason: 'bad_code', message: '无法识别的二维码（不是本系统的学生码）' };

  const cls = classById(session.classId);
  const classmates = studentsOfClass(session.classId);
  let student = classmates.find(s => s.classId === parsed.classId && s.stuNo === parsed.stuNo);
  let note = null;
  if (!student) {
    // 码与名单不符：尝试按姓名匹配（可能是旧贴纸/换学号）
    const byName = classmates.filter(s => s.name === parsed.name);
    if (byName.length === 1) {
      student = byName[0];
      note = 'stale_code';
    } else {
      return { ok: false, reason: 'not_found', message: `${parsed.name} 不在「${cls ? cls.name : '?'}」名单中` };
    }
  }

  if (session.submissions[student.id]) {
    const sub = session.submissions[student.id];
    return { ok: true, duplicate: true, note, student, order: sub.order, status: sub.status, stats: sessionStats(session) };
  }

  const status = session.closed ? 'late' : 'ok';
  const sub = { order: maxOrder(session) + 1, time: Date.now(), status, grade: null };
  session.submissions[student.id] = sub;
  saveDb();
  return { ok: true, duplicate: false, note, student, order: sub.order, status: sub.status, time: sub.time, stats: sessionStats(session) };
}

// ---------- HTTP API ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  // 本地工具必须禁用启发式缓存：WebView 缓存旧 JS 会挡住更新后的界面，no-cache = 每次用 ETag 向服务验证
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

const api = express.Router();

api.get('/server-info', (req, res) => {
  res.json({ ips: lanIps(), httpPort, httpsPort, today: todayStr(), app: process.env.HWSCAN_APP === '1' });
});

api.get('/bootstrap', (req, res) => res.json({
  ...db,
  sessions: db.sessions.map(s => ({ ...s, stats: sessionStats(s) })),
}));

// ----- 班级 -----
api.post('/classes', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: '班级名称不能为空' });
  const cls = { id: nextId(), name, createdAt: Date.now() };
  db.classes.push(cls);
  saveDb();
  broadcast({ type: 'classes_changed' });
  res.json(cls);
});

api.delete('/classes/:id', (req, res) => {
  const cls = classById(+req.params.id);
  if (!cls) return res.status(404).json({ message: '班级不存在' });
  db.classes = db.classes.filter(c => c.id !== cls.id);
  db.students = db.students.filter(s => s.classId !== cls.id);
  db.sessions = db.sessions.filter(s => s.classId !== cls.id);
  saveDb();
  broadcast({ type: 'classes_changed' });
  res.json({ ok: true });
});

// ----- 学生 -----
api.get('/classes/:id/students', (req, res) => {
  res.json(studentsOfClass(+req.params.id));
});

api.post('/classes/:id/students', (req, res) => {
  const cls = classById(+req.params.id);
  if (!cls) return res.status(404).json({ message: '班级不存在' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: '姓名不能为空' });
  const classmates = studentsOfClass(cls.id);
  let stuNo = String(req.body.stuNo || '').trim();
  if (!stuNo) stuNo = String(classmates.length + 1).padStart(2, '0');
  while (classmates.some(s => s.stuNo === stuNo)) stuNo += '*';
  const stu = { id: nextId(), classId: cls.id, name, stuNo };
  db.students.push(stu);
  saveDb();
  broadcast({ type: 'students_changed', classId: cls.id });
  res.json(stu);
});

api.put('/students/:id', (req, res) => {
  const stu = db.students.find(s => s.id === +req.params.id);
  if (!stu) return res.status(404).json({ message: '学生不存在' });
  const name = String(req.body.name ?? stu.name).trim();
  const stuNo = String(req.body.stuNo ?? stu.stuNo).trim();
  if (!name) return res.status(400).json({ message: '姓名不能为空' });
  if (db.students.some(s => s.classId === stu.classId && s.id !== stu.id && s.stuNo === stuNo)) {
    return res.status(400).json({ message: `学号 ${stuNo} 已存在` });
  }
  Object.assign(stu, { name, stuNo });
  saveDb();
  broadcast({ type: 'students_changed', classId: stu.classId });
  res.json(stu);
});

api.delete('/students/:id', (req, res) => {
  const stu = db.students.find(s => s.id === +req.params.id);
  if (!stu) return res.status(404).json({ message: '学生不存在' });
  db.students = db.students.filter(s => s.id !== stu.id);
  for (const sess of db.sessions) delete sess.submissions[stu.id];
  saveDb();
  broadcast({ type: 'students_changed', classId: stu.classId });
  res.json({ ok: true });
});

// Excel 导入：{ students:[{name,stuNo}], mode:'append'|'replace' }
api.post('/classes/:id/import', (req, res) => {
  const cls = classById(+req.params.id);
  if (!cls) return res.status(404).json({ message: '班级不存在' });
  const rows = Array.isArray(req.body.students) ? req.body.students : [];
  const cleaned = [];
  const seen = new Set();
  for (const row of rows) {
    const name = String(row.name || '').trim().replace(/\s+/g, '');
    if (!name) continue;
    let stuNo = String(row.stuNo ?? '').trim();
    if (!stuNo) stuNo = String(cleaned.length + 1).padStart(2, '0');
    while (seen.has(stuNo)) stuNo += '*';
    seen.add(stuNo);
    cleaned.push({ name, stuNo });
  }
  if (!cleaned.length) return res.status(400).json({ message: '没有解析到有效名单（需包含"姓名"列）' });
  if (req.body.mode === 'replace') db.students = db.students.filter(s => s.classId !== cls.id);
  else {
    // 追加时跳过「姓名+学号」完全重复的行
    const existing = new Set(studentsOfClass(cls.id).map(s => s.name + '|' + s.stuNo));
    for (const stu of cleaned) if (existing.has(stu.name + '|' + stu.stuNo)) stu.skip = true;
  }
  const added = [];
  for (const stu of cleaned) {
    if (stu.skip) continue;
    const rec = { id: nextId(), classId: cls.id, name: stu.name, stuNo: stu.stuNo };
    db.students.push(rec);
    added.push(rec);
  }
  saveDb();
  broadcast({ type: 'students_changed', classId: cls.id });
  res.json({ added: added.length, total: studentsOfClass(cls.id).length });
});

// ----- 数据备份/还原（导出文件就是 db.json 原始结构，App 版菜单「导入旧数据」可直接导入） -----
// 导出：返回完整数据，同时在 backups/ 留一份带时间戳的副本
api.get('/export', (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(BACKUP_DIR, 'export-' + ts + '.json'), JSON.stringify(db));
    pruneBackups();
    res.set('X-Backup-Saved', '1');
  } catch (e) {
    console.error('导出副本写入失败:', e.message);
  }
  res.json(db);
});

// 导入：校验 → 落盘+备份当前数据 → 全量还原（保留原 id，二维码贴纸继续有效）
api.post('/import', (req, res) => {
  const d = req.body || {};
  if (!Array.isArray(d.classes) || !Array.isArray(d.students)) {
    return res.status(400).json({ message: '不是本系统的备份文件（缺少班级/名单数据）' });
  }
  // 三类数据共用一个 id 空间：全局去重 + 只收安全整数
  const seenIds = new Set();
  const uniqueId = (id) => {
    if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  };
  // submissions 里的值只收非空对象，null/数组等脏数据直接丢弃（否则 sessionStats 会崩）
  const cleanSubs = (subs) => {
    const out = {};
    for (const [k, v] of Object.entries(subs)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
    }
    return out;
  };
  const classes = d.classes
    .filter(c => c && typeof c.name === 'string' && c.name.trim() && uniqueId(c.id))
    .map(c => ({ id: c.id, name: c.name.trim(), createdAt: Number.isFinite(c.createdAt) ? c.createdAt : Date.now() }));
  const students = d.students
    .filter(s => s && Number.isInteger(s.classId) && typeof s.name === 'string' && s.name.trim() && uniqueId(s.id))
    .map(s => ({ id: s.id, classId: s.classId, name: s.name.trim(), stuNo: String(s.stuNo ?? '') }));
  const sessions = (Array.isArray(d.sessions) ? d.sessions : [])
    .filter(s => s && Number.isInteger(s.classId) && s.submissions && typeof s.submissions === 'object' && !Array.isArray(s.submissions) && uniqueId(s.id))
    .map(s => ({
      id: s.id,
      classId: s.classId,
      subject: typeof s.subject === 'string' ? s.subject : '',
      title: typeof s.title === 'string' ? s.title.slice(0, 50) : '',
      date: /^\d{4}-\d{2}-\d{2}$/.test(s.date || '') ? s.date : '',
      createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
      closed: !!s.closed,
      submissions: cleanSubs(s.submissions),
    }));
  if (!classes.length) return res.status(400).json({ message: '备份文件里没有班级数据' });
  // counter 至少取全部 id 的最大值，避免还原后新建班级/学生撞 id
  let counter = Number.isSafeInteger(d.counter) && d.counter > 0 ? d.counter : 0;
  for (const list of [classes, students, sessions]) {
    for (const it of list) if (it.id > counter) counter = it.id;
  }
  counter = Math.min(counter, Number.MAX_SAFE_INTEGER - 1);
  // 先把防抖中的最新数据落盘，"导入前备份"才是完整的
  clearTimeout(saveTimer);
  saveDbNow();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, 'db-before-import-' + ts + '.json'));
  pruneBackups();
  db = { counter, classes, students, sessions, settings: { ...normalizeSettings(db.settings), grades: normalizeGrades(d.settings && d.settings.grades) } };
  saveDbNow();
  broadcast({ type: 'db_changed' });
  res.json({ ok: true, classes: classes.length, students: students.length, sessions: sessions.length });
});

// ----- 设置（等级体系） -----
api.put('/settings/grades', (req, res) => {
  const list = Array.isArray(req.body.grades) ? req.body.grades : null;
  if (!list) return res.status(400).json({ message: 'grades 需要是数组' });
  if (!list.length) return res.status(400).json({ message: '至少保留一个等级' });
  if (list.length > 9) return res.status(400).json({ message: '等级最多 9 个（键盘 1~9 快捷批改）' });
  const grades = [];
  for (const g of list) {
    const s = String(g ?? '').trim().slice(0, 12);
    if (!s) return res.status(400).json({ message: '等级名称不能为空' });
    if (grades.includes(s)) return res.status(400).json({ message: `等级「${s}」重复了` });
    grades.push(s);
  }
  db.settings = { ...db.settings, grades };
  saveDb();
  broadcast({ type: 'settings_changed' });
  res.json({ grades });
});

// ----- 收作业场次 -----
api.post('/sessions', (req, res) => {
  const cls = classById(+req.body.classId);
  if (!cls) return res.status(400).json({ message: '请选择班级' });
  const subject = String(req.body.subject || '作业').trim() || '作业';
  const title = String(req.body.title || '').trim().slice(0, 50);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date) ? req.body.date : todayStr();
  const sess = { id: nextId(), classId: cls.id, subject, title, date, createdAt: Date.now(), closed: false, submissions: {} };
  db.sessions.push(sess);
  saveDb();
  broadcast({ type: 'sessions_changed' });
  res.json(sess);
});

api.get('/sessions/:id', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  res.json(sessionFull(sess));
});

// 修改场次标题（如「光的干涉」）
api.post('/sessions/:id/title', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  sess.title = String(req.body.title || '').trim().slice(0, 50);
  saveDb();
  broadcast({ type: 'sessions_changed' });
  res.json(sess);
});

function sessionFull(sess) {
  return {
    ...sess,
    stats: sessionStats(sess),
    className: classById(sess.classId)?.name || '?',
    students: studentsOfClass(sess.classId).map(s => ({
      ...s, sub: sess.submissions[s.id] || null,
    })),
  };
}

// 手机扫码上报（也供演示模式调用）
api.post('/sessions/:id/scan', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  const result = doScan(sess, req.body.code);
  if (result.ok && !result.duplicate) {
    broadcast({ type: 'scan', sid: sess.id, studentId: result.student.id, name: result.student.name, stuNo: result.student.stuNo, order: result.order, status: result.status, time: result.time, stats: result.stats });
  }
  res.json(result);
});

api.post('/sessions/:id/unsubmit', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  delete sess.submissions[+req.body.studentId];
  saveDb();
  broadcast({ type: 'unsubmit', sid: sess.id, studentId: +req.body.studentId, stats: sessionStats(sess) });
  res.json({ ok: true, stats: sessionStats(sess) });
});

api.post('/sessions/:id/setlate', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  const stuId = +req.body.studentId;
  const sub = sess.submissions[stuId];
  if (!sub) return res.status(400).json({ message: '该学生尚未登记' });
  sub.status = req.body.late ? 'late' : 'ok';
  saveDb();
  broadcast({ type: 'setlate', sid: sess.id, studentId: stuId, status: sub.status, stats: sessionStats(sess) });
  res.json({ ok: true });
});

// 等级：单个 / 批量
api.post('/sessions/:id/grade', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  const stuId = +req.body.studentId;
  const grade = req.body.grade === null ? null : String(req.body.grade);
  const sub = sess.submissions[stuId];
  if (!sub) return res.status(400).json({ message: '该学生尚未登记，不能打等级' });
  sub.grade = grade;
  saveDb();
  broadcast({ type: 'grade', sid: sess.id, studentId: stuId, grade });
  res.json({ ok: true });
});

api.post('/sessions/:id/grade-batch', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  const ids = Array.isArray(req.body.studentIds) ? req.body.studentIds.map(Number) : [];
  const grade = req.body.grade === null ? null : String(req.body.grade);
  let n = 0;
  for (const id of ids) {
    const sub = sess.submissions[id];
    if (sub) { sub.grade = grade; n++; }
  }
  saveDb();
  broadcast({ type: 'grade_batch', sid: sess.id, studentIds: ids, grade });
  res.json({ ok: true, count: n });
});

// 截止收集 / 重新打开
api.post('/sessions/:id/closed', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  sess.closed = !!req.body.closed;
  saveDb();
  broadcast({ type: 'session_closed', sid: sess.id, closed: sess.closed });
  res.json({ ok: true, closed: sess.closed });
});

api.delete('/sessions/:id', (req, res) => {
  const sess = sessionById(+req.params.id);
  if (!sess) return res.status(404).json({ message: '场次不存在' });
  db.sessions = db.sessions.filter(s => s.id !== sess.id);
  saveDb();
  broadcast({ type: 'sessions_changed' });
  res.json({ ok: true });
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ message: '接口不存在' }));

// ---------- 启动（端口冲突自动顺延） ----------
function listen(server, port, label) {
  return new Promise((resolve) => {
    const onError = (e) => {
      if (e.code === 'EADDRINUSE') resolve(null);
      else { console.error(`${label} 启动失败:`, e.message); resolve(null); }
    };
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}

let httpPort = null, httpsPort = null, httpSrv, httpsSrv;

async function start() {
  loadDb();
  const { key, cert } = await loadCert();
  httpsSrv = https.createServer({ key, cert }, app);
  httpSrv = http.createServer(app);

  for (let i = 0; i < 10 && !httpPort; i++) httpPort = await listen(httpSrv, HTTP_PORT_BASE + i, 'HTTP');
  for (let i = 0; i < 10 && !httpsPort; i++) httpsPort = await listen(httpsSrv, HTTPS_PORT_BASE + i, 'HTTPS');
  if (!httpPort && !httpsPort) {
    console.error(`端口 ${HTTP_PORT_BASE}~${HTTP_PORT_BASE + 9} 均被占用，无法启动。`);
    process.exit(1);
  }

  // 桌面 App 模式：stdout 握手，把实际端口告诉壳进程（端口冲突自动顺延后壳需要真实端口）
  if (process.env.HWSCAN_APP === '1') {
    console.log('HWSCAN_READY ' + JSON.stringify({ httpPort, httpsPort }));
  }

  // 手机端必须走 HTTPS 才能用摄像头：非本机访问 HTTP 时自动跳转 HTTPS
  // 跳转目标只允许本机局域网地址（S1：Host 头来自请求，不可信，不能原样回填）
  const myHosts = new Set(['localhost', '127.0.0.1', ...lanIps()]);
  httpSrv.on('request', (req, res) => {
    if (httpsPort) {
      const host = (req.headers.host || '').split(':')[0];
      if (!myHosts.has(host)) {
        // Host 不是本机：拒绝服务而非转发（防止被当明文入口/开放重定向）
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('请使用电脑端页面上的二维码地址访问');
        return;
      }
      if (host !== 'localhost' && host !== '127.0.0.1' && !req.url.startsWith('/ws')) {
        res.writeHead(302, { Location: `https://${host}:${httpsPort}${req.url}` });
        res.end();
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const wsClients = new Set();
  for (const srv of [httpSrv, httpsSrv]) {
    srv.on('upgrade', (req, socket, head) => {
      // S2：只接受本机地址作为握手 Host；浏览器握手必带 Origin，第三方网页（origin 是别人
      // 的站点）直接拒绝，防同网段恶意页面偷听广播。非浏览器客户端（无 Origin）与 HTTP API
      // 同一信任级别，不额外拦截。
      const host = (req.headers.host || '').split(':')[0];
      const origin = req.headers.origin || '';
      // 手机扫码页走 https://局域网IP:端口；老师电脑/Tauri 壳走 http://localhost:HTTP端口
      const okOrigins = host === 'localhost' || host === '127.0.0.1'
        ? [`http://${host}:${httpPort}`, `https://${host}:${httpsPort}`]
        : [`https://${host}:${httpsPort}`];
      if (req.url !== '/ws' || !myHosts.has(host) || (origin && !okOrigins.includes(origin))) {
        socket.destroy(); return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        wsClients.add(ws);
        ws.on('close', () => wsClients.delete(ws)); // B1：及时清理，否则死连接常驻内存
        ws.on('error', () => ws.terminate());
      });
    });
  }
  broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) if (ws.readyState === 1) ws.send(data);
  };

  console.log('==============================================');
  console.log('  作业扫码登记 已启动');
  console.log(`  电脑端界面:  http://localhost:${httpPort}`);
  if (httpsPort) {
    console.log(`  手机扫码页:  https://${lanIps()[0] || '本机IP'}:${httpsPort}  （用电脑端页面上的二维码打开）`);
    console.log('  手机首次打开提示"证书不受信任"属正常现象，点"继续访问/高级→继续"即可');
  } else {
    console.log('  HTTPS 端口被占用，手机扫码功能不可用，请换个端口重试');
  }
  console.log(`  数据文件:    ${DB_FILE}`);
  console.log('  关闭本窗口或按 Ctrl+C 即停止服务');
  console.log('==============================================');

  // --open：由服务自己打开浏览器，端口以实际监听为准（脚本里硬编码端口会在顺延后打不开）
  if (OPEN_BROWSER && httpPort) {
    const url = `http://localhost:${httpPort}`;
    try {
      const { execFile } = require('child_process');
      // 参数数组形式，不经 shell 拼接；url 只含 localhost 与数字端口
      if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
      else if (process.platform === 'darwin') execFile('open', [url], () => {});
      else execFile('xdg-open', [url], () => {});
    } catch { /* 打不开就让老师手动复制上面的地址 */ }
  }
}

process.on('SIGINT', () => { saveDbNow(); process.exit(0); });
process.on('SIGTERM', () => { saveDbNow(); process.exit(0); });

start();
