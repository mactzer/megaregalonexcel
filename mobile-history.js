(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const node=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
  let api,owner,epoch=0,entries=[],pending=[],queue,controller,loading=false,flushing=false,again=false,missing=false,debounce,initialized=-1,recovering=Promise.resolve();
  const current=value=>value===epoch&&api&&api.status().authenticated;
  function message(text,error=false){$('history-status').textContent=text;$('history-status').className='note'+(error?' missing':'');$('retry-history').hidden=!pending.length;}
  function render(){
    $('history').replaceChildren();
    if(!entries.length)$('history').append(node('li','Aún no hay consultas compartidas.'));
    for(const entry of entries){
      const li=document.createElement('li'),info=node('span',entry.code),result=node('span',entry.label);
      info.append(node('small',(entry.username?'@'+entry.username:'Autor no disponible')+' · '+new Intl.DateTimeFormat('es-PA',{timeZone:'America/Panama',dateStyle:'medium',timeStyle:'short'}).format(new Date(entry.created_at))));
      if(entry.description)info.append(node('small',entry.description));
      if(entry.cents!==null)result.append(node('small',new Intl.NumberFormat('es-PA',{style:'currency',currency:'USD'}).format(entry.cents/100)));
      if(entry.salida)result.append(node('small','Salida '+entry.salida));
      li.append(info,result);$('history').append(li);
    }
  }
  function clear(){epoch++;initialized=-1;if(controller)controller.abort();controller=null;entries=[];pending=[];queue=null;loading=flushing=again=missing=false;clearTimeout(debounce);render();message('Inicia sesión para ver las consultas compartidas.');}
  async function persist(value){if(!current(value)||!queue)return;const selected=queue;await selected.write(pending.map(item=>({...item})));}
  async function load(){
    if(!api||!api.status().authenticated||missing)return;
    if(loading){again=true;return;}
    const selected=epoch;loading=true;$('clear-history').disabled=true;
    if(!entries.length){message('Cargando consultas compartidas…');$('history').replaceChildren(node('li','Cargando historial compartido…'));}
    try{
      const result=await api.queries.list(controller.signal);if(!current(selected))return;
      entries=result.entries;render();if(!entries.length&&result.damaged)$('history').replaceChildren(node('li','Consultas pendientes de verificar.'));message(pending.length?pending.length+' consultas pendientes de guardar. Pulsa Reintentar.':result.damaged?result.damaged+' consultas no pudieron verificarse. Las demás se conservan.':'Historial compartido con el equipo. Fechas y horas de Panamá.',Boolean(result.damaged));
    }catch(error){
      if(!current(selected))return;missing=Boolean(error.setupRequired);
      if(!entries.length)$('history').replaceChildren(node('li','Historial pendiente de recuperar. Los registros guardados se conservan.'));
      message((entries.length?'Se conserva la última vista. ':'')+error.message,true);
      if(missing){const link=node('a',' Activar consultas compartidas');link.href='supabase-consultas.html';link.target='_blank';link.rel='noopener';$('history-status').append(link);}
    }finally{if(current(selected)){loading=false;$('clear-history').disabled=false;if(again){again=false;schedule();}}}
  }
  function schedule(){clearTimeout(debounce);debounce=setTimeout(load,200);}
  async function flush(){
    if(flushing||!pending.length||!api||!api.status().authenticated)return;
    const selected=epoch;flushing=true;
    try{
      while(pending.length&&current(selected)){
        const ticket=pending[0];message('Guardando '+pending.length+' consultas compartidas…');
        await api.queries.add(ticket,controller.signal);if(!current(selected))return;
        pending=pending.filter(item=>item.id!==ticket.id);try{await persist(selected);}catch(_){}if(!current(selected))return;
      }
      missing=false;await load();
    }catch(error){if(current(selected)){missing=Boolean(error.setupRequired);message('Consulta pendiente de guardar. '+error.message+' Pulsa Reintentar.',true);if(missing){const link=node('a',' Abrir activación');link.href='supabase-consultas.html';link.target='_blank';link.rel='noopener';$('history-status').append(link);}}}
    finally{if(current(selected))flushing=false;}
  }
  async function begin(){
    if(!api||!api.status().authenticated||initialized===api.status().generation)return;
    clear();initialized=api.status().generation;controller=new AbortController();queue=api.queries.queue();const selected=epoch;
    recovering=(async()=>{try{const stored=await queue.read();if(!current(selected))return;pending=Array.isArray(stored)?stored:[];}
    catch(error){if(current(selected))message('No se pudieron recuperar reintentos locales. El historial guardado permanece en Supabase.',true);}})();await recovering;
    if(current(selected)){await load();if(current(selected))flush();}
  }
  window.addEventListener('mobile:consulted',async event=>{
    if(!api||!api.status().authenticated)return;
    const selected=epoch,{code,label,match,price}=event.detail;
    await recovering;if(!current(selected))return;
    const cents=price&&price.override?price.override.cents:match&&Number.isFinite(match.product.pventa)?Math.round(match.product.pventa*100):null;
    try{
      const ticket=await api.queries.ticket({version:1,code,label,description:match?String(match.product.descripcion||'').slice(0,2048):'',cents,salida:match?String(match.doc.salida||''):'',invoiceDate:match?match.doc.invoiceDate:'',source:price&&price.override?'admin':match?'pdf':'none'});
      if(!current(selected))return;pending.push(ticket);await persist(selected);if(current(selected))flush();
    }catch(error){if(current(selected))message('No se confirmó el guardado de esta consulta. '+error.message,true);}
  });
  $('clear-history').addEventListener('click',()=>{missing=false;load();});
  $('retry-history').addEventListener('click',()=>{missing=false;flush();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){load();if(!missing)flush();}});
  setInterval(()=>{if(!document.hidden&&MobileSession.currentSection==='scanner'){load();if(!missing)flush();}},10000);
  MobileSession.ready.then(value=>{owner=value;api=owner.AuditCloud;owner.addEventListener('audit:authenticated',begin);owner.addEventListener('traza:session-cleared',clear);owner.addEventListener('audit:changed',event=>{if(['mega_product_queries','all'].includes(event.detail.table))schedule();});begin();}).catch(()=>{});
})();
