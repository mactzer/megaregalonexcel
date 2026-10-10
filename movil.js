(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let api, controller, scanControls, cameraGeneration = 0, busy = false;
  let history = [], catalogReady = false, signingIn = false, accountGeneration = null, resumeCatalog = false;
  const status = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'error' : ''; };
  const element = (tag, text, className) => { const e = document.createElement(tag); e.textContent = text; if (className) e.className = className; return e; };
  const time = date => new Intl.DateTimeFormat('es-PA', { timeZone: 'America/Panama', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
  function renderHistory() {
    $('history').replaceChildren();
    if (!history.length) $('history').append(element('li', 'Aún no has consultado productos.'));
    for (const entry of history) {
      const li = document.createElement('li');
      const info = element('span', entry.code);
      info.append(element('small', time(entry.date)));
      li.append(info, element('span', entry.label)); $('history').append(li);
    }
  }
  function stopCamera() {
    cameraGeneration++;
    if (scanControls) { scanControls.stop(); scanControls = null; }
    const stream = $('video').srcObject;
    if (stream) stream.getTracks().forEach(track => track.stop());
    $('video').srcObject = null;
    $('camera').hidden = $('camera-controls').hidden = true;
    $('scan').disabled = busy || !catalogReady || !api || !api.status().authenticated;
    $('torch').hidden = true;
    $('zoom-control').hidden = true;
  }
  function clear() {
    if (controller) controller.abort();
    accountGeneration = null; resumeCatalog = false;
    catalogReady = false; stopCamera(); history = []; renderHistory();
    $('result').replaceChildren(); $('result').hidden = true;
    $('barcode').value = $('password').value = '';
    $('workspace').hidden = true; $('login-panel').hidden = false;
    $('cancel').hidden = true;
    status('Inicia sesión para consultar tus documentos.');
  }
  window.addEventListener('mobile:stop-camera', stopCamera);
  function adoptAccount() {
    if (!api || !api.status().authenticated) return;
    const account = api.status();
    if (accountGeneration !== account.generation) { history = []; renderHistory(); catalogReady = false; accountGeneration = account.generation; }
    $('identity').textContent = '@' + account.user.username;
    $('login-panel').hidden = true; $('workspace').hidden = false;
    if (!signingIn && !busy && !catalogReady && MobileSession.currentSection === 'scanner') prepareCatalog();
    MobileScanner.prepare().catch(() => {});
  }
  MobileSession.ready.then(async owner => {
    try {
      api = owner.AuditCloud;
      await api.ready();
      owner.addEventListener('traza:session-cleared', clear); owner.addEventListener('audit:authenticated', adoptAccount);
      $('login-button').disabled = false;
      if (api.status().authenticated) adoptAccount(); else status('Acceso seguro listo. Inicia sesión.');
    } catch (e) { status(e.message, true); }
  }).catch(e => status(e.message, true));
  window.addEventListener('mobile-session:navigated', event => {
    if (event.detail.section !== 'scanner') { stopCamera(); if (controller) controller.abort(); }
    else { if (busy && !catalogReady) resumeCatalog = true; adoptAccount(); }
  });
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-button').disabled = true; signingIn = true;
    status('Verificando tu cuenta y desbloqueando el historial…');
    try {
      await api.mobile.login($('username').value, $('password').value);
      $('password').value = '';
      if (!api.status().authenticated) throw new Error('No se pudo verificar el acceso.');
      adoptAccount();
      await prepareCatalog();
    } catch (e) { $('password').value = ''; status(e.message, true); }
    finally { signingIn = false; $('login-button').disabled = false; }
  });
  $('logout').addEventListener('click', () => { clear(); api.mobile.logout(); });
  $('clear-history').addEventListener('click', () => { history = []; renderHistory(); });
  $('photo-button').addEventListener('click', () => { if (!busy && catalogReady && !MobilePriceEditor.busy) $('photo-input').click(); });
  $('photo-input').addEventListener('change', async () => {
    const file = $('photo-input').files[0]; $('photo-input').value = '';
    if (!file || busy || !catalogReady || MobilePriceEditor.busy || !api.status().authenticated) return;
    stopCamera(); busy = true;
    const current = new AbortController(), epoch = api.status().generation; controller = current;
    $('search').disabled = $('scan').disabled = $('photo-button').disabled = $('refresh-catalog').disabled = true; $('cancel').hidden = false;
    $('result').replaceChildren(); $('result').hidden = true; status('Leyendo las barras de la foto…');
    let found;
    try {
      found = await MobileScanner.photo(file, current.signal);
      if (current.signal.aborted || !api.status().authenticated || api.status().generation !== epoch) { found = null; return; }
      if (found.length > 1) {
        const result = $('result'); result.hidden = false; result.append(element('h2', 'Selecciona el código que quieres consultar'), element('p', 'La foto contiene varios códigos de barras distintos.'));
        for (const item of found) { const button = element('button', item.text, 'photo-choice'); button.addEventListener('click', () => { if (api.status().authenticated && api.status().generation === epoch) lookup(item.text); }); result.append(button); }
        status('Se reconocieron ' + found.length + ' códigos. Selecciona uno.');
      }
    } catch (e) { if (api.status().authenticated && api.status().generation === epoch) status(current.signal.aborted ? 'Lectura de foto cancelada.' : e.message, true); }
    finally {
      busy = false; $('search').disabled = $('scan').disabled = $('photo-button').disabled = !catalogReady || !api.status().authenticated; $('refresh-catalog').disabled = false; $('cancel').hidden = true;
      if (controller === current) controller = null;
    }
    if (found && found.length === 1) lookup(found[0].text);
  });
  function showProduct(product, doc, failed, price) {
    const result = $('result'); result.className = 'card'; result.replaceChildren(); result.hidden = false;
    result.append(element('p', 'PRODUCTO ENCONTRADO EN EL ARCHIVO', 'result-label'), element('h2', product.descripcion || 'Sin descripción en el PDF', 'product-name'));
    result.append(element('div', Number.isFinite(product.pventa) ? new Intl.NumberFormat('es-PA', { style: 'currency', currency: 'USD' }).format(product.pventa) : 'Precio no disponible', 'price'));
    result.append(element('p', 'Precio de venta registrado en el PDF; no confirma el precio vigente.', 'note price-source'));
    const dl = document.createElement('dl');
    for (const [name, value] of [['Código de barras', product.codigo], ['Empaque', product.empaque], ['Referencia', product.ref], ['Salida de origen', doc.salida], ['Registrado', time(doc.date)]]) {
      dl.append(element('dt', name), element('dd', value || 'No disponible en el documento'));
    }
    result.append(dl);
    if (failed) result.append(element('p', 'Hay ' + failed + ' documentos sin verificar en el índice. Este resultado podría tener una versión posterior. Pulsa Actualizar para reintentar.', 'note missing'));
    window.dispatchEvent(new CustomEvent('mobile:product', { detail: { product, price } }));
  }
  async function prepareCatalog() {
    if (busy || (window.MobilePriceEditor && MobilePriceEditor.busy) || !api || !api.status().authenticated) return;
    stopCamera(); busy = true; catalogReady = false;
    const current = new AbortController(); controller = current;
    $('scan').disabled = $('search').disabled = $('photo-button').disabled = $('refresh-catalog').disabled = true;
    $('cancel').hidden = false; $('result').replaceChildren(); $('result').hidden = true;
    $('catalog-status').textContent = 'Comprobando documentos y recuperando el índice cifrado…';
    status('La primera preparación procesa los PDF una vez. Las siguientes consultas utilizan el índice.');
    try {
      const info = await api.mobile.prepare(progress => {
        $('catalog-status').textContent = progress.done + ' de ' + progress.total + ' documentos preparados · ' + progress.cached + ' recuperados del índice.';
      }, current.signal);
      if (current.signal.aborted || !api.status().authenticated) return;
      catalogReady = true;
      $('catalog-status').textContent = info.products + ' productos · ' + info.documents + ' documentos · ' + info.cached + ' recuperados del índice.' + (info.failed ? ' ' + info.failed + ' documentos sin verificar; pulsa Actualizar para reintentar.' : ' Índice listo.');
      status('Listo para escanear. La búsqueda ya no abre los PDF.', Boolean(info.failed));
    } catch (e) {
      if (api.status().authenticated) {
        $('catalog-status').textContent = 'Índice pendiente. Pulsa Actualizar para prepararlo.';
        status(current.signal.aborted ? 'Preparación cancelada.' : e.message, true);
      }
    } finally {
      busy = false; $('search').disabled = $('scan').disabled = $('photo-button').disabled = !catalogReady;
      $('refresh-catalog').disabled = false; $('cancel').hidden = true;
      if (controller === current) controller = null;
      if (resumeCatalog) { resumeCatalog = false; adoptAccount(); }
    }
  }
  $('refresh-catalog').addEventListener('click', prepareCatalog);
  let checkingUpdates = false;
  setInterval(async () => {
    if (!api || !api.status().authenticated || !catalogReady || busy || (window.MobilePriceEditor && MobilePriceEditor.busy) || checkingUpdates || document.hidden || MobileSession.currentSection !== 'scanner') return;
    checkingUpdates = true;
    const epoch = api.status().generation;
    try {
      const changed = await api.mobile.hasUpdates();
      if (changed && api.status().authenticated && api.status().generation === epoch && !busy) await prepareCatalog();
    } catch (_) {
      if (api.status().authenticated) $('catalog-status').textContent = 'No se pudieron comprobar documentos nuevos. El índice conserva la última actualización; pulsa Actualizar para reintentar.';
    } finally { checkingUpdates = false; }
  }, 30000);
  async function lookup(raw) {
    const code = String(raw).trim();
    if (!code || code.length > 80 || /[\x00-\x1f]/.test(code)) { status('Escribe un código válido.', true); return; }
    if (busy || !catalogReady || (window.MobilePriceEditor && MobilePriceEditor.busy)) return;
    if (!api || !api.status().authenticated) { status('Inicia sesión para consultar productos.', true); return; }
    stopCamera(); busy = true;
    controller = new AbortController();
    const current = controller, epoch = api.status().generation;
    const assertCurrent = () => { if (current.signal.aborted || !api.status().authenticated || api.status().generation !== epoch) throw new Error('Consulta cancelada.'); };
    $('barcode').value = code; $('search').disabled = $('scan').disabled = $('photo-button').disabled = true;
    $('result').hidden = true; $('result').replaceChildren();
    $('cancel').hidden = false;
    $('refresh-catalog').disabled = true;
    status('Consultando el índice…');
    let timer;
    try {
      const response = await Promise.race([
        api.mobile.lookup(code, current.signal),
        new Promise((resolve, reject) => { timer = setTimeout(() => {
          current.abort(); reject(new Error('La conexión no respondió en cinco segundos. Reintenta la consulta; no se ha confirmado el producto.'));
        }, 5000); })
      ]);
      const { documents: count, failed, match, price } = response;
      assertCurrent();
      let label;
      if (match) {
        showProduct(match.product, match.doc, failed, price); label = 'Encontrado';
        status('Producto encontrado en el índice de ' + count + ' documentos.');
      } else {
        const result = $('result'); result.hidden = false; result.className = 'card warning';
        label = failed ? 'Consulta incompleta' : 'Sin coincidencia';
        result.append(element('p', failed ? 'CONSULTA INCOMPLETA' : 'SIN COINCIDENCIA EN LOS PDF', 'result-label missing'), element('h2', code, 'product-name'));
        result.append(element('p', failed ? 'No se pudieron leer ' + failed + ' de ' + count + ' documentos al preparar el índice. No podemos confirmar si este producto está en el archivo. Pulsa Actualizar para reintentar.' : 'Este código no aparece en los ' + count + ' PDF revisados. Esto no confirma que falte en el inventario de la empresa.'));
        status(failed ? 'La consulta terminó con documentos sin verificar.' : 'Consulta del archivo completada.', Boolean(failed));
      }
      history.unshift({ code, label, date: new Date().toISOString() }); history = history.slice(0, 20); renderHistory();
      $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { if (api.status().authenticated && (timer || !current.signal.aborted)) status(e.message, true); }
    finally { clearTimeout(timer); busy = false; $('search').disabled = $('scan').disabled = $('photo-button').disabled = !catalogReady || !api.status().authenticated; $('refresh-catalog').disabled = false; $('cancel').hidden = true; if (controller === current) controller = null; }
  }
  $('lookup-form').addEventListener('submit', event => { event.preventDefault(); lookup($('barcode').value); });
  $('cancel').addEventListener('click', () => { if (controller) controller.abort(); if (window.MobilePriceEditor) MobilePriceEditor.cancel(); status('Consulta cancelada. Puedes intentar otro código.'); });
  $('scan').addEventListener('click', async () => {
    if (busy || !catalogReady || (window.MobilePriceEditor && MobilePriceEditor.busy) || !api || !api.status().authenticated) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status('La cámara requiere HTTPS. Puedes escribir el código manualmente.', true); return; }
    const sequence = ++cameraGeneration;
    $('scan').disabled = true;
    $('camera').hidden = $('camera-controls').hidden = false;
    status('Permite el acceso a la cámara trasera y apunta al código.');
    try {
      const controls = await MobileScanner.start($('video'), text => {
        if (sequence !== cameraGeneration || busy) return;
        if (navigator.vibrate) navigator.vibrate(60);
        lookup(text);
      });
      if (sequence !== cameraGeneration) { controls.stop(); return; }
      scanControls = controls;
      const stream = $('video').srcObject;
      const track = stream && stream.getVideoTracks()[0];
      const capabilities = track && track.getCapabilities ? track.getCapabilities() : {};
      if (capabilities.torch && track.applyConstraints) { $('torch').hidden = false; $('torch').textContent = 'Encender linterna'; }
      if (capabilities.zoom && Number.isFinite(capabilities.zoom.min) && Number.isFinite(capabilities.zoom.max) && capabilities.zoom.max > capabilities.zoom.min) {
        const zoom = $('camera-zoom'); zoom.min = capabilities.zoom.min; zoom.max = Math.min(capabilities.zoom.max, 6);
        zoom.step = capabilities.zoom.step || .1; zoom.value = track.getSettings().zoom || capabilities.zoom.min;
        $('zoom-control').hidden = false;
      }
    } catch (e) {
      if (sequence !== cameraGeneration) return;
      stopCamera(); status(e.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Actívalo en el navegador o escribe el código.' : 'No se pudo iniciar la cámara. Cierra otras aplicaciones que la usen o escribe el código.', true);
    }
  });
  $('stop').addEventListener('click', stopCamera);
  $('camera-zoom').addEventListener('input', async () => {
    const stream = $('video').srcObject, track = stream && stream.getVideoTracks()[0];
    if (!track) return;
    try { await track.applyConstraints({ advanced: [{ zoom: Number($('camera-zoom').value) }] }); }
    catch (_) { status('Este dispositivo no permite ajustar el zoom. Acerca la etiqueta manteniendo el enfoque.', true); }
  });
  $('torch').addEventListener('click', async () => {
    const stream = $('video').srcObject, track = stream && stream.getVideoTracks()[0];
    if (!track) return;
    try { const next = !track.getSettings().torch; await track.applyConstraints({ advanced: [{ torch: next }] }); $('torch').textContent = next ? 'Apagar linterna' : 'Encender linterna'; }
    catch (_) { status('Este dispositivo no permite controlar la linterna.', true); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
  window.addEventListener('pagehide', () => { clear(); if (api) api.mobile.logout(); });
})();
