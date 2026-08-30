// 工作台：新建收作业场次 + 进行中场次 + 手机扫码入口
(function () {
  'use strict';
  const { api, toast, registerView } = window.App;
  const { state, refresh, studentsOf, classById } = window.Store;

  const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '科学'];

  registerView('home-view', {
    data() {
      return {
        subjects: SUBJECTS,
        subject: '数学',
        subjectCustom: '',
        date: new Date().toISOString().slice(0, 10),
        showQrFor: null,   // 显示手机入口二维码的场次 id
        qrDataUrl: '',
        scanUrl: '',
      };
    },
    computed: {
      classId() { return Number(localStorage.getItem('hw.class')) || (state.classes[0] && state.classes[0].id) || null; },
      cls() { return classById(this.classId); },
      openSessions() {
        return state.sessions.filter(s => !s.closed).sort((a, b) => b.id - a.id);
      },
      recentClosed() {
        return state.sessions.filter(s => s.closed).sort((a, b) => b.id - a.id).slice(0, 5);
      },
      effectiveSubject() { return (this.subjectCustom.trim() || this.subject); },
    },
    methods: {
      studentsOf, classById,
      async createSession() {
        if (!this.classId) return toast('请先在「名单」页创建班级', 'err');
        if (studentsOf(this.classId).length === 0) return toast('这个班还没有学生名单', 'err');
        const s = await api('POST', '/sessions', { classId: this.classId, subject: this.effectiveSubject, date: this.date });
        await refresh();
        toast('场次已创建，可以把手机拿过来了', 'ok');
        this.openQr(s.id);
        this.$router.push(`/live/${s.id}`);
      },
      async openQr(sid) {
        this.showQrFor = sid;
        const info = state.serverInfo;
        if (!info || !info.ips.length || !info.httpsPort) {
          this.qrDataUrl = '';
          this.scanUrl = '';
          toast('未获取到本机局域网地址，请确认电脑与手机在同一 WiFi', 'err');
          return;
        }
        this.scanUrl = `https://${info.ips[0]}:${info.httpsPort}/#/scan?sid=${sid}`;
        this.qrDataUrl = this.makeQr(this.scanUrl);
      },
      makeQr(text) {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const n = qr.getModuleCount();
        const scale = 6, quiet = 4;
        const size = (n + quiet * 2) * scale;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000';
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
          }
        }
        return canvas.toDataURL('image/png');
      },
    },
    template: `
    <div class="page">
      <div class="card">
        <h2>开一场收作业 <span class="sub">电脑保持这页不关，大屏实时更新</span></h2>
        <div class="row" style="margin-bottom:12px">
          <select v-model.number="classId" style="min-width:150px">
            <option v-for="c in state.classes" :key="c.id" :value="c.id">{{ c.name }}（{{ studentsOf(c.id).length }}人）</option>
          </select>
          <select v-model="date" style="width:150px">
            <option :value="date">{{ date }}</option>
          </select>
        </div>
        <div class="chips" style="margin-bottom:12px">
          <span v-for="s in subjects" :key="s" class="chip" :class="{on: subject===s && !subjectCustom}" @click="subject=s; subjectCustom=''">{{ s }}</span>
          <input v-model="subjectCustom" :placeholder="subject + ' / 自定义科目'" style="width:170px">
        </div>
        <button class="btn primary big" @click="createSession">✋ 开始收作业</button>
      </div>

      <div class="card" v-if="openSessions.length">
        <h2>收集中 <span class="sub">扫完点「截止」，之后的扫码自动记为补交</span></h2>
        <table class="list">
          <thead><tr><th>班级</th><th>科目</th><th>日期</th><th>进度</th><th style="min-width:280px"></th></tr></thead>
          <tbody>
            <tr v-for="s in openSessions" :key="s.id">
              <td>{{ (classById(s.classId)||{}).name }}</td>
              <td><b>{{ s.subject }}</b></td>
              <td>{{ s.date }}</td>
              <td><span class="tag green">{{ s.submitted + s.late }}/{{ studentsOf(s.classId).length }}</span></td>
              <td>
                <div class="row">
                  <button class="btn sm primary" @click="openQr(s.id)">📱 手机扫码</button>
                  <router-link class="btn sm" :to="'/live/'+s.id">🖥 看板</router-link>
                  <router-link class="btn sm" :to="'/grade/'+s.id">✏️ 批改</router-link>
                  <button class="btn sm" @click="api('POST','/sessions/'+s.id+'/closed',{closed:true}).then(refresh)">截止</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card" v-if="recentClosed.length">
        <h2>已截止 <span class="sub">更多在「历史」页</span></h2>
        <table class="list">
          <tbody>
            <tr v-for="s in recentClosed" :key="s.id">
              <td>{{ (classById(s.classId)||{}).name }} <b>{{ s.subject }}</b> {{ s.date }}</td>
              <td><span class="tag">{{ s.submitted + s.late }}/{{ studentsOf(s.classId).length }}</span></td>
              <td>
                <div class="row">
                  <router-link class="btn sm" :to="'/grade/'+s.id">批改</router-link>
                  <button class="btn sm" @click="api('POST','/sessions/'+s.id+'/closed',{closed:false}).then(refresh)">重新打开</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 手机扫码入口弹层 -->
      <div v-if="showQrFor" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px" @click.self="showQrFor=null">
        <div class="card" style="max-width:420px;width:100%;text-align:center">
          <h2 style="justify-content:center">📱 用手机扫这个码</h2>
          <div class="qr-white"><img v-if="qrDataUrl" :src="qrDataUrl" style="width:240px;height:240px"></div>
          <p class="hint" style="margin-top:12px;text-align:left">
            1. 手机与电脑连<b>同一个 WiFi</b><br>
            2. 手机相机扫码 → 首次打开提示「证书不受信任」：<br>
            &nbsp;&nbsp;&nbsp;iPhone：点「显示详细信息」→「访问此网站」<br>
            &nbsp;&nbsp;&nbsp;Android（Chrome）：点「高级」→「继续前往」<br>
            3. 允许使用摄像头 → 点「开始连续扫码」
          </p>
          <p class="hint" style="margin-top:8px;word-break:break-all">{{ scanUrl }}</p>
          <button class="btn" style="margin-top:10px" @click="showQrFor=null">关闭</button>
        </div>
      </div>
    </div>`,
    setup() { return { state, api, refresh }; },
  });
})();
