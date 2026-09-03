// 历史记录：场次一览 / 班级视角（学生×场次矩阵）/ 学生视角（搜索 + 时间线）
(function () {
  'use strict';
  const { api, toast, fmtTime, registerView } = window.App;
  const { state, studentsOf, classById, gradePosCls } = window.Store;

  const TABS = [
    { key: 'sessions', name: '场次' },
    { key: 'class',    name: '班级视角' },
    { key: 'student',  name: '学生视角' },
  ];
  const TAB_KEY = 'hw.history.tab';

  registerView('history-view', {
    data() {
      return {
        tab: 'sessions',
        filterClass: '',
        armDeleteId: null,
        clsId: null,   // 班级视角选中的班
        stuQuery: '',
        stuId: null,   // 学生视角选中的学生
      };
    },
    computed: {
      tabs() { return TABS; },
      list() {
        let list = state.sessions.slice().sort((a, b) => b.id - a.id);
        if (this.filterClass) list = list.filter(s => s.classId === this.filterClass);
        return list;
      },
      clsSessions() {
        if (!this.clsId) return [];
        return state.sessions
          .filter(s => s.classId === this.clsId)
          .sort((a, b) => (a.date === b.date ? a.id - b.id : (a.date < b.date ? -1 : 1)));
      },
      clsStudents() { return this.clsId ? studentsOf(this.clsId) : []; },
      matrix() {
        const cols = this.clsSessions;
        const rows = this.clsStudents.map(stu => ({
          stu,
          cells: cols.map(s => {
            const sub = s.submissions[stu.id] || null;
            return { sub, absent: !sub, late: !!(sub && sub.status === 'late'), grade: sub && sub.grade };
          }),
        }));
        return { cols, rows };
      },
      stuAll() {
        const q = this.stuQuery.trim().toLowerCase();
        if (!q) return [];
        return state.students
          .filter(s => String(s.name || '').toLowerCase().includes(q) || String(s.stuNo || '').toLowerCase().includes(q));
      },
      stuMatches() { return this.stuAll.slice(0, 20); },
      stu() { return state.students.find(s => s.id === this.stuId) || null; },
      stuTimeline() {
        if (!this.stu) return [];
        return state.sessions
          .filter(s => s.classId === this.stu.classId)
          .sort((a, b) => (a.date === b.date ? b.id - a.id : (a.date < b.date ? 1 : -1)))
          .map(s => ({ s, sub: s.submissions[this.stu.id] || null }));
      },
      stuSummary() {
        const ok = this.stuTimeline.filter(x => x.sub && x.sub.status === 'ok').length;
        const late = this.stuTimeline.filter(x => x.sub && x.sub.status === 'late').length;
        const grades = {};
        for (const x of this.stuTimeline) if (x.sub && x.sub.grade) grades[x.sub.grade] = (grades[x.sub.grade] || 0) + 1;
        return { total: this.stuTimeline.length, ok, late, absent: this.stuTimeline.length - ok - late, grades };
      },
    },
    watch: {
      '$route.params.tab': {
        immediate: true,
        handler(v) {
          let t = v;
          if (!TABS.some(x => x.key === t)) {
            const last = localStorage.getItem(TAB_KEY);
            t = TABS.some(x => x.key === last) ? last : 'sessions';
          }
          this.tab = t;
          if (t !== v) this.$router.replace('/history/' + t);
          localStorage.setItem(TAB_KEY, t);
        },
      },
      // 班级视角默认班：跟工作台当前选中班一致；bootstrap 未返回时先空着，classes 到了再补
      'state.classes': {
        immediate: true,
        handler() {
          if (!this.clsId || !state.classes.some(c => c.id === this.clsId)) {
            this.clsId = state.classId || (state.classes[0] && state.classes[0].id) || null;
          }
        },
      },
    },
    methods: {
      studentsOf, classById, fmtTime, gradePosCls,
      switchTab(k) { this.$router.push('/history/' + k); },
      pickStudent(stu) { this.stuId = stu.id; },
      // 就地二次确认（Tauri 壳不支持 confirm()）：第一次点进入待确认态，3 秒后自动复位
      async remove(s) {
        if (this.armDeleteId !== s.id) {
          this.armDeleteId = s.id;
          toast('再点一次「删除」确认，3 秒内有效', '', 2800);
          setTimeout(() => { if (this.armDeleteId === s.id) this.armDeleteId = null; }, 3000);
          return;
        }
        this.armDeleteId = null;
        await api('DELETE', `/sessions/${s.id}`);
        toast('已删除');
      },
      exportAll() {
        const XLSX = window.XLSX;
        const wb = XLSX.utils.book_new();
        const list = this.list;
        if (!list.length) return toast('没有可导出的记录');
        // 逐场导出需要场次详情（含学生），串行拉取
        (async () => {
          let first = null;
          for (const s of list) {
            const full = await api('GET', `/sessions/${s.id}`);
            const rows = [['学号', '姓名', '提交状态', '扫码顺序', '提交时间', '等级']];
            for (const stu of full.students.slice().sort((a, b) => (a.stuNo > b.stuNo ? 1 : -1))) {
              rows.push([
                stu.stuNo, stu.name,
                !stu.sub ? '未交' : stu.sub.status === 'late' ? '补交' : '已交',
                stu.sub ? stu.sub.order : '',
                stu.sub ? new Date(stu.sub.time).toLocaleTimeString('zh-CN', { hour12: false }) : '',
                stu.sub?.grade || '',
              ]);
            }
            const ws = XLSX.utils.aoa_to_sheet(rows);
            const sheetName = `${s.date}_${s.title || s.subject}`.replace(/[\\/?*\[\]:]/g, '-').slice(0, 31);
            XLSX.utils.book_append_sheet(wb, ws, sheetName);
            if (!first) first = full;
          }
          const cls = first ? first.className : '全部';
          XLSX.writeFile(wb, `${cls}-作业登记汇总.xlsx`);
        })().catch(e => toast(e.message, 'err'));
      },
    },
    template: `
    <div class="page">
      <div class="card">
        <div class="row" style="margin:0">
          <div class="tabbar" style="margin:0">
            <button class="btn" v-for="t in tabs" :key="t.key" :class="{on: tab===t.key}" @click="switchTab(t.key)">{{ t.name }}</button>
          </div>
          <div class="spacer"></div>
          <template v-if="tab==='sessions'">
            <select v-model="filterClass" style="min-width:150px">
              <option value="">全部班级</option>
              <option v-for="c in state.classes" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <button class="btn" @click="exportAll">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
              导出全部（多工作表）
            </button>
          </template>
        </div>
      </div>

      <!-- ======== 场次视角 ======== -->
      <template v-if="tab==='sessions'">
        <div class="card" v-if="list.length">
          <table class="list">
            <thead><tr><th>日期</th><th>班级</th><th>科目 / 标题</th><th>提交</th><th>状态</th><th></th></tr></thead>
            <tbody>
              <tr v-for="s in list" :key="s.id">
                <td>{{ s.date }}</td>
                <td>{{ (classById(s.classId)||{}).name }}</td>
                <td><b>{{ s.title || s.subject }}</b><span class="hint" v-if="s.title" style="margin-left:6px">{{ s.subject }}</span></td>
                <td><span class="tag" :class="s.stats && s.stats.submitted + s.stats.late >= studentsOf(s.classId).length ? 'green' : ''">{{ (s.stats ? s.stats.submitted + s.stats.late : 0) }}/{{ studentsOf(s.classId).length }}</span><span class="tag amber" v-if="s.stats && s.stats.late" style="margin-left:4px">补{{ s.stats.late }}</span></td>
                <td>{{ s.closed ? '已截止' : '收集中' }}</td>
                <td>
                  <div class="row">
                    <router-link class="btn sm" :to="'/live/'+s.id">查看</router-link>
                    <router-link class="btn sm" :to="'/grade/'+s.id">批改</router-link>
                    <button class="btn sm danger" :class="{armed: armDeleteId===s.id}" @click="remove(s)">{{ armDeleteId===s.id ? '确认删除' : '删除' }}</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="empty" v-else>还没有登记记录</div>
      </template>

      <!-- ======== 班级视角：学生 × 场次矩阵 ======== -->
      <template v-else-if="tab==='class'">
        <div class="card">
          <div class="class-tabs" style="margin-bottom:12px">
            <button v-for="c in state.classes" :key="c.id" class="btn" :class="{on: clsId===c.id}" @click="clsId = c.id">{{ c.name }}</button>
          </div>
          <span class="hint">{{ clsSessions.length }} 次作业 · {{ clsStudents.length }} 名学生</span>
          <div class="matrix-wrap" v-if="matrix.cols.length">
            <table class="matrix">
              <thead>
                <tr>
                  <th class="stu-cell">学生</th>
                  <th v-for="s in matrix.cols" :key="s.id">
                    <router-link class="col-link" :to="'/live/'+s.id" :title="s.date + ' ' + (s.title || s.subject)">
                      <div class="d">{{ s.date.slice(5) }}</div>
                      <div class="col-title">{{ s.title || s.subject }}</div>
                    </router-link>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in matrix.rows" :key="row.stu.id">
                  <td class="stu-cell">{{ row.stu.name }} <span class="hint">{{ row.stu.stuNo }}</span></td>
                  <td v-for="(cell, ci) in row.cells" :key="ci">
                    <template v-if="!cell.absent">
                      <span class="grade-chip" :class="gradePosCls(cell.grade)" v-if="cell.grade">{{ cell.grade }}</span>
                      <span class="hint" v-else>已</span>
                      <span class="m-late" v-if="cell.late" title="补交">补</span>
                    </template>
                    <span class="m-absent" v-else title="未交">缺</span>
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td class="stu-cell col-sum">交齐</td>
                  <td class="col-sum" v-for="s in matrix.cols" :key="s.id">{{ s.stats ? s.stats.submitted + s.stats.late : 0 }}/{{ s.stats ? s.stats.total : 0 }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div class="empty" v-else>这个班还没有作业记录</div>
          <p class="hint" style="margin-top:10px">等级底色与批改页一致（在「设置-批改等级」里定义）· 已交未批标「已」· 「补」= 补交 · 「缺」= 未交。作业多时表格可左右滚动，学生列固定。</p>
        </div>
      </template>

      <!-- ======== 学生视角：搜索 + 时间线 ======== -->
      <template v-else>
        <div class="card">
          <div class="row">
            <input v-model="stuQuery" placeholder="输入姓名或学号，跨班级搜索" style="min-width:260px">
            <span class="hint" v-if="!stuQuery.trim()">搜到后点名字看 TA 的全部作业记录</span>
          </div>
          <div class="row" style="margin-top:10px" v-if="stuQuery.trim()">
            <button class="btn sm" v-for="m in stuMatches" :key="m.id" :class="{primary: stuId===m.id}" @click="pickStudent(m)">
              {{ (classById(m.classId)||{}).name || '?' }} · {{ m.name }}<span class="hint">（{{ m.stuNo }}）</span>
            </button>
            <span class="hint" v-if="!stuMatches.length">没有匹配的学生</span>
            <span class="hint" v-else-if="stuAll.length > 20">共 {{ stuAll.length }} 位匹配，仅显示前 20 位，请输入更精确的关键字</span>
          </div>
        </div>

        <template v-if="stu">
          <div class="card">
            <div class="row" style="margin-bottom:10px">
              <h2 style="margin:0">{{ stu.name }} · {{ (classById(stu.classId)||{}).name || '?' }}</h2>
              <span class="hint">学号 {{ stu.stuNo }}</span>
            </div>
            <div class="row">
              <span class="tag">共 {{ stuSummary.total }} 次</span>
              <span class="tag green">已交 {{ stuSummary.ok }}</span>
              <span class="tag amber" v-if="stuSummary.late">补交 {{ stuSummary.late }}</span>
              <span class="tag" :class="{red: stuSummary.absent}" v-if="stuSummary.absent">未交 {{ stuSummary.absent }}</span>
              <span class="tag" v-for="(n, g) in stuSummary.grades" :key="g" :class="gradePosCls(g)">{{ g }} × {{ n }}</span>
            </div>
          </div>
          <div class="card" v-if="stuTimeline.length">
            <table class="list timeline">
              <thead><tr><th>日期</th><th>科目 / 标题</th><th>状态</th><th>等级</th><th>扫码序 / 时间</th></tr></thead>
              <tbody>
                <tr v-for="row in stuTimeline" :key="row.s.id">
                  <td>{{ row.s.date }}</td>
                  <td><b>{{ row.s.title || row.s.subject }}</b><span class="hint" v-if="row.s.title" style="margin-left:6px">{{ row.s.subject }}</span></td>
                  <td><span class="tag" :class="!row.sub ? '' : (row.sub.status === 'late' ? 'amber' : 'green')">{{ !row.sub ? '未交' : row.sub.status === 'late' ? '补交' : '已交' }}</span></td>
                  <td><span class="grade-chip" :class="gradePosCls(row.sub && row.sub.grade)" v-if="row.sub && row.sub.grade">{{ row.sub.grade }}</span><span class="hint" v-else>—</span></td>
                  <td class="hint">{{ row.sub ? '#' + row.sub.order + ' · ' + fmtTime(row.sub.time) : '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>
    </div>`,
    setup() { return { state }; },
  });
})();
