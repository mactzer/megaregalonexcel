(function(){
 'use strict';
 const root=document.getElementById('chat-view');if(!root)return;
 const C=window.ProductChatCloud;if(!C){root.textContent='No se pudo cargar el chat. Actualiza la página para reintentar.';return;}const S=C.STATES;
 const n=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const b=(label,fn,cls='chat-button')=>{const e=n('button',label,cls);e.type='button';if(fn)e.addEventListener('click',fn);return e;};
 const $=id=>document.getElementById(id),money=c=>c===null?'Precio no disponible':new Intl.NumberFormat('es-PA',{style:'currency',currency:'USD'}).format(c/100);
 const when=value=>new Intl.DateTimeFormat('es-ES',{timeZone:'America/Panama',year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(value));
 let api,user,epoch=-1,sequence=0,active=false,messages=new Map(),caseMap=new Map(),members=[],notices=[],newest=0,oldest=0,more=false,loading=false,refreshAgain=false,thread=null;
 let pending=null,reply=null,attachment=null,attachmentURL=null,scanner=null,scanGeneration=0,catalogReady=false;
 const pendingCases=new Map(),pendingShares=new Map();let threadTurn=0,caseListTurn=0;
 let dialog=null,timer,urls=new Map(),requests=new Set(),caseCursor=null,caseFilter='open',lastSync=0,panel='';
 const current=(s=sequence)=>s===sequence&&api&&api.status().authenticated&&api.status().generation===epoch;
 const isActive=()=>active&&!document.hidden;
 function status(text,error=false){const e=$('chat-status');if(e){e.textContent=text;e.classList.toggle('chat-error',error);}const d=$('chat-lookup-status');if(dialog?.open&&d){d.textContent=text;d.classList.toggle('chat-error',error);}}
 function guard(s){if(!current(s))throw new Error('La sesión cambió.');}
 async function run(fn){const s=sequence;try{return await fn(s);}catch(error){if(current(s))status(error.message,true);return null;}}
 function controller(){const c=new AbortController();requests.add(c);return c;}
 function badge(){window.dispatchEvent(new CustomEvent('chat:unread',{detail:{count:notices.length}}));const e=$('chat-unread');if(e){e.hidden=!notices.length;e.textContent=notices.length===100?'99+':String(notices.length);}const label=$('chat-notification-toggle');if(label)label.textContent='Notificaciones'+(notices.length?' ('+notices.length+(notices.length===100?'+':'')+')':'');}
 function clear(){
  sequence++;epoch=-1;active=false;messages.clear();caseMap.clear();members=[];notices=[];newest=oldest=0;more=loading=refreshAgain=false;thread=null;pending=null;reply=null;attachment=null;catalogReady=false;caseCursor=null;lastSync=0;pendingCases.clear();pendingShares.clear();threadTurn++;caseListTurn++;
  for(const c of requests)c.abort();requests.clear();stopCamera();if(dialog){dialog.close();dialog.remove();dialog=null;}for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();if(attachmentURL)URL.revokeObjectURL(attachmentURL);attachmentURL=null;badge();root.replaceChildren(n('p','Inicia sesión con tu cuenta para abrir el chat.','chat-empty'));root.append(b('Iniciar sesión',()=>window.TrazaUI.navigate('archive')));
 }
 function layout(){
  root.replaceChildren();const shell=n('div',undefined,'chat-shell');
  const header=n('header',undefined,'chat-header'),title=n('div');title.append(n('p','EQUIPO · MEGA REGALÓN','chat-eyebrow'),n('h1','Chat de productos'));const controls=n('div',undefined,'chat-actions');
  controls.append(b('Pendientes',()=>togglePanel('cases')),b('Notificaciones',()=>togglePanel('notifications')));controls.lastChild.id='chat-notification-toggle';header.append(title,controls);
  const sync=n('p','Conectando…','chat-sync');sync.id='chat-sync';
  const stream=n('section',undefined,'chat-stream');stream.id='chat-stream';stream.setAttribute('aria-label','Conversación del equipo');stream.tabIndex=0;
  const older=b('Cargar mensajes anteriores',()=>loadOlder(),'chat-older');older.id='chat-older';older.hidden=true;
  const list=n('div');list.id='chat-messages';list.setAttribute('role','log');list.setAttribute('aria-live','polite');stream.append(older,list);
  const side=n('aside',undefined,'chat-side');side.id='chat-side';side.hidden=true;side.setAttribute('aria-label','Conversación y seguimiento');
  const composer=n('form',undefined,'chat-composer');composer.id='chat-composer';
  const target=n('div',undefined,'chat-reply-preview');target.id='chat-reply-preview';target.hidden=true;
  const preview=n('div',undefined,'chat-attachment-preview');preview.id='chat-attachment-preview';preview.hidden=true;
  const tools=n('div',undefined,'chat-tools');const scan=b('Escanear producto',()=>openLookup());scan.id='chat-scan';
  const file=n('input');file.type='file';file.accept='image/jpeg,image/png,image/webp';file.hidden=true;file.id='chat-file';file.addEventListener('change',()=>{attachment=file.files[0]||null;file.value='';if(attachment){if(attachment.size>24*1024*1024){attachment=null;status('La foto supera 24 MB.',true);return;}if(attachmentURL)URL.revokeObjectURL(attachmentURL);attachmentURL=URL.createObjectURL(attachment);preview.replaceChildren();const img=n('img');img.src=attachmentURL;img.alt='Foto que se compartirá';preview.append(img,n('span','Se reducirá a un máximo de 160 KB.'),b('Quitar foto',clearAttachment));preview.hidden=false;}});
  tools.append(scan,b('Foto',()=>file.click()),b('😊 Emojis',()=>picker('emojis')),b('Stickers',()=>picker('stickers')),b('@ Mencionar',()=>picker('mentions')),file);
  const pickerBox=n('div',undefined,'chat-picker');pickerBox.id='chat-picker';pickerBox.hidden=true;
  const row=n('div',undefined,'chat-write');const input=n('textarea');input.id='chat-text';input.placeholder='Escribe al equipo…';input.rows=2;input.maxLength=4000;input.setAttribute('aria-label','Mensaje al equipo');input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();composer.requestSubmit();}});
  const send=b('Enviar');send.type='submit';send.id='chat-send';row.append(input,send);const hint=n('p','','chat-status');hint.id='chat-status';hint.setAttribute('role','status');
  composer.append(target,preview,tools,pickerBox,row,hint);composer.addEventListener('submit',event=>{event.preventDefault();sendComposer();});
  const main=n('div',undefined,'chat-body');main.append(stream,side);shell.append(header,sync,main,composer);root.append(shell);badge();showSync();
 }
 function showSync(){const e=$('chat-sync');if(!e||!api)return;const s=api.status();e.textContent=!navigator.onLine?'Sin conexión. Los envíos necesitan confirmación.':s.syncMode==='live'&&!s.networkIssue?'● En tiempo real · Mensajes cifrados para tu equipo': 'Reconectando · Comprobaciones de respaldo activas';}
 function clearAttachment(){attachment=null;if(attachmentURL)URL.revokeObjectURL(attachmentURL);attachmentURL=null;if($('chat-attachment-preview'))$('chat-attachment-preview').hidden=true;}
 function name(id){return '@'+(members.find(m=>m.id===id)?.username||(id===user.id?user.username:'Miembro del equipo'));}
 function productCard(p,c){
  const card=n('div',undefined,'chat-product '+(c?'chat-case-'+c.status:p.result));
  card.append(n('p',c?(c.status==='resolved'?'✓ PROBLEMA RESUELTO':S[c.status]):p.result==='found'?'PRODUCTO ENCONTRADO':p.result==='incomplete'?'CONSULTA INCOMPLETA':'SIN COINCIDENCIA EN EL ARCHIVO','chat-product-state'));
  card.append(n('h3',p.description||p.code),n('p',money(p.cents),'chat-price'),n('p',(p.identifier==='reference'?'Referencia consultada: ':'Código: ')+p.code,'chat-code'));
  if(p.ref)card.append(n('p','Referencia: '+p.ref));
  if(p.source)card.append(n('p',p.source+(p.salida?' · '+p.salida:'')+(p.invoiceDate?' · Factura '+p.invoiceDate.split('-').reverse().join('/'):'') ,'chat-caption'));
  card.append(n('p','Consultado: '+when(p.checkedAt)+'. El precio compartido corresponde a ese momento.','chat-caption'));
  if(p.result!=='found')card.append(n('p','Sin coincidencia en los documentos consultables. No confirma la existencia en el sistema de caja.','chat-caption'));
  if(c){if(c.assigned_to)card.append(n('p','En atención por '+name(c.assigned_to),'chat-caption'));if(c.revision)card.append(n('p','Actualizado por '+name(c.updated_by)+' · '+when(c.updated_at),'chat-caption'));if(c.resolution?.note)card.append(n('p',c.resolution.note));}
  return card;
 }
 function messageCard(m,compact=false){
  const card=n('article',undefined,'chat-message'+(m.created_by===user.id?' mine':''));card.dataset.messageId=m.id;
  const top=n('div',undefined,'chat-message-meta');top.append(n('strong',name(m.created_by)),n('time',when(m.created_at)));card.append(top);
  if(m.damaged){card.append(n('p','No se pudo verificar este mensaje. Actualiza para reintentar.','chat-error'));return card;}
  if(m.parent_id&&!compact)card.append(b('↳ Ver conversación vinculada',()=>openThread(m.parent_id),'chat-reply-link'));
  if(m.kind==='text')card.append(n('p',m.body.text,'chat-message-text'));
  if(m.kind==='sticker'){const s=C.STICKERS[m.body.sticker],st=n('div',undefined,'chat-sticker');st.append(n('span',s[0]),n('strong',s[1]));card.append(st);}
  if(m.kind==='image'){
   if(m.body.text)card.append(n('p',m.body.text,'chat-message-text'));const img=n('img');img.alt='Imagen de producto compartida por '+name(m.created_by);img.className='chat-photo';img.loading='lazy';
   if(urls.has(m.id)){img.src=urls.get(m.id);card.append(img);}else{const load=b('Ver foto del producto',()=>run(async s=>{load.disabled=true;const c=controller();try{const blob=await api.chat.image(m,c.signal);guard(s);const url=URL.createObjectURL(blob);urls.set(m.id,url);if(load.isConnected){img.src=url;load.replaceWith(img);}}finally{requests.delete(c);load.disabled=false;}}));card.append(load);}
  }
  if(['product','case'].includes(m.kind)){
   const c=caseMap.get(m.id),p=c?.status==='resolved'&&c.resolution?.product?c.resolution.product:m.body.product;card.append(productCard(p,c));
   if(m.kind==='case')card.append(b('Ver seguimiento',()=>openThread(m.id),'chat-reply-link'));else card.append(b('Comprobar precio actual',()=>openLookup(p.code,false,p.identifier||'barcode'),'chat-reply-link'));
  }
  if(!compact)card.append(b(['case','product'].includes(m.kind)?'Comentar sobre este producto':'Responder',()=>openThread(m.parent_id||m.id),'chat-reply-link'));
  return card;
 }
 function render(){
  const list=$('chat-messages');if(!list)return;const stream=$('chat-stream'),bottom=stream.scrollHeight-stream.scrollTop-stream.clientHeight<100,position=stream.scrollTop;
  const sorted=[...messages.values()].sort((a,b)=>a.seq-b.seq);list.replaceChildren();if(!sorted.length)list.append(n('p','Inicia una conversación con tu equipo.','chat-empty'));for(const m of sorted)list.append(messageCard(m));
  $('chat-older').hidden=!more;if(bottom)stream.scrollTop=stream.scrollHeight;else stream.scrollTop=position;
 }
 function absorb(rows,fromList=false){for(const m of rows){messages.set(m.id,m);if(fromList)newest=Math.max(newest,m.seq);oldest=oldest?Math.min(oldest,m.seq):m.seq;}}
 async function loadCasesFor(rows,s=sequence){const ids=rows.filter(m=>m.kind==='case').map(m=>m.id);for(let i=0;i<ids.length;i+=40){const result=await api.chat.cases({ids:ids.slice(i,i+40)});guard(s);for(const c of result.cases)caseMap.set(c.id,c);}}
 async function loadOlder(){return run(async s=>{const btn=$('chat-older');btn.disabled=true;try{const r=await api.chat.list({before:oldest});guard(s);await loadCasesFor(r.messages,s);guard(s);const stream=$('chat-stream'),position=stream.scrollTop,height=stream.scrollHeight;absorb(r.messages,true);more=r.more;render();stream.scrollTop=position+stream.scrollHeight-height;}finally{if(btn.isConnected)btn.disabled=false;}});}
 async function refresh(){
  if(!current()||document.hidden)return;if(loading){refreshAgain=true;return;}loading=true;const s=sequence;
  try{
   const unread=await api.chat.notifications();guard(s);notices=unread;badge();lastSync=Date.now();if(user.role!==api.status().user.role){user=api.status().user;if(dialog?.open)dialog.close();}
   if(isActive()){
    let next=await api.chat.list(newest?{after:newest}:{});guard(s);const initial=!newest;if(initial)more=next.more;absorb(next.messages,true);await loadCasesFor(next.messages,s);guard(s);
    for(let i=0;next.more&&!initial&&i<5;i++){next=await api.chat.list({after:newest});guard(s);absorb(next.messages,true);await loadCasesFor(next.messages,s);guard(s);}
    await loadCasesFor([...messages.values()].filter(m=>m.kind==='case'),s);guard(s);render();showSync();
    if(panel==='cases'&&!$('chat-case-filter')?.matches(':focus'))await caseList(true);if(panel==='notifications')renderNotifications();if(thread)await refreshThread();
   }
  }catch(error){if(current(s))status('No se pudo sincronizar el chat. '+error.message,true);}finally{if(current(s)){loading=false;if(refreshAgain){refreshAgain=false;setTimeout(refresh,200);}}}
 }
 async function sendComposer(kind=null,sticker=null){
  if(!current()||$('chat-send').disabled)return;const s=sequence,input=$('chat-text');if(!pending&&!sticker&&!input.value.trim()&&!attachment)return;
  $('chat-send').disabled=true;input.disabled=true;status(pending?'Reintentando el mismo envío…':'Enviando…');
  try{
   if(!pending){const mentions=members.filter(m=>input.value.split(/\s+/).some(word=>word.replace(/[.,!?]$/,'').toLowerCase()==='@'+m.username.toLowerCase())).map(m=>m.id);
    const ticket=attachment?await api.chat.imageTicket(attachment,reply,input.value,mentions):await api.chat.ticket(sticker?{version:1,sticker}:{version:1,text:input.value.trim()},sticker?'sticker':'text',reply,mentions);guard(s);pending=ticket;
   }
   const row=await (pending.image?api.chat.sendImage(pending):api.chat.send(pending));guard(s);pending=null;input.value='';clearAttachment();absorb([row]);render();status('Enviado y guardado.');if(thread)await refreshThread();
  }catch(error){if(current(s))status('Pendiente de confirmar: '+error.message+' Pulsa Reintentar envío.',true);}
  finally{if(current(s)){$('chat-send').disabled=false;input.disabled=Boolean(pending);$('chat-send').textContent=pending?'Reintentar envío':'Enviar';for(const button of root.querySelectorAll('.chat-tools button'))button.disabled=Boolean(pending);}}
 }
 function picker(kind){const box=$('chat-picker');if(!box.hidden&&box.dataset.kind===kind){box.hidden=true;return;}box.hidden=false;box.dataset.kind=kind;box.replaceChildren();
  if(kind==='emojis')for(const emoji of ['👍','✅','📦','🔎','❓','🙌','🙂','⚠️','💲','🙏','👋','❤️'])box.append(b(emoji,()=>{$('chat-text').value+=emoji;$('chat-text').focus();box.hidden=true;},'chat-emoji'));
  if(kind==='stickers')for(const key of Object.keys(C.STICKERS))box.append(b(C.STICKERS[key].join(' '),()=>{box.hidden=true;sendComposer('sticker',key);},'chat-sticker-choice'));
  if(kind==='mentions')for(const m of members.filter(m=>['admin','user'].includes(m.role)))box.append(b(name(m.id),()=>{$('chat-text').value+='@'+m.username+' ';$('chat-text').focus();box.hidden=true;},'chat-sticker-choice'));
 }
 function selectReply(id){reply=id;const box=$('chat-reply-preview');if(!box)return;box.hidden=!id;box.replaceChildren();if(id){const m=messages.get(id);box.append(n('span','Respondiendo a '+name(m?.created_by||user.id)),b('Cancelar respuesta',()=>selectReply(null),'chat-reply-link'));} }
 function closePanel(){threadTurn++;caseListTurn++;panel='';thread=null;selectReply(null);$('chat-side').hidden=true;root.classList.remove('chat-side-open');}
 function sideTitle(title){const side=$('chat-side');side.hidden=false;root.classList.add('chat-side-open');side.replaceChildren();const header=n('div',undefined,'chat-side-header');header.append(n('h2',title),b('Cerrar',closePanel));side.append(header);return side;}
 function togglePanel(next){if(panel===next){closePanel();return;}threadTurn++;caseListTurn++;thread=null;selectReply(null);panel=next;if(next==='cases')run(()=>caseList(true));else renderNotifications();}
 function renderNotifications(){const side=sideTitle('Notificaciones');if(!notices.length)side.append(n('p','No tienes notificaciones pendientes.','chat-empty'));else{
  side.append(b('Marcar como leídas',()=>run(async s=>{await api.chat.read(Math.max(...notices.map(x=>x.id)));guard(s);notices=[];badge();renderNotifications();})));
  const labels={message:'Mensaje nuevo',reply:'Respuesta a tu conversación',mention:'Te mencionaron',case:'Producto por revisar',assigned:'Solicitud asignada a ti',resolved:'Producto solucionado',status:'Cambio de estado'};
  for(const item of notices)side.append(b(labels[item.kind]+' · '+when(item.created_at),()=>run(async s=>{await openThread(item.message_id);guard(s);await api.chat.read(item.id,undefined,true);guard(s);notices=notices.filter(x=>x.id!==item.id);badge();}),'chat-notification'));
 }}
 async function caseList(reset){
  const s=sequence,turn=++caseListTurn,wanted=caseFilter;if(reset)caseCursor=null;
  const r=await api.chat.cases({status:caseFilter,before:reset?null:caseCursor});guard(s);if(panel!=='cases'||turn!==caseListTurn||caseFilter!==wanted)return;for(const c of r.cases)caseMap.set(c.id,c);const last=r.cases.at(-1);if(last)caseCursor={time:last.updated_at,id:last.id};
  const side=sideTitle('Seguimiento de productos'),filter=n('select');filter.id='chat-case-filter';filter.setAttribute('aria-label','Filtrar incidencias');for(const [id,label]of [['open','Pendientes y en proceso'],...Object.entries(S),['all','Todos los casos']]){const opt=n('option',label);opt.value=id;opt.selected=id===caseFilter;filter.append(opt);}filter.addEventListener('change',()=>{caseFilter=filter.value;run(()=>caseList(true));});side.append(filter);
  if(!r.cases.length)side.append(n('p','No hay solicitudes en este estado.','chat-empty'));
  for(const c of r.cases){let m=messages.get(c.id);if(!m){const r=await api.chat.list({id:c.id});guard(s);m=r.messages[0];if(panel!=='cases'||turn!==caseListTurn||caseFilter!==wanted)return;if(m)messages.set(m.id,m);}if(!m||m.damaged)continue;const item=b('',()=>openThread(c.id),'chat-case-item');item.append(n('strong',m.body.product.code),n('span',m.body.product.description||'Producto por identificar'),n('small',S[c.status]+(c.assigned_to?' · '+name(c.assigned_to):'')));side.append(item);}
  if(r.more)side.append(b('Más casos',()=>run(()=>caseList(false))));
 }
 async function openThread(id){const turn=++threadTurn;caseListTurn++;return run(async s=>{
  let m=messages.get(id);if(!m){const r=await api.chat.list({id});guard(s);m=r.messages[0];if(m)messages.set(m.id,m);}if(!m||m.damaged)throw new Error('No se encontró una conversación verificable.');
  if(m.parent_id){id=m.parent_id;const r=await api.chat.list({id});guard(s);m=r.messages[0];if(m)messages.set(m.id,m);}if(!m)throw new Error('No se encontró el mensaje original.');
  if(turn!==threadTurn||!active)return;panel='thread';thread=id;selectReply(id);await refreshThread();guard(s);
 });}
 async function refreshThread(before=0){
  if(!thread)return;if(!before&&$('chat-side')?.querySelector('form[data-dirty]'))return;const s=sequence,id=thread,m=messages.get(id);const r=await api.chat.list({parent:id,before});guard(s);if(thread!==id||panel!=='thread')return;
  if(m.kind==='case'){const c=await api.chat.cases({ids:[id]});guard(s);if(thread!==id||panel!=='thread')return;if(c.cases[0])caseMap.set(id,c.cases[0]);}
  const side=sideTitle('Conversación del producto');side.append(messageCard(m,true));
  if(r.more)side.append(b('Respuestas anteriores',()=>run(()=>refreshThread(r.messages[0]?.seq))));for(const reply of r.messages)side.append(messageCard(reply,true));if(!r.messages.length)side.append(n('p','Escribe abajo para comentar sobre esta consulta.','chat-empty'));
  const c=caseMap.get(id);if(c){side.append(b('Seguir esta solicitud',()=>run(async s=>{await api.chat.follow(c.id);guard(s);status('Recibirás las actualizaciones de esta solicitud.');})));if(user.role==='admin')caseForm(side,c,m);side.append(b('Historial de seguimiento',()=>run(()=>showCaseHistory(c.id,side))));}
 }
 async function showCaseHistory(id,side,before){const s=sequence,r=await api.chat.caseHistory(id,before);guard(s);if(!side.isConnected||thread!==id||panel!=='thread')return;for(const event of r.events){const item=n('div',undefined,'chat-event');item.append(n('strong',S[event.status]+' · '+name(event.changed_by)),n('p',event.resolution?.note||''),n('small',when(event.created_at)));side.append(item);}if(!r.events.length)side.append(n('p','Sin cambios todavía.'));if(r.more)side.append(b('Más cambios',event=>{event.currentTarget.remove();run(()=>showCaseHistory(id,side,r.events.at(-1).revision));}));}
 function label(text,input){const l=n('label',text,'chat-field');l.append(input);return l;}
 function caseForm(side,c,m){
  let pendingChange=null;
  const form=n('form',undefined,'chat-resolution-form'),state=n('select'),assignee=n('select'),note=n('textarea');state.setAttribute('aria-label','Estado de la solicitud');assignee.setAttribute('aria-label','Asignar solicitud');note.setAttribute('aria-label','Motivo y solución');note.required=true;note.maxLength=1000;
  for(const [id,value]of Object.entries(S)){const o=n('option',value);o.value=id;o.selected=id===c.status;state.append(o);}const nobody=n('option','Sin asignar');nobody.value='';assignee.append(nobody);for(const mem of members.filter(m=>m.role==='admin')){const o=n('option',name(mem.id));o.value=mem.id;o.selected=mem.id===c.assigned_to;assignee.append(o);}
  form.addEventListener('input',()=>{form.dataset.dirty='true';});form.addEventListener('change',()=>{form.dataset.dirty='true';});
  const save=b('Guardar seguimiento');save.type='submit';form.append(n('h3','Gestionar solicitud'),label('Estado',state),label('Responsable',assignee),label('Motivo o solución',note),save);
  const productActions=n('div',undefined,'chat-actions');productActions.append(b('Buscar de nuevo',()=>openLookup(m.body.product.code,false,m.body.product.identifier||'barcode')),b('Asociar o registrar producto',()=>openLookup(m.body.product.code,true,m.body.product.identifier||'barcode')));form.append(productActions);
  form.addEventListener('submit',event=>{event.preventDefault();run(async s=>{save.disabled=true;try{
    if(!pendingChange){const ticket=await api.chat.caseTicket(c,state.value,assignee.value,note.value,c.resolution?.product||null);guard(s);pendingChange=ticket;}guard(s);const result=await api.chat.updateCase(pendingChange);guard(s);pendingChange=null;delete form.dataset.dirty;caseMap.set(c.id,result);await refreshThread();guard(s);status('Seguimiento guardado para todo el equipo.');render();
   }catch(error){if(error.code==='40001'){pendingChange=null;delete form.dataset.dirty;await refreshThread();}throw error;}finally{if(save.isConnected){save.disabled=false;save.textContent=pendingChange?'Reintentar seguimiento':'Guardar seguimiento';for(const control of [state,assignee,note])control.disabled=Boolean(pendingChange);}}});});side.append(form);
 }
 let scannerPromise;
 function scannerReady(){if(window.MobileScanner)return Promise.resolve();if(!scannerPromise){const script=path=>new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=path;el.onload=resolve;el.onerror=()=>reject(new Error('No se pudo cargar el lector. Escribe el código manualmente.'));document.head.append(el);});scannerPromise=script('vendor/zxing-browser.min.js').then(()=>script('vendor/zxing-wasm-reader.js')).then(()=>script('mobile-scanner.js?v=2')).catch(error=>{scannerPromise=null;throw error;});}return scannerPromise;}
 function stopCamera(){scanGeneration++;if(scanner){scanner.stop();scanner=null;}const video=$('chat-video');if(video?.srcObject){video.srcObject.getTracks().forEach(t=>t.stop());video.srcObject=null;}const camera=$('chat-camera');if(camera)camera.hidden=true;}
 function modal(title){stopCamera();if(dialog){dialog.close();dialog.remove();}dialog=n('dialog',undefined,'chat-dialog');const head=n('div',undefined,'chat-dialog-header');head.append(n('h2',title),b('Cerrar',()=>dialog.close()));dialog.append(head);dialog.addEventListener('close',stopCamera);document.body.append(dialog);dialog.showModal();return dialog;}
 function openLookup(raw='',manage=false,identifier='barcode'){
  if(!current())return;const d=modal('Consultar y compartir producto');
  const camera=n('div',undefined,'chat-camera');camera.id='chat-camera';camera.hidden=true;const video=n('video');video.id='chat-video';video.autoplay=video.muted=video.playsInline=true;video.setAttribute('aria-label','Escáner de códigos de barras');camera.append(video,b('Detener cámara',stopCamera));d.append(camera);
  const cam=b('Abrir cámara',()=>run(async s=>{stopCamera();const turn=scanGeneration;const owner=d;try{await scannerReady();guard(s);if(!owner.open||turn!==scanGeneration)return;camera.hidden=false;const controls=await MobileScanner.start(video,value=>{if(current(s)&&owner.open){stopCamera();input.value=value;form.requestSubmit();}});if(!current(s)||!owner.open||turn!==scanGeneration){controls.stop();return;}scanner=controls;}catch(error){stopCamera();if(current(s)&&owner.open)msg.textContent='No se pudo abrir la cámara. Escribe el código o usa un lector USB.';}}));d.append(cam);
  const form=n('form',undefined,'chat-lookup-form'),input=n('input'),mode=n('select');input.id='chat-lookup-code';input.required=true;input.maxLength=80;input.autocomplete='off';input.placeholder='Código de barras o referencia';input.value=raw;
  for(const [value,text]of [['barcode','Código de barras'],['reference','Referencia exacta'],['name','Nombre o referencia parcial']]){const o=n('option',text);o.value=value;mode.append(o);}mode.value=identifier;mode.id='chat-lookup-mode';mode.setAttribute('aria-label','Buscar producto por');form.append(mode,label('Producto',input));const submit=b('Consultar');submit.type='submit';form.append(submit);d.append(form);
  const msg=n('p','','chat-caption');msg.id='chat-lookup-status';msg.setAttribute('role','status');const result=n('div');result.id='chat-lookup-result';d.append(msg,result);
  form.addEventListener('submit',event=>{event.preventDefault();lookup(input.value,mode.value,manage);});if(raw)form.requestSubmit();else input.focus();
 }
 let lookupGeneration=0;
 async function lookup(raw,mode='barcode',manage=false){return run(async s=>{
  stopCamera();const d=dialog,msg=$('chat-lookup-status'),box=$('chat-lookup-result'),turn=++lookupGeneration;if(!d?.open||!box)return;box.replaceChildren();msg.classList.remove('chat-error');msg.textContent='Preparando el catálogo existente…';
  const c=controller();const timeout=setTimeout(()=>c.abort(),30000),valid=()=>{guard(s);if(!d.open||!box.isConnected||turn!==lookupGeneration)throw new Error('La consulta cambió.');};
  try{
   if(catalogReady&&await api.mobile.hasUpdates(c.signal))catalogReady=false;valid();if(!catalogReady){await api.mobile.prepare(p=>{if(current(s)&&msg.isConnected)msg.textContent='Preparando documentos: '+(p.done||0)+' de '+(p.total||0);},c.signal);valid();catalogReady=true;}
   const r=await api.mobile.lookup(raw,c.signal,mode);valid();
   if(mode==='name'){msg.textContent=(r.candidateCount||0)+' coincidencias. Selecciona el producto exacto.';for(const candidate of r.candidates||[])box.append(b(candidate.product.descripcion+' · '+(candidate.product.codigo||candidate.product.ref),()=>{const v=candidate.product.codigo||candidate.product.ref;lookup(v,candidate.product.codigo?'barcode':'reference',manage);},'chat-candidate'));return;}
   if(r.match?.ambiguousReference)throw new Error('La referencia corresponde a varios códigos. Consulta el código exacto.');
   const p=snapshot(raw,r,mode);msg.textContent=p.result==='incomplete'?'El catálogo está incompleto. Se puede solicitar revisión sin confirmar una ausencia.':'Consulta completada. Escanear no modifica el inventario.';box.append(productCard(p));
   if(p.result==='found')box.append(b('Compartir en el chat',()=>shareProduct(p)));else box.append(b('Solicitar solución',()=>requestCase(p)));
   if(user.role==='admin'){if(p.identifier!=='reference')box.append(b('Registrar o asociar este código',()=>adminProduct(box,p)));if(p.result==='found')box.append(b('Editar precio',()=>adminPrice(box,p,r)));if(manage&&p.identifier!=='reference')adminProduct(box,p);}
  }finally{clearTimeout(timeout);requests.delete(c);}
 });}
 function snapshot(raw,r,mode='barcode'){const match=r.match,p=match?.product,override=r.price?.override;return {version:1,result:match?'found':r.failed||r.unidentified||r.stale?'incomplete':'missing',code:p?.codigo?C.code(p.codigo):mode==='reference'?String(raw).trim():C.code(raw),identifier:p?.codigo||mode!=='reference'?'barcode':'reference',description:p?.descripcion||'',ref:p?.ref||'',cents:override?override.cents:Number.isFinite(p?.pventa)?Math.round(p.pventa*100):null,source:override?'Precio administrativo':match?.doc?.kind==='registered'?'Registro administrativo':match?'Precio de la última factura':'Archivo de documentos',salida:match?.doc?.salida||'',invoiceDate:match?.doc?.invoiceDate||'',checkedAt:r.price?.checkedAt||new Date().toISOString(),sourceCode:p?.codigo||'',note:''};}
 async function shareProduct(p){return run(async s=>{const d=dialog,key=JSON.stringify([p,reply]),btns=[...d.querySelectorAll('button')];for(const btn of btns)btn.disabled=true;try{let ticket=pendingShares.get(key);if(!ticket){ticket=await api.chat.ticket({version:1,product:p},'product',reply);guard(s);pendingShares.set(key,ticket);}const row=await api.chat.send(ticket);guard(s);pendingShares.delete(key);absorb([row]);render();if(dialog===d)d.close();status('Producto compartido y guardado.');}finally{for(const btn of btns)btn.disabled=false;}});}
 async function requestCase(p){return run(async s=>{const d=dialog,key=(p.identifier||'barcode')+'|'+p.code;let ticket=pendingCases.get(key);if(!ticket){ticket=await api.chat.ticket({version:1,product:p},'case');guard(s);pendingCases.set(key,ticket);}const c=await api.chat.openCase(p,ticket);guard(s);pendingCases.delete(key);caseMap.set(c.id,c);if(dialog===d){d.close();await openThread(c.id);guard(s);}render();status('Solicitud compartida. Si ya existía una pendiente, te vinculamos a esa misma.');});}
 function adminProduct(box,p){
  let pendingProduct=null,pendingResolution=null;
  if(box.querySelector('.chat-register-form'))return;const form=n('form',undefined,'chat-register-form'),description=n('input'),ref=n('input'),price=n('input'),source=n('input'),reason=n('input');description.value=p.description;description.required=true;description.maxLength=2048;ref.value=p.ref;ref.maxLength=120;price.value=p.cents===null?'':(p.cents/100).toFixed(2);price.inputMode='decimal';price.disabled=p.result==='found';source.placeholder='Código del producto existente, si es una asociación';source.maxLength=80;reason.required=true;reason.maxLength=500;
  const save=b('Guardar producto o asociación');save.type='submit';form.append(n('h3','Administrar producto'),n('p','Código consultado: '+p.code,'chat-caption'),label('Descripción',description),label('Referencia',ref),label('Precio confirmado (USD)',price),label('Asociar al código existente (opcional)',source),label('Motivo obligatorio',reason),n('p','Este registro pertenece al catálogo de consulta de MegaControl. Las existencias del sistema de caja se administran en ese sistema.','chat-caption'),save);
  form.addEventListener('submit',event=>{event.preventDefault();run(async s=>{save.disabled=true;try{let chosen={...p,result:'found',description:description.value.trim(),ref:ref.value.trim(),cents:parsePrice(price.value,true),source:'Registro administrativo',checkedAt:new Date().toISOString(),sourceCode:'',note:reason.value.trim()};
   if(source.value.trim()){const target=C.code(source.value);if(target===p.code)throw new Error('El código asociado debe corresponder a otro producto existente.');const r=await api.mobile.lookup(target);guard(s);if(!r.match||r.match.ambiguousReference)throw new Error('No hay un producto único para ese código. Compruébalo antes de asociar.');chosen={...snapshot(target,r),code:p.code,sourceCode:r.match.product.lookupCode||target,source:'Asociación administrativa',note:reason.value.trim()};}
   const old=await api.chat.catalogProduct(p.code);guard(s);if(!pendingProduct){const ticket=await api.chat.productTicket(chosen,old?.version||0);guard(s);pendingProduct=ticket;}guard(s);await api.chat.putProduct(pendingProduct);guard(s);pendingProduct=null;
   if(thread&&caseMap.get(thread)){const c=caseMap.get(thread);if(!pendingResolution){const ticket=await api.chat.caseTicket(c,'resolved',user.id,reason.value,chosen);guard(s);pendingResolution=ticket;}guard(s);await api.chat.updateCase(pendingResolution);guard(s);pendingResolution=null;await refreshThread();guard(s);}
   dialog.close();status('Producto guardado. Las próximas consultas usarán este registro.');await refresh();
  }finally{if(save.isConnected)save.disabled=false;}});});box.append(form);description.focus();
 }
 function parsePrice(raw,optional=false){if(optional&&!raw.trim())return null;const m=/^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(raw.trim());if(!m)throw new Error('Precio inválido. Usa por ejemplo 7.99.');return Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));}
 function adminPrice(box,p,r){if(box.querySelector('.chat-price-form'))return;const form=n('form',undefined,'chat-price-form'),price=n('input'),reason=n('input');price.value=p.cents===null?'':(p.cents/100).toFixed(2);price.required=true;price.inputMode='decimal';price.setAttribute('aria-label','Nuevo precio');reason.required=true;reason.maxLength=500;const save=b('Guardar precio compartido');save.type='submit';form.append(n('h3','Cambio de precio administrativo'),label('Nuevo precio (USD)',price),label('Motivo',reason),save);form.addEventListener('submit',e=>{e.preventDefault();run(async s=>{save.disabled=true;try{const code=r.match.product.lookupCode||p.sourceCode||p.code;await api.mobile.setPrice(code,parsePrice(price.value),r.price?.override?.version||0,undefined,{reason:reason.value,previousCents:p.cents});guard(s);form.remove();await lookup(p.code);guard(s);status('Precio guardado con historial administrativo.');}finally{if(save.isConnected)save.disabled=false;}});});box.append(form);price.focus();}
 async function login(){if(!api?.status().authenticated||!api.chat)return;const a=api.status();if(epoch===a.generation)return;sequence++;epoch=a.generation;user=a.user;layout();active=window.TrazaUI.currentSection==='chat';const s=sequence;try{members=await api.chat.members();guard(s);await refresh();}catch(error){if(current(s))status('No se pudo abrir el chat: '+error.message,true);}}
 function navigate(){active=window.TrazaUI?.currentSection==='chat';if(!active){stopCamera();if(dialog?.open)dialog.close();return;}if(api?.status().authenticated){if(epoch!==api.status().generation)login();else{showSync();refresh();}}}
 function boot(){api=window.AuditCloud;if(!api?.chat){root.replaceChildren(n('p','El chat requiere el acceso compartido de MegaControl en Supabase.'));return;}clear();window.addEventListener('audit:authenticated',login);window.addEventListener('audit:logout',clear);window.addEventListener('traza-ui:navigated',navigate);
  window.addEventListener('audit:changed',event=>{if(!current())return;const table=event.detail?.table;if(['all','mega_chat_messages','mega_chat_cases','mega_chat_notifications'].includes(table)){clearTimeout(timer);timer=setTimeout(refresh,200);}if(['all','mega_audit_records','mega_chat_products'].includes(table))catalogReady=false;});
  const fit=()=>root.style.setProperty('--chat-viewport',(window.visualViewport?.height||window.innerHeight)+'px');if(window.visualViewport)window.visualViewport.addEventListener('resize',fit);window.addEventListener('resize',fit);fit();
  window.addEventListener('audit:sync-status',showSync);window.addEventListener('offline',()=>{stopCamera();showSync();});window.addEventListener('online',()=>{showSync();refresh();});document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();else refresh();});window.addEventListener('pagehide',clear);
  setInterval(()=>{if(!current()||document.hidden)return;const interval=api.status().syncMode==='live'?120000:30000;if(Date.now()-lastSync>=interval)refresh();},30000);login();
 }
 boot();
})();
