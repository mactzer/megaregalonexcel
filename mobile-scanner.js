(function () {
  'use strict';
  // Numeric enum values from the bundled @zxing/library 0.21.3.
  const FORMATS = [4, 7, 6, 14, 15, 2, 8]; // Code 128, EAN, UPC, Code 39, ITF.
  const HINTS = new Map([[2, FORMATS], [3, true]]); // POSSIBLE_FORMATS, TRY_HARDER.
  function makeReader() { return new ZXingBrowser.BrowserMultiFormatReader(HINTS); }
  const cppOptions = { formats: ['Code128', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code39', 'Code93', 'ITF', 'Codabar'], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: false, minLineCount: 2, maxNumberOfSymbols: 16, returnErrors: false };
  let moduleReady;
  function prepare() {
    if (!window.ZXingWASM) return Promise.reject(new Error('El lector avanzado no está disponible. Actualiza la página.'));
    if (!moduleReady) moduleReady = ZXingWASM.prepareZXingModule({ overrides: { locateFile: path => new URL('vendor/' + path, document.baseURI).href }, fireImmediately: true });
    return moduleReady;
  }
  function size(source) { return { width: source.videoWidth || source.naturalWidth || source.width, height: source.videoHeight || source.naturalHeight || source.height }; }
  function region(source, rect, angle = 0) {
    const { width, height } = size(source);
    rect = rect || { x: 0, y: 0, width, height };
    const scale = Math.min(2, 1800 / Math.max(rect.width, rect.height)), rad = angle * Math.PI / 180;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(scale * (Math.abs(rect.width * Math.cos(rad)) + Math.abs(rect.height * Math.sin(rad))));
    canvas.height = Math.ceil(scale * (Math.abs(rect.width * Math.sin(rad)) + Math.abs(rect.height * Math.cos(rad))));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(rad);
    ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, -rect.width * scale / 2, -rect.height * scale / 2, rect.width * scale, rect.height * scale);
    return canvas;
  }
  async function read(source, rect, angle = 0) {
    await prepare();
    const canvas = region(source, rect, angle);
    let pixels;
    try {
      pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
      const found = await ZXingWASM.readBarcodes(pixels, cppOptions);
      const centerX = canvas.width / 2, centerY = canvas.height / 2;
      const distance = item => { const p = item.position; return p ? Math.hypot((p.topLeft.x + p.bottomRight.x) / 2 - centerX, (p.topLeft.y + p.bottomRight.y) / 2 - centerY) : 0; };
      return found.filter(item => item.isValid !== false && !item.error && item.text).sort((a, b) => distance(a) - distance(b)).map(item => ({ text: item.text, format: item.format }));
    } finally { if (pixels) pixels.data.fill(0); canvas.width = canvas.height = 0; }
  }
  function aimedRegion(video) {
    const { width, height } = size(video), box = video.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    // The preview uses object-fit:cover. Read the region the operator actually sees.
    const scale = Math.max(box.width / width, box.height / height);
    const sw = Math.min(width, box.width * .94 / scale), sh = Math.min(height, box.height * .75 / scale);
    return { x: (width - sw) / 2, y: (height - sh) / 2, width: sw, height: sh };
  }
  async function photo(file, signal) {
    if (!file || !file.type.startsWith('image/') || file.size > 24 * 1024 * 1024) throw new Error('Selecciona una foto JPG, PNG o WebP de hasta 24 MB.');
    const guard = () => { if (signal && signal.aborted) throw new DOMException('Lectura cancelada', 'AbortError'); };
    guard();
    // Cancelling a photo must not wait for a slow, shared WASM download.
    let onAbort;
    try {
      await Promise.race([prepare(), new Promise((resolve, reject) => {
        onAbort = () => reject(new DOMException('Lectura cancelada', 'AbortError'));
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      })]);
    } finally { if (signal && onAbort) signal.removeEventListener('abort', onAbort); }
    guard();
    let image, url;
    try {
      if (window.createImageBitmap) image = await createImageBitmap(file);
      else { url = URL.createObjectURL(file); image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('No se pudo abrir la foto. Usa JPG o PNG.')); img.src = url; }); }
      guard();
      const { width, height } = size(image), started = performance.now();
      const rectangles = [null];
      // Overlapping tiles preserve small bars instead of shrinking the whole sheet.
      const sw = width * .62, sh = height * .30;
      for (const y of [.35, 0, .70, .175, .525]) for (const x of [0, .38]) rectangles.push({ x: width * x, y: height * y, width: sw, height: sh });
      for (const rect of rectangles) for (const angle of [0, -8, 8, -18, 18]) {
        guard(); if (performance.now() - started > 5000) throw new Error('La foto no contiene un código legible. Acerca una sola etiqueta, evita reflejos y toma otra foto.');
        const found = await read(image, rect, angle); guard();
        if (found.length) return [...new Map(found.map(item => [item.text, item])).values()];
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      throw new Error('No se encontró un código completo en la foto. Acerca una etiqueta y vuelve a intentarlo.');
    } finally { if (image && image.close) image.close(); if (url) URL.revokeObjectURL(url); }
  }
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
              const aimed = region(video, aimedRegion(video));
              try { const found = await detector.detect(aimed); if (found.length) value = found[0].rawValue; } catch (_) {}
              finally { aimed.width = aimed.height = 0; }
            }
            if (!value && !stopped && window.ZXingWASM) {
              try { const found = await read(video, aimedRegion(video), [0, -8, 8, -18, 18][attempt % 5]); if (found.length) value = found[0].text; } catch (_) {}
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
  window.MobileScanner = Object.freeze({ start, decode, read, photo, prepare });
})();
