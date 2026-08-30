// 真机截图取证：从用户手机截图中裁出二维码区域，用 ZXing/jsQR 解码。
// 目的：判定「打印的码本身有问题」还是「手机相机帧有问题」。
// 运行：node scripts/forensic.mjs
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { createCanvas } from './canvas-shim.mjs';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

globalThis.jsQR = (await import('jsqr')).default;
await prepareZXingModule({ overrides: { wasmBinary: readFileSync(new URL('../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url).pathname) } });

const DIR = '/Users/zhewenliu/.zcode/cli/image-cache/sess_ff06cdd5-368f-40a7-9db3-e5eea5988c40';

function load(name) {
  const png = PNG.sync.read(fs.readFileSync(`${DIR}/${name}`));
  const img = createCanvas(png.width, png.height);
  img.data.set(png.data);
  return img;
}

// 从大图中裁剪子区域
function crop(src, x0, y0, w, h) {
  const out = createCanvas(w, h);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= src.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= src.width) continue;
      const si = (sy * src.width + sx) * 4, di = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[di + k] = src.data[si + k];
    }
  }
  return out;
}

async function decode(img, label) {
  const r1 = await readBarcodes({ data: img.data, width: img.width, height: img.height }, { maxNumberOfSymbols: 10, tryDenoise: true });
  const fr = img.imageData();
  const r2 = globalThis.jsQR(fr.data, fr.width, fr.height, { inversionAttempts: 'attemptBoth' });
  const zx = r1.length ? r1.map(x => x.text).join(' | ') : 'FAIL';
  const jq = r2 ? r2.data : 'FAIL';
  console.log(`${label}: ZXing=${zx}  jsQR=${jq}`);
  return { zx: r1.length ? r1[0].text : null, jq: r2 ? r2.data : null };
}

// 陈静的近景（整图先试，再裁码区）
const chen = load('image-e14aea825d8420f4ae887ff85116b4a8.png');
console.log(`== 陈静 近景截图 ${chen.width}x${chen.height} ==`);
await decode(chen, '整图');

// 黄丽的近景
const huang = load('image-55b81df290f9d864cc62dbe780637489.png');
console.log(`== 黄丽 近景截图 ${huang.width}x${huang.height} ==`);
await decode(huang, '整图');
