// 应用装配：路由 + 顶部导航
(function () {
  'use strict';
  const { Vue, VueRouter } = window;
  const { registry } = window.App;
  const Store = window.Store;

  const routes = [
    { path: '/', component: registry['home-view'] },
    { path: '/history', component: registry['history-view'] },
    { path: '/settings/:section(appearance|roster|qr|data)?', component: registry['settings-view'] },
    // 旧路由兼容：重定向到设置壳
    { path: '/roster', redirect: '/settings/roster' },
    { path: '/qr', redirect: '/settings/qr' },
    { path: '/live/:sid(\\d+)', component: registry['live-view'] },
    { path: '/grade/:sid(\\d+)', component: registry['grade-view'] },
    { path: '/scan', component: registry['scan-view'], meta: { bare: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ];

  const router = VueRouter.createRouter({
    history: VueRouter.createWebHashHistory(),
    routes,
  });

  const Root = {
    computed: {
      bare() { return this.$route.meta && this.$route.meta.bare; },
    },
    template: `
    <div>
      <nav class="topnav" v-if="!bare">
        <span class="brand">
          <svg viewBox="0 0 100 100"><rect width="100" height="100" rx="20"/><path d="M28 52l14 14 30-32" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>作业扫码登记</span>
        </span>
        <router-link to="/">工作台</router-link>
        <router-link to="/history">历史</router-link>
        <div class="spacer"></div>
        <router-link to="/settings/appearance" title="设置">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;vertical-align:-3px;margin-right:2px"><path d="M12 22a10 10 0 1 1 10-10c0 3-3 3-5 3h-2a2 2 0 0 0-1.6 3.2l-.4 1.2A2 2 0 0 1 11 21H8a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H3"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/></svg>
          设置
        </router-link>
      </nav>
      <router-view></router-view>
    </div>`,
  };

  const app = Vue.createApp(Root);
  app.use(router);
  app.mount('#app');

  // 启动时立刻应用上次保存的外观（无闪切换）
  const a = (window.Settings && window.Settings.readAppearance()) || { theme: 'handdrawn', palette: 'orange' };
  if (window.Settings) window.Settings.applyAppearance(a.theme, a.palette);
  Store.init();
})();
