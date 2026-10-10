(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const money = value => new Intl.NumberFormat('es-PA', { style: 'currency', currency: 'USD' }).format(value);
  const node = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
  let api, controller, sequence = 0;
  MobileSession.ready.then(owner => { api = owner.AuditCloud; owner.addEventListener('traza:session-cleared', () => { sequence++; if (controller) controller.abort(); }); }).catch(() => {});
  window.MobilePriceEditor = Object.freeze({ get busy() { return Boolean(controller); }, cancel() { if (controller) controller.abort(); } });
  window.addEventListener('mobile-session:navigated', event => {
    if (event.detail.section !== 'scanner' && controller) { sequence++; controller.abort(); $('result').replaceChildren(); $('result').hidden = true; }
  });
  window.addEventListener('mobile:product', event => {
    const { product, price } = event.detail; render(product, price || { available: false, override: null });
  });
  function render(product, state) {
    const result = $('result'), selected = ++sequence, epoch = api.status().generation;
    const old = result.querySelector('.price-panel'); if (old) old.remove();
    const panel = node('div', '', 'price-panel'), override = state.override;
    result.querySelector('.price').textContent = override ? money(override.cents / 100) : Number.isFinite(product.pventa) ? money(product.pventa) : 'Precio no disponible';
    const source = result.querySelector('.price-source');
    source.textContent = override ? 'Precio actualizado por un administrador · ' + new Intl.DateTimeFormat('es-PA', { timeZone: 'America/Panama', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(override.updatedAt)) : 'Precio original del PDF; no confirma el precio vigente.';
    if (override) panel.append(node('p', 'Precio original del PDF: ' + (Number.isFinite(product.pventa) ? money(product.pventa) : 'No disponible'), 'note original-price'));
    if (!state.available) panel.append(node('p', 'Precios compartidos pendientes de activación. Se muestra únicamente el precio del PDF.', 'note missing'));
    result.append(panel);
    if (api.status().user.role !== 'admin') return;
    const notice = node('p', '', 'note'); notice.id = 'price-notice'; notice.setAttribute('role', 'status'); panel.append(notice);
    const current = () => selected === sequence && api.status().authenticated && api.status().generation === epoch && MobileSession.currentSection === 'scanner';
    async function update(run, saving) {
      if (!current() || controller) return;
      const abort = new AbortController(); controller = abort;
      window.dispatchEvent(new Event('mobile:stop-camera'));
      const buttons = [...document.querySelectorAll('#scan,#search,#refresh-catalog,#photo-button,#result button')].map(button => [button, button.disabled]);
      for (const [button] of buttons) button.disabled = true;
      $('cancel').hidden = false; notice.textContent = saving ? 'Guardando el precio compartido…' : 'Comprobando activación…';
      try {
        const confirmed = await run(abort.signal);
        if (!current() || abort.signal.aborted) return;
        render(product, confirmed);
        const success = $('price-notice'); if (success) success.textContent = saving ? 'Precio compartido guardado. Todos lo verán en sus siguientes consultas.' : confirmed.available ? 'Precios compartidos activados.' : 'La tabla sigue pendiente de activación.';
      } catch (error) {
        if (!current()) return;
        notice.textContent = abort.signal.aborted ? 'Guardado cancelado. Consulta nuevamente para verificar si el precio cambió.' : error.message; notice.className = 'note missing';
        if (saving) { result.querySelector('.price').textContent = 'Precio pendiente de comprobar'; for (const e of panel.querySelectorAll('form,#edit-price')) e.remove(); }
      } finally {
        if (controller === abort) controller = null;
        $('cancel').hidden = true;
        for (const [button, disabled] of buttons) if (button.isConnected) button.disabled = !api.status().authenticated || disabled;
      }
    }
    if (!state.available) {
      const inactive = node('button', 'Editar precio · activar primero', 'quiet'); inactive.id = 'edit-price'; inactive.disabled = true; panel.append(inactive);
      const explanation = node('p', 'El propietario debe ejecutar el SQL de precios en Supabase. ', 'note');
      const link = node('a', 'Abrir SQL de activación'); link.href = 'supabase/precios.sql'; link.target = '_blank'; link.rel = 'noopener'; explanation.append(link); panel.append(explanation);
      const guide = node('a', 'Activar precios: copiar SQL y abrir Supabase'); guide.href = 'supabase-precios.html'; guide.target = '_blank'; guide.rel = 'noopener'; panel.append(guide);
      const check = node('button', 'Comprobar activación', 'quiet'); check.id = 'check-prices'; panel.append(check); check.addEventListener('click', () => update(signal => api.mobile.price(product.codigo, signal), false)); return;
    }
    const edit = node('button', 'Editar precio', 'quiet'); edit.id = 'edit-price';
    const form = document.createElement('form'); form.id = 'price-form'; form.className = 'price-editor'; form.hidden = true;
    const label = node('label', 'Nuevo precio de venta (USD)'); label.htmlFor = 'price-input';
    const input = document.createElement('input'); input.id = 'price-input'; input.type = 'text'; input.inputMode = 'decimal'; input.required = true; input.maxLength = 10; input.value = override ? (override.cents / 100).toFixed(2) : Number.isFinite(product.pventa) ? product.pventa.toFixed(2) : '';
    const save = node('button', 'Guardar precio'); save.id = 'save-price'; save.type = 'submit';
    form.append(label, input, node('p', 'El cambio se comparte con todos. La factura original se conserva.', 'note'), save); panel.append(edit, form);
    edit.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); });
    form.addEventListener('submit', event => {
      event.preventDefault(); const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(input.value.trim());
      if (!match) { notice.textContent = 'Escribe un precio válido con hasta dos decimales, por ejemplo 7.99.'; return; }
      const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
      update(signal => api.mobile.setPrice(product.codigo, cents, override ? override.version : 0, signal), true);
    });
  }
})();
