// 全局状态：bootstrap 数据 + WebSocket 实时事件分发
(function () {
  'use strict';
  const { api } = window.App;
  const { Vue } = window;
  const reactive = Vue.reactive;

  const state = reactive({
    loaded: false,
    serverInfo: null,   // {ips, httpPort, httpsPort, app}
    classes: [],
    students: [],
    sessions: [],
    classId: null,      // 当前选中班级（响应式，名单/工作台/二维码页共用，localStorage 仅做持久化）
    wsOpen: false,      // WebSocket 连接状态（供视图决定是否降级轮询）
  });

  const sessionListeners = new Map(); // sid -> Set<fn>

  async function refresh() {
    const db = await api('GET', '/bootstrap');
    state.classes = db.classes;
    state.students = db.students;
    state.sessions = db.sessions;
    // 选中班级失效（被删/数据还原后 id 变化）时回退到第一个班
    if (!state.classes.some(c => c.id === state.classId)) {
      state.classId = (state.classes[0] && state.classes[0].id) || null;
      if (state.classId) localStorage.setItem('hw.class', String(state.classId));
    }
    state.loaded = true;
  }

  function setClass(id) {
    state.classId = id;
    if (id) localStorage.setItem('hw.class', String(id));
  }

  async function init() {
    state.classId = Number(localStorage.getItem('hw.class')) || null;
    try {
      state.serverInfo = await api('GET', '/server-info');
    } catch { /* 界面仍可用 */ }
    await refresh().catch(e => console.error('bootstrap 失败', e));

    connectWs();
  }

  let ws = null;
  let wsTimer = null;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch { retry(); return; }
    ws.onopen = () => { state.wsOpen = true; };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => { state.wsOpen = false; retry(); };
    ws.onerror = () => { state.wsOpen = false; ws.close(); };
  }

  function retry() {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connectWs, 2000);
  }

  function handle(msg) {
    // db_changed：除全局刷新外，还要通知所有持有本地场次状态的视图（大屏/批改/扫码页）
    if (msg.type === 'db_changed') {
      refresh();
      for (const set of sessionListeners.values()) for (const fn of set) fn(msg);
      return;
    }
    if (['classes_changed', 'students_changed', 'sessions_changed'].includes(msg.type)) {
      refresh();
      return;
    }
    if (msg.sid != null) {
      const set = sessionListeners.get(msg.sid);
      if (set) for (const fn of set) fn(msg);
    }
  }

  function onSessionEvent(sid, fn) {
    if (!sessionListeners.has(sid)) sessionListeners.set(sid, new Set());
    sessionListeners.get(sid).add(fn);
    return () => sessionListeners.get(sid)?.delete(fn);
  }

  // 班级学生
  function studentsOf(classId) {
    return state.students.filter(s => s.classId === classId).sort((a, b) => (a.stuNo > b.stuNo ? 1 : -1));
  }
  function classById(id) { return state.classes.find(c => c.id === id); }

  // 未交名单文案
  function absentText(sessionFull) {
    const t = sessionFull.title ? `「${sessionFull.title}」` : '';
    const absent = sessionFull.students.filter(s => !s.sub);
    if (!absent.length) return `【作业登记】${sessionFull.className} ${sessionFull.subject}${t} ${sessionFull.date}：全员交齐 🎉`;
    return `【作业未交名单】${sessionFull.className} ${sessionFull.subject}${t} ${sessionFull.date}：` +
      absent.map(s => s.name).join('、') + `（共${absent.length}人）`;
  }

  window.Store = { state, init, refresh, onSessionEvent, studentsOf, classById, absentText, connectWs, setClass };
})();
