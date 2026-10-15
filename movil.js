(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let api, controller, scanControls, cameraGeneration = 0, busy = false;
  let catalogReady = false, signingIn = false, accountGeneration = null, resumeCatalog = false,lastIndexCheck=null;
  const status = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'error' : ''; };
  const element = (tag, text, className) => { const e = document.createElement(tag); e.textContent = text; if (className) e.className = className; return e; };
  const invoiceDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : 'No disponible en el PDF';
  const money = value => Number.isFinite(value) ? new Intl.NumberFormat('es-PA', { style: 'currency', currency: 'USD' }).format(value) : 'Precio no disponible';
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
    catalogReady = false; stopCamera();
    $('result').replaceChildren(); $('result').hidden = true;
    $('barcode').value = $('password').value = '';
    setLookupMode('barcode'); $('lookup-kind').disabled = true;
    $('workspace').hidden = true; $('login-panel').hidden = false;
    $('cancel').hidden = true;
    status('Inicia sesión para consultar tus documentos.');
  }
  window.addEventListener('mobile:stop-camera', stopCamera);
  function adoptAccount() {
    if (!api || !api.status().authenticated) return;
    const account = api.status();
    if (accountGeneration !== account.generation) { catalogReady = false; accountGeneration = account.generation; }
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
      owner.addEventListener('audit:sync-status',updateHealth);
      owner.addEventListener('audit:changed',event=>{if(['mega_product_prices','all'].includes(event.detail.table))markPriceStale('El equipo tiene cambios. Consulta nuevamente para confirmar el precio.');});
      $('login-button').disabled = false;
      if (api.status().authenticated) adoptAccount(); else status('Acceso seguro listo. Inicia sesión.');
    } catch (e) { status(e.message, true); }
  }).catch(e => status(e.message, true));
  window.addEventListener('mobile-session:navigated', event => {
    if (event.detail.section !== 'scanner') { stopCamera(); if (controller) controller.abort(); }
    else { if (busy && !catalogReady) resumeCatalog = true; adoptAccount(); checkCatalogUpdates(true); }
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
  function markPriceStale(text){const notice=$('result').querySelector('.price-freshness');if(notice){notice.textContent=text;notice.className='note missing price-freshness';for(const control of $('result').querySelectorAll('#edit-price,#save-price,.price-history-entry button'))control.disabled=true;}}
  function updateHealth(){
    if(!api||!api.status().authenticated)return;const state=api.status(),offline=!navigator.onLine;
    $('sync-status').textContent=offline?'Sin conexión. Los datos visibles son una referencia de la última consulta.':state.networkIssue?'No se pudo comprobar la conexión. Pulsa Actualizar para reintentar.':state.syncMode==='live'?'Sincronización en vivo activa.':'Sincronización en vivo desconectada. Se comprueba el archivo periódicamente.';
    $('sync-status').className='note'+(offline||state.networkIssue||state.syncMode!=='live'?' missing':'');
    if(offline||state.networkIssue)markPriceStale('Precio sin comprobar en este momento. '+(offline?'Sin conexión.':'La conexión falló.'));
  }
  window.addEventListener('offline',()=>{updateHealth();stopCamera();});window.addEventListener('online',()=>{updateHealth();checkCatalogUpdates(true);});
  window.addEventListener('mobile:price-refresh',()=>lookup($('barcode').value,$('lookup-kind').value));
  setInterval(()=>{if(document.hidden)return;updateHealth();const notice=$('result').querySelector('.price-freshness');if(notice&&notice.dataset.checkedAt&&Date.now()-Date.parse(notice.dataset.checkedAt)>120000)markPriceStale('Han pasado más de dos minutos desde la comprobación. Comprueba el precio de nuevo antes de usarlo.');},30000);
  $('photo-button').addEventListener('click', () => { if (!busy && catalogReady && !MobilePriceEditor.busy) { setLookupMode('barcode'); $('photo-input').click(); } });
  $('photo-input').addEventListener('change', async () => {
    const file = $('photo-input').files[0]; $('photo-input').value = '';
    if (!file || busy || !catalogReady || MobilePriceEditor.busy || !api.status().authenticated) return;
    stopCamera(); busy = true;
    const current = new AbortController(), epoch = api.status().generation; controller = current;
    $('lookup-kind').disabled = $('search').disabled = $('scan').disabled = $('photo-button').disabled = $('refresh-catalog').disabled = true; $('cancel').hidden = false;
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
      busy = false; $('lookup-kind').disabled = $('search').disabled = $('scan').disabled = $('photo-button').disabled = !catalogReady || !api.status().authenticated; $('refresh-catalog').disabled = false; $('cancel').hidden = true;
      if (controller === current) controller = null;
    }
    if (found && found.length === 1) lookup(found[0].text);
  });
  function showProduct(match, failed, price, unidentified=0) {
    const { product, doc, history: sources, unverifiedDates, conflictingPrices,ambiguousReference } = match;
    const result = $('result'); result.className = failed || unverifiedDates || conflictingPrices ? 'card warning' : 'card'; result.replaceChildren(); result.hidden = false;
    result.append(element('p', doc.kind==='registered'?'PRODUCTO REGISTRADO POR ADMINISTRACIÓN':'PRODUCTO ENCONTRADO EN EL ARCHIVO', 'result-label'), element('h2', product.descripcion || 'Sin descripción en el PDF', 'product-name'));
    result.append(element('div', money(product.pventa), 'price'));
    const imported=doc.reviewed&&doc.kind!=='salida';
    const sourceLabel = element('p', doc.kind==='registered'?'Precio registrado por un administrador. No proviene de una factura.':product.priceOrigin==='manual'?'Precio de venta confirmado por un administrador al importar.':imported?'Precio de venta confirmado en la lectura del documento.':failed || unverifiedDates || conflictingPrices ? 'Precio del PDF de la salida seleccionada.' : 'Precio del PDF de la última salida.', 'note price-source');
    sourceLabel.dataset.pdfLabel = sourceLabel.textContent; result.append(sourceLabel);
    const dl = document.createElement('dl');
    for (const [name, value] of [['Código de barras', product.codigo], ['Empaque', product.empaque], ['Referencia', product.ref], [imported?'Documento de origen':'Salida de origen', doc.salida], ['Fecha de factura', invoiceDate(doc.invoiceDate)]]) {
      dl.append(element('dt', name), element('dd', value || 'No disponible en el documento'));
    }
    if (doc.archiveSalida && doc.archiveSalida !== doc.salida) dl.append(element('dt', 'Número guardado en Archivo'), element('dd', doc.archiveSalida));
    result.append(dl);
    if(unidentified)result.append(element('p','Hay '+unidentified+' productos archivados sin código o referencia. La consulta cubre los productos identificados; vincula las etiquetas pendientes desde Archivo.','note missing'));
    if(ambiguousReference)result.append(element('p','Esta referencia corresponde a varios códigos de barras. Consulta el código exacto del producto para ver su precio.','note missing'));
    if (failed) result.append(element('p', 'Hay ' + failed + ' documentos sin verificar en el índice. Este resultado podría tener una versión posterior. Pulsa Actualizar para reintentar.', 'note missing'));
    if (unverifiedDates) result.append(element('p', 'Hay ' + unverifiedDates + ' coincidencias sin fecha de factura válida. No se puede confirmar cuál es la última salida; revisa esos PDF. Se da prioridad a las facturas con fecha verificada.', 'note missing'));
    if (conflictingPrices) result.append(element('p', 'La salida seleccionada tiene precios distintos para este código. Revisa las coincidencias en Salidas antes de fijar un precio.', 'note missing'));
    const section = element('section', '', 'product-salidas');
    section.setAttribute('aria-label', 'Salidas del producto');
    const mixed=sources.some(s=>s.doc.kind&&s.doc.kind!=='salida');
    section.append(element('h3', mixed?'Salidas y facturas':'Salidas'), element('p', mixed?'Las salidas tienen prioridad. Las otras facturas se consultan cuando el producto no tiene una salida. Se usa la fecha impresa del documento.':'De más reciente a más antigua, según la fecha de la factura. A igual fecha, primero el número de salida mayor.', 'note'));
    const table = document.createElement('table');
    table.append(element('caption', sources.length + ' coincidencias del producto en facturas'));
    const head = document.createElement('thead'), headings = document.createElement('tr');
    for (const title of [mixed?'Documento':'Salida',mixed?'Precio confirmado':'Precio del PDF','Fecha de factura']) { const th = element('th', title); th.scope = 'col'; headings.append(th); }
    head.append(headings); table.append(head);
    const body = document.createElement('tbody');
    for (const [index, source] of sources.entries()) {
      const row = document.createElement('tr'), number = element('td', ((source.doc.kind&&source.doc.kind!=='salida')?({factura:'Factura ',pedido:'Pedido ',otro:'Documento '}[source.doc.kind]||'Documento '):'')+(source.doc.salida || 'No disponible'));
      if (index === 0 && !unverifiedDates && !failed && !conflictingPrices) { row.className = 'latest-salida'; number.append(element('small', imported?'Documento usado':'Última salida')); }
      row.append(number, element('td', money(source.product.pventa)), element('td', invoiceDate(source.doc.invoiceDate))); body.append(row);
    }
    table.append(body); section.append(table);if(doc.kind==='registered'&&!sources.length){section.replaceChildren(element('h3','Registro administrativo'),element('p','Producto confirmado por un administrador. Aún no tiene coincidencias en facturas archivadas. No indica existencias del sistema de caja.','note'));} result.append(section);
    if(!ambiguousReference)window.dispatchEvent(new CustomEvent('mobile:product', { detail: { product, price,doc } }));
  }
  async function prepareCatalog() {
    if (busy || (window.MobilePriceEditor && MobilePriceEditor.busy) || !api || !api.status().authenticated) return;
    stopCamera(); busy = true; catalogReady = false;
    const current = new AbortController(); controller = current;
    $('lookup-kind').disabled = $('scan').disabled = $('search').disabled = $('photo-button').disabled = $('refresh-catalog').disabled = true;
    $('cancel').hidden = false; $('result').replaceChildren(); $('result').hidden = true;
    $('catalog-status').textContent = 'Comprobando documentos y recuperando el índice cifrado…';
    status('La primera preparación procesa los PDF una vez. Las siguientes consultas utilizan el índice.');
    try {
      const info = await api.mobile.prepare(progress => {
        $('catalog-status').textContent = progress.done + ' de ' + progress.total + ' documentos preparados · ' + progress.cached + ' del índice local · '+(progress.shared||0)+' del compartido.';
      }, current.signal);
      if (current.signal.aborted || !api.status().authenticated) return;
      catalogReady = true;
      lastIndexCheck=info.checkedAt;updateHealth();
      $('catalog-status').textContent = info.products + ' productos · ' + info.documents + ' documentos · ' + info.cached + ' recuperados del índice.' + (info.failed ? ' ' + info.failed + ' documentos sin verificar; pulsa Actualizar para reintentar.' : ' Índice listo.');
      if(info.unidentified)$('catalog-status').textContent+=' '+info.unidentified+' productos pendientes de código o referencia.';
      if(info.shared)$('catalog-status').textContent+=' '+info.shared+' documentos recuperados del índice compartido sin abrir sus PDF.';
      if(info.sharedFailed)$('catalog-status').textContent+=' Índice compartido pendiente para algunos documentos; se utilizó la lectura local.';
      status('Listo para escanear. La búsqueda ya no abre los PDF.', Boolean(info.failed||info.unidentified));
    } catch (e) {
      if (api.status().authenticated) {
        $('catalog-status').textContent = 'Índice pendiente. Pulsa Actualizar para prepararlo.';
        status(current.signal.aborted ? 'Preparación cancelada.' : e.message, true);
      }
    } finally {
      busy = false; $('lookup-kind').disabled = $('search').disabled = $('scan').disabled = $('photo-button').disabled = !catalogReady || !api.status().authenticated;
      $('refresh-catalog').disabled = false; $('cancel').hidden = true;
      if (controller === current) controller = null;
      if (resumeCatalog) { resumeCatalog = false; adoptAccount(); }
    }
  }
  $('refresh-catalog').addEventListener('click', prepareCatalog);
  let checkingUpdates = false,needsCatalogCheck=false,lastCatalogCheck=0,catalogCheck=Promise.resolve();
  async function checkCatalogUpdates(force=false) {
    if (!api || !api.status().authenticated || !catalogReady || busy || (window.MobilePriceEditor && MobilePriceEditor.busy) || checkingUpdates || document.hidden || MobileSession.currentSection !== 'scanner') return;
    checkingUpdates = true;
    if(api.status().syncMode==='live'&&!force&&!needsCatalogCheck&&Date.now()-lastCatalogCheck<120000){checkingUpdates=false;return;}
    needsCatalogCheck=false;lastCatalogCheck=Date.now();
    const epoch = api.status().generation;
    let finish;catalogCheck=new Promise(resolve=>{finish=resolve;});
    for(const id of ['lookup-kind','search','scan','photo-button','refresh-catalog'])$(id).disabled=true;
    try {
      const changed = await api.mobile.hasUpdates();
      if(changed&&api.status().authenticated&&api.status().generation===epoch){
        if(!busy&&!(window.MobilePriceEditor&&MobilePriceEditor.busy))await prepareCatalog();
        else needsCatalogCheck=true;
      }
    } catch (_) {
      needsCatalogCheck=true;
      if (api.status().authenticated) $('catalog-status').textContent = 'No se pudieron comprobar documentos nuevos. El índice conserva la última actualización; pulsa Actualizar para reintentar.';
    } finally {
      checkingUpdates = false;
      if(api.status().authenticated&&api.status().generation===epoch&&!busy&&!(window.MobilePriceEditor&&MobilePriceEditor.busy)){
        for(const id of ['lookup-kind','search','scan','photo-button'])$(id).disabled=!catalogReady;
        if(scanControls)$('scan').disabled=true;
        $('refresh-catalog').disabled=false;
      }
      finish();
    }
  }
  setInterval(()=>checkCatalogUpdates(false),30000);
  MobileSession.ready.then(owner=>{let timer;owner.addEventListener('audit:changed',event=>{if(!['mega_audit_records','all'].includes(event.detail.table))return;needsCatalogCheck=true;clearTimeout(timer);timer=setTimeout(()=>checkCatalogUpdates(true),250);});}).catch(()=>{});
  function setLookupMode(mode) {
    $('lookup-kind').value = mode;
    $('barcode-label').textContent = mode === 'name'?'Nombre o parte de la referencia':mode === 'reference' ? 'Referencia del producto' : 'Código de barras';
    $('barcode').placeholder = mode === 'name'?'Ej. Dylan o HB-025':mode === 'reference' ? 'Ej. HB-0254866' : 'Ej. 7451234567890';
  }
  $('lookup-kind').addEventListener('change', () => { stopCamera(); setLookupMode($('lookup-kind').value); });
  async function lookup(raw, mode = 'barcode') {
    if(needsCatalogCheck||checkingUpdates){stopCamera();await catalogCheck;if(needsCatalogCheck)await checkCatalogUpdates(true);if(checkingUpdates||needsCatalogCheck)return;}
    const code = String(raw).trim();
    if (!code || code.length > 80 || /[\x00-\x1f]/.test(code)) { status('Escribe un código válido.', true); return; }
    if (busy || !catalogReady || (window.MobilePriceEditor && MobilePriceEditor.busy)) return;
    if (!api || !api.status().authenticated) { status('Inicia sesión para consultar productos.', true); return; }
    setLookupMode(mode);
    stopCamera(); busy = true;
    controller = new AbortController();
    const current = controller, epoch = api.status().generation;
    const assertCurrent = () => { if (current.signal.aborted || !api.status().authenticated || api.status().generation !== epoch) throw new Error('Consulta cancelada.'); };
    $('barcode').value = code; $('lookup-kind').disabled = $('search').disabled = $('scan').disabled = $('photo-button').disabled = true;
    $('result').hidden = true; $('result').replaceChildren();
    $('cancel').hidden = false;
    $('refresh-catalog').disabled = true;
    status('Consultando el índice…');
    let timer;
    try {
      const response = await Promise.race([
        api.mobile.lookup(code, current.signal, mode),
        new Promise((resolve, reject) => { timer = setTimeout(() => {
          current.abort(); reject(new Error('La conexión no respondió en cinco segundos. Reintenta la consulta; no se ha confirmado el producto.'));
        }, 5000); })
      ]);
      const { documents: count, failed, match, price,unidentified=0 } = response;
      assertCurrent();
      updateHealth();lastIndexCheck=response.checkedAt;
      if(mode==='name'){
        const result=$('result');result.hidden=false;result.className='card';result.append(element('h2',response.candidateCount?'Selecciona el producto':'Sin coincidencias por nombre'),element('p',response.candidateCount+' coincidencias en el índice. '+(response.candidateCount>50?'Se muestran las primeras 50; añade palabras para precisar.':''),'note'));
        for(const candidate of response.candidates){const product=candidate.product,button=element('button',product.descripcion||product.ref,'quiet name-choice');button.append(element('small',(product.codigo?'Código '+product.codigo:'Referencia '+product.ref)+' · '+(product.ref||'Sin referencia')));button.addEventListener('click',()=>lookup(product.codigo||product.ref,product.codigo?'barcode':'reference'));result.append(button);}
        if(failed||unidentified||response.stale)result.append(element('p','Búsqueda incompleta: hay documentos o identificadores pendientes de comprobar. Actualiza el índice antes de confirmar una ausencia.','note missing'));
        status('Búsqueda local completada. Selecciona un producto para comprobar su precio.');return;
      }
      let label;
      if (match) {
        showProduct(match, failed, price,unidentified); label = 'Encontrado';
        if(response.stale){markPriceStale('Índice pendiente de comprobar. Puede faltar una salida posterior.');$('result').append(element('p','No se ha confirmado que el índice corresponda al archivo actual. Pulsa Actualizar.','note missing'));}
        if (mode === 'reference') $('result').append(element('p', 'Coincidencia por referencia: ' + code, 'note'));
        status('Producto encontrado en el índice de ' + count + ' documentos.');
      } else {
        const result = $('result'); result.hidden = false; result.className = 'card warning';
        label = failed||unidentified||response.stale ? 'Consulta incompleta' : 'Sin coincidencia';
        result.append(element('p', failed||unidentified||response.stale ? 'CONSULTA INCOMPLETA' : 'SIN COINCIDENCIA EN LOS PDF', 'result-label missing'), element('h2', code, 'product-name'));
        result.append(element('p', response.stale?'El índice no se pudo comprobar contra el archivo actual. Actualiza antes de confirmar que falta este producto.':failed ? 'No se pudieron leer ' + failed + ' de ' + count + ' documentos al preparar el índice. No podemos confirmar si este producto está en el archivo. Pulsa Actualizar para reintentar.' : unidentified?'Hay '+unidentified+' productos archivados sin código o referencia. '+(mode==='reference'?'Esta referencia':'Este código')+' no coincide con los productos identificados; completa sus etiquetas desde Archivo antes de confirmar que falta.':(mode==='reference'?'Esta referencia':'Este código')+' no aparece en los ' + count + ' PDF revisados. Esto no confirma que falte en el inventario de la empresa.'));
        status(failed||unidentified||response.stale ? 'La consulta terminó con productos o documentos pendientes de verificar.' : 'Consulta del archivo completada.', Boolean(failed||unidentified||response.stale));
      }
      window.dispatchEvent(new CustomEvent('mobile:consulted', { detail: { code, label, match, price } }));
      if (!window.matchMedia('(min-width: 900px)').matches) $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { if (api.status().authenticated && (timer || !current.signal.aborted)) status(e.message, true); }
    finally { clearTimeout(timer); busy = false; $('lookup-kind').disabled = $('search').disabled = $('scan').disabled = $('photo-button').disabled = !catalogReady || !api.status().authenticated; $('refresh-catalog').disabled = false; $('cancel').hidden = true; if (controller === current) controller = null; }
  }
  $('lookup-form').addEventListener('submit', event => { event.preventDefault(); lookup($('barcode').value, $('lookup-kind').value); });
  $('cancel').addEventListener('click', () => { if (controller) controller.abort(); if (window.MobilePriceEditor) MobilePriceEditor.cancel(); status('Consulta cancelada. Puedes intentar otro código.'); });
  $('scan').addEventListener('click', async () => {
    if (busy || !catalogReady || (window.MobilePriceEditor && MobilePriceEditor.busy) || !api || !api.status().authenticated) return;
    setLookupMode('barcode');
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
