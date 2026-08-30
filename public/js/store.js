// 全局状态：bootstrap 数据 + WebSocket 实时事件分发
(function () {
  'use strict';
  const { api } = window.App;
  const { Vue } = window;
  const reactive = Vue.reactive;

  const state = reactive({
    loaded: false,
    serverInfo: null,   // {ips, httpPort, httpsPort}
    classes: [],
    students: [],
    sessions: [],
  });

  const sessionListeners = new Map(); // sid -> Set<fn>

  async function refresh() {
    const db = await api('GET', '/bootstrap');
    state.classes = db.classes;
    state.students = db.students;
    state.sessions = db.sessions;
    state.loaded = true;
  }

  async function init() {
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
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = retry;
    ws.onerror = () => ws.close();
  }

  function retry() {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connectWs, 2000);
  }

  function handle(msg) {
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
    const absent = sessionFull.students.filter(s => !s.sub);
    if (!absent.length) return `【作业登记】${sessionFull.className} ${sessionFull.subject} ${sessionFull.date}：全员交齐 🎉`;
    return `【作业未交名单】${sessionFull.className} ${sessionFull.subject} ${sessionFull.date}：` +
      absent.map(s => s.name).join('、') + `（共${absent.length}人）`;
  }

  window.Store = { state, init, refresh, onSessionEvent, studentsOf, classById, absentText, connectWs };
})();
