// 服务端 API 回归测试：node scripts/api-test.mjs   （需服务已启动）
const BASE = process.env.BASE || 'http://localhost:3000/api';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const scan = (sid, code) => req('POST', `/sessions/${sid}/scan`, { code });

async function main() {
  console.log('== 基础信息 ==');
  const info = await req('GET', '/server-info');
  check('server-info 返回局域网 IP', Array.isArray(info.ips) && info.ips.length > 0, JSON.stringify(info));
  check('HTTPS 端口存在', Number.isInteger(info.httpsPort));

  console.log('== 班级与名单 ==');
  const cls = await req('POST', '/classes', { name: `测试班${Date.now() % 10000}` });
  check('创建班级', cls.id > 0);
  const imp = await req('POST', `/classes/${cls.id}/import`, {
    mode: 'replace',
    students: [
      { name: '张三', stuNo: '01' }, { name: '李四', stuNo: '02' },
      { name: '王五', stuNo: '03' }, { name: '赵六', stuNo: '04' },
      { name: '张三', stuNo: '05' }, // 同名不同号
    ],
  });
  check('导入 5 名学生', imp.added === 5, JSON.stringify(imp));
  const students = await req('GET', `/classes/${cls.id}/students`);
  const byName = n => students.filter(s => s.name === n);
  check('同名学生保留 2 条', byName('张三').length === 2);

  console.log('== 收作业 ==');
  const sess = await req('POST', '/sessions', { classId: cls.id, subject: '数学' });
  check('创建场次', sess.id > 0);

  let r = await scan(sess.id, 'HW|x|01|张三');
  check('非法码被拒绝', r.ok === false && r.reason === 'bad_code', JSON.stringify(r));

  r = await scan(sess.id, `HW|${cls.id}|01|张三`);
  check('张三登记成功 order=1', r.ok && !r.duplicate && r.order === 1, JSON.stringify(r));

  r = await scan(sess.id, `HW|${cls.id}|01|张三`);
  check('重复扫码 → duplicate', r.ok && r.duplicate === true);

  r = await scan(sess.id, `HW|${cls.id}|99|李四`);
  check('旧贴纸（学号不符姓名符合）→ 按姓名匹配', r.ok && r.student.name === '李四' && r.note === 'stale_code', JSON.stringify(r));

  r = await scan(sess.id, `HW|${cls.id}|01|张三`);
  check('同名干扰：张三(01)的旧码仍指向原学生', r.ok && r.duplicate === true);

  r = await scan(sess.id, `HW|999|01|外人`);
  check('名单外学生被拒绝', r.ok === false && r.reason === 'not_found');

  r = await scan(sess.id, `HW|${cls.id}|03|王五`);
  check('王五登记 order=3', r.ok && r.order === 3);
  check('实时统计 3/5（含本人）', r.stats && r.stats.submitted === 3 && r.stats.total === 5, JSON.stringify(r.stats));

  console.log('== 截止与补交 ==');
  await req('POST', `/sessions/${sess.id}/closed`, { closed: true });
  r = await scan(sess.id, `HW|${cls.id}|04|赵六`);
  check('截止后扫码 → 补交(late)', r.ok && r.status === 'late' && r.order === 4, JSON.stringify(r));

  console.log('== 等级 ==');
  const stu = Object.fromEntries(students.map(s => [s.name + s.stuNo, s.id]));
  await req('POST', `/sessions/${sess.id}/grade`, { studentId: stu['王五03'], grade: 'A+' });
  await req('POST', `/sessions/${sess.id}/grade-batch`, { studentIds: [stu['张三01'], stu['赵六04']], grade: 'A-' });
  let full = await req('GET', `/sessions/${sess.id}`);
  const subOf = id => full.students.find(s => s.id === id).sub;
  check('单个等级 A+', subOf(stu['王五03']).grade === 'A+');
  check('批量等级 A-', subOf(stu['张三01']).grade === 'A-' && subOf(stu['赵六04']).grade === 'A-');
  check('未批改为 null', subOf(stu['李四02']).grade === null);

  console.log('== 撤销与统计 ==');
  await req('POST', `/sessions/${sess.id}/unsubmit`, { studentId: stu['王五03'] });
  full = await req('GET', `/sessions/${sess.id}`);
  check('撤销后 sub 为空', full.students.find(s => s.id === stu['王五03']).sub === null);
  check('统计 3/5', full.stats.submitted + full.stats.late === 3 && full.stats.total === 5);

  await req('POST', `/sessions/${sess.id}/setlate`, { studentId: stu['李四02'], late: true });
  full = await req('GET', `/sessions/${sess.id}`);
  check('手动标记补交', full.students.find(s => s.id === stu['李四02']).sub.status === 'late');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试执行失败:', e); process.exit(1); });
