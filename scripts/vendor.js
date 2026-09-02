// 将前端第三方库从 node_modules 拷贝到 public/vendor，
// 使系统在无外网的校园环境下也能完整运行。npm install 后执行一次即可。
const fs = require('fs');
const path = require('path');

const files = [
  ['vue/dist/vue.global.prod.js', 'vue.global.prod.js'],
  ['vue-router/dist/vue-router.global.prod.js', 'vue-router.global.prod.js'],
  ['jsqr/dist/jsQR.js', 'jsQR.js'],
  ['qrcode-generator/dist/qrcode.js', 'qrcode-generator.js'],
  ['jspdf/dist/jspdf.umd.min.js', 'jspdf.umd.min.js'],
  ['xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js'],
  // ZXing-C++ WASM：多码同时识别的主引擎（jsQR 仅作兜底）
  ['zxing-wasm/dist/es/reader/index.js', 'zxing/index.js'],
  ['zxing-wasm/dist/es/share.js', 'share.js'],
  ['zxing-wasm/dist/reader/zxing_reader.wasm', 'zxing/zxing_reader.wasm'],
];

// 手绘主题字体：霞鹜文楷 Lite（按 unicode-range 切片的 woff2，浏览器按需加载）
// 只取 Regular+Bold 两个字重；CSS 里的相对路径 ./files/… 保持原目录结构
const fontPkg = 'lxgw-wenkai-lite-webfont';
const fontFiles = [
  `${fontPkg}/lxgwwenkailite-regular.css`, `${fontPkg}/lxgwwenkailite-bold.css`,
];
const fontDirPrefixes = ['lxgwwenkailite-regular-subset-', 'lxgwwenkailite-bold-subset-'];

const destDir = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(destDir, { recursive: true });
fs.mkdirSync(path.join(destDir, 'zxing'), { recursive: true });

for (const [src, name] of files) {
  const from = path.join(__dirname, '..', 'node_modules', ...src.split('/'));
  const to = path.join(destDir, name);
  if (!fs.existsSync(from)) {
    console.error(`缺少依赖 ${src}，请先执行 npm install`);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  console.log(`已拷贝 ${name} (${(fs.statSync(to).size / 1024).toFixed(0)} KB)`);
}

// ---- 字体归拢 ----
const fontSrcDir = path.join(__dirname, '..', 'node_modules', fontPkg);
const fontDestDir = path.join(destDir, 'fonts');
if (fs.existsSync(fontSrcDir)) {
  const filesDir = path.join(fontDestDir, 'files');
  fs.rmSync(fontDestDir, { recursive: true, force: true });
  fs.mkdirSync(filesDir, { recursive: true });
  // CSS 与 files/ 同级，保持包内相对路径 ./files/… 不变
  for (const css of fontFiles) {
    const from = path.join(fontSrcDir, path.basename(css));
    fs.copyFileSync(from, path.join(fontDestDir, path.basename(css)));
  }
  let total = 0, count = 0;
  for (const f of fs.readdirSync(path.join(fontSrcDir, 'files'))) {
    if (fontDirPrefixes.some(p => f.startsWith(p)) && f.endsWith('.woff2')) {
      fs.copyFileSync(path.join(fontSrcDir, 'files', f), path.join(filesDir, f));
      total += fs.statSync(path.join(fontSrcDir, 'files', f)).size;
      count++;
    }
  }
  console.log(`已拷贝字体 ${count} 个切片 woff2 (共 ${(total / 1024 / 1024).toFixed(1)} MB，浏览器按需加载单个约 50KB)`);
} else {
  console.log(`跳过字体（缺少 ${fontPkg}，手绘主题将回退系统楷体）`);
}
console.log('前端库本地化完成');
