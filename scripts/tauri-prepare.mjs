// Tauri 打包前准备：把运行时资源归拢到 src-tauri/resources，并准备 node sidecar 二进制
// 用法：node scripts/tauri-prepare.mjs   （每次 tauri build 前执行一次）
import { cpSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, platform, execPath } from 'node:process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = join(ROOT, 'src-tauri');
const RES = join(APP, 'resources');

if (platform !== 'darwin') throw new Error('本脚本目前只支持 macOS 打包');
const LIPO_ARCH = { arm64: 'arm64', x64: 'x86_64' }[arch];
const TRIPLE = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[arch];

// 1. server.js + 前端静态资源
rmSync(RES, { recursive: true, force: true });
mkdirSync(RES, { recursive: true });
copyFileSync(join(ROOT, 'server.js'), join(RES, 'server.js'));
cpSync(join(ROOT, 'public'), join(RES, 'public'), { recursive: true });

// 2. 生产依赖（express / ws / selfsigned 及其传递依赖），全新安装保证干净
copyFileSync(join(ROOT, 'package.json'), join(RES, 'package.json'));
execSync('npm install --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error', {
  cwd: RES, stdio: 'inherit',
});
rmSync(join(RES, 'package-lock.json'), { force: true });

// 3. node sidecar：直接取当前 node 可执行文件，universal 瘦身到本机架构
mkdirSync(join(APP, 'binaries'), { recursive: true });
const src = resolve(execPath);
const dst = join(APP, 'binaries', `hwscan-node-${TRIPLE}`);
try {
  execSync(`lipo -thin ${LIPO_ARCH} -output "${dst}" "${src}"`);
} catch {
  copyFileSync(src, dst);
}
execSync(`chmod +x "${dst}"`);

console.log('✓ 资源就绪:', RES);
console.log('✓ sidecar:', dst);
