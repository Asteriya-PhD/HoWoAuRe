// 生成 1024×1024 应用图标源图（macOS 圆角矩形 + 二维码定位角 + 绿色对勾）
// 仅用项目内已有的 pngjs，无新增依赖。产物：scripts/icon-src.png
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const S = 1024;
const png = new PNG({ width: S, height: S });

const lerp = (a, b, t) => a + (b - a) * t;

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

// 圆角矩形内测（标准圆角）
function inRRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx, dy = y - cy;
  if (dx === 0 && dy === 0) return true;
  // 仅在四角区域做圆判断
  const inCorner = (x < x0 + r || x > x1 - r) && (y < y0 + r || y > y1 - r);
  return inCorner ? dx * dx + dy * dy <= r * r : true;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function distToSeg(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = x - ax, wy = y - ay;
  const t = Math.max(0, Math.min(1, (vx * wx + vy * wy) / (vx * vx + vy * vy)));
  const dx = x - (ax + vx * t), dy = y - (ay + vy * t);
  return Math.hypot(dx, dy);
}

// ---------- 背景：蓝色渐变圆角矩形 ----------
const BG_TOP = hex('#5AA2F8'), BG_BOT = hex('#2563EB');
const BX0 = 0, BY0 = 0, BX1 = S - 1, BY1 = S - 1, BR = 180;

// ---------- 白色卡片 ----------
const C = 128;            // 卡片边距
const CR = 96;            // 卡片圆角

// ---------- 二维码定位角（三个，比例 7:5:3） ----------
const P = 168;            // 定位角外框尺寸
const WI = 24;            // 白环内缩（1/7）
const W = 120;            // 白环尺寸（5/7）
const CI = 48;            // 黑心内缩（2/7）
const CB = 72;            // 黑心尺寸（3/7）
const PAD = 72;           // 卡片内边距
const CX0 = C, CY0 = C, CX1 = S - 1 - C, CY1 = S - 1 - C; // 卡片范围
const corners = [
  [CX0 + PAD, CY0 + PAD],
  [CX0 + PAD, CY1 - PAD - P],
  [CX1 - PAD - P, CY0 + PAD],
];

// ---------- 绿色对勾徽章 ----------
const CHK = { cx: 742, cy: 742, r: 178 };
const GREEN = hex('#22C55E'), GREEN_DARK = hex('#16A34A');
const WHITE = hex('#FFFFFF'), INK = hex('#111827');

for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const bg = [lerp(BG_TOP[0], BG_BOT[0], t), lerp(BG_TOP[1], BG_BOT[1], t), lerp(BG_TOP[2], BG_BOT[2], t)];
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    let rgba = null;

    if (inRRect(x, y, BX0, BY0, BX1, BY1, BR)) rgba = [...bg, 255];

    // 白色卡片
    if (rgba && inRRect(x, y, C, C, S - 1 - C, S - 1 - C, CR)) rgba = [...WHITE, 255];

    // 定位角：黑中心 → 白内环 → 黑外框（从小到大判断，内层优先）
    if (rgba && rgba[0] === 255) {
      for (const [px, py] of corners) {
        if (inRRect(x, y, px + CI, py + CI, px + CI + CB - 1, py + CI + CB - 1, 12)) { rgba = [...INK, 255]; continue; }
        if (inRRect(x, y, px + WI, py + WI, px + WI + W - 1, py + WI + W - 1, 20)) { rgba = [...WHITE, 255]; continue; }
        if (inRRect(x, y, px, py, px + P - 1, py + P - 1, 28)) { rgba = [...INK, 255]; continue; }
      }
      // 中央点状模块点缀（模拟二维码数据点）
      const mods = [
        [452, 452], [532, 452], [612, 452],
        [452, 532], [612, 532],
        [532, 612],
      ];
      for (const [mx, my] of mods) {
        if (inRRect(x, y, mx, my, mx + 34, my + 34, 8)) rgba = [...INK, 255];
      }
    }

    // 绿色对勾徽章（覆盖在最上层）
    if (rgba && inCircle(x, y, CHK.cx, CHK.cy, CHK.r)) {
      const edge = inCircle(x, y, CHK.cx, CHK.cy, CHK.r) && !inCircle(x, y, CHK.cx, CHK.cy, CHK.r - 14);
      const ok = distToSeg(x, y, CHK.cx - 78, CHK.cy + 6, CHK.cx - 18, CHK.cy + 66) < 34
        || distToSeg(x, y, CHK.cx - 18, CHK.cy + 66, CHK.cx + 84, CHK.cy - 66) < 34;
      const g = y < CHK.cy ? GREEN : GREEN_DARK;
      rgba = ok ? [...WHITE, 255] : [...g, 255];
      if (edge) rgba = [...hex('#15803D'), 255];
    }

    if (rgba) {
      png.data[i] = rgba[0]; png.data[i + 1] = rgba[1]; png.data[i + 2] = rgba[2]; png.data[i + 3] = rgba[3];
    } else {
      png.data[i + 3] = 0; // 透明（圆角外）
    }
  }
}

const out = join(ROOT, 'scripts', 'icon-src.png');
writeFileSync(out, PNG.sync.write(png));
console.log('图标已生成:', out);
