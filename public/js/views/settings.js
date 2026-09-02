// 设置：外观（主题/配色） + 班级名单 + 二维码 + 数据备份
(function () {
  'use strict';
  const { toast, registerView } = window.App;

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

  // ---- 设置壳：左侧分区导航 + 右侧子视图 ----
  registerView('settings-view', {
    data() {
      const reg = window.App.registry;
      return {
        sections: [
          { key: 'appearance', name: '外观',     icon: 'palette' },
          { key: 'roster',     name: '班级名单', icon: 'users' },
          { key: 'qr',         name: '二维码',   icon: 'qr' },
          { key: 'data',       name: '数据备份', icon: 'database' },
        ],
        // 子视图组件对象：data() 里随 settings-view 实例一起返回，
        // 模板用 <component :is="..."> 动态渲染
        subComponents: {
          appearance: reg['settings-appearance-view'],
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
