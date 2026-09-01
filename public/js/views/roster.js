// 名单管理：班级增删 + 学生名单编辑 + Excel 导入
(function () {
  'use strict';
  const { api, toast, registerView, parseRosterSheet, download } = window.App;
  const { state, refresh, studentsOf, classById, setClass } = window.Store;

  registerView('roster-view', {
    data() {
      return {
        newClassName: '',
        newStudent: { name: '', stuNo: '' },
        importPreview: null, // {rows:[{name,stuNo}], fileName}
        importMode: 'append',
        restorePreview: null, // {fileName, data, classes, students, sessions}
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

      // ---- Excel 导入 ----
      async onImportFile(ev) {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        try {
          const buf = await file.arrayBuffer();
          const wb = window.XLSX.read(buf, { type: 'array' });
          const rows = parseRosterSheet(wb.Sheets[wb.SheetNames[0]]);
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
        } finally {
          this.busy = false;
        }
      },

      // ---- 数据备份/还原 ----
      async exportData() {
        this.busy = true;
        try {
          const res = await fetch('/api/export');
          if (!res.ok) throw new Error(`请求失败 (${res.status})`);
          const data = await res.json();
          const savedCopy = res.headers.get('X-Backup-Saved') === '1';
          const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
          const d = new Date();
          const p = n => String(n).padStart(2, '0');
          const fname = `作业扫码备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
          const inApp = state.serverInfo && state.serverInfo.app;
          if (inApp) {
            toast(savedCopy
              ? '备份已保存到数据文件夹的 backups/（菜单「打开数据文件夹」可查看）'
              : '备份已生成，但写入数据文件夹失败，请检查磁盘', savedCopy ? 'ok' : 'err', 4000);
          } else {
            download(blob, fname);
            toast(`已下载备份文件 ${fname}`, 'ok', 4000);
          }
        } catch (e) {
          toast(e.message, 'err');
        } finally {
          this.busy = false;
        }
      },
      onRestoreFile(ev) {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (!file || this.busy) return;
        file.text().then(text => {
          const data = JSON.parse(text.replace(/^\uFEFF/, ''));
          if (!data || !Array.isArray(data.classes) || !Array.isArray(data.students)) {
            throw new Error('不是本系统的备份文件（缺少班级/名单数据）');
          }
          this.restorePreview = {
            fileName: file.name,
            data,
            classes: data.classes.length,
            students: data.students.length,
            sessions: (data.sessions || []).length,
          };
        }).catch(e => {
          toast(e instanceof SyntaxError
            ? `「${file.name}」不是 JSON 备份文件，请使用「导出备份」生成的文件`
            : '无法读取备份文件：' + e.message, 'err');
        });
      },
      async confirmRestore() {
        const preview = this.restorePreview;
        if (!preview) return;
        this.busy = true;
        try {
          const r = await api('POST', '/import', preview.data);
          if (this.restorePreview === preview) this.restorePreview = null;
          toast(`已还原：${r.classes} 个班级、${r.students} 名学生、${r.sessions} 个场次，班级与学号保持不变`, 'ok', 4000);
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
        } finally {
          this.busy = false;
        }
      },
    },
    template: `
    <div class="page">
      <div class="card">
        <h2>班级 <span class="sub">一个老师可管理多个班</span></h2>
        <div class="row" style="margin-bottom:12px">
          <select v-model.number="currentClass" style="min-width:180px">
            <option v-for="c in state.classes" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="btn sm danger" @click="deleteClass" :disabled="!cls">删除班级</button>
          <div class="spacer"></div>
          <input v-model="newClassName" placeholder="新班级名称，如：三年二班" @keyup.enter="addClass" style="width:210px">
          <button class="btn primary" @click="addClass">＋ 新建班级</button>
        </div>

        <div class="row" v-if="cls">
          <input v-model="filter" placeholder="搜索姓名/学号" style="width:180px">
          <div class="spacer"></div>
          <label class="btn">
            📥 导入 Excel/CSV
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
          <button class="btn" @click="importPreview=null">取消</button>
        </div>
      </div>

      <div class="card" v-if="cls">
        <h2>「{{ cls.name }}」名单 <span class="sub">{{ studentsOf(classId).length }} 人</span></h2>
        <div class="row" style="margin-bottom:10px">
          <input v-model="newStudent.stuNo" placeholder="学号(可空)" style="width:110px">
          <input v-model="newStudent.name" placeholder="姓名" @keyup.enter="addStudent" style="width:140px">
          <button class="btn primary sm" @click="addStudent">＋ 添加</button>
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
      <div class="card" v-if="restorePreview">
        <h2>导入备份 <span class="sub">{{ restorePreview.fileName }}</span></h2>
        <div style="margin-bottom:10px">
          将覆盖当前全部数据，还原为：<b>{{ restorePreview.classes }}</b> 个班级、<b>{{ restorePreview.students }}</b> 名学生、<b>{{ restorePreview.sessions }}</b> 个收作业场次。<br>
          班级编号与学号保持原样，<b>已打印的二维码贴纸继续有效</b>（导入前会自动备份当前数据）。
        </div>
        <div class="row">
          <button class="btn primary" :disabled="busy" @click="confirmRestore">导入并覆盖</button>
          <button class="btn" @click="restorePreview=null">取消</button>
        </div>
      </div>

      <div class="card">
        <h2>💾 数据备份 <span class="sub">班级、名单、登记记录一键存本地</span></h2>
        <div class="row" style="margin-bottom:10px">
          <button class="btn" @click="exportData" :disabled="busy">⬇️ 导出备份</button>
          <label class="btn">
            📥 导入备份
            <input type="file" accept=".json,application/json" style="display:none" @change="onRestoreFile">
          </label>
        </div>
        <div class="hint">换电脑、重装系统或更新 App 前，先「导出备份」存一份文件；之后「导入备份」即可完整还原，<b>不需要重新导入 Excel</b>（重新导入会生成新班级，贴在作业本上的二维码就作废了）。桌面 App 版也可用菜单「导入旧数据（db.json）…」导入同样的备份文件。</div>
      </div>
    </div>`,
    setup() { return { state, studentsOf, refresh }; },
  });
})();
