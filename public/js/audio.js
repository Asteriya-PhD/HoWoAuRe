// 扫码提示音：WebAudio 合成，无需音频文件
(function () {
  'use strict';
  let ctx = null;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 首次用户手势时预热（手机浏览器要求）
  function warmup() { ensure(); }

  function beep(freq, ms, gain = 0.22, type = 'sine', when = 0) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.05);
  }

  window.ScanAudio = {
    warmup,
    ok() { beep(880, 90); beep(1320, 110, 0.22, 'sine', 0.07); },   // 新登记：上行双音
    dup() { beep(520, 60, 0.1); },                                   // 重复入镜：轻点
    bad() { beep(220, 130, 0.25, 'square'); beep(180, 150, 0.25, 'square', 0.12); }, // 无效码
  };
})();
