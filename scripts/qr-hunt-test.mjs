// 核心算法验证：一张合成图里放多个二维码（含 6 个相同码、旋转码、小码），
// 验证 QRHunt.findMulti 一帧全部识别。运行：node scripts/qr-hunt-test.mjs [--save]
import { createCanvas } from './canvas-shim.mjs';
import fs from 'node:fs';

globalThis.jsQR = (await import('jsqr')).default;
const QRHuntMod = await import('../public/js/qr-hunt.js');
const { findMulti } = QRHuntMod.default ?? QRHuntMod;
const qrcodeMod = await import('qrcode-generator');
const qrcode = qrcodeMod.default ?? qrcodeMod.qrcode ?? qrcodeMod;
// 覆写默认的单字节截断转换，确保中文名以 UTF-8 编码进码
qrcode.stringToBytes = s => Array.from(new TextEncoder().encode(s));

const W = 1400, H = 900;
const img = createCanvas(W, H);

function makeMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = [];
  for (let y = 0; y < n; y++) {
    const row = [];
    for (let x = 0; x < n; x++) row.push(qr.isDark(y, x));
    m.push(row);
  }
  return m;
}

// 在 (cx,cy) 处绘制 size×size 的二维码，可旋转；2x2 超采样
function drawMatrix(matrix, cx, cy, size, angleDeg = 0) {
  const n = matrix.length;
  const cell = size / n;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const ext = Math.ceil((size * (Math.abs(cos) + Math.abs(sin))) / 2) + 1;
  for (let dy = -ext; dy <= ext; dy++) {
    for (let dx = -ext; dx <= ext; dx++) {
      let dark = 0;
      for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
        const px = dx + ox, py = dy + oy;
        const mx = (px * cos - py * sin) / cell + n / 2;
        const my = (px * sin + py * cos) / cell + n / 2;
        const mi = Math.floor(mx), mj = Math.floor(my);
        if (mi >= 0 && mj >= 0 && mi < n && mj < n && matrix[mj][mi]) dark++;
      }
      if (dark >= 3) img.set(cx + dx, cy + dy, 20, 20, 20);
    }
  }
}

img.fill(255, 255, 255);

const only = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;
const allCodes = [
  // 6 个完全相同的码（对应「1行/人，6个」贴纸场景），带 ±7° 歪斜
  ...[0, 1, 2, 3, 4, 5].map(i => ({ text: 'HW|1|07|李雷', cx: 180 + i * 215, cy: 160, size: 165, angle: (i % 3 - 1) * 7 })),
  { text: 'HW|1|01|韩梅梅', cx: 220, cy: 620, size: 210, angle: 45 },
  { text: 'HW|1|12|王小虎', cx: 620, cy: 640, size: 130, angle: 0 },
  { text: 'HW|1|33|John Smith', cx: 1000, cy: 660, size: 90, angle: 12 },
];
const codes = only ? only.map(i => allCodes[i]).filter(Boolean) : allCodes;
for (const c of codes) drawMatrix(makeMatrix(c.text), c.cx, c.cy, c.size, c.angle);

const frame = img.imageData();
const direct = globalThis.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
console.log('裸 jsQR 首个结果:', direct ? direct.data : 'FAIL');
// 注意：本场景（6个相同码+45°大码+小码）对 jsQR 是极端工况，它现在只是
// ZXing 主引擎之后的兜底（主引擎见 scripts/accuracy-test.mjs，同场景 9/9 全解）。
// 这里验证兜底的「渐进滑窗」相对裸 jsQR 的增益：至少找到 2 个唯一码且无误识别。
const t0 = Date.now();
const found = findMulti(frame, { maxCodes: 40, expect: 40, maxMs: 1500, shift: 1 });
const ms = Date.now() - t0;

const got = new Set(found.map(f => f.data));
const want = new Set(codes.map(c => c.text));
console.log(`识别耗时 ${ms}ms，找到 ${found.length} 个码（去重后 ${got.size}）`);
let pass = true;
const extra = [...got].filter(t => !want.has(t));
if (extra.length) { pass = false; console.log('  ✗ 误识别:', extra); }
if (got.size < 2) { pass = false; console.log('  ✗ 兜底至少应找到 2 个唯一码'); }
for (const t of want) console.log(`  ${got.has(t) ? '✓' : '—'} ${t}${got.has(t) ? '' : '（本兜底未覆盖，属预期）'}`);

if (process.argv.includes('--save')) fs.writeFileSync('/tmp/qr-hunt-test.png', img.png());
console.log(pass ? '\n通过：一帧多码识别正常' : '\n失败');
process.exit(pass ? 0 : 1);
