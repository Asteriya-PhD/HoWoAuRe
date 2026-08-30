// 识别率基准：模拟「PDF 缩到 33%/50% 显示在屏幕上、手机隔空拍」的小码场景。
// 传感器帧 1600x1200，10 个不同的学生码（2列×5行），含旋转/边缘/明暗差异。
// 对比：旧管线（900px jsQR）→ 中间态（1366px jsQR 滑窗）→ 新管线（1366px ZXing-WASM）。
// 注意：jsQR 的 findMulti 会就地涂白识别过的区域，所以各管线各自用干净帧。
// 运行：node scripts/accuracy-test.mjs
import { createCanvas } from './canvas-shim.mjs';

globalThis.jsQR = (await import('jsqr')).default;
const QRHuntMod = await import('../public/js/qr-hunt.js');
const { findMulti } = QRHuntMod.default ?? QRHuntMod;
const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
// Node 里 fetch 不支持 file://，直接把 wasm 字节注入；浏览器端走同源 fetch（见 index.html）
const { readFileSync } = await import('node:fs');
const wasmPath = new URL('../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url).pathname;
await prepareZXingModule({ overrides: { wasmBinary: readFileSync(wasmPath) } });
const qm = await import('qrcode-generator');
const qrcode = qm.default ?? qm.qrcode ?? qm;
qrcode.stringToBytes = s => Array.from(new TextEncoder().encode(s));

const W = 1600, H = 1200;

function makeMatrix(text) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount();
  const m = [];
  for (let y = 0; y < n; y++) { const row = []; for (let x = 0; x < n; x++) row.push(qr.isDark(y, x)); m.push(row); }
  return m;
}

function drawMatrix(img, matrix, cx, cy, size, angleDeg = 0, shade = 0) {
  const n = matrix.length, cell = size / n;
  const rad = (angleDeg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const ext = Math.ceil((size * (Math.abs(cos) + Math.abs(sin))) / 2) + 1;
  const dk = 40 - shade, lt = 235 - shade;
  for (let dy = -ext; dy <= ext; dy++) for (let dx = -ext; dx <= ext; dx++) {
    let votes = 0;
    for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
      const px = dx + ox, py = dy + oy;
      if (matrix[Math.floor((px * sin + py * cos) / cell + n / 2)]?.[Math.floor((px * cos - py * sin) / cell + n / 2)]) votes++;
    }
    if (votes >= 3) img.set(cx + dx, cy + dy, dk, dk, dk);
    else img.set(cx + dx, cy + dy, lt, lt, lt);
  }
}

const students = ['王晓明', '李思思', '张伟', '刘洋', '陈静', '杨帆', '赵磊', '黄丽', '周杰', '吴敏'];
const layout = [];
for (let i = 0; i < 10; i++) {
  const col = i % 2, row = Math.floor(i / 2);
  layout.push({
    text: `HW|15|${String(i + 1).padStart(2, '0')}|${students[i]}`,
    cx: 430 + col * 760 + (i * 37) % 60 - 30,
    cy: 130 + row * 235 + (i * 53) % 40 - 20,
    size: 92 + (i % 4) * 16,
    angle: ((i * 7) % 11 - 5) * 1.8,
    shade: (i % 3) * 18,
  });
}

function buildScene(sizeScale) {
  const img = createCanvas(W, H);
  img.fill(255, 255, 255);
  for (const c of layout) drawMatrix(img, makeMatrix(c.text), c.cx, c.cy, Math.round(c.size * sizeScale), c.angle, c.shade);
  return img;
}

function downscale(src, targetW) {
  // 面积平均（box filter）降采样，接近摄像头/浏览器平滑缩放的效果
  const s = src.width / targetW;
  const w = targetW, h = Math.round(src.height / s);
  const out = createCanvas(w, h);
  for (let y = 0; y < h; y++) {
    const sy0 = y * s, sy1 = Math.min(src.height, (y + 1) * s);
    for (let x = 0; x < w; x++) {
      const sx0 = x * s, sx1 = Math.min(src.width, (x + 1) * s);
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = Math.floor(sy0); sy < sy1; sy++) {
        for (let sx = Math.floor(sx0); sx < sx1; sx++) {
          const si = (sy * src.width + sx) * 4;
          r += src.data[si]; g += src.data[si + 1]; b += src.data[si + 2]; n++;
        }
      }
      const di = (y * w + x) * 4;
      out.data[di] = r / n; out.data[di + 1] = g / n; out.data[di + 2] = b / n; out.data[di + 3] = 255;
    }
  }
  return out;
}

const want = new Set(layout.map(c => c.text));

function runJsqr(name, img, opts) {
  const frame = img.imageData();
  const t0 = Date.now();
  const found = findMulti(frame, opts);
  const ms = Date.now() - t0;
  const got = new Set(found.map(f => f.data));
  const hit = [...want].filter(t => got.has(t)).length;
  console.log(`${name}: 识别 ${hit}/10，耗时 ${ms}ms`);
  return hit;
}

async function runZxing(baseCanvas, targetW, label) {
  const frame = downscale(baseCanvas, targetW).imageData();
  const t0 = Date.now();
  const results = await readBarcodes({ data: frame.data, width: frame.width, height: frame.height }, { maxNumberOfSymbols: 30, tryDenoise: true });
  const ms = Date.now() - t0;
  const hit = results.filter(r => want.has(r.text)).length;
  console.log(`${label}: 识别 ${hit}/10，耗时 ${ms}ms`);
  return hit;
}

let zx33 = 0, zx50 = 0;

console.log('== 场景一：33% 缩放 PDF（小码，最难） ==');
const s33 = buildScene(1);
const zx33r = await runZxing(s33, 1366, '新管线  1366px ZXing  ');
const old33 = runJsqr('旧管线   900px jsQR   ', downscale(s33, 900), { maxCodes: 30 });
const mid33 = runJsqr('中间态 1366px jsQR滑窗', downscale(s33, 1366), { maxCodes: 30, expect: 10 });
zx33 = zx33r;

console.log('\n== 场景二：50% 缩放 PDF（中码） ==');
const s50 = buildScene(1.5);
const zx50r = await runZxing(s50, 1366, '新管线  1366px ZXing  ');
const old50 = runJsqr('旧管线   900px jsQR   ', downscale(s50, 900), { maxCodes: 30 });
const mid50 = runJsqr('中间态 1366px jsQR滑窗', downscale(s50, 1366), { maxCodes: 30, expect: 10 });
zx50 = zx50r;

console.log(`\n结论: 33%场景 旧${old33}/10 → jsQR滑窗${mid33}/10 → ZXing ${zx33}/10；50%场景 ZXing ${zx50}/10`);
process.exit(zx33 >= 9 && zx50 >= 9 ? 0 : 1);
