// 中央反光场景：模拟拍屏幕时中央 glare 让「位置靠中间」的码局部对比度下降而漏检。
// 验证 ZXing 多遍策略：常规 → 去噪+全局直方图 → 四分块隔离，逐遍能捞回多少。
// 运行：node scripts/glare-test.mjs
import { createCanvas } from './canvas-shim.mjs';
import { readFileSync } from 'node:fs';

const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
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

function drawMatrix(img, matrix, cx, cy, size, angleDeg = 0, lift = 0) {
  // lift：该区域环境亮度抬升（反光），黑模块变浅、白模块封顶
  const n = matrix.length, cell = size / n;
  const rad = (angleDeg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const ext = Math.ceil((size * (Math.abs(cos) + Math.abs(sin))) / 2) + 1;
  const dk = Math.min(255, 30 + lift * 3.2);   // 反光下黑模块被抬高到 ~150
  const lt = Math.min(255, 235 + lift);        // 白模块很快封顶 255
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
  });
}
// 中央椭圆反光：中列 4 个码（index 1,3,5,7 → cx≈1190）+ 靠内的码落在 glare 里
function glareLift(cx, cy) {
  const dx = (cx - 950) / 520, dy = (cy - 600) / 420;
  const d = dx * dx + dy * dy;
  return d >= 1 ? 0 : Math.round(42 * (1 - d));
}

const img = createCanvas(W, H);
img.fill(255, 255, 255);
for (const c of layout) {
  const lift = glareLift(c.cx, c.cy);
  c.lift = lift;
  drawMatrix(img, makeMatrix(c.text), c.cx, c.cy, c.size, c.angle, lift);
}
const want = new Map(layout.map(c => [c.text, c]));
const centerCodes = layout.filter(c => c.lift > 10).map(c => c.text);
console.log(`反光区内的码: ${centerCodes.length} 个`);

const frame = img.imageData();

async function scan(opts, tile) {
  let data = frame.data, w = W, h = H, ox = 0, oy = 0;
  if (tile) {
    w = Math.floor(W / 2) + 24; h = Math.floor(H / 2) + 24;
    ox = Math.max(0, Math.min(W - w, tile[0])); oy = Math.max(0, Math.min(H - h, tile[1]));
    data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) data.set(frame.data.subarray(((oy + y) * W + ox) * 4, ((oy + y) * W + ox) * 4 + w * 4), y * w * 4);
  }
  return readBarcodes({ data, width: w, height: h }, opts).then(r => ({ r, ox, oy }));
}

const t0 = Date.now();
const found = new Map(); // text -> {r, ox, oy}
const pass1 = await scan({ maxNumberOfSymbols: 30, tryDenoise: false });
for (const r of pass1.r) if (!found.has(r.text)) found.set(r.text, { r, ox: pass1.ox, oy: pass1.oy });
console.log(`第1遍 常规:        ${found.size}/10，${Date.now() - t0}ms`);

if (found.size < 10) {
  const pass2 = await scan({ maxNumberOfSymbols: 30, tryDenoise: true, binarizer: 'GlobalHistogram' });
  for (const r of pass2.r) if (!found.has(r.text)) found.set(r.text, { r, ox: pass2.ox, oy: pass2.oy });
  console.log(`第2遍 去噪+全局直方图: ${found.size}/10，${Date.now() - t0}ms`);
}

if (found.size < 10) {
  const tw = Math.floor(W / 2) + 24, th = Math.floor(H / 2) + 24;
  for (const tile of [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th]]) {
    if (found.size >= 10 || Date.now() - t0 > 460) break;
    const pass3 = await scan({ maxNumberOfSymbols: 10, tryDenoise: true }, tile);
    for (const r of pass3.r) if (!found.has(r.text)) found.set(r.text, { r, ox: pass3.ox, oy: pass3.oy });
    console.log(`第3遍 四分块 ${tile}: ${found.size}/10，${Date.now() - t0}ms`);
  }
}

const missedCenter = centerCodes.filter(t => !found.has(t));
console.log(`\n结果: ${found.size}/10；反光区中间码 ${centerCodes.length} 个中漏掉 ${missedCenter.length} 个${missedCenter.length ? '：' + missedCenter.join('、') : ''}`);
process.exit(found.size === 10 ? 0 : 1);
