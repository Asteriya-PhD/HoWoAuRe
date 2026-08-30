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
console.log('前端库本地化完成');
