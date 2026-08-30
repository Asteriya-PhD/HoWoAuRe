/*
 * 一帧多码识别：在单帧画面里连续找出尽可能多的二维码。
 *
 * 实测结论（scripts/accuracy-test.mjs 可复现）：
 * - jsQR 单次只返回一个码；把已识别区域涂白后对同一帧再扫，可继续找下一个；
 * - 但只要画面里有两个以上的码，jsQR 的定位器就可能互相干扰——连第一个都解不出来，
 *   且干扰与码的内容无关（不同学生的码也一样触发），「1行/人」的相同贴纸必触；
 * - 唯一可靠的办法是「隔离」：把画面切成足够小的块，让每块大概率只含一个码。
 *
 * 因此策略是「全帧快扫 + 渐进网格」：
 * 1. 全帧 hunt：识别 → 涂白 → 再识别（画面里只有 1~2 个码时一步到位，最常见、最快）；
 * 2. 数量没到 expect（还剩几人没扫到）时，逐级加密网格：2×2 → 4×4 → 6×6，
 *    相邻网格间保持重叠，避免码恰好压在切割线上被裁坏；
 * 3. 全程受 maxMs 时间预算保护，超时先把已找到的交回去（下一帧继续扫）。
 *
 * imgData 会被就地修改（识别过的区域被涂白）。浏览器与 Node 测试脚本共用本模块。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QRHunt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function bboxOf(location, pad) {
    const xs = [location.topLeftCorner.x, location.topRightCorner.x, location.bottomLeftCorner.x, location.bottomRightCorner.x];
    const ys = [location.topLeftCorner.y, location.topRightCorner.y, location.bottomLeftCorner.y, location.bottomRightCorner.y];
    return {
      x0: Math.floor(Math.min(...xs)) - pad,
      y0: Math.floor(Math.min(...ys)) - pad,
      x1: Math.ceil(Math.max(...xs)) + pad,
      y1: Math.ceil(Math.max(...ys)) + pad,
    };
  }

  function grow(box, n) { return { x0: box.x0 - n, y0: box.y0 - n, x1: box.x1 + n, y1: box.y1 + n }; }

  function pointInBox(p, b) { return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1; }

  function maskWhite(data, width, height, b) {
    const x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
    const x1 = Math.min(width - 1, Math.ceil(b.x1)), y1 = Math.min(height - 1, Math.ceil(b.y1));
    for (let y = y0; y <= y1; y++) {
      let i = (y * width + x0) * 4;
      for (let x = x0; x <= x1; x++, i += 4) {
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
      }
    }
  }

  // 在一块（或一帧）像素内连续识别：识别 → 涂白 → 再识别
  function huntRegion(data, width, height, jsQRfn, opts) {
    const found = [];       // {data, location(本区域坐标)}
    const maskedBoxes = [];
    const pad = opts.pad != null ? opts.pad : 8;
    let stall = 0;

    for (let i = 0; i < opts.maxCodes * 3; i++) {
      const res = jsQRfn(data, width, height, {
        inversionAttempts: opts.invert ? 'attemptBoth' : 'dontInvert',
      });
      if (!res) break;

      const cx = (res.location.topLeftCorner.x + res.location.bottomRightCorner.x) / 2;
      const cy = (res.location.topLeftCorner.y + res.location.bottomRightCorner.y) / 2;

      // 落回已涂白区域 → 遮挡不彻底，扩大重试；反复失败则放弃
      const hit = maskedBoxes.findIndex(b => pointInBox({ x: cx, y: cy }, b));
      if (hit >= 0) {
        if (++stall > 6) break;
        maskedBoxes[hit] = grow(maskedBoxes[hit], 16);
        maskWhite(data, width, height, maskedBoxes[hit]);
        continue;
      }

      if (!found.some(f => f.data === res.data)) found.push({ data: res.data, location: res.location });
      const box = bboxOf(res.location, pad);
      maskWhite(data, width, height, box);
      maskedBoxes.push(box);
    }
    return found;
  }

  function extractTile(src, srcW, srcH, tile) {
    const w = tile.x1 - tile.x0, h = tile.y1 - tile.y0;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const s = ((tile.y0 + y) * srcW + tile.x0) * 4;
      out.set(src.subarray(s, s + w * 4), y * w * 4);
    }
    return { data: out, width: w, height: h };
  }

  function clampTile(t, w, h) {
    return {
      x0: Math.max(0, Math.min(Math.round(t.x0), w - 2)),
      y0: Math.max(0, Math.min(Math.round(t.y0), h - 2)),
      x1: Math.max(2, Math.min(Math.round(t.x1), w)),
      y1: Math.max(2, Math.min(Math.round(t.y1), h)),
    };
  }

  // n×n 网格：块大小 w/n、h/n（带 ov 重叠边），均匀铺满整幅
  function gridTiles(w, h, n, ov) {
    const tw = Math.ceil(w / n), th = Math.ceil(h / n);
    const xs = [];
    const ys = [];
    for (let i = 0; i < n; i++) {
      xs.push(Math.min(w - Math.min(tw + ov, w), Math.round(i * (w - tw) / (n - 1 || 1)) - (i ? ov : 0)));
      ys.push(Math.min(h - Math.min(th + ov, h), Math.round(i * (h - th) / (n - 1 || 1)) - (i ? ov : 0)));
    }
    const tiles = [];
    for (const y0 of ys) for (const x0 of xs) {
      tiles.push({ x0, y0, x1: Math.min(w, x0 + tw + ov), y1: Math.min(h, y0 + th + ov) });
    }
    return tiles;
  }

  /**
   * @param {object} imgData {data(RGBA), width, height}
   * @param {object} opts {
   *   jsQR, maxCodes=30, expect=0, pad=8, invert=false, maxMs=500,
   *   shift=0  // 0/1/2 轮换：改变细粒度窗口的起点，多帧并集覆盖压在窗口缝上的码
   * }
   * @returns {Array} [{data, location(原图坐标)}]
   */
  function findMulti(imgData, opts) {
    opts = opts || {};
    const jsQRfn = opts.jsQR || (typeof jsQR !== 'undefined' ? jsQR : null);
    if (!jsQRfn) throw new Error('jsQR 未加载');

    const t0 = Date.now();
    const maxMs = opts.maxMs || 500;
    const expect = Math.max(0, opts.expect | 0);
    const w = imgData.width, h = imgData.height;

    // 第一优先：全帧快扫（画面里只有一两个码时一步到位，最常见也最快）
    const found = huntRegion(imgData.data, w, h, jsQRfn, opts);

    // 已找到的码就地涂白，后续窗口不会重复识别它们
    for (const f of found) {
      maskWhite(imgData.data, w, h, grow(bboxOf(f.location, 10), 6));
    }

    // 第二优先：多尺度滑窗。画面里码一多，jsQR 的定位器会互相干扰（连第一个都解不出），
    // 唯一可靠的办法是用足够小的窗口把每个码「隔离」；窗口从半屏逐级收缩，
    // 细粒度用半窗步进（50% 重叠），保证码不会被窗口缝裁坏。
    // 实测：全帧/大窗颗粒无收时，227~340px 的窗口能逐个隔离中码场景（scripts/accuracy-test.mjs）。
    const shift = (opts.shift | 0) % 3;
    const scales = [
      { sx: w, sy: h },                                       // 全帧（已扫，占位对齐索引）
      { sx: Math.round(w / 2), sy: Math.round(h / 2), nx: 2, ny: 2 },
      { sx: Math.round(w / 2.86), sy: Math.round(h / 2.86), nx: 3, ny: 3 },
      { sx: Math.round(w / 4), sy: Math.round(h / 4), nx: 4, ny: 4 },
      { sx: Math.round(w / 6), sy: Math.round(h / 6), nx: 6, ny: 6 },
      { sx: Math.round(w / 8), sy: Math.round(h / 8), nx: 8, ny: 8 },
    ];

    const needMore = () => found.length < Math.max(2, expect) && Date.now() - t0 <= maxMs;

    for (let si = 1; si < scales.length && needMore(); si++) {
      const { sx, sy, nx, ny } = scales[si];
      const stepX = Math.max(1, Math.floor((w - sx) / Math.max(1, nx - 1)));
      const stepY = Math.max(1, Math.floor((h - sy) / Math.max(1, ny - 1)));
      const offX = shift * Math.floor(stepX / 3);
      const offY = shift * Math.floor(stepY / 3);
      const xs = [];
      for (let i = 0; i < nx; i++) xs.push(Math.max(0, Math.min(w - sx, i * stepX + (i % 2 ? offX : 0))));
      const ys = [];
      for (let i = 0; i < ny; i++) ys.push(Math.max(0, Math.min(h - sy, i * stepY + (i % 2 ? offY : 0))));
      for (const y0 of ys) {
        for (const x0 of xs) {
          if (!needMore()) break;
          const t = clampTile({ x0, y0, x1: x0 + sx, y1: y0 + sy }, w, h);
          const win = extractTile(imgData.data, w, h, t);
          const hits = huntRegion(win.data, win.width, win.height, jsQRfn, opts);
          for (const f of hits) {
            if (found.some(x => x.data === f.data)) continue;
            found.push({
              data: f.data,
              location: {
                topLeftCorner: { x: f.location.topLeftCorner.x + t.x0, y: f.location.topLeftCorner.y + t.y0 },
                topRightCorner: { x: f.location.topRightCorner.x + t.x0, y: f.location.topRightCorner.y + t.y0 },
                bottomLeftCorner: { x: f.location.bottomLeftCorner.x + t.x0, y: f.location.bottomLeftCorner.y + t.y0 },
                bottomRightCorner: { x: f.location.bottomRightCorner.x + t.x0, y: f.location.bottomRightCorner.y + t.y0 },
              },
            });
            // 新找到的码立刻涂白，后续窗口不再受它干扰
            maskWhite(imgData.data, w, h, grow(bboxOf(f.location, 10), 6));
          }
        }
      }
    }
    return found;
  }

  return { findMulti };
});
