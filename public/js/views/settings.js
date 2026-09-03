// 设置：外观（主题/配色） + 班级名单 + 二维码 + 数据备份
(function () {
  'use strict';
  const { api, toast, registerView } = window.App;

  const STORAGE_KEY = 'hw.appearance';
  // 数据区也持久化当前活动 section，避免刷新跳回第一个
  const SECTION_KEY = 'hw.settings.section';

  // 主题/配色定义的唯一来源在 index.html 的 window.HW_APPEARANCE
  const A = window.HW_APPEARANCE || {
    defaultTheme: 'handdrawn', defaultPalette: 'orange',
    themes: ['handdrawn', 'warm', 'glass'],
    palettes: [{ key: 'orange', hex: '#f97316', rgb: '249,115,22' }],
  };

  const THEME_META = {
    handdrawn: { name: '手绘漫画', desc: '奶油纸+贴纸阴影，霞鹜文楷字体，亲和可爱' },
    warm:      { name: '暖橙编辑风', desc: '陶土橙+衬线标题，安静克制，像工具书' },
    glass:     { name: 'iOS 毛玻璃', desc: '彩色光斑+磨砂卡片+玻璃分段控件，现代轻盈' },
  };
  const PALETTE_NAMES = { orange: '暖橙', grass: '草原绿', sky: '晴空蓝', berry: '莓红', grape: '葡萄紫' };

  const THEMES = A.themes.map(key => ({ key, ...THEME_META[key] }));
  const PALETTES = A.palettes.map(p => ({ ...p, name: PALETTE_NAMES[p.key] || p.key }));

  function readAppearance() {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        theme: THEMES.some(t => t.key === v.theme) ? v.theme : A.defaultTheme,
        palette: PALETTES.some(p => p.key === v.palette) ? v.palette : A.defaultPalette,
      };
    } catch { return { theme: A.defaultTheme, palette: A.defaultPalette }; }
  }

  function applyAppearance(theme, palette) {
    const html = document.documentElement;
    html.setAttribute('data-theme', theme);
    html.setAttribute('data-palette', palette);
    // 同步浏览器地址栏颜色与 favicon（手机 PWA / 标签页体验）
    const pal = PALETTES.find(p => p.key === palette) || PALETTES[0];
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', 'rgb(' + pal.rgb + ')');
    const icon = document.querySelector('link[rel="icon"]');
    if (icon) icon.href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='" + encodeURIComponent(pal.hex) + "'/%3E%3Cpath d='M28 52l14 14 30-32' stroke='%23fff' stroke-width='10' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
  }

  function persistAppearance(theme, palette) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, palette }));
  }

  // ---- 外观子视图 ----
  registerView('settings-appearance-view', {
    data() {
      const a = readAppearance();
      return { ...a, themes: THEMES, palettes: PALETTES };
    },
    methods: {
      pickTheme(t) {
        this.theme = t;
        applyAppearance(this.theme, this.palette);
        persistAppearance(this.theme, this.palette);
      },
      pickPalette(p) {
        this.palette = p;
        applyAppearance(this.theme, this.palette);
        persistAppearance(this.theme, this.palette);
      },
    },
    template: `
    <div>
      <div class="card">
        <h2>主题风格</h2>
        <div class="theme-grid">
          <div v-for="t in themes" :key="t.key" class="theme-card" :class="{on: theme===t.key}" @click="pickTheme(t.key)">
            <div class="name">{{ t.name }}</div>
            <div class="desc">{{ t.desc }}</div>
            <div class="preview">
              <div class="pill"></div>
              <div class="square"></div>
              <div class="square green"></div>
              <div class="square warn"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>配色</h2>
        <p class="hint" style="margin-bottom:14px">配色与主题独立：任意主题下都能换一套主色。圆点的勾号表示当前已选。</p>
        <div class="palette-grid">
          <div v-for="p in palettes" :key="p.key" class="palette-dot" :class="{on: palette===p.key}"
               :style="{background:'rgb('+p.rgb+')'}" :title="p.name" @click="pickPalette(p.key)"></div>
        </div>
      </div>
    </div>`,
  });

  // ---- 批改等级子视图 ----
  const DEFAULT_GRADES = ['A+', 'A', 'A-', '不合格'];
  const { state } = window.Store;
  registerView('settings-grades-view', {
    data() { return { list: [], serverList: [], armRemoveId: null, DEFAULT_GRADES }; },
    created() { this.reload(); },
    watch: {
      // 其他设备/页面改了等级表时同步进来；自己正在编辑还没保存时不打扰；
      // 内容相同时不重建数组，避免无意义的行重渲染打断正在点击/输入的操作
      'state.settings': {
        handler() {
          if (JSON.stringify(this.list) !== JSON.stringify(this.serverList)) return;
          const fresh = (state.settings || {}).grades || [];
          if (JSON.stringify(fresh) !== JSON.stringify(this.list)) {
            this.list = fresh.slice();
            this.serverList = fresh.slice();
          }
        },
      },
    },
    methods: {
      reload() {
        this.list = ((state.settings || {}).grades || []).slice();
        this.serverList = this.list.slice();
      },
      // 预览 chip 按「行号」取色：展示的就是保存后会生效的样子
      chipCls(i) { return String(this.list[i] ?? '').trim() ? 'gp' + (i + 1) : ''; },
      async save() {
        const list = this.list.map(g => String(g ?? '').trim());
        if (list.some(g => !g)) { toast('等级名称不能为空', 'err'); this.list = this.serverList.slice(); return; }
        const dup = list.find((g, i) => list.indexOf(g) !== i);
        if (dup) { toast(`等级「${dup}」重复了`, 'err'); this.list = this.serverList.slice(); return; }
        try {
          const r = await api('PUT', '/settings/grades', { grades: list });
          // list 一并镜像服务器响应：保存期间发生的其他写入，以后落地的一方为准
          this.serverList = r.grades.slice();
          this.list = r.grades.slice();
          toast('等级已保存', 'ok');
        } catch (e) {
          toast(e.message, 'err');
          this.list = this.serverList.slice();
        }
      },
      add() {
        if (this.list.length >= 9) return toast('最多 9 个等级（键盘 1~9 快捷批改）', 'err');
        // 占位名避开已有名称，防止连点添加触发去重报错
        let name = '新等级';
        for (let n = 2; this.list.includes(name); n++) name = '新等级' + n;
        this.list.push(name);
        this.save();
      },
      remove(i) {
        if (this.list.length <= 1) return toast('至少保留一个等级', 'err');
        // 就地二次确认（与删除场次同款）：第一次点进入待确认态，3 秒后自动复位
        if (this.armRemoveId !== i) {
          this.armRemoveId = i;
          toast('再点一次「删除」确认，3 秒内有效', '', 2800);
          setTimeout(() => { if (this.armRemoveId === i) this.armRemoveId = null; }, 3000);
          return;
        }
        this.armRemoveId = null;
        this.list.splice(i, 1);
        this.save();
      },
      move(i, d) {
        const j = i + d;
        if (j < 0 || j >= this.list.length) return;
        [this.list[i], this.list[j]] = [this.list[j], this.list[i]];
        this.save();
      },
      restoreDefault() {
        this.list = DEFAULT_GRADES.slice();
        this.save();
      },
    },
    template: `
    <div>
      <div class="card">
        <h2>批改等级</h2>
        <p class="hint" style="margin-bottom:14px">批改用的等级表，按老师自己的习惯来（几个都行，最多 9 个）。<br>
        顺序即批改页键盘 <span class="kbd">1</span>~<span class="kbd">9</span> 快捷键与配色：靠前偏绿、靠后偏红。<br>
        改等级表<b>不影响已保存的旧记录的文字</b>——已打过的等级原样保留；颜色按当前表的位置取，重排或删除后旧记录的颜色会跟着变/变灰。</p>
        <div class="grade-row" v-for="(g, i) in list" :key="i">
          <span class="idx">{{ i + 1 }}</span>
          <input v-model="list[i]" maxlength="12" style="width:180px" @change="save">
          <span class="grade-chip" :class="chipCls(i)" v-if="String(list[i] || '').trim()">{{ String(list[i]).trim() }}</span>
          <div class="spacer"></div>
          <button class="btn sm" :disabled="i === 0" @click="move(i, -1)" title="上移">↑</button>
          <button class="btn sm" :disabled="i === list.length - 1" @click="move(i, 1)" title="下移">↓</button>
          <button class="btn sm danger" :class="{armed: armRemoveId === i}" :disabled="list.length <= 1" @click="remove(i)">{{ armRemoveId === i ? '确认删除' : '删除' }}</button>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn" @click="add">添加等级</button>
          <button class="btn" @click="restoreDefault">恢复默认（{{ DEFAULT_GRADES.join(' / ') }}）</button>
        </div>
        <p class="hint" style="margin-top:12px">保存后立即生效：批改页的按钮、快捷键和看板颜色同步更新，其他开着的页面也会实时收到。</p>
      </div>
    </div>`,
    setup() { return { state }; },
  });

  // ---- 设置壳：左侧分区导航 + 右侧子视图 ----
  registerView('settings-view', {
    data() {
      const reg = window.App.registry;
      return {
        sections: [
          { key: 'appearance', name: '外观',     icon: 'palette' },
          { key: 'grades',     name: '批改等级', icon: 'award' },
          { key: 'roster',     name: '班级名单', icon: 'users' },
          { key: 'qr',         name: '二维码',   icon: 'qr' },
          { key: 'data',       name: '数据备份', icon: 'database' },
        ],
        // 子视图组件对象：data() 里随 settings-view 实例一起返回，
        // 模板用 <component :is="..."> 动态渲染
        subComponents: {
          appearance: reg['settings-appearance-view'],
          grades:     reg['settings-grades-view'],
          roster:     reg['roster-view'],
          qr:         reg['qr-view'],
          data:       reg['data-view'],
        },
      };
    },
    computed: {
      section() {
        const s = (this.$route.params.section || 'appearance');
        return this.sections.some(x => x.key === s) ? s : 'appearance';
      },
    },
    watch: {
      section: { immediate: false, handler(v) {
        // 同步 URL，方便直接打开「设置-班级名单」
        const target = '/settings/' + v;
        if (this.$route.path !== target) this.$router.replace(target);
        localStorage.setItem(SECTION_KEY, v);
      } },
    },
    created() {
      // 第一次进入：从 localStorage 恢复上次所在分区
      const last = localStorage.getItem(SECTION_KEY);
      if (last && this.sections.some(x => x.key === last) && !this.$route.params.section) {
        this.$router.replace('/settings/' + last);
      }
    },
    methods: {
      icon(name) {
        const i = {
          palette: '<path d="M12 22a10 10 0 1 1 10-10c0 3-3 3-5 3h-2a2 2 0 0 0-1.6 3.2l-.4 1.2A2 2 0 0 1 11 21H8a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H3"/>',
          award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 12.9L17 22l-5-3-5 3 1.5-9.1"/>',
          users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
          qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM19 14h2v2h-2zM14 19h2v2h-2zM19 19h2v2h-2z"/>',
          database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/>',
        }[name] || '';
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + i + '</svg>';
      },
    },
    template: `
    <div class="page">
      <div class="settings-shell">
        <nav class="settings-side">
          <div v-for="s in sections" :key="s.key"
               class="settings-nav-item" :class="{on: section===s.key}"
               @click="$router.push('/settings/'+s.key)">
            <span class="ico" v-html="icon(s.icon)"></span>
            <span>{{ s.name }}</span>
          </div>
        </nav>
        <div class="settings-main">
          <component :is="subComponents[section]" :embedded="section!=='appearance' && section!=='data'" />
        </div>
      </div>
    </div>`,
  });

  // 注册 setter（供 app.js 启动时同步一次）
  window.Settings = { applyAppearance, readAppearance };
})();
