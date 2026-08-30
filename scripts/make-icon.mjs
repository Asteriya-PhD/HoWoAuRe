// 生成 1024×1024 应用图标源图（v2：macOS 风格圆角方块 + 作业卡片 + 扫描光束 + 对勾徽章）
// 仅用项目内已有的 pngjs，无新增依赖。产物：scripts/icon-src.png
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const S = 1024;
const png = new PNG({ width: S, height: S });

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 圆角矩形符号距离（负值在内部），标准 centered-box 形式
function sdRRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const bx = (x1 - x0) / 2 - r, by = (y1 - y0) / 2 - r;
  const qx = Math.abs(x - cx) - bx, qy = Math.abs(y - cy) - by;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(x, y, cx, cy, r) { return Math.hypot(x - cx, y - cy) - r; }
function distToSeg(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = clamp(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
}
// 抗锯齿覆盖度：sd≈0 处半透明，边缘约 2px 过渡
const cov = sd => clamp(0.5 - sd / 2, 0, 1);

// alpha 混合：颜色为 [r,g,b]，透明度单独给
function blend(base, rgb, a) {
  const k = clamp(a, 0, 1);
  return [lerp(base[0], rgb[0], k), lerp(base[1], rgb[1], k), lerp(base[2], rgb[2], k)];
}

// ---------- 配色 ----------
const G_TOP = hex('#34D399'), G_BOT = hex('#047857');        // 背景渐变（品牌绿）
const INK = hex('#0F172A');                                   // 深墨
const LINE = hex('#CBD5E1');                                  // 文字行灰
const WHITE = hex('#FFFFFF');
const BEAM = hex('#10B981');                                  // 扫描束
const BD1 = hex('#34D399'), BD2 = hex('#16A34A');             // 徽章渐变
const SHADOW = hex('#0F172A');

// ---------- 几何 ----------
const R = 230;                                                // macOS 大圆角
const CX0 = 130, CY0 = 130, CX1 = S - 130, CY1 = S - 130, CR2 = 92; // 白卡片
// 二维码定位角（左上）：外 150 / 环宽 34 / 心宽 46
const FX = 196, FY = 196, FS = 150, G1 = 34, G2 = 52;
// 文字行 [x0, y, x1, 高]
const lines = [
  [406, 214, 838, 46],
  [406, 292, 700, 46],
  [196, 420, 838, 46],
  [196, 498, 580, 46],
];
// 扫描光束
const BM_Y0 = 600, BM_Y1 = 726, BM_X0 = CX0 + 46, BM_X1 = CX1 - 46, BM_LINE = 663;
// 对勾徽章
const B_CX = 764, B_CY = 764, B_R = 158;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // 1. 背景：对角渐变圆角方块 + 左上柔和高光
    const sdBg = sdRRect(x, y, 0, 0, S - 1, S - 1, R);
    const aBg = cov(sdBg);
    if (aBg <= 0) { png.data[i + 3] = 0; continue; }
    const t = clamp((x + y) / (2 * S - 2), 0, 1);
    let c = [lerp(G_TOP[0], G_BOT[0], t), lerp(G_TOP[1], G_BOT[1], t), lerp(G_TOP[2], G_BOT[2], t)];
    const hl = Math.max(0, 1 - Math.hypot(x - S * 0.3, y - S * 0.22) / (S * 0.55)) * 0.1;
    c = [lerp(c[0], 255, hl), lerp(c[1], 255, hl), lerp(c[2], 255, hl)];

    // 2. 卡片投影（向右下偏移的柔和阴影）
    const sdSh = sdRRect(x, y, CX0 + 10, CY0 + 22, CX1 + 10, CY1 + 22, CR2);
    const aSh = 0.28 * (1 - clamp(sdSh / 70, 0, 1));
    if (aSh > 0) c = blend(c, SHADOW, aSh);

    // 3. 白色卡片
    const sdCard = sdRRect(x, y, CX0, CY0, CX1, CY1, CR2);
    const aCard = cov(sdCard);
    if (aCard > 0) c = blend(c, WHITE, aCard);

    if (sdCard < 0) {
      // 4. 定位角（三层嵌套：外框 - 白环 - 心）
      const outer = cov(sdRRect(x, y, FX, FY, FX + FS, FY + FS, 36));
      const mid = cov(sdRRect(x, y, FX + G1, FY + G1, FX + FS - G1, FY + FS - G1, 20));
      const core = cov(sdRRect(x, y, FX + G2, FY + G2, FX + FS - G2, FY + FS - G2, 10));
      const k = Math.max(outer - mid, core);
      if (k > 0) c = blend(c, INK, k);

      // 5. 文字行
      for (const [lx0, ly0, lx1, lh] of lines) {
        const a2 = cov(sdRRect(x, y, lx0, ly0, lx1, ly0 + lh, lh / 2));
        if (a2 > 0) c = blend(c, LINE, a2);
      }

      // 6. 扫描光束：浅色带 + 亮线 + 两端括号
      const band = cov(sdRRect(x, y, BM_X0, BM_Y0, BM_X1, BM_Y1, 20));
      c = blend(c, BEAM, 0.16 * band);
      const ln = cov(sdRRect(x, y, BM_X0, BM_LINE - 5, BM_X1, BM_LINE + 5, 5));
      c = blend(c, BEAM, 0.95 * ln);
      const BK = 64, BT = 16, BY = 22;   // 括号长/厚/距光束
      for (const bx of [BM_X0, BM_X1]) {
        const x0 = bx === BM_X0 ? bx : bx - BK, x1 = x0 + BK;
        const bTop = cov(sdRRect(x, y, x0, BM_Y0 - BY, x1, BM_Y0 - BY + BT, BT / 2));
        const bBot = cov(sdRRect(x, y, x0, BM_Y1 + BY - BT, x1, BM_Y1 + BY, BT / 2));
        c = blend(c, BEAM, 0.9 * Math.max(bTop, bBot));
      }
    }

    // 7. 对勾徽章：白环 + 渐变圆 + 白色粗对勾
    const sdO = sdCircle(x, y, B_CX, B_CY, B_R);
    if (sdO < 0) {
      const ring = clamp(cov(sdO) - cov(sdCircle(x, y, B_CX, B_CY, B_R - 16)), 0, 1);
      if (ring > 0) c = blend(c, WHITE, ring);
      const tb = clamp(((x - B_CX) + (y - B_CY)) / (2 * B_R) + 0.5, 0, 1);
      const g = [lerp(BD1[0], BD2[0], tb), lerp(BD1[1], BD2[1], tb), lerp(BD1[2], BD2[2], tb)];
      const inner = cov(sdCircle(x, y, B_CX, B_CY, B_R - 16));
      if (inner > 0) c = blend(c, g, inner);
      const HW = 26, FT = 6;   // 对勾笔画半宽 / 边缘过渡
      const chk = Math.max(
        HW - Math.min(distToSeg(x, y, B_CX - 70, B_CY + 6, B_CX - 14, B_CY + 60), 1e9),
        HW - Math.min(distToSeg(x, y, B_CX - 14, B_CY + 60, B_CX + 76, B_CY - 54), 1e9),
      );
      const aChk = clamp(chk / FT, 0, 1);
      if (aChk > 0) c = blend(c, WHITE, aChk);
    }

    png.data[i] = Math.round(c[0]); png.data[i + 1] = Math.round(c[1]);
    png.data[i + 2] = Math.round(c[2]); png.data[i + 3] = Math.round(aBg * 255);
  }
}

const out = join(ROOT, 'scripts', 'icon-src.png');
writeFileSync(out, PNG.sync.write(png));
console.log('图标已生成:', out);
