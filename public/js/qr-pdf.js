// 学生二维码贴纸 PDF 生成（纯前端）
// - 二维码：qrcode-generator 点阵 → jsPDF 矢量矩形（打印无损，任意大小都清晰）
// - 中文文字：jsPDF 内置字体不支持中文，用系统字体在 canvas 高分辨率渲染后作为图片嵌入（≈300dpi）
(function () {
  'use strict';

  const CODE_PX_PER_MM = 12; // 文字图清晰度

  function payload(cls, stu) {
    return `HW|${cls.id}|${stu.stuNo}|${stu.name}`;
  }

  function makeMatrix(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const m = [];
    for (let y = 0; y < n; y++) {
      const row = [];
      for (let x = 0; x < n; x++) row.push(qr.isDark(y, x));
      m.push(row);
    }
    return m;
  }

  // 按班级里最密的码决定统一尺寸：长学号/长姓名会升到 v3/v4（29/34 模块），
  // 同样的毫米尺寸下格子更小更难扫，所以密度高的班自动放大
  function classCodeSize(cls, students) {
    let maxModules = 25;
    for (const stu of students) {
      const qr = qrcode(0, 'M');
      qr.addData(payload(cls, stu));
      qr.make();
      maxModules = Math.max(maxModules, qr.getModuleCount());
    }
    // 常规 25 模块 → 20mm（每格 0.8mm）；密码头班升到 24mm
    return { size: maxModules > 25 ? 24 : 20, maxModules };
  }

  // 在 (x, y) 处绘制 sizeMm 大小的二维码（黑色矢量方块）
  function drawQr(doc, text, x, y, sizeMm) {
    const m = makeMatrix(text);
    const n = m.length;
    const cell = sizeMm / n;
    doc.setFillColor(0, 0, 0);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (m[r][c]) doc.rect(x + c * cell, y + r * cell, cell + 0.05, cell + 0.05, 'F');
      }
    }
  }

  const labelCache = new Map();
  // 居中文字图片：(x,y) 为文字块左上角，wMm×hMm
  function drawLabel(doc, text, x, y, wMm, hMm, { bold = false, gray = false } = {}) {
    const key = [text, bold, gray].join('|');
    let url = labelCache.get(key);
    if (!url) {
      const scale = CODE_PX_PER_MM;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(wMm * scale);
      canvas.height = Math.ceil(hMm * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // 字号自适应：宽度充满 92%
      let fontPx = canvas.height * 0.9;
      const font = `${bold ? '700 ' : ''}${fontPx}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.font = font;
      const measured = ctx.measureText(text).width;
      if (measured > canvas.width * 0.92) {
        fontPx = fontPx * (canvas.width * 0.92) / measured;
        ctx.font = `${bold ? '700 ' : ''}${fontPx}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      }
      ctx.fillStyle = gray ? '#555555' : '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
      url = canvas.toDataURL('image/png');
      labelCache.set(key, url);
    }
    doc.addImage(url, 'PNG', x, y, wMm, hMm);
  }

  /**
   * 生成贴纸 PDF
   * @param {object} p { cls, students, layout: 'large'|'row6'|'page36' }
   * @returns jsPDF document
   */
  function generateStickers(p) {
    const { cls, students, layout } = p;
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
    const PW = 210, PH = 297, M = 10; // 页宽高与页边距

    const pageBreak = (y, need) => {
      if (y + need > PH - M) { doc.addPage(); return M; }
      return y;
    };

    let y = M;

    if (layout === 'large') {
      // 1份/人：4列×7行，每页 28 人；码 20mm（密码头班 24mm），格内余量足够静区
      const cols = 4, cw = (PW - 2 * M) / 4, ch = (PH - 2 * M) / 7;
      const { size: q, maxModules } = classCodeSize(cls, students);
      const dense = maxModules > 25;      // 长学号等密码头：省略副行文字
      let col = 0;
      for (const stu of students) {
        y = col === 0 ? pageBreak(y, ch) : y;
        const x = M + col * cw;
        // 浅灰描边当裁切参考线（在静区之外）
        doc.setDrawColor(215);
        doc.setLineWidth(0.2);
        doc.rect(x, y, cw, ch);
        const text = payload(cls, stu);
        drawQr(doc, text, x + (cw - q) / 2, y + 2, q);
        drawLabel(doc, stu.name, x + 12, y + q + 4, cw - 24, 7, { bold: true });
        if (!dense) drawLabel(doc, `${cls.name} · ${stu.stuNo}`, x + 10, y + q + 12, cw - 20, 4.5, { gray: true });
        col++;
        if (col >= cols) { col = 0; y += ch; }
      }
      if (maxModules > 25) {
        // 密度提示：本班码含长学号，已自动放大
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(`注：本班学号较长，二维码已自动放大（密度 ${maxModules} 模块）`, PW / 2, PH - 4, { align: 'center' });
      }
    } else if (layout === 'row6') {
      // 1行/人（6个）：18mm 码 + 4mm 间隙（≥4 模块静区），行高 30mm，每页 9 行
      const per = 6, q = 18, gap = 4, rh = 30;
      for (const stu of students) {
        y = pageBreak(y, rh);
        const text = payload(cls, stu);
        const total = per * q + (per - 1) * gap;
        const x0 = (PW - total) / 2;
        for (let i = 0; i < per; i++) {
          const x = x0 + i * (q + gap);
          drawQr(doc, text, x, y, q);
          drawLabel(doc, stu.name, x - 1, y + q + 1.5, q + 2, 6.5, { bold: true });
        }
        y += rh;
      }
    } else {
      // 1页/人（96个）：8列×12行，18mm 码 + 3mm 间隙
      const per = 8, rows = 12, q = 18, gap = 3;
      for (const stu of students) {
        y = pageBreak(y, 14 + rows * (q + gap));
        drawLabel(doc, `${cls.name} ${stu.name}（学号 ${stu.stuNo}）`, M, y, PW - 2 * M, 6, { gray: true });
        y += 8;
        const total = per * q + (per - 1) * gap;
        const x0 = (PW - total) / 2;
        const text = payload(cls, stu);
        for (let r = 0; r < rows; r++) {
          if (y + q > PH - M) break;
          for (let c = 0; c < per; c++) drawQr(doc, text, x0 + c * (q + gap), y, q);
          y += q + gap;
        }
        y += 4;
      }
    }
    return doc;
  }

  window.QrPdf = { payload, generateStickers };
})();
