// 历史记录：所有场次一览 + 单场导出
(function () {
  'use strict';
  const { api, toast, registerView } = window.App;
  const { state, studentsOf, classById } = window.Store;

  registerView('history-view', {
    data() { return { filterClass: '', armDeleteId: null }; },
    computed: {
      list() {
        let list = state.sessions.slice().sort((a, b) => b.id - a.id);
        if (this.filterClass) list = list.filter(s => s.classId === this.filterClass);
        return list;
      },
    },
    methods: {
      studentsOf, classById,
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
        for (const s of list) {
          const sid = Number(this.$route ? s.id : s.id);
          void sid;
        }
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
        <div class="row">
          <h2 style="margin:0">历史登记</h2>
          <select v-model="filterClass" style="min-width:150px">
            <option value="">全部班级</option>
            <option v-for="c in state.classes" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <div class="spacer"></div>
          <button class="btn" @click="exportAll">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
            导出全部（多工作表）
          </button>
        </div>
      </div>

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
    </div>`,
    setup() { return { state }; },
  });
})();
