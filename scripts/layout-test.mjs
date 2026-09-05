// 版式验证：按「1份/人」几何（4列×7行、20mm 码、4mm+ 静区）在 A4 比例画布上
// 复现打印效果，模拟手机拍摄（整页入镜 + 只拍中间两行两种取景），
// 验证 ZXing 多遍策略能把 10 个码全部识别——尤其是页面中部的码。
// 运行：node scripts/layout-test.mjs
import { createCanvas } from './canvas-shim.mjs';
import { readFileSync } from 'node:fs';

const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
const wasmPath = new URL('../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url).pathname;
await prepareZXingModule({ overrides: { wasmBinary: readFileSync(wasmPath) } });
const qm = await import('qrcode-generator');
const qrcode = qm.default ?? qm.qrcode ?? qm;
qrcode.stringToBytes = s => Array.from(new TextEncoder().encode(s));

// ---- 与 qr-pdf.js 保持一致的新版几何（单位 mm） ----
const PW = 210, PH = 297, M = 10;
const COLS = 5, ROWS = 7, Q = 20;
const CW = (PW - 2 * M) / COLS, CH = (PH - 2 * M) / ROWS;
const students = ['王晓明', '李思思', '张伟', '刘洋', '陈静', '杨帆', '赵磊', '黄丽', '周杰', '吴敏'];

function makeMatrix(text) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount();
  const m = [];
  for (let y = 0; y < n; y++) { const row = []; for (let x = 0; x < n; x++) row.push(qr.isDark(y, x)); m.push(row); }
  return m;
}

function drawMatrix(img, matrix, cx, cy, size, angleDeg = 0) {
  const n = matrix.length, cell = size / n;
  const rad = (angleDeg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const ext = Math.ceil((size * (Math.abs(cos) + Math.abs(sin))) / 2) + 1;
  for (let dy = -ext; dy <= ext; dy++) for (let dx = -ext; dx <= ext; dx++) {
    let votes = 0;
    for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
      const px = dx + ox, py = dy + oy;
      if (matrix[Math.floor((px * sin + py * cos) / cell + n / 2)]?.[Math.floor((px * cos - py * sin) / cell + n / 2)]) votes++;
    }
    if (votes >= 3) img.set(cx + dx, cy + dy, 30, 30, 30);
    else img.set(cx + dx, cy + dy, 240, 240, 240);
  }
}

// 画整页（含轻微纸张灰度不均）
const pxPerMm = 5.2; // 手机拍整页 A4 时的典型比例
const PWx = Math.round(PW * pxPerMm), PHx = Math.round(PH * pxPerMm);
const sheet = createCanvas(PWx, PHx);
sheet.fill(245, 245, 245);
const layout = [];
for (let i = 0; i < students.length; i++) {
  const col = i % COLS, row = Math.floor(i / COLS);
  const x = M + col * CW + (CW - Q) / 2, y = M + row * CH + 2;
  layout.push({
    text: `HW|15|${String(i + 1).padStart(2, '0')}|${students[i]}`,
    cx: Math.round((x + Q / 2) * pxPerMm),
    cy: Math.round((y + Q / 2) * pxPerMm),
    size: Math.round(Q * pxPerMm),
    angle: ((i * 7) % 11 - 5) * 1.2,
  });
}
for (const c of layout) drawMatrix(sheet, makeMatrix(c.text), c.cx, c.cy, c.size, c.angle);
const want = new Set(layout.map(c => c.text));

async function zx(imgData) {
  return readBarcodes({ data: imgData.data, width: imgData.width, height: imgData.height }, { maxNumberOfSymbols: 30, tryDenoise: true });
}
function report(name, results, subset) {
  const got = new Set(results.map(r => r.text));
  const targets = subset ? layout.filter(c => subset.has(c.text)) : layout;
  const hit = targets.filter(c => got.has(c.text)).length;
  console.log(`${name}: ${hit}/${targets.length}`);
  return hit;
}

// 取景一：整页入镜
console.log('取景一：整页 A4 入镜');
const full = await zx(sheet.imageData());
report('  常规一遍', full.r ?? full, null);

// 取景二：只拍中间两行（模拟「中间位置的码」），周围留 15% 背景
console.log('取景二：只拍页面中部（第2~3行）');
const bandY0 = Math.round((M + CH) * pxPerMm * 0.9);
const bandH = Math.round(CH * 2.2 * pxPerMm);
const band = createCanvas(PWx, bandH);
for (let y = 0; y < bandH; y++) {
  const sy = Math.min(PHx - 1, bandY0 + y);
  band.data.set(sheet.data.subarray(sy * PWx * 4, sy * PWx * 4 + PWx * 4), y * PWx * 4);
}
const bandRow = [1, 2].flatMap(row => [0, 1, 2, 3, 4].map(c => row * COLS + c)).filter(i => i < layout.length);
const bandWant = new Set(bandRow.map(i => layout[i].text));
const r2 = await zx(band.imageData());
const h2 = report('  常规一遍', r2.r ?? r2, bandWant);

// 取景三：手持歪斜 6°（旋转整页重采样）
console.log('取景三：整页 + 相机歪 6°');
const rot = createCanvas(PWx + 400, PHx + 400);
rot.fill(250, 250, 250);
{
  const rad = 6 * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const cx0 = PWx / 2, cy0 = PHx / 2, cx1 = rot.width / 2, cy1 = rot.height / 2;
  for (let y = 0; y < rot.height; y++) for (let x = 0; x < rot.width; x++) {
    const dx = x - cx1, dy = y - cy1;
    const sx = Math.round(dx * cos - dy * sin + cx0), sy = Math.round(dx * sin + dy * cos + cy0);
    if (sx >= 0 && sy >= 0 && sx < PWx && sy < PHx) {
      const di = (y * rot.width + x) * 4, si = (sy * PWx + sx) * 4;
      for (let k = 0; k < 4; k++) rot.data[di + k] = sheet.data[si + k];
    }
  }
}
const r3 = await zx(rot.imageData());
const h3 = report('  常规一遍', r3.r ?? r3, null);

const total = (full.r ? full.r.length : full.length) >= students.length && h2 === bandWant.size && h3 >= students.length;
console.log(total ? '\n通过：新版式几何全部识别' : '\n存在漏检');
process.exit(total ? 0 : 1);
