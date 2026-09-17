// Tauri 打包前准备：把前端静态资源归拢到 src-tauri/resources
// （服务端已内建 Rust 进程，不再需要 server.js / node_modules / node sidecar）
// 用法：node scripts/tauri-prepare.mjs   （每次 tauri build 前执行一次）
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = join(ROOT, 'src-tauri');
const RES = join(APP, 'resources');

rmSync(RES, { recursive: true, force: true });
mkdirSync(RES, { recursive: true });
cpSync(join(ROOT, 'public'), join(RES, 'public'), { recursive: true });

console.log('✓ 资源就绪:', RES);
