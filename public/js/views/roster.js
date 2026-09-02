// 名单管理：班级增删 + 学生名单编辑 + Excel 导入
// 可独立作为路由页（/roster，旧链接兼容），也可嵌在设置壳里（settings 路由）
(function () {
  'use strict';
  const { api, toast, registerView } = window.App;
  const { state, refresh, studentsOf, classById, setClass } = window.Store;

  registerView('roster-view', {
    props: { embedded: { type: Boolean, default: false } },
    data() {
      return {
        newClassName: '',
        newStudent: { name: '', stuNo: '' },
        importPreview: null,
        importMode: 'append',
        busy: false,
        filter: '',
      };
    },
    computed: {
      currentClass: {
        get() { return state.classId; },
        set(v) { setClass(v); },
      },
      classId() { return state.classId; },
      cls() { return classById(this.classId); },
      students() {
        const list = this.classId ? studentsOf(this.classId) : [];
        const kw = this.filter.trim();
        return kw ? list.filter(s => s.name.includes(kw) || s.stuNo.includes(kw)) : list;
      },
    },
    methods: {
      async addClass() {
        const name = this.newClassName.trim();
        if (!name) return;
        await api('POST', '/classes', { name });
        this.newClassName = '';
        await refresh();
        const created = state.classes.find(c => c.name === name);
        if (created) this.currentClass = created.id;
        toast(`已创建「${name}」`, 'ok');
      },
      async deleteClass() {
        if (!this.cls) return;
        if (!confirm(`确定删除「${this.cls.name}」？其名单与登记记录将一并删除。`)) return;
        await api('DELETE', `/classes/${this.classId}`);
        await refresh();
        toast('已删除');
      },
      async addStudent() {
        const name = this.newStudent.name.trim();
        if (!name || !this.classId) return;
        await api('POST', `/classes/${this.classId}/students`, { name, stuNo: this.newStudent.stuNo.trim() });
        this.newStudent = { name: '', stuNo: '' };
        await refresh();
      },
      async saveStudent(stu) {
        try {
          await api('PUT', `/students/${stu.id}`, { name: stu.name, stuNo: stu.stuNo });
        } catch (e) {
          toast(e.message, 'err');
          refresh();
        }
      },
      async deleteStudent(stu) {
        if (!confirm(`删除学生「${stu.name}」？`)) return;
        await api('DELETE', `/students/${stu.id}`);
        refresh();
      },
      async onImportFile(ev) {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        try {
          const buf = await file.arrayBuffer();
          const wb = window.XLSX.read(buf, { type: 'array' });
          const rows = window.App.parseRosterSheet(wb.Sheets[wb.SheetNames[0]]);
          if (!rows.length) return toast('没有解析到名单：文件需有「姓名」列表头', 'err');
          this.importPreview = { rows, fileName: file.name };
          this.importMode = 'append';
        } catch (e) {
          toast('文件解析失败：' + e.message, 'err');
        }
      },
      downloadTemplate() {
        const aoa = [['姓名', '学号'], ['张三', '01'], ['李四', '02']];
        const ws = window.XLSX.utils.aoa_to_sheet(aoa);
        const wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, '名单');
        window.XLSX.writeFile(wb, '名单模板.xlsx');
      },
      async confirmImport() {
        if (!this.importPreview || !this.classId) return;
        this.busy = true;
        try {
          const r = await api('POST', `/classes/${this.classId}/import`, {
            students: this.importPreview.rows,
            mode: this.importMode,
          });
          toast(`导入完成：新增 ${r.added} 人，班级现有 ${r.total} 人`, 'ok');
          this.importPreview = null;
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
        } finally { this.busy = false; }
      },
      cancelImport() { this.importPreview = null; },
    },
    template: `
    <div :class="embedded ? '' : 'page'">
      <div class="card">
        <h2>班级 <span class="sub">一个老师可管理多个班</span></h2>
        <div class="row" style="margin-bottom:12px">
          <select v-model.number="currentClass" style="min-width:180px">
            <option v-for="c in state.classes" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="btn sm danger" @click="deleteClass" :disabled="!cls">删除班级</button>
          <div class="spacer"></div>
          <input v-model="newClassName" placeholder="新班级名称，如：三年二班" @keyup.enter="addClass" style="width:210px">
          <button class="btn primary" @click="addClass">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            新建班级
          </button>
        </div>

        <div class="row" v-if="cls">
          <input v-model="filter" placeholder="搜索姓名/学号" style="width:180px">
          <div class="spacer"></div>
          <label class="btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
            导入 Excel/CSV
            <input type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="onImportFile">
          </label>
          <button class="btn" @click="downloadTemplate">下载模板</button>
        </div>
      </div>

      <div class="card" v-if="importPreview">
        <h2>导入预览 <span class="sub">{{ importPreview.fileName }} · 共 {{ importPreview.rows.length }} 人</span></h2>
        <div class="row" style="margin-bottom:10px">
          <label class="chip" :class="{on: importMode==='append'}"><input type="radio" value="append" v-model="importMode" style="display:none"> 追加到现有名单</label>
          <label class="chip" :class="{on: importMode==='replace'}"><input type="radio" value="replace" v-model="importMode" style="display:none"> 覆盖现有名单</label>
        </div>
        <div style="max-height:220px;overflow:auto;margin-bottom:12px">
          <table class="list">
            <thead><tr><th>#</th><th>姓名</th><th>学号</th></tr></thead>
            <tbody><tr v-for="(r,i) in importPreview.rows.slice(0,50)" :key="i"><td>{{ i+1 }}</td><td>{{ r.name }}</td><td>{{ r.stuNo || '（自动编号）' }}</td></tr></tbody>
          </table>
          <div class="hint" v-if="importPreview.rows.length > 50">仅显示前 50 人…</div>
        </div>
        <div class="row">
          <button class="btn primary" :disabled="busy" @click="confirmImport">确认导入</button>
          <button class="btn" @click="cancelImport">取消</button>
        </div>
      </div>

      <div class="card" v-if="cls">
        <h2>「{{ cls.name }}」名单 <span class="sub">{{ studentsOf(classId).length }} 人</span></h2>
        <div class="row" style="margin-bottom:10px">
          <input v-model="newStudent.stuNo" placeholder="学号(可空)" style="width:110px">
          <input v-model="newStudent.name" placeholder="姓名" @keyup.enter="addStudent" style="width:140px">
          <button class="btn primary sm" @click="addStudent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            添加
          </button>
        </div>
        <table class="list" v-if="students.length">
          <thead><tr><th style="width:70px">学号</th><th>姓名</th><th style="width:90px"></th></tr></thead>
          <tbody>
            <tr v-for="s in students" :key="s.id">
              <td><input v-model="s.stuNo" style="width:60px;padding:4px 8px" @change="saveStudent(s)"></td>
              <td><input v-model="s.name" style="width:120px;padding:4px 8px" @change="saveStudent(s)"></td>
              <td><button class="btn sm danger" @click="deleteStudent(s)">删除</button></td>
            </tr>
          </tbody>
        </table>
        <div class="empty" v-else>还没有学生，导入 Excel 或手动添加</div>
      </div>

      <div class="empty" v-else-if="state.loaded && !state.classes.length">
        先创建一个班级，再导入学生名单
      </div>
    </div>`,
    setup() { return { state, studentsOf, refresh }; },
  });
})();
