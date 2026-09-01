// 摄像头连续扫描引擎：优先浏览器原生 BarcodeDetector（一帧多码），
// 否则 jsQR + 遮挡重扫 + 分块重试（public/js/qr-hunt.js）。
(function () {
  'use strict';

  class ScanEngine {
    /**
     * @param {HTMLVideoElement} video
     * @param {object} handlers { onCodes([{data, corners:[{x,y}x4]}], map), onError(err) }
     *        corners 坐标已换算为视频显示坐标（0~1 相对比例 × 显示区域），onCodes 里给出 map 帮助函数
     */
    constructor(video, handlers) {
      this.video = video;
      this.handlers = handlers;
      this.running = false;
      this.stream = null;
      this.workCanvas = document.createElement('canvas');
      this.workCtx = this.workCanvas.getContext('2d', { willReadFrequently: true });
      // ZXing 用全分辨率帧，单独一块画布
      this.zxCanvas = document.createElement('canvas');
      this.zxCtx = this.zxCanvas.getContext('2d', { willReadFrequently: true });
      // 运动检测画布（极小尺寸，算帧间差异用）
      this.motionCanvas = document.createElement('canvas');
      this.motionCanvas.width = 48;
      this.motionCanvas.height = 36;
      this.motionCtx = this.motionCanvas.getContext('2d', { willReadFrequently: true });
      this.prevLuma = null;
      this.detector = null;
      this.facing = 'environment';
      this.deviceIds = [];
      this.deviceIdx = 0;
      this.torchOn = false;
    }

    get useNative() { return !!this.detector; }

    async start() {
      await this.pickCameras();
      await this.openStream();
      this.running = true;
      if ('BarcodeDetector' in window) {
        try {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (formats.includes('qr_code')) this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch { this.detector = null; }
      }
      this.tick();
    }

    async pickCameras() {
      try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
        this.deviceIds = devices.map(d => d.deviceId);
      } catch { this.deviceIds = []; }
    }

    async openStream() {
      this.stopStream();
      // 分级协商分辨率：部分厂商浏览器会无视 ideal 给出 640×480 低清流，
      // 低清下整页多码的码密度不足是漏检主因，所以从高到低逐档尝试
      const attempts = [
        // 实测：1600×1200 是速度/画质平衡点。更高的流（如 1440×1920）传感器读出慢、
        // 运动模糊更重、单帧处理翻倍，扫动时识别率反而大幅下降（真机实测）
        { width: { ideal: 1600 }, height: { ideal: 1200 } },
        { width: { ideal: 1280 }, height: { ideal: 960 } },
        true,
      ];
      let lastErr = null;
      for (const video of attempts) {
        const base = typeof video === 'boolean' && video === true
          ? { facingMode: { ideal: this.facing } }
          : { ...video, facingMode: { ideal: this.facing }, frameRate: { ideal: 30 } };
        if (this.deviceIds.length && this.facing === 'device') base.deviceId = { exact: this.deviceIds[this.deviceIdx] };
        // 厂商浏览器反复开关相机后 getUserMedia 可能永久挂起：8 秒超时，若事后返回则丢弃
        const gum = navigator.mediaDevices.getUserMedia({ audio: false, video: base }).then(s => {
          if (this._gumTimedOut) s.getTracks().forEach(t => t.stop());
          return s;
        });
        this._gumTimedOut = false;
        const t0 = new Promise((_, rej) => setTimeout(() => { this._gumTimedOut = true; rej(new Error('TimeoutError')); }, 8000));
        try {
          this.stream = await Promise.race([gum, t0]);
          break;
        } catch (e) {
          lastErr = e;
          this.stream = null;
        }
      }
      if (!this.stream) throw lastErr || new Error('NotSupportedError');
      this.video.srcObject = this.stream;
      this.video.setAttribute('playsinline', 'true');
      // play() 个别机型在无帧时会长期挂起：不阻塞后续流程，帧到了识别循环自然开始工作
      await Promise.race([
        this.video.play().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
      this.torchOn = false;
      await this.initZoom();
      await this.initPhotoGrabber();
    }

    // 变焦：对顽固码放大后模块尺寸翻倍，识别率大增（依赖镜头 zoom 能力）
    async initZoom() {
      this.zoomCaps = null;
      this.zoom = 1;
      const track = this.stream && this.stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? track.getCapabilities() : {};
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        this.zoomCaps = { min: caps.zoom.min, max: Math.min(caps.zoom.max, 5), step: caps.zoom.step || 0.1 };
      }
    }

    async setZoom(z) {
      if (!this.zoomCaps) return false;
      const track = this.stream && this.stream.getVideoTracks()[0];
      if (!track) return false;
      const target = Math.max(this.zoomCaps.min, Math.min(this.zoomCaps.max, z));
      try {
        await track.applyConstraints({ advanced: [{ zoom: target }] });
        this.zoom = target;
        return true;
      } catch { return false; }
    }

    // 高清拍照识别：预览流有运动模糊/噪声时，相机拍照模式的多帧合成帧
    // 画质远超预览帧。返回识别到的 [{data, rel}]（可能为空）
    async initPhotoGrabber() {
      this.imageGrabber = null;
      this.lastPhotoAt = 0;
      if (!('ImageCapture' in window)) return;
      try {
        const track = this.stream.getVideoTracks()[0];
        this.imageGrabber = new ImageCapture(track);
      } catch { this.imageGrabber = null; }
    }

    async tryPhoto() {
      if (!this.imageGrabber || !this.imageGrabber.takePhoto) return [];
      const now = performance.now();
      if (now - this.lastPhotoAt < 1800) return [];
      this.lastPhotoAt = now;
      let blob;
      try {
        const photo = await this.imageGrabber.takePhoto({ fillLightMode: 'off' });
        blob = photo.blob;
      } catch { return []; }
      try {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const zw = Math.round(img.width * scale), zh = Math.round(img.height * scale);
        this.zxCanvas.width = zw; this.zxCanvas.height = zh;
        this.zxCtx.drawImage(img, 0, 0, zw, zh);
        URL.revokeObjectURL(url);
        const frame = this.zxCtx.getImageData(0, 0, zw, zh);
        const results = await window.ZXingReader.readBarcodes(
          { data: frame.data, width: zw, height: zh },
          { maxNumberOfSymbols: 30, tryDenoise: true },
        );
        return results.map(r => {
          const p = r.position;
          return {
            data: r.text,
            rel: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft]
              .map(pt => ({ x: pt.x / zw, y: pt.y / zh })),
          };
        });
      } catch { return []; }
    }

    stopStream() {
      if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
      }
    }

    async stop() {
      this.running = false;
      this.stopStream();
    }

    pause() { this.paused = true; }
    resume() { this.paused = false; }

    async switchCamera() {
      if (this.deviceIds.length > 1) {
        this.deviceIdx = (this.deviceIdx + 1) % this.deviceIds.length;
        this.facing = 'device';
      } else {
        this.facing = this.facing === 'environment' ? 'user' : 'environment';
      }
      await this.openStream();
    }

    async toggleTorch() {
      const track = this.stream && this.stream.getVideoTracks()[0];
      if (!track) return false;
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (!caps.torch) return false;
      this.torchOn = !this.torchOn;
      await track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      return this.torchOn;
    }

    hasTorch() {
      const track = this.stream && this.stream.getVideoTracks()[0];
      if (!track || !track.getCapabilities) return false;
      return !!track.getCapabilities().torch;
    }

    async tick() {
      if (!this.running) return;
      if (this.paused) { setTimeout(() => this.tick(), 150); return; }
      const t0 = performance.now();
      let deep = false;
      try {
        const expect = this.handlers.getExpect ? Math.max(0, this.handlers.getExpect() | 0) : 0;
        if (expect === 0) {
          // 全班收齐：进入低耗巡检（保留画面，偶尔探测补交通知）
          this.idleCount = (this.idleCount || 0) + 1;
          if (this.idleCount % 5 === 0) await this.detectOnce(false);
          setTimeout(() => this.tick(), 400);
          return;
        }
        // 扫动全程周期性夹带一张相机高清照片参与识别：
        // 预览流和拍照流两路取并集，单帧漏检几乎必然被照片帧补上
        this.photoTick = (this.photoTick || 0) + 1;
        if (this.photoTick % 10 === 0 && this.imageGrabber) {
          try {
            const pc = await this.tryPhoto();
            if (pc.length) this.handlers.onCodes(pc);
          } catch { /* 拍照失败不影响主循环 */ }
        }
        const motion = this.computeMotion();
        // 镜头在动（正在扫过去）→ 只跑快路径，保证「一扫而过」；
        // 镜头静止（对着难啃的码瞄准）→ 才逐级加深多遍识别
        // 阈值 10：真实摄像头静止时的传感器噪声 <10，扫动时通常 >30
        deep = motion < 10;
        await this.detectOnce(deep);
      } catch (e) {
        console.error('detect error', e);
      }
      // 快路径节奏紧（跟手），深路径间隔放宽（反正镜头是停着的）
      const budget = deep ? 200 : 50;
      const cost = performance.now() - t0;
      setTimeout(() => this.tick(), Math.max(0, budget - cost));
    }

    // 帧间运动强度：48×36 缩略图的亮度平均差（0~255），扫动时通常 >20，静止时接近 0
    computeMotion() {
      const mc = this.motionCanvas;
      this.motionCtx.drawImage(this.video, 0, 0, mc.width, mc.height);
      const d = this.motionCtx.getImageData(0, 0, mc.width, mc.height).data;
      const luma = new Float32Array(mc.width * mc.height);
      for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
        luma[i] = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
      }
      let score = 255;
      if (this.prevLuma && this.prevLuma.length === luma.length) {
        let sum = 0;
        for (let i = 0; i < luma.length; i++) sum += Math.abs(luma[i] - this.prevLuma[i]);
        score = sum / luma.length;
      }
      this.prevLuma = luma;
      return score;
    }

    async detectOnce(deep = false) {
      const video = this.video;
      if (!video.videoWidth) return;

      // 路线一（主引擎）：ZXing-C++ WASM。质量完全可控、多码基准 10/10，
      // 各厂商浏览器的原生 BarcodeDetector 质量参差（尤其国产 ROM 无谷歌服务时），
      // 故只在 ZXing 未就绪时临时用原生检测顶替。
      if (window.ZXingReader) {
        try {
          // 快路径（扫动）：压到 1100px + 关去噪，单帧处理提速近一半，
          // 用更高帧率换取「一扫而过」；近拍场景码占画面大，密度依然充足。
          // 深路径（静止）：1600px 全力识别 + 完整六遍
          const cap = deep ? 1600 : 1100;
          const maxDim = Math.max(video.videoWidth, video.videoHeight);
          const zxScale = Math.min(1, cap / maxDim);
          const zw = Math.round(video.videoWidth * zxScale);
          const zh = Math.round(video.videoHeight * zxScale);
          if (this.zxCanvas.width !== zw || this.zxCanvas.height !== zh) {
            this.zxCanvas.width = zw;
            this.zxCanvas.height = zh;
          }
          this.zxCtx.drawImage(video, 0, 0, zw, zh);
          const frame = this.zxCtx.getImageData(0, 0, zw, zh);
          const w = frame.width, h = frame.height;
          const expect = this.handlers.getExpect ? Math.max(0, this.handlers.getExpect() | 0) : 0;
          const t0 = performance.now();

          const codes = [];
          const seenTexts = new Set();
          const merge = (results, ox, oy, divW, divH) => {
            for (const r of results || []) {
              if (seenTexts.has(r.text)) continue;
              seenTexts.add(r.text);
              const p = r.position;
              codes.push({
                data: r.text,
                rel: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft]
                  .map(pt => ({ x: (pt.x + ox) / divW, y: (pt.y + oy) / divH })),
              });
            }
          };

          // 第 1 遍：全帧常规参数（绝大多数帧一步到位）
          merge(await window.ZXingReader.readBarcodes(
            { data: frame.data, width: w, height: h },
            deep ? { maxNumberOfSymbols: 30, tryDenoise: false } : { maxNumberOfSymbols: 30 },
          ), 0, 0, w, h);

          // 第 2 遍：去噪 + 全局直方图二值化（仅深路径：镜头静止时才花这个时间）
          if (deep && codes.length < expect && performance.now() - t0 < 380) {
            merge(await window.ZXingReader.readBarcodes(
              { data: frame.data, width: w, height: h },
              { maxNumberOfSymbols: 30, tryDenoise: true, binarizer: 'GlobalHistogram' },
            ), 0, 0, w, h);
          }

          // 第 3 遍：0.72× 降采样再识别（深路径）。拍屏幕时的摩尔纹依赖采样比例，
          // 换一个比例摩尔纹图样就变了，全帧漏的码常在这一遍出现
          if (deep && codes.length < expect && performance.now() - t0 < 380) {
            const dw = Math.round(w * 0.72), dh = Math.round(h * 0.72);
            this.zxCtx.drawImage(this.zxCanvas, 0, 0, dw, dh);
            const small = this.zxCtx.getImageData(0, 0, dw, dh);
            merge(await window.ZXingReader.readBarcodes(
              { data: small.data, width: dw, height: dh },
              { maxNumberOfSymbols: 30, tryDenoise: true },
            ), 0, 0, dw, dh);
            // 恢复画布上的全分辨率帧，供第 4 遍分块使用
            this.zxCtx.drawImage(video, 0, 0, zw, zh);
          }

          // 第 4 遍：四分块隔离（深路径）——把码分到不同小图里，互扰自然消失
          if (deep && codes.length < expect && performance.now() - t0 < 420) {
            const tw = Math.floor(w / 2) + 12, th = Math.floor(h / 2) + 12;
            for (const [qx, qy] of [[0, 0], [w - tw, 0], [0, h - th], [w - tw, h - th]]) {
              if (codes.length >= expect || performance.now() - t0 > 460) break;
              const x0 = Math.max(0, Math.min(w - tw, qx));
              const y0 = Math.max(0, Math.min(h - th, qy));
              const tile = this.zxCtx.getImageData(x0, y0, tw, th);
              merge(await window.ZXingReader.readBarcodes(
                { data: tile.data, width: tile.width, height: tile.height },
                { maxNumberOfSymbols: 10, tryDenoise: true },
              ), x0, y0, w, h);
            }
          }

          // 第 5 遍：跨引擎补漏（深路径）。jsQR 的定位原理与 ZXing 完全不同，盲区不重叠——
          // ZXing 找不满时换引擎在同一帧再扫（多尺度滑窗 + 逐帧换起点）
          if (deep && codes.length < expect && performance.now() - t0 < 900) {
            this.frameNo = (this.frameNo || 0) + 1;
            try {
              const s2 = Math.min(1, 1366 / w);
              const w2 = Math.round(w * s2), h2 = Math.round(h * s2);
              if (this.workCanvas.width !== w2) { this.workCanvas.width = w2; this.workCanvas.height = h2; }
              this.workCtx.drawImage(video, 0, 0, w2, h2);
              const frame2 = this.workCtx.getImageData(0, 0, w2, h2);
              for (const f of window.QRHunt.findMulti(frame2, { maxCodes: 30, expect, maxMs: 450, shift: this.frameNo % 3 })) {
                if (seenTexts.has(f.data)) continue;
                seenTexts.add(f.data);
                const loc = f.location;
                codes.push({
                  data: f.data,
                  rel: [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner]
                    .map(pt => ({ x: pt.x / w2, y: pt.y / h2 })),
                });
              }
            } catch { /* 兜底失败不影响已有结果 */ }
          }

          // 第 6 遍：高清拍照识别（自带 1.8 秒限流）。拍照画质远超预览流，
          // 是对顽固码的终极手段
          if (deep && codes.length < expect) {
            this._stillMisses = (this._stillMisses || 0) + 1;
            if (this._stillMisses >= 2) {
              for (const c of await this.tryPhoto()) {
                if (seenTexts.has(c.data)) continue;
                seenTexts.add(c.data);
                codes.push(c);
              }
            }
          } else {
            this._stillMisses = 0;
          }

          if (codes.length) {
            this.handlers.onCodes(codes);
            this.engineName = 'ZXing';
            return;
          }
          return; // zxing 认为这帧没有码：不落到 jsQR（避免每帧双倍开销），下一帧再说
        } catch (e) {
          console.error('zxing 识别失败，退回原生检测', e);
        }
      }

      // 路线二（过渡）：浏览器原生 BarcodeDetector，仅在 ZXing 尚未就绪时使用
      if (this.detector) {
        const raw = await this.detector.detect(video);
        const codes = raw.map(r => ({
          data: r.rawValue,
          // 原生返回的是视频像素坐标，换算为 0~1 比例
          rel: r.cornerPoints.map(p => ({ x: p.x / video.videoWidth, y: p.y / video.videoHeight })),
        }));
        this.handlers.onCodes(codes);
        this.engineName = '原生检测';
        return;
      }

      // 路线三（最后兜底，ZXing 与原生都不可用时）：jsQR + 遮挡重扫 + 多尺度滑窗；
      // shift 逐帧轮换，让滑动窗口的起点每帧不同，几帧的并集能覆盖压在窗口缝上的码
      this.frameNo = (this.frameNo || 0) + 1;
      const scale = Math.min(1, 1366 / video.videoWidth);
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      if (this.workCanvas.width !== w) { this.workCanvas.width = w; this.workCanvas.height = h; }
      this.workCtx.drawImage(video, 0, 0, w, h);
      const frame = this.workCtx.getImageData(0, 0, w, h);
      const expect = this.handlers.getExpect ? Math.max(0, this.handlers.getExpect() | 0) : 0;
      const found = window.QRHunt.findMulti(frame, { maxCodes: 30, expect, maxMs: 500, shift: this.frameNo % 3 });
      const codes = found.map(f => ({
        data: f.data,
        rel: [f.location.topLeftCorner, f.location.topRightCorner, f.location.bottomRightCorner, f.location.bottomLeftCorner]
          .map(p => ({ x: p.x / w, y: p.y / h })),
      }));
      this.handlers.onCodes(codes);
    }
  }

  window.ScanEngine = ScanEngine;
})();
