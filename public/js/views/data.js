// 数据备份页：导出 / 导入备份（从 roster.js 拆出，便于放进设置）
(function () {
  'use strict';
  const { api, toast, registerView, download } = window.App;
  const { state } = window.Store;

  registerView('data-view', {
    data() { return { restorePreview: null, busy: false }; },
    methods: {
      async exportData() {
        this.busy = true;
        try {
          const res = await fetch('/api/export');
          if (!res.ok) throw new Error(`请求失败 (${res.status})`);
          const data = await res.json();
          const savedCopy = res.headers.get('X-Backup-Saved') === '1';
          const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
          const d = new Date();
          const p = n => String(n).padStart(2, '0');
          const fname = `作业扫码备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
          const inApp = state.serverInfo && state.serverInfo.app;
          if (inApp) {
            toast(savedCopy
              ? '备份已保存到数据文件夹的 backups/（菜单「打开数据文件夹」可查看）'
              : '备份已生成，但写入数据文件夹失败，请检查磁盘', savedCopy ? 'ok' : 'err', 4000);
          } else {
            download(blob, fname);
            toast(`已下载备份文件 ${fname}`, 'ok', 4000);
          }
        } catch (e) {
          toast(e.message, 'err');
        } finally { this.busy = false; }
      },
      onRestoreFile(ev) {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (!file || this.busy) return;
        file.text().then(text => {
          const data = JSON.parse(text.replace(/^\uFEFF/, ''));
          if (!data || !Array.isArray(data.classes) || !Array.isArray(data.students)) {
            throw new Error('不是本系统的备份文件（缺少班级/名单数据）');
          }
          this.restorePreview = {
            fileName: file.name, data,
            classes: data.classes.length,
            students: data.students.length,
            sessions: (data.sessions || []).length,
          };
        }).catch(e => {
          toast(e instanceof SyntaxError
            ? `「${file.name}」不是 JSON 备份文件，请使用「导出备份」生成的文件`
            : '无法读取备份文件：' + e.message, 'err');
        });
      },
      async confirmRestore() {
        const preview = this.restorePreview;
        if (!preview) return;
        this.busy = true;
        try {
          const r = await api('POST', '/import', preview.data);
          if (this.restorePreview === preview) this.restorePreview = null;
          toast(`已还原：${r.classes} 个班级、${r.students} 名学生、${r.sessions} 个场次，班级与学号保持不变；批改等级表已随备份还原`, 'ok', 4000);
          window.Store.refresh();
        } catch (e) {
          toast(e.message, 'err');
        } finally { this.busy = false; }
      },
      cancelRestore() { this.restorePreview = null; },
    },
    template: `
    <div>
      <div class="card">
        <h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/></svg>
          数据备份
        </h2>
        <p class="hint" style="margin-bottom:14px">换电脑、重装系统或更新 App 前，先「导出备份」存一份文件；之后「导入备份」即可完整还原，<b>不需要重新导入 Excel</b>（重新导入会生成新班级，贴在作业本上的二维码就作废了）。</p>
        <div class="row">
          <button class="btn" @click="exportData" :disabled="busy">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
            导出备份
          </button>
          <label class="btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9m0 0l-4 4m4-4l4 4M4 3h16"/></svg>
            导入备份
            <input type="file" accept=".json,application/json" style="display:none" @change="onRestoreFile">
          </label>
        </div>
        <p class="hint" style="margin-top:12px">桌面 App 版也可用菜单「导入旧数据（db.json）…」导入同样的备份文件。</p>
      </div>

      <div class="card" v-if="restorePreview">
        <h2>导入备份 <span class="sub">{{ restorePreview.fileName }}</span></h2>
        <p style="margin-bottom:12px">将覆盖当前全部数据，还原为：<b>{{ restorePreview.classes }}</b> 个班级、<b>{{ restorePreview.students }}</b> 名学生、<b>{{ restorePreview.sessions }}</b> 个收作业场次。<br>班级编号与学号保持原样，<b>已打印的二维码贴纸继续有效</b>（导入前会自动备份当前数据）。</p>
        <div class="row">
          <button class="btn primary" :disabled="busy" @click="confirmRestore">导入并覆盖</button>
          <button class="btn" @click="cancelRestore">取消</button>
        </div>
      </div>
    </div>`,
  });
})();
