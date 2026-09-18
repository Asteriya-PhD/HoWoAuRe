// 双服务对比：同一组操作按同一顺序打 Node 版与 Rust 版，逐项对比状态码与 JSON。
// 时间戳/端口号做归一化（两类实现不可能同毫秒）；数组保序、对象键序不敏感。
// 用法：node scripts/api-diff.mjs   （自动拉起两份服务在临时数据目录，结束自动清理）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_PORT = 3210, RUST_PORT = 3212;
const NODE_BASE = `http://localhost:${NODE_PORT}/api`;
const RUST_BASE = `http://localhost:${RUST_PORT}/api`;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

// ---------- JSON 归一化：时间戳/端口 → 占位；对象键序不敏感；数组保序 ----------
function norm(v, opts = {}) {
  if (Array.isArray(v)) return v.map(x => norm(x, opts));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if ((opts.ports || opts.normPorts) && (k === 'httpPort' || k === 'httpsPort')) { o[k] = '***port***'; continue; }
      // 网卡枚举口径两版不同（Node os.networkInterfaces vs if-addrs），只校验"非空数组"
      if (k === 'ips') { o[k] = Array.isArray(v[k]) && v[k].length > 0 ? '***ips***' : v[k]; continue; }
      o[k] = norm(v[k], opts);
    }
    return o;
  }
  if (typeof v === 'number' && v >= 1e12) return '***ts***';
  return v;
}
const eq = (a, b, opts = {}) => JSON.stringify(norm(a, opts)) === JSON.stringify(norm(b, opts));

async function req(base, op) {
  // 有请求体但未显式给 Content-Type 时补 json（真实前端总是带）；text + 自定义头 = 故意不带
  const headers = op.headers
    ? { ...op.headers }
    : (op.text !== undefined || op.body !== undefined ? { 'Content-Type': 'application/json' } : undefined);
  const body = op.text !== undefined ? op.text : op.body;
  const res = await fetch(base + op.path, {
    method: op.method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

const OPS = [
  { name: 'server-info（口径）', method: 'GET', path: '/server-info', normPorts: true },
  { name: 'bootstrap 空', method: 'GET', path: '/bootstrap' },
  { name: '非 JSON 内容类型（Node 版 500 崩溃 / Rust 版 400，已记录的有意偏差）', method: 'POST', path: '/classes', text: 'name=x', headers: { 'Content-Type': 'text/plain' }, statusPair: { node: 500, rust: 400 }, bodyOnlyStatus: true },
  { name: '坏 JSON → 400', method: 'POST', path: '/classes', text: '{oops', headers: { 'Content-Type': 'application/json' }, expectStatus: 400, bodyOnlyStatus: true },
  { name: '创建班级', method: 'POST', path: '/classes', body: { name: '对比班' } },
  { name: '班级名空 → 400', method: 'POST', path: '/classes', body: { name: '  ' }, expectStatus: 400 },
  { name: '空名单导入 → 400', method: 'POST', path: '/classes/1/import', body: { mode: 'replace', students: [] }, expectStatus: 400 },
  { name: '导入名单（同名不同号/无学号）', method: 'POST', path: '/classes/1/import', body: { mode: 'replace', students: [
    { name: '张三', stuNo: '01' }, { name: '李四', stuNo: '02' }, { name: '王五', stuNo: '03' },
    { name: '赵六', stuNo: '04' }, { name: '张三', stuNo: '05' }, { name: '无学号' } ] } },
  { name: 'GET 名单', method: 'GET', path: '/classes/1/students' },
  { name: '学号撞号加 *', method: 'POST', path: '/classes/1/students', body: { name: '撞号', stuNo: '01' } },
  { name: '自动学号补齐', method: 'POST', path: '/classes/1/students', body: { name: '新同学' } },
  { name: 'PUT 学生（改名/组别）', method: 'PUT', path: '/students/7', body: { name: '撞号改', group: '第1组' } },
  { name: 'PUT 学号重复 → 400', method: 'PUT', path: '/students/8', body: { stuNo: '02' }, expectStatus: 400 },
  { name: 'PUT 姓名空 → 400', method: 'PUT', path: '/students/8', body: { name: '' }, expectStatus: 400 },
  { name: '删除学生', method: 'DELETE', path: '/students/9' },
  { name: '不存在学生 → 404', method: 'DELETE', path: '/students/999', expectStatus: 404 },
  { name: '创建场次', method: 'POST', path: '/sessions', body: { classId: 1, subject: '数学', title: '光的干涉' } },
  { name: '缺班级 → 400', method: 'POST', path: '/sessions', body: {}, expectStatus: 400 },
  { name: '场次标题修改', method: 'POST', path: '/sessions/10/title', body: { title: '改过的标题' } },
  { name: '场次科目修改', method: 'POST', path: '/sessions/10/subject', body: { subject: '化学' } },
  { name: '场次科目不存在 → 404', method: 'POST', path: '/sessions/999/subject', body: { subject: '化学' }, expectStatus: 404 },
  { name: '场次科目留空 → 作业', method: 'POST', path: '/sessions/10/subject', body: { subject: '  ' } },
  { name: '不存在场次 → 404', method: 'GET', path: '/sessions/999', expectStatus: 404 },
  { name: '非法码', method: 'POST', path: '/sessions/10/scan', body: { code: 'HW|x|01|张三' } },
  { name: '正常扫码 order=1', method: 'POST', path: '/sessions/10/scan', body: { code: 'HW|1|01|张三' } },
  { name: '重复扫码 duplicate', method: 'POST', path: '/sessions/10/scan', body: { code: 'HW|1|01|张三' } },
  { name: '旧贴纸 stale_code', method: 'POST', path: '/sessions/10/scan', body: { code: 'HW|1|99|李四' } },
  { name: '名单外 not_found', method: 'POST', path: '/sessions/10/scan', body: { code: 'HW|999|01|外人' } },
  { name: '王五扫码', method: 'POST', path: '/sessions/10/scan', body: { code: 'HW|1|03|王五' } },
  { name: '截止', method: 'POST', path: '/sessions/10/closed', body: { closed: true } },
  { name: '截止后扫码 late', method: 'POST', path: '/sessions/10/scan', body: { code: 'HW|1|04|赵六' } },
  { name: '单打等级', method: 'POST', path: '/sessions/10/grade', body: { studentId: 4, grade: 'A+' } },
  { name: '批量等级', method: 'POST', path: '/sessions/10/grade-batch', body: { studentIds: [2, 5], grade: 'A-' } },
  { name: '未登记打等级 → 400', method: 'POST', path: '/sessions/10/grade', body: { studentId: 6, grade: 'B' }, expectStatus: 400 },
  { name: '撤销', method: 'POST', path: '/sessions/10/unsubmit', body: { studentId: 4 } },
  { name: '手动补交', method: 'POST', path: '/sessions/10/setlate', body: { studentId: 3, late: true } },
  { name: '请假开', method: 'POST', path: '/sessions/10/leave', body: { studentId: 6, leave: true } },
  { name: '请假后照常登记', method: 'POST', path: '/sessions/10/scan', body: { code: 'HW|1|05|张三' } },
  { name: '请假关', method: 'POST', path: '/sessions/10/leave', body: { studentId: 6, leave: false } },
  { name: '场次详情', method: 'GET', path: '/sessions/10' },
  { name: '分组导入（含 unmatched/同名/空学号）', method: 'POST', path: '/classes/1/groups-import', body: { rows: [
    { name: '张三', stuNo: '01', group: '第1组' }, { name: '李四', stuNo: '02', group: '第1组' },
    { name: '王五', stuNo: '03', group: '第2组' }, { name: '赵六', stuNo: '04', group: '第2组' },
    { name: '张三', stuNo: '05', group: '第1组' }, { name: '马七', group: '第1组' },
    { name: '张三', stuNo: 'xx', group: '第3组' } ] } },
  { name: '分组场次', method: 'POST', path: '/sessions', body: { classId: 1, subject: '语文', groups: ['第1组'] } },
  { name: '组内扫码', method: 'POST', path: '/sessions/11/scan', body: { code: 'HW|1|02|李四' } },
  { name: '组外拒收 not_in_group', method: 'POST', path: '/sessions/11/scan', body: { code: 'HW|1|03|王五' } },
  { name: '组内同名扫码', method: 'POST', path: '/sessions/11/scan', body: { code: 'HW|1|05|张三' } },
  { name: '分组场次详情', method: 'GET', path: '/sessions/11' },
  { name: '清空分组', method: 'POST', path: '/classes/1/groups-clear', body: {} },
  { name: '等级体系：非数组 → 400', method: 'PUT', path: '/settings/grades', body: { grades: 'x' }, expectStatus: 400 },
  { name: '等级体系：空 → 400', method: 'PUT', path: '/settings/grades', body: { grades: [] }, expectStatus: 400 },
  { name: '等级体系：超 9 → 400', method: 'PUT', path: '/settings/grades', body: { grades: ['1','2','3','4','5','6','7','8','9','10'] }, expectStatus: 400 },
  { name: '等级体系：重复 → 400', method: 'PUT', path: '/settings/grades', body: { grades: ['A', 'A '] }, expectStatus: 400 },
  { name: '等级体系：合法', method: 'PUT', path: '/settings/grades', body: { grades: ['优', '良', '不合格'] } },
  { name: '科目体系：非数组 → 400', method: 'PUT', path: '/settings/subjects', body: { subjects: 'x' }, expectStatus: 400 },
  { name: '科目体系：空 → 400', method: 'PUT', path: '/settings/subjects', body: { subjects: [] }, expectStatus: 400 },
  { name: '科目体系：超 12 → 400', method: 'PUT', path: '/settings/subjects', body: { subjects: Array.from({ length: 13 }, (_, i) => '科' + i) }, expectStatus: 400 },
  { name: '科目体系：重复 → 400', method: 'PUT', path: '/settings/subjects', body: { subjects: ['物理', ' 物理 '] }, expectStatus: 400 },
  { name: '科目体系：空名 → 400', method: 'PUT', path: '/settings/subjects', body: { subjects: ['物理', '  '] }, expectStatus: 400 },
  { name: '科目体系：合法（数字元素 String() 语义）', method: 'PUT', path: '/settings/subjects', body: { subjects: ['物理', 123, '化学'] } },
  { name: 'bootstrap（含统计）', method: 'GET', path: '/bootstrap' },
  { name: '导出（含 X-Backup-Saved 头）', method: 'GET', path: '/export', checkHeader: 'x-backup-saved' },
  { name: '合成库导入（脏字段清洗）', method: 'POST', path: '/import', body: {
    counter: 100,
    classes: [{ id: 90, name: '旧班', createdAt: 1700000000000 }],
    students: [{ id: 91, classId: 90, name: '旧同学', stuNo: '1', group: ' 旧组 ' }],
    sessions: [{ id: 92, classId: 90, subject: '旧科目', title: '旧场次'.repeat(30), date: '2026-01-02', createdAt: 1700000000001,
      closed: true, groups: ['旧组', '旧组', ''], leave: { 91: 1700000000000 },
      submissions: { 91: { order: 1, time: 1700000000002, status: 'ok', grade: 'B' } } }],
    settings: { grades: ['甲', '乙'], subjects: ['甲科', 123] },
  } },
  { name: '导入后 bootstrap', method: 'GET', path: '/bootstrap' },
  { name: '缺班级数据 → 400', method: 'POST', path: '/import', body: { classes: [] }, expectStatus: 400 },
  { name: '删场次', method: 'DELETE', path: '/sessions/10' },
  { name: '删班级', method: 'DELETE', path: '/classes/1' },
  { name: '非 /api 路径走静态（404）', method: 'GET', path: '/definitely-no-file', expectStatus: 404, bodyOnlyStatus: true },
  { name: '/api 未知接口 → 404', method: 'GET', path: '/nope', expectStatus: 404 },
  { name: '不存在班级的分组导入 → 404', method: 'POST', path: '/classes/999/groups-import', body: { rows: [] }, expectStatus: 404 },
];

async function waitReady(base, label) {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(base + '/server-info');
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
    if (i % 20 === 19) console.log(`  等待 ${label}…`);
  }
  throw new Error(`${label} 启动超时`);
}

// ---------- WebSocket 广播对比（同类型消息逐条对比） ----------
function openWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const msgs = [];
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve({ ws, msgs }); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws 连接失败')); };
  });
}
function recvWs(x) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(x.msgs), 1500);
    x.ws.onmessage = (ev) => {
      x.msgs.push(JSON.parse(ev.data));
      clearTimeout(t);
      resolve(x.msgs);
    };
  });
}

async function wsCompare() {
  const a = await openWs(NODE_PORT), b = await openWs(RUST_PORT);
  // 监听必须先挂上再触发广播（Node 版不缓冲，晚挂会丢消息）
  const pa = recvWs(a), pb = recvWs(b);
  await fetch(NODE_BASE + '/classes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '广播班' }) });
  await fetch(RUST_BASE + '/classes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '广播班' }) });
  const [ma, mb] = await Promise.all([pa, pb]);
  a.ws.close(); b.ws.close();
  check('广播消息一致（classes_changed）', eq(ma, mb) && ma.length === 1 && ma[0].type === 'classes_changed',
    `${JSON.stringify(ma)} vs ${JSON.stringify(mb)}`);
}

async function main() {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-node-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-rust-'));
  const procs = [];
  try {
    console.log('== 启动双服务 ==');
    procs.push(spawn('node', ['server.js', '--http', String(NODE_PORT), '--https', '3520', '--data-dir', dirA],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }));
    procs.push(spawn(path.join(ROOT, 'src-tauri/target/debug/devserve'),
      ['--http', String(RUST_PORT), '--https', '3522', '--data-dir', dirB, '--public', path.join(ROOT, 'public')],
      { stdio: ['ignore', 'pipe', 'inherit'] }));
    await waitReady(NODE_BASE, 'Node 版');
    await waitReady(RUST_BASE, 'Rust 版');

    console.log('\n== 逐项对比 ==');
    for (const op of OPS) {
      const a = await req(NODE_BASE, op);
      const b = await req(RUST_BASE, op);
      const statusOk = op.statusPair
        ? (a.status === op.statusPair.node && b.status === op.statusPair.rust)
        : op.expectStatus
          ? (a.status === b.status && a.status === op.expectStatus)
          : a.status === b.status;
      const headerOk = !op.checkHeader || a.headers.get(op.checkHeader) === b.headers.get(op.checkHeader);
      const bodyOk = op.bodyOnlyStatus || eq(a.json, b.json, op);
      check(op.name, statusOk && headerOk && bodyOk,
        `node=${a.status} rust=${b.status} norm差异: ${JSON.stringify(norm(a.json))?.slice(0, 300)} vs ${JSON.stringify(norm(b.json))?.slice(0, 300)}`);
    }

    console.log('\n== WebSocket 广播对比 ==');
    await wsCompare();

    console.log('\n== 最终 db.json 结构对比 ==');
    const dbA = JSON.parse(fs.readFileSync(path.join(dirA, 'db.json'), 'utf8'));
    const dbB = JSON.parse(fs.readFileSync(path.join(dirB, 'db.json'), 'utf8'));
    check('db.json 结构一致', eq(dbA, dbB), `${JSON.stringify(norm(dbA)).slice(0, 400)} vs ${JSON.stringify(norm(dbB)).slice(0, 400)}`);

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('对比执行失败:', e); process.exit(1); });
