// 手机/平板连续扫码页：镜头常开，画面里出现过的码立即登记
(function () {
  'use strict';
  const { api, toast, fmtTime, registerView } = window.App;
  const { state, refresh, onSessionEvent, studentsOf, classById } = window.Store;

  registerView('scan-view', {
    data() {
      return {
        session: null,       // 场次详情（含 students）
        phase: 'loading',    // loading | pick | ready | running | error
        errorMsg: '',
        showRemain: false,
        armMarkId: null,     // 手动登记的就地二次确认（记录待确认的学生 id）
        msgs: [],            // 最近识别提示 [{key, cls, name, text}]
        flashColor: '',
        flashKey: 0,
        engine: null,
        seen: new Set(),     // 已成功登记/确认过的码
        _queue: [],          // 待上报队列（串行）
        _pumping: false,     // 队列处理中
        _failedAt: new Map(),// 无效码冷却时间戳
        torchOn: false,
        camReady: false,     // 摄像头是否已成功打开
        camRes: '',          // 实际相机分辨率，如 1600x1200
        camWaitSec: 0,       // 相机启动已等待秒数
        widePreview: false,  // 广角预览（contain 显示完整帧，便于一次看全一排）
        canZoom: false,      // 镜头是否支持变焦
        zoomLabel: '',       // 当前变焦倍数显示
        resPoll: null,       // 分辨率轮询
        zxReady: false,      // ZXing-WASM 主引擎是否就绪
        debugShot: '',       // 抓帧诊断的定格画面
        debugInfo: null,     // 诊断结果
        demoTimer: null,
        offSession: null,
        torchCaps: false,    // 补光灯硬件能力（iPhone Safari 不支持，置灰避免死按钮）
        showA2hs: false,     // 「添加到主屏幕」引导（仅 iPhone 浏览器内显示）
        remainPoll: null,
      };
    },
    computed: {
      sid() { return Number(this.$route.query.sid); },
      engineLabel() {
        if (this.zxReady || window.ZXingReader) return 'ZXing-WASM 多码引擎';
        if ('BarcodeDetector' in window) return '浏览器原生检测（ZXing 加载中）';
        return 'jsQR（兜底）';
      },
      total() { return this.session ? this.session.students.length : 0; },
      submitted() { return this.session ? this.session.stats.submitted : 0; },
      lateCount() { return this.session ? this.session.stats.late : 0; },
      remain() {
        if (!this.session) return [];
        const done = new Set(Object.keys(this.session.submissions).map(Number));
        return this.session.students.map(s => ({ ...s, done: done.has(s.id) }));
      },
      remainCount() { return this.remain.filter(s => !s.done).length; },
    },
    async created() {
      this.showA2hs = /iP(hone|od)/.test(navigator.userAgent)
        && navigator.standalone !== true
        && !localStorage.getItem('hw.a2hs-dismissed');
      if (!this.sid) {
        this.phase = 'pick';
        return;
      }
      await this.loadSession();
    },
    mounted() {
      this.offSession = onSessionEvent(this.sid, () => this.loadSession(true));
      // WS 断连时（iPhone 对自签证书的 wss 常被拒）降级为 5 秒轮询，未交名单不至于失联
      this.remainPoll = setInterval(() => {
        if (this.sid && this.phase !== 'pick' && !state.wsOpen) this.loadSession(true);
      }, 5000);
      window.addEventListener('beforeunload', this.cleanup);
      // ZXing WASM 异步加载，就绪后刷新引擎标签（window 属性不是响应式的）
      this.zxPoll = setInterval(() => {
        if (window.ZXingReader) { this.zxReady = true; clearInterval(this.zxPoll); }
      }, 400);
    },
    beforeUnmount() {
      this.cleanup();
      if (this.offSession) this.offSession();
      clearInterval(this.zxPoll);
      clearInterval(this.remainPoll);
      window.removeEventListener('beforeunload', this.cleanup);
    },
    unmounted() {
      clearInterval(this.resPoll);
    },
    methods: {
      // 轮询实际分辨率（流协商后可能延迟出帧）
      watchResolution() {
        clearInterval(this.resPoll);
        this.resPoll = setInterval(() => {
          const v = this.$refs.video;
          if (v && v.videoWidth) {
            this.camRes = `${v.videoWidth}×${v.videoHeight}`;
            clearInterval(this.resPoll);
          }
        }, 500);
      },
      lowRes() {
        if (!this.camRes) return false;
        const w = parseInt(this.camRes, 10);
        return w > 0 && w < 1000;
      },
      cleanup() {
        clearInterval(this.resPoll);
        clearInterval(this.camWaitTimer);
        if (this.engine) { this.engine.stop(); this.engine = null; }
        clearInterval(this.demoTimer);
      },
      async loadSession(silent) {
        try {
          this.session = await api('GET', `/sessions/${this.sid}`);
          if (this.phase !== 'running') this.phase = 'ready';
        } catch (e) {
          this.phase = 'error';
          this.errorMsg = e.message;
        }
      },
      async startScan() {
        ScanAudio.warmup();
        // 先切到扫码界面让 <video> 渲染出来，再启动摄像头（否则 video 元素还不存在）
        this.phase = 'running';
        this.camReady = false;
        await this.$nextTick();
        const video = this.$refs.video;
        if (!video) { this.failStart('页面未就绪，请点重试'); return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          this.failStart('这个浏览器不支持网页调用摄像头，建议用手机默认浏览器或 Chrome/Safari 打开。');
          return;
        }
        this.engine = new ScanEngine(video, {
          onCodes: codes => this.onCodes(codes),
          getExpect: () => this.remainCount,
        });
        this.camWaitStart = Date.now();
        this.camWaitTimer = setInterval(() => {
          this.camWaitSec = Math.round((Date.now() - this.camWaitStart) / 1000);
        }, 500);
        try {
          await this.engine.start();
          this.camReady = true;
          this.canZoom = !!this.engine.zoomCaps;
          this.torchCaps = this.engine.hasTorch();
          clearInterval(this.camWaitTimer);
          this.watchResolution();
        } catch (e) {
          this.cleanup();
          this.engine = null;
          this.phase = 'error';
          this.errorMsg = this.cameraHint(e);
        }
      },
      failStart(msg) {
        this.cleanup();
        this.engine = null;
        this.phase = 'error';
        this.errorMsg = msg;
      },
      cameraHint(e) {
        if (location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
          return '当前是 HTTP 页面，浏览器不允许调用摄像头。请回到电脑端扫二维码，用 HTTPS 地址打开。';
        }
        if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
          return '摄像头权限被拒绝。请在浏览器地址栏的网站设置里允许使用摄像头，然后刷新重试。';
        }
        if (e && e.name === 'NotFoundError') return '没有找到可用的摄像头。';
        return '无法打开摄像头：' + (e && e.message ? e.message : '未知错误');
      },
      async onCodes(codes) {
        if (!codes.length || !this.session) return;
        const overlay = this.$refs.overlay;
        if (overlay) this.drawOverlay(codes);
        // 入队串行上报：关键修复——此前「标记已处理」发生在上报之前，
        // 多码同帧时后上报的码会被并发锁静默丢弃（且永不重试）
        for (const c of codes) {
          if (this.seen.has(c.data)) continue;
          const last = this._failedAt.get(c.data);
          if (last && Date.now() - last < 3000) continue; // 无效码 3 秒冷却，避免刷接口
          this._queue.push(c);
        }
        this.pump();
      },
      pump() {
        if (this._pumping) return;
        this._pumping = true;
        (async () => {
          while (this._queue.length) {
            const c = this._queue.shift();
            if (this.seen.has(c.data)) continue;
            await this.report(c);
          }
          this._pumping = false;
        })();
      },
      async report(code) {
        try {
          const r = await api('POST', `/sessions/${this.sid}/scan`, { code: code.data });
          if (r.ok && !r.duplicate) {
            this.seen.add(code.data);           // 成功才标记已处理
            // 本地立即记账，不依赖 WS 回声（手机端 wss 自签证书可能被拒，WS 断了演示模式/未交名单也能推进）
            if (this.session && this.session.submissions) {
              this.session.submissions[r.student.id] = { order: r.order, time: r.time, status: r.status, grade: null };
              this.session.stats = r.stats;
            }
            ScanAudio.ok();
            if (navigator.vibrate) navigator.vibrate(60);
            this.flash('#22c55e');
            this.pushMsg('ok', r.student.name, code.manual
              ? '已手动登记'
              : r.note === 'stale_code'
                ? `已登记（第${r.order}本·码与名单不符，已按姓名匹配）`
                : `已登记 · 第 ${r.order} 本${r.status === 'late' ? ' · 补交' : ''}`);
          } else if (r.ok && r.duplicate) {
            this.seen.add(code.data);
            if (!code.manual) {
              ScanAudio.dup();
              this.flash('rgba(148,163,184,.5)');
              this.pushMsg('dup', r.student.name, r.status === 'late' ? '已登记过（补交）' : '已登记过，跳过');
            }
          } else {
            ScanAudio.bad();
            this.flash('rgba(239,68,68,.6)');
            this.pushMsg('bad', '无效码', r.message || '不是本班学生码');
            this._failedAt.set(code.data, Date.now());
          }
        } catch (e) {
          toast(e.message, 'err');
          this._failedAt.set(code.data, Date.now());
        }
      },
      pushMsg(cls, who, text) {
        this._msgSeq = (this._msgSeq || 0) + 1;
        this.msgs.unshift({ key: this._msgSeq, cls, who, text });
        if (this.msgs.length > 3) this.msgs.pop();
      },
      flash(color) {
        this.flashColor = color;
        this.flashKey++;
        requestAnimationFrame(() => {
          const el = this.$refs.flash;
          if (!el) return;
          el.classList.remove('go');
          void el.offsetWidth;
          el.classList.add('go');
        });
      },
      drawOverlay(codes) {
        const canvas = this.$refs.overlay;
        const video = this.$refs.video;
        if (!canvas || !video) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        // 按当前预览模式（cover 裁边 / contain 完整）映射视频相对坐标
        const vw = video.videoWidth, vh = video.videoHeight;
        const scale = this.widePreview ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
        const dx = (w - vw * scale) / 2, dy = (h - vh * scale) / 2;
        for (const c of codes) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = this.seen.has(c.data) ? 'rgba(148,163,184,.6)' : 'rgba(74,222,128,.9)';
          ctx.beginPath();
          c.rel.forEach((p, i) => {
            const x = dx + p.x * vw * scale, y = dy + p.y * vh * scale;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.stroke();
        }
      },
      async toggleTorch() {
        const on = await this.engine.toggleTorch();
        this.torchOn = !!on;
        if (on === false && this.torchOn) this.torchOn = false;
      },
      dismissA2hs() {
        this.showA2hs = false;
        localStorage.setItem('hw.a2hs-dismissed', '1');
      },
      async switchCam() {
        try { await this.engine.switchCamera(); } catch (e) { toast('切换摄像头失败', 'err'); }
      },
      // 抓帧诊断：定格当前帧，分遍识别并展示每遍结果（截图可发给开发者分析）
      async captureDebug() {
        const video = this.$refs.video;
        if (!video || !video.videoWidth) return toast('摄像头未就绪', 'err');
        this.engine && this.engine.pause();
        const c = document.createElement('canvas');
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(video, 0, 0);
        this.debugShot = c.toDataURL('image/jpeg', 0.85);

        const frame = ctx.getImageData(0, 0, c.width, c.height);
        const passes = [];
        const t0 = performance.now();
        if (window.ZXingReader) {
          const run = async (opts, label) => {
            const t = performance.now();
            const r = await window.ZXingReader.readBarcodes({ data: frame.data, width: c.width, height: c.height }, opts);
            passes.push({ label, n: r.length, ms: Math.round(performance.now() - t), texts: r.map(x => x.text) });
          };
          await run({ maxNumberOfSymbols: 30 }, '① ZXing 常规');
          await run({ maxNumberOfSymbols: 30, tryDenoise: true, binarizer: 'GlobalHistogram' }, '② ZXing 去噪+直方图');
          await run({ maxNumberOfSymbols: 30, tryDenoise: true }, '③ ZXing 去噪');
        }
        {
          const t = performance.now();
          const f2 = ctx.getImageData(0, 0, c.width, c.height);
          const found = window.QRHunt.findMulti(f2, { maxCodes: 30, expect: 99, maxMs: 1500, shift: 1 });
          passes.push({ label: '④ jsQR 滑窗', n: found.length, ms: Math.round(performance.now() - t), texts: found.map(f => f.data) });
        }
        const uniq = new Set(passes.flatMap(p => p.texts));
        const cls = classById(this.session.classId);
        const payloadOf = s => (cls ? window.QrPdf.payload(cls, s) : `|${s.stuNo}|${s.name}`);
        const missing = this.remain
          .filter(s => !s.done && !uniq.has(payloadOf(s)))
          .map(s => s.name);
        this.debugInfo = {
          res: `${c.width}×${c.height}`,
          passes,
          total: uniq.size,
          expect: this.remainCount,
          missing,
          ms: Math.round(performance.now() - t0),
        };
      },
      closeDebug() {
        this.debugShot = '';
        this.debugInfo = null;
        this.engine && this.engine.resume();
      },
      async zoomBy(delta) {
        if (!this.engine || !this.engine.zoomCaps) return;
        const ok = await this.engine.setZoom(this.engine.zoom + delta);
        if (ok) this.zoomLabel = this.engine.zoom.toFixed(1) + '×';
      },
      // 手动兜底：个别码反复扫不进时，点未交名单里的名字直接登记
      // 就地二次确认（Tauri 壳不支持 confirm()）：第一次点进入待确认态，3 秒后自动复位
      async manualMark(s) {
        if (s.done) return;
        if (this.armMarkId !== s.id) {
          this.armMarkId = s.id;
          this.pushMsg('dup', s.name, '再点一次确认登记（请确认本子确实在）');
          setTimeout(() => { if (this.armMarkId === s.id) this.armMarkId = null; }, 3000);
          return;
        }
        this.armMarkId = null;
        const cls = classById(this.session.classId);
        await this.report({ data: window.QrPdf.payload(cls, s), manual: true });
      },
      // 演示模式：无需贴纸和摄像头，模拟扫完全班（用于体验/测试整个流程）
      startDemo() {
        ScanAudio.warmup();
        this.phase = 'running';
        clearInterval(this.demoTimer);
        this.demoTimer = setInterval(async () => {
          const next = this.remain.find(s => !s.done);
          if (!next || this.phase !== 'running') { clearInterval(this.demoTimer); return; }
          const cls = classById(this.session.classId);
          await this.report({ data: window.QrPdf.payload(cls, next) });
        }, 900);
      },
    },
    template: `
    <div class="scan-page">
      <div class="a2hs-bar" v-if="showA2hs">
        <span>📱 建议：Safari「分享 → 添加到主屏幕」，之后从主屏图标打开——无地址栏、摄像头更稳定</span>
        <button class="btn sm" @click="dismissA2hs">知道了</button>
      </div>
      <!-- 选择场次 -->
      <div class="scan-start" v-if="phase==='pick'">
        <h1>选择要收作业的场次</h1>
        <p class="hint" style="margin-bottom:16px">请在电脑端「工作台」先开一场收作业，然后用电脑上显示的二维码打开本页。</p>
        <div v-for="s in state.sessions.slice().reverse().slice(0,8)" :key="s.id" style="margin-bottom:8px">
          <button class="btn big" style="width:100%" @click="$router.replace({query:{sid:s.id}}); $router.go(0)">
            {{ (classById(s.classId)||{}).name }} · {{ s.title || s.subject }} · {{ s.date }}
          </button>
        </div>
        <div class="empty" v-if="!state.sessions.length">还没有场次，去电脑端创建一个吧</div>
      </div>

      <!-- 启动/错误 -->
      <div class="scan-start" v-else-if="phase==='ready' || phase==='error'">
        <template v-if="session">
          <div style="font-size:40px">📚</div>
          <h1>{{ session.className }} · {{ session.subject }}<template v-if="session.title"> ·「{{ session.title }}」</template></h1>
          <p class="hint">{{ session.date }} · 全班 {{ total }} 人 · 已交 {{ submitted }} 人<span v-if="lateCount"> · 补交 {{ lateCount }}</span></p>
          <p class="hint" style="margin:10px 0 4px;text-align:left">
            1️⃣ 全班作业本<b style="color:#fff">码朝上摊开</b><br>
            2️⃣ 点下方按钮，<b style="color:#fff">镜头从左往右扫过去</b><br>
            3️⃣ 哪本入镜哪本就登记，「叮」一声变绿即成功，重复入镜不会重复登记
          </p>
          <button class="btn primary big" style="width:100%;margin-top:14px" @click="startScan">▶ 开始连续扫码</button>
          <p class="hint" style="margin-top:10px">识别引擎：{{ engineLabel }}</p>
          <button class="btn big" style="width:100%;margin-top:6px;background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.25)" @click="startDemo">🎬 演示模式（模拟扫码）</button>
        </template>
        <template v-if="phase==='error'">
          <div style="font-size:40px">📵</div>
          <h1>无法开始</h1>
          <p class="hint" style="text-align:left">{{ errorMsg }}</p>
          <button class="btn big" style="width:100%;margin-top:14px" @click="$router.go(0)">重试</button>
        </template>
      </div>

      <!-- 扫码中 -->
      <template v-else-if="phase==='running'">
        <div class="scan-video-wrap">
          <video ref="video" autoplay muted playsinline :style="{objectFit: widePreview ? 'contain' : 'cover'}"></video>
          <canvas ref="overlay" class="overlay"></canvas>
          <div v-if="!camReady" style="position:absolute;inset:0;z-index:3;background:#0b0f0d;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 24px">
            <div>
              <p style="color:#94a3b8">正在打开摄像头…{{ camWaitSec ? camWaitSec + ' 秒' : '' }}<br>如弹出权限询问，请点「允许」</p>
              <p v-if="camWaitSec >= 8" style="color:#fbbf24;font-size:13px;margin-top:10px">
                等待偏长。建议：<br>1. 完全关闭本页再重新打开（释放相机占用）<br>2. 关掉其他正在用相机的应用<br>3. 或重启手机浏览器后重试
              </p>
            </div>
          </div>
          <div ref="flash" class="scan-flash" :style="{background: flashColor}"></div>

          <div class="scan-top">
            <button class="ctrl-btn" style="width:36px;height:36px;font-size:15px" @click="cleanup(); phase='ready'">✕</button>
            <div class="title">
              {{ session.className }} · {{ session.subject }}
              <div style="font-size:11px;font-weight:400;opacity:.85">
                {{ camRes || '相机启动中…' }}<span v-if="lowRes()" style="color:#fbbf24"> · 分辨率偏低，请靠近逐本扫</span>
              </div>
            </div>
            <div class="count"><b>{{ submitted }}</b> / {{ total }}</div>
          </div>

          <div class="scan-bottom">
            <div class="scan-msgs">
              <div class="scan-msg" :class="m.cls" v-for="m in msgs" :key="m.key">
                <span class="who">{{ m.who }}</span><span>{{ m.text }}</span>
              </div>
            </div>
            <div class="remain-toggle" @click="showRemain = !showRemain">
              {{ showRemain ? '▾' : '▸' }} 未交 {{ remainCount }} 人<span v-if="lateCount" style="color:#fbbf24"> · 补交 {{ lateCount }} 人</span>
              <span style="color:#64748b">（点名字可手动登记）</span>
            </div>
            <div class="remain-list" v-if="showRemain">
              <span class="rname" :class="{done: s.done}" v-for="s in remain" :key="s.id" @click="manualMark(s)">{{ s.name }}</span>
            </div>
            <div class="ctrl-btns">
              <template v-if="canZoom">
                <button class="ctrl-btn" style="width:40px;font-size:12px" @click="zoomBy(-0.5)" title="缩小">🔍－</button>
                <button class="ctrl-btn" style="width:40px;font-size:12px" @click="zoomBy(0.5)" title="放大（对顽固码放大后停 1 秒）">{{ zoomLabel || '🔍＋' }}</button>
              </template>
              <button class="ctrl-btn" :class="{on: torchOn}" :disabled="!torchCaps" @click="toggleTorch" :title="torchCaps ? '补光灯' : '此设备不支持网页补光灯（iPhone 请用室内灯光）'">🔦</button>
              <button class="ctrl-btn" @click="switchCam" title="切换摄像头">🔄</button>
              <button class="ctrl-btn" :class="{on: widePreview}" @click="widePreview = !widePreview" title="广角预览：显示完整画面，方便一次扫一排">🖥</button>
              <button class="ctrl-btn" @click="captureDebug" title="抓帧诊断：定格并分析当前画面">🐞</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 抓帧诊断 -->
      <div v-if="debugShot" style="position:fixed;inset:0;background:#0b0f0d;z-index:300;display:flex;flex-direction:column;overflow:auto">
        <div style="padding:calc(env(safe-area-inset-top,0px) + 10px) 14px 6px;display:flex;align-items:center;gap:10px">
          <b style="font-size:15px">🐞 抓帧诊断</b>
          <span class="hint" style="color:#94a3b8;font-size:12px">{{ debugInfo.res }} · 共 {{ debugInfo.total }}/{{ debugInfo.expect }} · 全流程 {{ debugInfo.ms }}ms</span>
          <span style="flex:1"></span>
          <button class="ctrl-btn" style="width:34px;height:34px;font-size:14px" @click="closeDebug">✕</button>
        </div>
        <img :src="debugShot" style="width:100%;object-fit:contain;max-height:46vh;background:#000">
        <div style="padding:10px 14px 20px">
          <div v-for="p in debugInfo.passes" :key="p.label" style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;color:#e2e8f0;border-bottom:1px solid rgba(255,255,255,.08)">
            <span style="flex:1">{{ p.label }}</span>
            <b :style="{color: p.n >= debugInfo.expect ? '#4ade80' : (p.n > 0 ? '#fbbf24' : '#f87171')}">{{ p.n }} 个</b>
            <span style="color:#64748b;width:52px;text-align:right">{{ p.ms }}ms</span>
          </div>
          <div style="margin-top:10px;font-size:13px;color:#e2e8f0" v-if="debugInfo.missing.length">
            这一帧里没认出的：<b style="color:#f87171">{{ debugInfo.missing.join('、') }}</b>
          </div>
          <div style="margin-top:6px;font-size:13px;color:#4ade80" v-else>这一帧全部认出 ✓（说明实时预览帧模糊/漏掉，停住镜头即可）</div>
          <p class="hint" style="color:#94a3b8;margin-top:10px;font-size:12px">
            请把本页<b style="color:#fff">截图</b>发给开发者：上面是摄像头看到的真实画面，各遍数字能定位问题环节。
          </p>
        </div>
      </div>

      <div class="scan-start" v-else-if="phase==='loading'">
        <p class="hint">加载中…</p>
      </div>
    </div>`,
    setup() { return { state, classById }; },
  });
})();
