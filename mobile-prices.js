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
    const { product, price,doc } = event.detail; render(product, price || { available: false, override: null },doc);
  });
  function render(product, state,doc) {
    const result = $('result'), selected = ++sequence, epoch = api.status().generation;
    const old = result.querySelector('.price-panel'); if (old) old.remove();
    const panel = node('div', '', 'price-panel'), override = state.override;
    result.querySelector('.price').textContent = override ? money(override.cents / 100) : Number.isFinite(product.pventa) ? money(product.pventa) : 'Precio no disponible';
    const source = result.querySelector('.price-source');
    source.textContent = override ? 'Precio actualizado por un administrador · ' + new Intl.DateTimeFormat('es-PA', { timeZone: 'America/Panama', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(override.updatedAt)) : source.dataset.pdfLabel;
    const freshness=node('p',state.checkedAt?'Precio compartido comprobado · '+new Intl.DateTimeFormat('es-PA',{timeZone:'America/Panama',timeStyle:'short'}).format(new Date(state.checkedAt)):'Precio compartido sin comprobar.','note price-freshness');panel.append(freshness);
    freshness.dataset.checkedAt=state.checkedAt||'';const refresh=node('button','Comprobar precio de nuevo','quiet');refresh.addEventListener('click',()=>window.dispatchEvent(new Event('mobile:price-refresh')));panel.append(refresh);
    if (override) panel.append(node('p', (product.priceOrigin==='manual'?'Precio confirmado al importar: ':'Precio original del PDF: ') + (Number.isFinite(product.pventa) ? money(product.pventa) : 'No disponible'), 'note original-price'));
    if(override&&doc&&doc.invoiceDate){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Panama',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(override.updatedAt)),pick=type=>parts.find(part=>part.type===type).value,day=pick('year')+'-'+pick('month')+'-'+pick('day');if(day<doc.invoiceDate)panel.append(node('p','El ajuste administrativo es anterior a la fecha de la última factura. Confirma si sigue autorizado.','note missing'));}
    if (!state.available) panel.append(node('p', 'Precios compartidos pendientes de activación. Se muestra únicamente el precio del PDF.', 'note missing'));
    result.insertBefore(panel, result.querySelector('.product-salidas'));
    const notice = node('p', '', 'note'); notice.id = 'price-notice'; notice.setAttribute('role', 'status'); panel.append(notice);
    const current = () => selected === sequence && api.status().authenticated && api.status().generation === epoch && MobileSession.currentSection === 'scanner';
    async function update(run, saving) {
      if (!current() || controller) return;
      const abort = new AbortController(); controller = abort;
      window.dispatchEvent(new Event('mobile:stop-camera'));
      const buttons = [...document.querySelectorAll('#scan,#search,#refresh-catalog,#photo-button,#lookup-kind,#result button')].map(button => [button, button.disabled]);
      for (const [button] of buttons) button.disabled = true;
      $('cancel').hidden = false; notice.textContent = saving ? 'Guardando el precio compartido…' : 'Comprobando activación…';
      try {
        const confirmed = await run(abort.signal);
        if (!current() || abort.signal.aborted) return;
        render(product, confirmed,doc);
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
    const historyButton=node('button','Historial de precios','quiet');historyButton.id='price-history-button';panel.append(historyButton);
    const history=node('section','','price-history');history.hidden=true;history.setAttribute('aria-label','Historial de precios');panel.append(history);
    let historyOffset=0,historyMore=true,historyLoading=false;
    async function loadHistory(){
      if(historyLoading||!current()||!historyMore||controller)return;historyLoading=true;historyButton.disabled=true;const abort=new AbortController();controller=abort;
      try{const response=await api.mobile.priceHistory(product.lookupCode||product.codigo||product.ref,abort.signal,historyOffset);if(!current())return;
        if(!historyOffset)history.replaceChildren(node('h3','Historial de cambios de precio'),node('p','Restaurar crea un nuevo cambio y conserva los anteriores.','note'));
        if(!response.entries.length&&!historyOffset)history.append(node('p','Aún no hay cambios de precio registrados.','note'));
        const oldMore=history.querySelector('.price-history-more');if(oldMore)oldMore.remove();
        for(const entry of response.entries){const card=node('article','','price-history-entry');card.append(node('strong',(entry.previousCents===null?'Precio anterior no registrado':money(entry.previousCents/100))+' → '+money(entry.cents/100)),node('p',(entry.username?'@'+entry.username:'Administrador registrado')+' · '+new Intl.DateTimeFormat('es-PA',{timeZone:'America/Panama',dateStyle:'medium',timeStyle:'short'}).format(new Date(entry.updatedAt)),'note'),node('p',entry.reason||'Cambio sin motivo registrado.','note'));
          if(api.status().user.role==='admin'&&override&&(entry.version!==override.version||entry.previousCents!==null&&entry.previousCents!==override.cents)){const previous=entry.version===override.version,target=previous?entry.previousCents:entry.cents,restore=node('button','Restaurar '+money(target/100),'quiet');restore.dataset.version=entry.version;const form=document.createElement('form');form.hidden=true;const label=node('label','Motivo de la restauración'),input=document.createElement('input');input.type='text';input.required=true;input.maxLength=500;label.append(input);const save=node('button','Confirmar restauración');save.type='submit';form.append(label,save);restore.addEventListener('click',()=>{form.hidden=!form.hidden;if(!form.hidden)input.focus();});form.addEventListener('submit',event=>{event.preventDefault();update(signal=>api.mobile.restorePrice(product.lookupCode||product.codigo||product.ref,entry.version,override.version,input.value,signal,previous),true);});card.append(restore,form);}
          history.append(card);
        }
        historyOffset=response.offset;historyMore=response.more;if(historyMore){const more=node('button','Ver más cambios','quiet price-history-more');more.addEventListener('click',loadHistory);history.append(more);}
      }catch(error){if(current()){const failed=node('p',error.message,'note missing'),retry=node('button','Reintentar historial','quiet');retry.addEventListener('click',()=>{failed.remove();retry.remove();loadHistory();});history.append(failed,retry);}}
      finally{historyLoading=false;if(current())historyButton.disabled=false;if(controller===abort)controller=null;}
    }
    historyButton.addEventListener('click',()=>{history.hidden=!history.hidden;if(!history.hidden&&!historyOffset)loadHistory();});
    if (api.status().user.role !== 'admin') return;
    if (!state.available) {
      const inactive = node('button', 'Editar precio · activar primero', 'quiet'); inactive.id = 'edit-price'; inactive.disabled = true; panel.append(inactive);
      const explanation = node('p', 'El propietario debe ejecutar el SQL de precios en Supabase. ', 'note');
      const link = node('a', 'Abrir SQL de activación'); link.href = 'supabase/precios.sql'; link.target = '_blank'; link.rel = 'noopener'; explanation.append(link); panel.append(explanation);
      const guide = node('a', 'Activar precios: copiar SQL y abrir Supabase'); guide.href = 'supabase-precios.html'; guide.target = '_blank'; guide.rel = 'noopener'; panel.append(guide);
      const check = node('button', 'Comprobar activación', 'quiet'); check.id = 'check-prices'; panel.append(check); check.addEventListener('click', () => update(signal => api.mobile.price(product.lookupCode||product.codigo, signal), false)); return;
    }
    const edit = node('button', 'Editar precio', 'quiet'); edit.id = 'edit-price';
    const form = document.createElement('form'); form.id = 'price-form'; form.className = 'price-editor'; form.hidden = true;
    const label = node('label', 'Nuevo precio de venta (USD)'); label.htmlFor = 'price-input';
    const input = document.createElement('input'); input.id = 'price-input'; input.type = 'text'; input.inputMode = 'decimal'; input.required = true; input.maxLength = 10; input.value = override ? (override.cents / 100).toFixed(2) : Number.isFinite(product.pventa) ? product.pventa.toFixed(2) : '';
    const save = node('button', 'Guardar precio'); save.id = 'save-price'; save.type = 'submit';
    const reasonLabel=node('label','Motivo del cambio');reasonLabel.htmlFor='price-reason';const reason=document.createElement('input');reason.id='price-reason';reason.type='text';reason.required=true;reason.maxLength=500;reason.placeholder='Ej. Precio autorizado por el jefe';
    form.append(label, input,reasonLabel,reason, node('p', 'El cambio se comparte con todos. La factura original se conserva.', 'note'), save); panel.append(edit, form);
    edit.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); });
    form.addEventListener('submit', event => {
      event.preventDefault(); const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(input.value.trim());
      if (!match) { notice.textContent = 'Escribe un precio válido con hasta dos decimales, por ejemplo 7.99.'; return; }
      const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
      update(signal => api.mobile.setPrice(product.lookupCode||product.codigo||product.ref, cents, override ? override.version : 0, signal,{reason:reason.value,previousCents:override?override.cents:Number.isFinite(product.pventa)?Math.round(product.pventa*100):null}), true);
    });
  }
})();
