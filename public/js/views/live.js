// 大屏看板：与扫码端实时同步，未交名单一键复制/导出
(function () {
  'use strict';
  const { api, toast, fmtTime, registerView, download } = window.App;
  const { state, refresh, onSessionEvent, studentsOf, classById, absentText } = window.Store;

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
        const { submitted, late, total } = this.session.stats;
        return { submitted, late, total, absent: total - submitted - late };
      },
    },
    async created() {
      await this.load();
      this.off = onSessionEvent(this.sid, m => this.onEvent(m));
    },
    beforeUnmount() { if (this.off) this.off(); },
    methods: {
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
        this.picked = null;
        if (action === 'unsubmit') await api('POST', `/sessions/${this.sid}/unsubmit`, { studentId: s.id });
        if (action === 'late') await api('POST', `/sessions/${this.sid}/setlate`, { studentId: s.id, late: !(s.sub && s.sub.status === 'late') });
        if (action === 'mark') {
          // 桌面端补登记：手机漏扫的学生，老师在大屏上直接点「已交」
          const cls = classById(this.session.classId);
          await api('POST', `/sessions/${this.sid}/scan`, { code: window.QrPdf.payload(cls, s) });
          toast(`已登记「${s.name}」`, 'ok');
        }
      },
      async copyAbsent() {
        const text = absentText(this.session);
        try {
          await navigator.clipboard.writeText(text);
          toast('未交名单已复制，可直接粘贴到家长群', 'ok');
        } catch {
          prompt('请手动复制：', text);
        }
      },
      exportExcel() {
        const XLSX = window.XLSX;
        const rows = [['学号', '姓名', '提交状态', '扫码顺序', '提交时间', '等级']];
        const list = this.session.students.slice().sort((a, b) => (a.stuNo > b.stuNo ? 1 : -1));
        for (const s of list) {
          rows.push([
            s.stuNo, s.name,
            !s.sub ? '未交' : s.sub.status === 'late' ? '补交' : '已交',
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
          const qr = qrcode(0, 'M');
          qr.addData(this.scanUrl);
          qr.make();
          const n = qr.getModuleCount(), scale = 6, quiet = 4;
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = (n + quiet * 2) * scale;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#000';
          for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
          this.qrDataUrl = canvas.toDataURL('image/png');
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
      async deleteSession() {
        if (!confirm('删除这场登记记录？（导出后再删更稳妥）')) return;
        await api('DELETE', `/sessions/${this.sid}`);
        this.$router.push('/');
      },
    },
    template: `
    <div class="page" v-if="session">
      <div class="card">
        <div class="row" style="margin-bottom:14px">
          <h2 v-if="!editTitle" style="margin:0;font-size:20px">{{ session.className }} · {{ session.subject }}<template v-if="session.title"> ·「{{ session.title }}」</template> · {{ session.date }}</h2>
          <div v-else class="row title-edit" style="margin:0">
            <input v-model="titleDraft" placeholder="作业标题，如：光的干涉（留空清除）" @keyup.enter="saveTitle" @keyup.esc="editTitle=false">
            <button class="btn sm primary" @click="saveTitle">保存</button>
            <button class="btn sm" @click="editTitle=false">取消</button>
          </div>
          <button v-if="!editTitle" class="btn sm" style="padding:2px 8px" title="编辑标题" @click="editTitleStart">✏️</button>
          <span class="tag" :class="session.closed ? 'blue' : 'green'">{{ session.closed ? '已截止（扫码记补交）' : '收集中' }}</span>
          <div class="spacer"></div>
          <button class="btn sm" @click="showPhoneQrFn">📱 手机扫码</button>
          <button class="btn sm" @click="toggleClosed">{{ session.closed ? '重新打开' : '截止收集' }}</button>
          <button class="btn sm danger" @click="deleteSession">删除</button>
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
          <div style="text-align:center;min-width:90px">
            <div class="stat-big" style="color:var(--danger);font-size:30px">{{ statText.absent }}</div>
            <div class="hint">未交</div>
          </div>
          <div class="spacer"></div>
          <div class="row" style="flex-direction:column;align-items:stretch">
            <div class="row">
              <button class="btn primary" @click="$router.push('/grade/'+sid)">✏️ 按扫码顺序批改</button>
              <button class="btn" @click="copyAbsent">📋 复制未交名单</button>
              <button class="btn" @click="exportExcel">⬇ 导出 Excel</button>
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
          <span class="hint">🟩 已交 · 🟨 补交 · 点学生卡可撤销/标记</span>
        </div>
        <div class="stu-grid">
          <div v-for="s in studentsView" :key="s.id" class="stu-card" :class="s.sub ? (s.sub.status==='late' ? 'late' : 'ok') : ''" @click="picked = s">
            <span class="order-no" v-if="s.sub">#{{ s.sub.order }}</span>
            <div class="name">{{ s.name }}</div>
            <div class="meta">{{ s.stuNo }}<span class="time" v-if="s.sub"> · {{ fmtTime(s.sub.time) }}</span><span v-if="s.sub && s.sub.status==='late'"> · 补交</span></div>
            <span class="grade-chip" :class="'g-'+s.sub.grade" v-if="s.sub && s.sub.grade">{{ s.sub.grade }}</span>
          </div>
        </div>
      </div>

      <!-- 学生操作 -->
      <div v-if="picked" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center" @click.self="picked=null">
        <div class="card" style="width:300px;text-align:center">
          <h2 style="justify-content:center">{{ picked.name }}（{{ picked.stuNo }}）</h2>
          <p class="hint" style="margin-bottom:14px">
            {{ picked.sub ? (picked.sub.status==='late' ? '补交 · 顺序#'+picked.sub.order : '已交 · 顺序#'+picked.sub.order) : '未交' }}
          </p>
          <div class="row" style="justify-content:center">
            <button class="btn primary" v-if="!picked.sub" @click="act('mark')">✔ 标记已交（补登记）</button>
            <button class="btn" v-if="picked.sub" @click="act('unsubmit')">撤销登记</button>
            <button class="btn" v-if="picked.sub" @click="act('late')">{{ picked.sub.status==='late' ? '改为已交' : '标记补交' }}</button>
          </div>
          <button class="btn sm" style="margin-top:12px" @click="picked=null">关闭</button>
        </div>
      </div>

      <!-- 手机入口 -->
      <div v-if="showPhoneQr" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center" @click.self="showPhoneQr=false">
        <div class="card" style="text-align:center;max-width:400px">
          <h2 style="justify-content:center">📱 手机扫这个码开始收作业</h2>
          <div class="qr-white"><img v-if="qrDataUrl" :src="qrDataUrl" style="width:230px;height:230px"></div>
          <p class="hint" style="text-align:left;margin-top:10px">首次打开：iPhone 点「显示详细信息 → 访问此网站」；Android 点「高级 → 继续前往」，然后允许摄像头。</p>
          <p class="hint" style="word-break:break-all">{{ scanUrl }}</p>
        </div>
      </div>
    </div>
    <div class="page" v-else><div class="empty">加载中…</div></div>`,
    setup() { return { fmtTime }; },
  });
})();
