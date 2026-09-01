// 二维码批量生成：三种排版 A4 PDF + 勾选补打
(function () {
  'use strict';
  const { api, toast, registerView, download } = window.App;
  const { state, studentsOf, classById } = window.Store;

  registerView('qr-view', {
    data() {
      return {
        layout: 'large',
        selected: new Set(),
        previewUrl: '',
        busy: false,
        layouts: [
          { key: 'large', name: '1份/人', desc: '28mm 码带规范静区间隙，3列×5行每页 15 人' },
          { key: 'row6', name: '1行/人（6个）', desc: '每生 6 个 24mm 小码，坏了就换，一学期够用' },
          { key: 'page36', name: '1页/人（36个）', desc: '整页同一名学生，适合打印备用/发给家长' },
        ],
      };
    },
    computed: {
      classId() { return state.classId; },
      cls() { return classById(this.classId); },
      students() { return this.classId ? studentsOf(this.classId) : []; },
      allSelected() { return this.students.length > 0 && this.students.every(s => this.selected.has(s.id)); },
    },
    created() {
      // 名单可能在 store 加载完成前为空，等名单到达后再默认全选一次
      this._stopWatchStudents = this.$watch(
        () => this.students,
        list => { if (!this._touchedSelection && this.selected.size === 0) list.forEach(s => this.selected.add(s.id)); },
        { immediate: true },
      );
    },
    beforeUnmount() { if (this._stopWatchStudents) this._stopWatchStudents(); },
    methods: {
      toggleAll() {
        this._touchedSelection = true;
        if (this.allSelected) this.selected.clear();
        else this.students.forEach(s => this.selected.add(s.id));
      },
      toggle(id) {
        this._touchedSelection = true;
        this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
      },
      async generate() {
        const list = this.students.filter(s => this.selected.has(s.id));
        if (!list.length) return toast('请先勾选要打印的学生', 'err');
        this.busy = true;
        try {
          const doc = window.QrPdf.generateStickers({ cls: this.cls, students: list, layout: this.layout });
          const blob = doc.output('blob');
          this.previewUrl = URL.createObjectURL(blob);
          download(blob, `${this.cls.name}-二维码贴纸-${list.length}人.pdf`);
          toast(`已生成 ${list.length} 名学生的二维码 PDF`, 'ok');
        } catch (e) {
          toast('生成失败：' + e.message, 'err');
        } finally {
          this.busy = false;
        }
      },
    },
    template: `
    <div class="page">
      <div class="hint-box" style="margin-bottom:16px">
        <b>使用建议：</b>全班统一贴在<b>作业本封面右上角</b>或姓名栏旁，收上来摊开时码都露在同一位置，扫码最快。
        想一次管一学期，可以把 PDF 拿去打印成<b>不干胶防水贴</b>。谁的码坏了/换本子了，在这页单独勾选补打谁。
      </div>

      <div class="card">
        <h2>班级 <span class="sub">{{ cls ? cls.name + ' · ' + students.length + ' 人' : '请先在「名单」页创建' }}</span></h2>
        <div class="chips" style="margin-bottom:14px">
          <label v-for="l in layouts" :key="l.key" class="chip" :class="{on: layout===l.key}" style="flex-direction:column;gap:2px;border-radius:12px;padding:10px 16px">
            <input type="radio" :value="l.key" v-model="layout" style="display:none">
            <b>{{ l.name }}</b>
            <span style="font-size:12px;opacity:.8">{{ l.desc }}</span>
          </label>
        </div>
        <div class="row">
          <button class="btn primary big" :disabled="busy || !cls" @click="generate">🖨 生成并下载 PDF</button>
          <span class="hint">将下载 {{ students.length && allSelected ? '全班' : selected.size + ' 名学生' }} 的贴纸文件，浏览器内可预览</span>
        </div>
      </div>

      <div class="card" v-if="cls">
        <h2>选择学生 <span class="sub">补打时只勾选对应学生即可</span></h2>
        <div class="row" style="margin-bottom:10px">
          <button class="btn sm" @click="toggleAll">{{ allSelected ? '全不选' : '全选' }}</button>
          <span class="hint">已选 {{ selected.size }} / {{ students.length }} 人</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px">
          <label v-for="s in students" :key="s.id" class="chip" :class="{on: selected.has(s.id)}" style="justify-content:flex-start">
            <input type="checkbox" :checked="selected.has(s.id)" @change="toggle(s.id)" style="margin-right:6px">
            {{ s.stuNo }} {{ s.name }}
          </label>
        </div>
      </div>

      <div class="card" v-if="previewUrl">
        <h2>PDF 预览</h2>
        <iframe :src="previewUrl" style="width:100%;height:70vh;border:1px solid var(--line);border-radius:8px"></iframe>
      </div>
    </div>`,
  });
})();
