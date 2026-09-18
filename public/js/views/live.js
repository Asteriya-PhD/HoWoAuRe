// 大屏看板：与扫码端实时同步，未交名单一键复制/导出
(function () {
  'use strict';
  const { api, toast, fmtTime, registerView, download, makeQrDataUrl } = window.App;
  const { state, refresh, onSessionEvent, studentsOf, classById, absentText, gradePosCls } = window.Store;

  registerView('live-view', {
    data() {
      return {
        session: null,
        off: null,
        picked: null,   // 点击学生卡 → 操作
        showPhoneQr: false,
        qrDataUrl: '',
        scanUrl: '',
        viewMode: 'stuNo',  // stuNo | order
        editTitle: false,   // 标题就地编辑
        titleDraft: '',
        editSubject: false, // 科目就地编辑
        subjectDraft: '',
        armDelete: false,        // 删除场次的就地二次确认
        absentFallback: '',      // 复制未交名单失败时的手动复制兜底
      };
    },
    computed: {
      sid() { return Number(this.$route.params.sid); },
      studentsView() {
        if (!this.session) return [];
        const list = this.session.students.slice();
        if (this.viewMode === 'order') {
          list.sort((a, b) => (a.sub?.order ?? 9999) - (b.sub?.order ?? 9999));
        }
        return list;
      },
      statText() {
        if (!this.session) return {};
        const { submitted, late, total, leave } = this.session.stats;
        return { submitted, late, total, leave: leave || 0, absent: total - submitted - late };
      },
      grades() { return (state.settings && state.settings.grades) || []; },
      subjects() {
        const list = (state.settings && state.settings.subjects) || [];
        return list.length ? list : ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '科学'];
      },
    },
    async created() {
      await this.load();
      this.off = onSessionEvent(this.sid, m => this.onEvent(m));
      this.keyHandler = (ev) => {
        // 弹窗没开、焦点在输入框时不抢键盘
        if (!this.picked) return;
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        let g;
        if (/^[1-9]$/.test(ev.key)) g = this.grades[Number(ev.key) - 1];
        else if (this.picked.sub && (ev.key === 'x' || ev.key === 'X')) g = null;
        if (g === undefined) return;
        ev.preventDefault();
        // 已交：直接改档；未交：一步「登记 + 打档」
        if (this.picked.sub) this.setGrade(this.picked, g);
        else if (g !== null) this.markAndGrade(this.picked, g);
      };
      window.addEventListener('keydown', this.keyHandler);
    },
    beforeUnmount() {
      if (this.off) this.off();
      window.removeEventListener('keydown', this.keyHandler);
    },
    methods: {
      async setGrade(s, grade) {
        if (!s.sub) return;
        try {
          await api('POST', `/sessions/${this.sid}/grade`, { studentId: s.id, grade });
          s.sub.grade = grade;
          toast(`「${s.name}」${grade === null ? '已清除等级' : '等级已设为 ' + grade}`, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      },
      // 一步到位：未交学生点等级 = 补登记已交 + 打该档（分组场次拒收组外学生，失败原样提示）
      async markAndGrade(s, grade) {
        const cls = classById(this.session.classId);
        try {
          const r = await api('POST', `/sessions/${this.sid}/scan`, { code: window.QrPdf.payload(cls, s) });
          if (!r.ok) return toast(r.message || '登记失败', 'err');
          await api('POST', `/sessions/${this.sid}/grade`, { studentId: s.id, grade });
          if (s.sub) s.sub.grade = grade;
          else s.sub = { order: r.order, time: r.time || Date.now(), status: r.status, grade };
          toast(`已登记「${s.name}」并设为 ${grade}${r.status === 'late' ? '（补交）' : ''}`, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      },
      async load() {
        try {
          this.session = await api('GET', `/sessions/${this.sid}`);
        } catch (e) {
          toast(e.message, 'err');
        }
      },
      onEvent(m) {
        if (!this.session) return;
        const s = this.session.students.find(x => x.id === m.studentId);
        switch (m.type) {
          case 'scan':
            if (s) s.sub = { order: m.order, time: m.time, status: m.status, grade: null };
            this.session.stats = m.stats;
            break;
          case 'unsubmit':
            if (s) s.sub = null;
            this.session.stats = m.stats;
            break;
          case 'setlate':
            if (s && s.sub) s.sub.status = m.status;
            this.session.stats = m.stats;
            break;
          case 'leave':
            if (s) {
              if (m.leave) { if (!this.session.leave) this.session.leave = {}; this.session.leave[s.id] = Date.now(); }
              else if (this.session.leave) delete this.session.leave[s.id];
              s.onLeave = !!m.leave;
            }
            this.session.stats = m.stats;
            break;
          case 'grade':
            if (s && s.sub) s.sub.grade = m.grade;
            break;
          case 'grade_batch':
            for (const id of m.studentIds) {
              const t = this.session.students.find(x => x.id === id);
              if (t && t.sub) t.sub.grade = m.grade;
            }
            break;
          case 'session_closed':
            this.session.closed = m.closed;
            break;
          default:
            this.load();
        }
      },
      async toggleClosed() {
        const target = !this.session.closed;
        await api('POST', `/sessions/${this.sid}/closed`, { closed: target });
        this.session.closed = target;
      },
      async act(action) {
        const s = this.picked;
        if (!s) return;
        // 补登记后弹窗保留，紧接着就能在同一弹窗里点等级；其余操作照旧关掉
        if (action !== 'mark') this.picked = null;
        if (action === 'unsubmit') await api('POST', `/sessions/${this.sid}/unsubmit`, { studentId: s.id });
        if (action === 'late') await api('POST', `/sessions/${this.sid}/setlate`, { studentId: s.id, late: !(s.sub && s.sub.status === 'late') });
        if (action === 'mark') {
          // 桌面端补登记：手机漏扫的学生，老师在大屏上直接点「已交」
          const cls = classById(this.session.classId);
          try {
            const r = await api('POST', `/sessions/${this.sid}/scan`, { code: window.QrPdf.payload(cls, s) });
            if (!r.ok) return toast(r.message || '登记失败', 'err');
            if (!s.sub) s.sub = { order: r.order, time: r.time || Date.now(), status: r.status, grade: null };
            toast(`已登记「${s.name}」，接着点下方等级即可`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        }
        if (action === 'leave') {
          const target = !s.onLeave;
          await api('POST', `/sessions/${this.sid}/leave`, { studentId: s.id, leave: target });
          toast(target ? `已标记「${s.name}」请假` : `已取消「${s.name}」的请假`, 'ok');
        }
      },
      async copyAbsent() {
        const text = absentText(this.session);
        try {
          await navigator.clipboard.writeText(text);
          toast('未交名单已复制，可直接粘贴到家长群', 'ok');
        } catch {
          // 剪贴板不可用（如非 HTTPS 上下文）：弹层展示全文，手动复制（Tauri 壳不支持 prompt()）
          this.absentFallback = text;
        }
      },
      exportExcel() {
        const XLSX = window.XLSX;
        const rows = [['学号', '姓名', '组别', '提交状态', '扫码顺序', '提交时间', '等级']];
        const list = this.session.students.slice().sort((a, b) => (a.stuNo > b.stuNo ? 1 : -1));
        for (const s of list) {
          rows.push([
            s.stuNo, s.name, s.group || '',
            !s.sub ? (s.onLeave ? '请假' : '未交') : s.sub.status === 'late' ? '补交' : '已交',
            s.sub ? s.sub.order : '',
            s.sub ? new Date(s.sub.time).toLocaleTimeString('zh-CN', { hour12: false }) : '',
            s.sub?.grade || '',
          ]);
        }
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '作业登记');
        XLSX.writeFile(wb, `${this.session.className}-${this.session.subject}${this.session.title ? '-' + this.session.title : ''}-${this.session.date}-作业登记.xlsx`);
      },
      async showPhoneQrFn() {
        const info = state.serverInfo;
        if (info && info.ips.length && info.httpsPort) {
          this.scanUrl = `https://${info.ips[0]}:${info.httpsPort}/#/scan?sid=${this.sid}`;
          this.qrDataUrl = makeQrDataUrl(this.scanUrl);
        }
        this.showPhoneQr = true;
      },
      editTitleStart() {
        this.titleDraft = this.session.title || '';
        this.editTitle = true;
        this.$nextTick(() => {
          const el = this.$el && this.$el.querySelector('.title-edit input');
          if (el) { el.focus(); el.select(); }
        });
      },
      async saveTitle() {
        const t = this.titleDraft.trim().slice(0, 50);
        try {
          await api('POST', `/sessions/${this.sid}/title`, { title: t });
          this.session.title = t;
          this.editTitle = false;
          toast(t ? '标题已更新' : '标题已清除', 'ok');
          refresh();
        } catch (e) { toast(e.message, 'err'); }
      },
      editSubjectStart() {
        this.subjectDraft = this.session.subject === '作业' ? '' : this.session.subject;
        this.editSubject = true;
        this.$nextTick(() => {
          const el = this.$el && this.$el.querySelector('input[list="hw-subject-list"]');
          if (el) { el.focus(); el.select(); }
        });
      },
      async saveSubject() {
        const t = this.subjectDraft.trim();
        try {
          await api('POST', `/sessions/${this.sid}/subject`, { subject: t });
          this.session.subject = t || '作业';
          this.editSubject = false;
          toast(t ? `科目已改为「${t}」` : '科目已恢复「作业」', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      },
      async deleteSession() {
        // 就地二次确认（Tauri 壳不支持 confirm()）：第一次点进入待确认态，3 秒后自动复位
        if (!this.armDelete) {
          this.armDelete = true;
          toast('再点一次「删除」确认，3 秒内有效', '', 2800);
          setTimeout(() => this.armDelete = false, 3000);
          return;
        }
        this.armDelete = false;
        await api('DELETE', `/sessions/${this.sid}`);
        this.$router.push('/');
      },
    },
    template: `
    <div class="page" v-if="session">
      <datalist id="hw-subject-list"><option v-for="s in subjects" :key="s" :value="s"></option></datalist>
      <div class="card">
        <div class="row" style="margin-bottom:14px">
          <h2 v-if="!editTitle" style="margin:0;font-size:20px">
            {{ session.className }} ·
            <template v-if="editSubject">
              <input v-model="subjectDraft" list="hw-subject-list" placeholder="科目，留空恢复「作业」" @keyup.enter="saveSubject" @keyup.esc="editSubject=false" style="width:160px;font-size:16px;padding:3px 8px">
              <button class="btn sm primary" style="padding:2px 8px" @click="saveSubject">保存</button>
              <button class="btn sm" style="padding:2px 8px" @click="editSubject=false">取消</button>
            </template>
            <span v-else style="cursor:pointer" title="点击修改科目" @click="editSubjectStart">{{ session.subject }}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:12px;height:12px;vertical-align:-1px;opacity:.55"><path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/></svg>
            </span>
            <template v-if="session.title"> ·「{{ session.title }}」</template> · {{ session.date }}
          </h2>
          <div v-else class="row title-edit" style="margin:0">
            <input v-model="titleDraft" placeholder="作业标题，如：光的干涉（留空清除）" @keyup.enter="saveTitle" @keyup.esc="editTitle=false">
            <button class="btn sm primary" @click="saveTitle">保存</button>
            <button class="btn sm" @click="editTitle=false">取消</button>
          </div>
          <button v-if="!editTitle" class="btn sm" style="padding:2px 8px" title="编辑标题" @click="editTitleStart">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:14px;height:14px"><path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/></svg>
          </button>
          <span class="tag" :class="session.closed ? 'blue' : 'green'">{{ session.closed ? '已截止（扫码记补交）' : '收集中' }}</span>
          <span class="tag blue" v-if="session.groups && session.groups.length" title="分组检查：未勾选组的学生扫码会被拒收">只收：{{ session.groups.join('、') }}</span>
          <div class="spacer"></div>
          <button class="btn sm" @click="showPhoneQrFn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/></svg>
            手机扫码
          </button>
          <button class="btn sm" @click="toggleClosed">{{ session.closed ? '重新打开' : '截止收集' }}</button>
          <button class="btn sm danger" :class="{armed: armDelete}" @click="deleteSession">{{ armDelete ? '再点一次确认删除' : '删除' }}</button>
        </div>

        <div class="row" style="align-items:flex-start">
          <div style="text-align:center;min-width:150px">
            <div class="stat-big" style="color:var(--primary)">{{ statText.submitted }}<small> / {{ statText.total }}</small></div>
            <div class="hint">已交</div>
          </div>
          <div style="text-align:center;min-width:90px" v-if="statText.late">
            <div class="stat-big" style="color:var(--warn);font-size:30px">{{ statText.late }}</div>
            <div class="hint">补交</div>
          </div>
          <div style="text-align:center;min-width:90px" v-if="statText.leave">
            <div class="stat-big" style="color:var(--leave-d);font-size:30px">{{ statText.leave }}</div>
            <div class="hint">请假</div>
          </div>
          <div style="text-align:center;min-width:90px">
            <div class="stat-big" style="color:var(--danger);font-size:30px">{{ statText.absent }}</div>
            <div class="hint">未交</div>
          </div>
          <div class="spacer"></div>
          <div class="row" style="flex-direction:column;align-items:stretch">
            <div class="row">
              <button class="btn primary" @click="$router.push('/grade/'+sid)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/></svg>
                按扫码顺序批改
              </button>
              <button class="btn" @click="copyAbsent">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                复制未交名单
              </button>
              <button class="btn" @click="exportExcel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
                导出 Excel
              </button>
            </div>
            <div class="hint" style="margin-top:6px">批改页与这里的数据实时同步</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom:12px">
          <span class="chip" :class="{on: viewMode==='stuNo'}" @click="viewMode='stuNo'">按学号</span>
          <span class="chip" :class="{on: viewMode==='order'}" @click="viewMode='order'">按扫码顺序</span>
          <div class="spacer"></div>
          <span class="hint"><span class="legend-dot ok"></span> 已交 · <span class="legend-dot late"></span> 补交 · <span class="legend-dot leave"></span> 请假 · 点学生卡可打等级/撤销/标记</span>
        </div>
        <div class="stu-grid">
          <div v-for="s in studentsView" :key="s.id" class="stu-card" :class="s.sub ? (s.sub.status==='late' ? 'late' : 'ok') : (s.onLeave ? 'leave' : '')" @click="picked = s">
            <span class="order-no" v-if="s.sub">#{{ s.sub.order }}</span>
            <div class="name">{{ s.name }}</div>
            <div class="meta">{{ s.stuNo }}<span class="time" v-if="s.sub"> · {{ fmtTime(s.sub.time) }}</span><span v-if="s.sub && s.sub.status==='late'"> · 补交</span><span v-if="s.onLeave && !s.sub"> · 请假</span></div>
            <span class="grade-chip" :class="gradePosCls(s.sub.grade)" v-if="s.sub && s.sub.grade">{{ s.sub.grade }}</span>
          </div>
        </div>
      </div>

      <!-- 学生操作 -->
      <div v-if="picked" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center" @click.self="picked=null">
        <div class="card" style="width:300px;text-align:center">
          <h2 style="justify-content:center">{{ picked.name }}（{{ picked.stuNo }}）</h2>
          <p class="hint" style="margin-bottom:14px">
            {{ picked.sub ? (picked.sub.status==='late' ? '补交 · 顺序#'+picked.sub.order : '已交 · 顺序#'+picked.sub.order) : '未交' }}
            <template v-if="picked.onLeave">（请假）</template>
          </p>
          <div class="row" style="justify-content:center">
            <button class="btn primary" v-if="!picked.sub && !picked.onLeave" @click="act('mark')">✓ 标记已交（补登记）</button>
            <button class="btn" v-if="picked.sub" @click="act('unsubmit')">撤销登记</button>
            <button class="btn" v-if="picked.sub" @click="act('late')">{{ picked.sub.status==='late' ? '改为已交' : '标记补交' }}</button>
            <button class="btn" @click="act('leave')">{{ picked.onLeave ? '取消请假' : '标记请假' }}</button>
          </div>
          <template v-if="picked.sub">
            <div class="row" style="justify-content:center;margin-top:14px;flex-wrap:wrap;gap:6px">
              <button class="gbtn" v-for="(g, i) in grades" :key="g"
                :title="'键盘 ' + (i + 1)"
                :class="{ [gradePosCls(g)]: picked.sub.grade === g }"
                @click="setGrade(picked, g)">{{ g }}</button>
              <button class="gbtn" v-if="picked.sub.grade" title="键盘 X" @click="setGrade(picked, null)">×</button>
            </div>
            <p class="hint" style="margin-top:8px">登记等级：键盘 <span class="kbd">1</span>~<span class="kbd">{{ grades.length }}</span> 选档，<span class="kbd">X</span> 清除</p>
          </template>
          <template v-else-if="!picked.onLeave && grades.length">
            <div class="row" style="justify-content:center;margin-top:14px;flex-wrap:wrap;gap:6px">
              <button class="gbtn" v-for="(g, i) in grades" :key="g"
                :title="'键盘 ' + (i + 1) + '：登记并打该档'"
                @click="markAndGrade(picked, g)">{{ g }}</button>
            </div>
            <p class="hint" style="margin-top:8px">一步登记：点等级 = 本子已交 + 打该档（键盘 <span class="kbd">1</span>~<span class="kbd">{{ grades.length }}</span>）</p>
          </template>
          <button class="btn sm" style="margin-top:12px" @click="picked=null">关闭</button>
        </div>
      </div>

      <!-- 手机入口 -->
      <div v-if="showPhoneQr" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center" @click.self="showPhoneQr=false">
        <div class="card" style="text-align:center;max-width:400px">
          <h2 style="justify-content:center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:20px;height:20px"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/></svg>
            手机扫这个码开始收作业
          </h2>
          <div class="qr-white"><img v-if="qrDataUrl" :src="qrDataUrl" style="width:230px;height:230px"></div>
          <p class="hint" style="text-align:left;margin-top:10px">首次打开：iPhone 点「显示详细信息 → 访问此网站」；Android 点「高级 → 继续前往」，然后允许摄像头。</p>
          <p class="hint" style="word-break:break-all">{{ scanUrl }}</p>
        </div>
      </div>

      <!-- 剪贴板不可用时的手动复制兜底 -->
      <div v-if="absentFallback" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px" @click.self="absentFallback=''">
        <div class="card" style="max-width:480px;width:100%">
          <h2>复制未交名单</h2>
          <p class="hint" style="margin-bottom:10px">自动复制失败，请长按/选中下面文字手动复制：</p>
          <textarea :value="absentFallback" readonly style="width:100%;height:110px;padding:10px 12px;font-size:14px;resize:vertical"></textarea>
          <div class="row" style="margin-top:12px;justify-content:flex-end">
            <button class="btn" @click="absentFallback=''">关闭</button>
          </div>
        </div>
      </div>
    </div>
    <div class="page" v-else><div class="empty">加载中…</div></div>`,
    setup() { return { fmtTime, gradePosCls }; },
  });
})();
