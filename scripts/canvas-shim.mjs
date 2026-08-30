// 供 Node 测试脚本使用的最小光栅画布（基于纯 JS 的 pngjs，无原生依赖）
import { PNG } from 'pngjs';

export function createCanvas(width, height) {
  const buf = Buffer.alloc(width * height * 4);
  const data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length);

  return {
    width, height, data,

    fill(r, g, b) {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    },

    set(x, y, r, g, b) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    },

    imageData() {
      return { data, width, height };
    },

    png() {
      const png = new PNG({ width, height });
      png.data = Buffer.from(data);
      return PNG.sync.write(png);
    },
  };
}
