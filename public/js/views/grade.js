// 按扫码顺序批改：作业本堆叠顺序 = 扫码顺序，键盘 1/2/3/4 逐本打等级
(function () {
  'use strict';
  const { api, toast, registerView } = window.App;
  const { onSessionEvent } = window.Store;

  const GRADES = ['A+', 'A', 'A-', '不合格'];
  const KEYMAP = { '1': 'A+', '2': 'A', '3': 'A-', '4': '不合格', 'x': null };
  const BTNCls = { 'A+': 'on-a', 'A': 'on-a2', 'A-': 'on-a3', '不合格': 'on-f' };

  registerView('grade-view', {
    data() {
      return {
        session: null,
        off: null,
        cursor: 0,           // 当前批改位置（列表下标）
        checked: new Set(),  // 批量选择的 studentId
        undoStack: [],
      };
    },
    computed: {
      sid() { return Number(this.$route.params.sid); },
      rows() {
        if (!this.session) return [];
        const list = this.session.students.filter(s => s.sub);
        list.sort((a, b) => a.sub.order - b.sub.order);
        return list;
      },
      gradedCount() { return this.rows.filter(r => r.sub && r.sub.grade).length; },
      allChecked() { return this.rows.length > 0 && this.rows.every(r => this.checked.has(r.id)); },
    },
    async created() {
      await this.load();
      this.off = onSessionEvent(this.sid, m => {
        if (['grade', 'grade_batch', 'scan', 'unsubmit', 'setlate'].includes(m.type)) this.load();
      });
      window.addEventListener('keydown', this.onKey);
    },
    beforeUnmount() {
      if (this.off) this.off();
      window.removeEventListener('keydown', this.onKey);
    },
    methods: {
      async load() {
        try { this.session = await api('GET', `/sessions/${this.sid}`); } catch (e) { toast(e.message, 'err'); }
      },
      onKey(ev) {
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') { ev.preventDefault(); return this.undo(); }
        const g = KEYMAP[ev.key];
        if (g === undefined) return;
        ev.preventDefault();
        if (this.checked.size) this.applyBatch(g);
        else this.gradeCurrent(g);
      },
      async gradeCurrent(grade) {
        const row = this.rows[this.cursor];
        if (!row) return toast('都批完啦 🎉');
        await this.setGrade(row, grade);
        if (this.cursor < this.rows.length - 1) this.cursor++;
      },
      async setGrade(row, grade) {
        this.undoStack.push({ studentId: row.id, prev: row.sub.grade });
        if (this.undoStack.length > 200) this.undoStack.shift();
        row.sub.grade = grade;
        try {
          await api('POST', `/sessions/${this.sid}/grade`, { studentId: row.id, grade });
        } catch (e) {
          toast(e.message, 'err');
          row.sub.grade = this.undoStack.pop().prev;
        }
      },
      async applyBatch(grade) {
        const ids = [...this.checked];
        for (const id of ids) {
          const row = this.rows.find(r => r.id === id);
          if (row) this.undoStack.push({ studentId: id, prev: row.sub.grade });
        }
        try {
          await api('POST', `/sessions/${this.sid}/grade-batch`, { studentIds: ids, grade });
          for (const row of this.rows) if (this.checked.has(row.id)) row.sub.grade = grade;
          this.checked.clear();
          toast(`已为 ${ids.length} 人设置「${grade === null ? '清除' : grade}」`, 'ok');
        } catch (e) {
          toast(e.message, 'err');
        }
      },
      async undo() {
        const op = this.undoStack.pop();
        if (!op) return toast('没有可撤销的操作');
        try {
          await api('POST', `/sessions/${this.sid}/grade`, { studentId: op.studentId, grade: op.prev });
          const row = this.rows.find(r => r.id === op.studentId);
          if (row) row.sub.grade = op.prev;
        } catch (e) { toast(e.message, 'err'); }
      },
      toggleCheck(row) {
        this.checked.has(row.id) ? this.checked.delete(row.id) : this.checked.add(row.id);
      },
      toggleSelectAll() {
        if (this.allChecked) this.checked.clear();
        else this.rows.forEach(r => this.checked.add(r.id));
      },
      clearChecked() { this.checked.clear(); },
      async gradeAllUngraded(grade) {
        const ids = this.rows.filter(r => !r.sub.grade).map(r => r.id);
        if (!ids.length) return toast('没有未批改的作业');
        for (const id of ids) {
          const row = this.rows.find(r => r.id === id);
          this.undoStack.push({ studentId: id, prev: null });
        }
        await api('POST', `/sessions/${this.sid}/grade-batch`, { studentIds: ids, grade });
        await this.load();
        toast(`已把 ${ids.length} 份未批改作业设为「${grade}」`, 'ok');
      },
    },
    template: `
    <div class="page" v-if="session">
      <div class="card">
        <div class="row" style="margin-bottom:10px">
          <h2 style="margin:0">{{ session.className }} · {{ session.subject }} · {{ session.date }}</h2>
          <span class="tag green">按扫码顺序 = 作业堆叠顺序</span>
          <div class="spacer"></div>
          <router-link class="btn sm" :to="'/live/'+sid">返回看板</router-link>
        </div>
        <div class="row">
          <span class="hint">键盘流：<span class="kbd">1</span> A+　<span class="kbd">2</span> A　<span class="kbd">3</span> A-　<span class="kbd">4</span> 不合格　<span class="kbd">X</span> 清除　<span class="kbd">Ctrl+Z</span> 撤销</span>
          <div class="spacer"></div>
          <span class="tag">已批 {{ gradedCount }} / {{ rows.length }}</span>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn sm" :disabled="!undoStack.length" @click="undo">↩ 撤销上一步</button>
          <button class="btn sm" @click="gradeAllUngraded('A')">把未批改的全部设为 A</button>
          <template v-if="checked.size">
            <div class="spacer"></div>
            <span class="tag blue">已选 {{ checked.size }} 人 →</span>
            <button class="btn sm" v-for="g in ['A+','A','A-','不合格',null]" :key="g" @click="applyBatch(g)">{{ g === null ? '清除' : g }}</button>
            <button class="btn sm" @click="clearChecked">取消选择</button>
          </template>
          <template v-else>
            <div class="spacer"></div>
            <span class="hint">先点选多行，可批量设等级；按 1/2/3/4 会直接批给当前行</span>
          </template>
        </div>
      </div>

      <div class="card" style="padding:6px">
        <div class="grade-row head">
          <input type="checkbox" style="zoom:1.3" :checked="allChecked" @change="toggleSelectAll">
          <span class="gname" style="cursor:pointer;user-select:none" @click="toggleSelectAll">全选 <span class="hint" v-if="checked.size">（已选 {{ checked.size }} / {{ rows.length }}）</span></span>
        </div>
        <div v-for="(row, i) in rows" :key="row.id">
          <div class="grade-row" :class="{current: i===cursor}">
            <input type="checkbox" style="zoom:1.3" :checked="checked.has(row.id)" @change="toggleCheck(row)">
            <span class="idx">#{{ row.sub.order }}</span>
            <span class="gname">{{ row.name }} <span class="hint">{{ row.stuNo }}<span v-if="row.sub.status==='late'"> · 补交</span></span></span>
            <span class="grade-chip" :class="'g-'+row.sub.grade" v-if="row.sub.grade">{{ row.sub.grade }}</span>
            <button class="gbtn" v-for="g in ['A+','A','A-','不合格']" :key="g" :class="{ [BTNCls[g]]: row.sub.grade===g }" @click="setGrade(row, g); if(cursor===i) cursor++">{{ g }}</button>
            <button class="gbtn" v-if="row.sub.grade" @click="setGrade(row, null)">×</button>
          </div>
        </div>
        <div class="empty" v-if="!rows.length">还没有人登记，先去扫码</div>
      </div>
    </div>
    <div class="page" v-else><div class="empty">加载中…</div></div>`,
    setup() { return { BTNCls }; },
  });
})();
