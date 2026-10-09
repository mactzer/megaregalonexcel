(function () {
  'use strict';
  // Numeric enum values from the bundled @zxing/library 0.21.3.
  const FORMATS = [4, 7, 6, 14, 15, 2, 8]; // Code 128, EAN, UPC, Code 39, ITF.
  const HINTS = new Map([[2, FORMATS], [3, true]]); // POSSIBLE_FORMATS, TRY_HARDER.
  function makeReader() { return new ZXingBrowser.BrowserMultiFormatReader(HINTS); }
  function frame(source, angle, crop) {
    const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
    const sw = crop ? width * .8 : width, sh = crop ? height * .55 : height;
    const scale = Math.min(2, 1280 / Math.max(sw, sh));
    const radians = angle * Math.PI / 180;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(scale * (Math.abs(sw * Math.cos(radians)) + Math.abs(sh * Math.sin(radians))));
    canvas.height = Math.ceil(scale * (Math.abs(sw * Math.sin(radians)) + Math.abs(sh * Math.cos(radians))));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width / 2, canvas.height / 2); context.rotate(radians);
    context.drawImage(source, (width - sw) / 2, (height - sh) / 2, sw, sh, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
    return canvas;
  }
  function decode(source, reader = makeReader(), attempt = 0) {
    const options = [[0, false], [0, true], [-12, false], [12, false], [-25, true], [25, true], [90, false]];
    const [angle, crop] = options[attempt % options.length];
    const canvas = frame(source, angle, crop);
    try { return reader.decodeFromCanvas(canvas).getText(); }
    finally { canvas.width = canvas.height = 0; }
  }
  async function start(video, onResult) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    let stopped = false, timer, attempt = 0;
    function stop() { stopped = true; clearTimeout(timer); stream.getTracks().forEach(track => track.stop()); if (video.srcObject === stream) video.srcObject = null; }
    try {
      video.srcObject = stream; await video.play();
      const track = stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (_) {}
      }
      const reader = makeReader();
      let detector;
      if (window.BarcodeDetector) {
        try {
          const supported = await BarcodeDetector.getSupportedFormats();
          const formats = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'itf'].filter(format => supported.includes(format));
          if (formats.length) detector = new BarcodeDetector({ formats });
        } catch (_) {}
      }
      async function scan() {
        if (stopped) return;
        try {
          if (video.videoWidth && video.videoHeight) {
            let value;
            if (detector) {
              try { const found = await detector.detect(video); if (found.length) value = found[0].rawValue; } catch (_) {}
            }
            if (!value && !stopped) value = decode(video, reader, attempt++);
            if (value && !stopped) { stop(); onResult(value); return; }
          }
        } catch (_) { /* No complete barcode in this frame: try another angle. */ }
        if (!stopped) timer = setTimeout(scan, 120);
      }
      timer = setTimeout(scan, 0);
      return { stop };
    } catch (error) { stop(); throw error; }
  }
  window.MobileScanner = Object.freeze({ start, decode });
})();
