// 应用装配：路由 + 顶部导航
(function () {
  'use strict';
  const { Vue, VueRouter } = window;
  const { registry } = window.App;
  const Store = window.Store;

  const routes = [
    { path: '/', component: registry['home-view'] },
    { path: '/roster', component: registry['roster-view'] },
    { path: '/qr', component: registry['qr-view'] },
    { path: '/history', component: registry['history-view'] },
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
          <svg viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#16a34a"/><path d="M28 52l14 14 30-32" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>作业扫码登记</span>
        </span>
        <router-link to="/">工作台</router-link>
        <router-link to="/roster">名单</router-link>
        <router-link to="/qr">二维码</router-link>
        <router-link to="/history">历史</router-link>
      </nav>
      <router-view></router-view>
    </div>`,
  };

  const app = Vue.createApp(Root);
  app.use(router);
  app.mount('#app');
  Store.init();
})();
