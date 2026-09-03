/*
 * 打包 Windows 免安装版（绿色便携包）
 * 产物：dist/作业扫码登记_Windows免安装版.zip
 *   - 内置便携版 node.exe（win-x64），老师无需安装 Node.js、无需联网
 *   - node_modules 仅含生产依赖（express/selfsigned/ws 均为纯 JS，跨平台通用）
 *   - 数据目录定位到包内 data\（HWSCAN_DATA_DIR），整个文件夹拷走数据跟着走
 *
 * 用法：node scripts/make-win-portable.mjs
 * 前置：dist/win-tmp/ 下放好 node-vX-win-x64.zip（脚本发现缺失会自动从 nodejs.org 下载）
 */
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(DIST, 'win-tmp');
const APP_NAME = '作业扫码登记_Windows免安装版';
const BUILD = path.join(DIST, 'HoWoAuRe-win-portable');
const ZIP_TMP = path.join(DIST, 'HoWoAuRe-win-portable.zip');
const ZIP = path.join(DIST, APP_NAME + '.zip');
const NODE_DIST_URL = 'https://nodejs.org/dist/latest-v22.x/';

function sh(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

async function download(url, dest) {
  await new Promise((resolve, reject) => {
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.headers.location) return get(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error(`下载失败 ${res.statusCode}: ${u}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
    get(url);
  });
}

async function ensureNodeZip() {
  fs.mkdirSync(TMP, { recursive: true });
  const existing = fs.readdirSync(TMP).filter(f => /^node-v[\d.]+-win-x64\.zip$/.test(f));
  if (existing.length) return path.join(TMP, existing[0]);
  console.log('未找到 node win-x64 zip，开始从 nodejs.org 下载…');
  const listHtml = await fetch(NODE_DIST_URL).then(r => r.text());
  const name = [...listHtml.matchAll(/node-v[\d.]+-win-x64\.zip/g)][0]?.[0];
  if (!name) throw new Error('无法从 nodejs.org 解析出最新版本文件名');
  const dest = path.join(TMP, name);
  await download(NODE_DIST_URL + name, dest);
  console.log('下载完成:', name);
  return dest;
}

// ---- 打包内容（均以 CRLF/UTF-8 BOM 写出，保证 Windows 记事本与 cmd 正常识别） ----

const BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'title 作业扫码登记',
  'cd /d "%~dp0"',
  'set "NODE_EXE=%~dp0node\\node.exe"',
  'set "HWSCAN_DATA_DIR=%~dp0data"',
  '',
  'if not exist "%NODE_EXE%" (',
  '  echo 缺少 node\\node.exe，请重新解压压缩包，不要改动文件夹内容。',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'echo 正在启动服务，3 秒后自动打开浏览器...',
  'echo 请勿关闭本窗口，关窗即停止服务。',
  'start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:3000"',
  '"%NODE_EXE%" server.js',
  '',
  'echo.',
  'echo 服务已停止。',
  'pause',
  '',
].join('\r\n');

const TXT = `作业扫码登记 — Windows 免安装版 使用说明
==========================================

【第一次使用】
1. 把整个压缩包解压到电脑上任意位置（如桌面）。注意：必须先解压再运行，
   不要在压缩包里直接双击。
2. 打开文件夹，双击「启动作业扫码.bat」。
   - 若弹出「Windows 已保护你的电脑 / 安全警告」，点「更多信息 → 仍要运行」或「运行」。
   - 第一次运行会弹出防火墙提示「是否允许 node.exe 访问网络」，务必勾选
     「专用网络」并点「允许访问」，否则手机连不上电脑。
3. 浏览器会自动打开电脑端界面，按页面提示：新建班级 → 导入名单 →
   生成二维码 PDF 打印贴纸 → 开始收作业。

【手机扫码】
- 手机必须和这台电脑连同一个 WiFi（教室里同一网络即可）。
- 电脑端点「开始收作业」后，用手机（相机/微信）扫电脑大屏上的二维码打开扫码页。
- 手机首次打开会提示「证书不受信任 / 不安全」，点「高级 → 继续前往」放行，
  这是正常现象（本系统在局域网内自建加密，数据不出校园）。
- 若提示打不开页面：部分校园网开了「设备隔离」，可让电脑开手机热点/随身WiFi
  反连，或请学校网络管理员放行。

【数据在哪、怎么换电脑】
- 全部数据（班级/名单/记录）都存在本文件夹内的 data\\ 子文件夹里，不上传任何服务器。
- 换电脑/拷给别人：整个文件夹复制过去即可，数据跟着走。
- 程序每次启动会在 data\\backups\\ 自动留最近 20 份备份。

【常见问题】
- 双击后窗口一闪而过：请确认是先解压了整个压缩包，且文件夹完整（含 node 文件夹）。
- 忘记关窗口/重复双击开了多个：关掉多余的黑窗口即可，端口冲突时系统会自动换端口，
  以浏览器实际打开的地址为准。
- 想清空全部数据：关闭服务后，删除 data\\ 文件夹里的 db.json 再启动。
- 更多用法（批量打等级、导出 Excel、演示模式等）见电脑端页面内的引导。
`;

async function main() {
  const nodeZip = await ensureNodeZip();

  console.log('清理旧构建目录…');
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.rmSync(ZIP_TMP, { force: true });
  fs.rmSync(ZIP, { force: true });
  fs.mkdirSync(BUILD, { recursive: true });

  // 1) 便携版 node.exe（tar 为 macOS/Windows 自带 bsdtar；--strip-components 去掉顶层版本目录）
  console.log('提取 node.exe…');
  fs.mkdirSync(path.join(BUILD, 'node'), { recursive: true });
  execFileSync('tar', ['-xf', nodeZip, '-C', path.join(BUILD, 'node'), '--strip-components=1']);

  // 2) 生产依赖（npm ci 按锁文件精确安装，避开开发依赖；全部纯 JS，跨平台可用）
  console.log('安装生产依赖…');
  const depStage = path.join(TMP, 'prod-deps');
  fs.rmSync(depStage, { recursive: true, force: true });
  fs.mkdirSync(depStage, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(depStage, f));
  }
  sh('npm ci --omit=dev', { cwd: depStage });
  fs.renameSync(path.join(depStage, 'node_modules'), path.join(BUILD, 'node_modules'));

  // 3) 服务与前端
  console.log('拷贝 server.js / public/…');
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(BUILD, 'server.js'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(BUILD, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(BUILD, 'public'), { recursive: true });

  // 4) 启动器与说明
  console.log('写入启动器与使用说明…');
  fs.writeFileSync(path.join(BUILD, '启动作业扫码.bat'), BAT, 'utf8');
  fs.writeFileSync(path.join(BUILD, '使用说明.txt'), '\ufeff' + TXT, 'utf8');

  // 5) 清理 macOS 垃圾文件后打 zip（tar -a 按扩展名选 zip 格式，文件名 UTF-8，Windows 解压不乱码）
  console.log('清理 .DS_Store 并打包 zip…');
  const rmDotDSStore = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rmDotDSStore(p);
      else if (e.name === '.DS_Store') fs.rmSync(p);
    }
  };
  rmDotDSStore(BUILD);
  execFileSync('tar', ['-a', '-cf', ZIP_TMP, '-C', BUILD, '.']);
  fs.renameSync(ZIP_TMP, ZIP);

  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
  console.log(`\n完成：${ZIP} (${mb(fs.statSync(ZIP).size)})`);
  console.log(`目录：${BUILD}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
