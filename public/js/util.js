// 通用工具：API 请求、Toast、时间格式化、组件注册表
(function () {
  'use strict';

  async function api(method, url, body) {
    const res = await fetch('/api' + url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 空响应 */ }
    if (!res.ok) {
      const msg = (data && data.message) || `请求失败 (${res.status})`;
      const err = new Error(msg);
      err.data = data;
      throw err;
    }
    return data;
  }

  const toastWrap = () => {
    let el = document.querySelector('.toast-wrap');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast-wrap';
      document.body.appendChild(el);
    }
    return el;
  };

  function toast(msg, type = '', ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    toastWrap().appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // 视图组件注册表：各 views/*.js 调用 registerView，app.js 统一装配路由
  const registry = {};
  function registerView(name, component) { registry[name] = component; }

  // 解析名单工作表：在前 10 行里找「姓名」表头；无表头时把第一列当姓名
  function parseRosterSheet(sheet) {
    const aoa = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!aoa.length) return [];
    let headerRow = -1, nameCol = -1, noCol = -1;
    for (let i = 0; i < Math.min(10, aoa.length); i++) {
      const row = aoa[i].map(c => String(c).trim());
      const ni = row.findIndex(c => c.includes('姓名'));
      if (ni >= 0) {
        headerRow = i; nameCol = ni;
        noCol = row.findIndex(c => c && c !== row[ni] && (c.includes('学号') || c.includes('编号') || c.includes('学籍号')));
        break;
      }
    }
    const out = [];
    if (headerRow >= 0) {
      for (let i = headerRow + 1; i < aoa.length; i++) {
        const name = String(aoa[i][nameCol] ?? '').trim().replace(/\s+/g, '');
        if (!name) continue;
        out.push({ name, stuNo: noCol >= 0 ? String(aoa[i][noCol] ?? '').trim() : '' });
      }
    } else {
      for (const row of aoa) {
        const name = String(row[0] ?? '').trim().replace(/\s+/g, '');
        if (!name || name.includes('姓名')) continue;
        out.push({ name, stuNo: String(row[1] ?? '').trim() });
      }
    }
    return out;
  }

  window.App = { api, toast, fmtTime, download, registerView, registry, parseRosterSheet };
})();
