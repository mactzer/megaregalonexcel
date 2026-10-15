(function (root) {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const HEADER = 'respaldo.megacontrol.json', PREVIOUS = 'respaldo-anterior.megacontrol.json';
  const LIMIT = 25 * 1024 * 1024 + 64, JSON_LIMIT = 64 * 1024 * 1024;
  const TABLES = ['mega_audit_workspace','mega_audit_members','mega_audit_user_keys','mega_audit_records','mega_audit_operations','mega_product_prices','mega_product_queries'];
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
  const cryptoApi = () => root.AuditCrypto || (typeof require === 'function' && require('./audit-crypto.js'));
  const fail = message => { throw new Error(message); };
  const noop = () => {};
  const b64 = value => cryptoApi().encodeBase64Url(value);
  const unb64 = value => cryptoApi().decodeBase64Url(value);
  const standard = value => unb64(String(value).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''));
  async function hash(value) { return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',value)), b=>b.toString(16).padStart(2,'0')).join(''); }
  function parts(name, workspace) {
    const p = typeof name === 'string' ? name.split('/') : [];
    if (p.length!==4 || p[0]!==workspace || !UUID.test(p[1]) || !UUID.test(p[2]) || !['pdf.bin','excel.bin','image.bin'].includes(p[3])) fail('Ruta de documento inválida en el respaldo.');
    return {id:p[2], kind:p[3].split('.')[0]};
  }
  function validateSnapshot(s,workspace) {
    if (!s || s.version!==1 || !UUID.test(workspace) || s.workspace_id!==workspace || !Number.isFinite(Date.parse(s.created_at)) || !s.tables || !Array.isArray(s.objects) || !Array.isArray(s.authors)) fail('Instantánea de respaldo inválida.');
    for (const name of TABLES) {
      if (!Array.isArray(s.tables[name])) fail('Faltan datos del respaldo: '+name);
      for (const row of s.tables[name]) if ((name==='mega_audit_workspace'?row.id:row.workspace_id)!==workspace) fail('El respaldo contiene datos de otro equipo.');
    }
    if(s.tables.mega_salidas!==undefined){if(!Array.isArray(s.tables.mega_salidas))fail('Identidades de salidas inválidas.');for(const row of s.tables.mega_salidas)if(row.workspace_id!==workspace)fail('El respaldo contiene identidades de otro equipo.');}
    if(s.tables.mega_product_price_history!==undefined){if(!Array.isArray(s.tables.mega_product_price_history))fail('Historial de precios inválido.');for(const row of s.tables.mega_product_price_history)if(row.workspace_id!==workspace)fail('El respaldo contiene precios de otro equipo.');}
    for(const [name,rows] of Object.entries(s.tables))if(name.startsWith('mega_chat_')){if(!Array.isArray(rows)||rows.some(row=>row.workspace_id!==workspace))fail('Datos del chat de otro equipo.');}
    const w=s.tables.mega_audit_workspace;
    if (w.length!==1 || !/^[0-9a-f]{64}$/.test(w[0].key_fingerprint)) fail('Clave del equipo inválida.');
    const paths=new Set();
    for(const o of s.objects) { const part=parts(o.name,workspace);if(o.bucket&&o.bucket!==(part.kind==='image'?'mega-chat-images':'mega-audit-documents'))fail('Bucket inválido en el respaldo.'); if(paths.has(o.name)) fail('Documento duplicado en el respaldo.'); paths.add(o.name); }
    for(const f of s.tables.mega_chat_files||[])if(f.attached&&!paths.has(f.path))fail('Falta la foto de un mensaje del chat.');
    const ids=new Set();
    for(const r of s.tables.mega_audit_records) {
      if(!UUID.test(r.id)||!UUID.test(r.created_by)||ids.has(r.id)) fail('Registro inválido en el respaldo.'); ids.add(r.id);
      for(const kind of ['pdf','excel']) if(r[kind+'_path']!==workspace+'/'+r.created_by+'/'+r.id+'/'+kind+'.bin'||!paths.has(r[kind+'_path'])) fail('Falta el '+kind.toUpperCase()+' de una salida. No se puede completar el respaldo.');
    }
    return s;
  }
  async function fileHandle(folder,path,create) {
    const p=path.split('/'); let parent=folder;
    if(p.some(x=>!x||x==='.'||x==='..'||/[\\\x00-\x1f]/.test(x))) fail('Ruta local inválida.');
    for(const part of p.slice(0,-1)) parent=await parent.getDirectoryHandle(part,{create:!!create});
    return parent.getFileHandle(p[p.length-1],{create:!!create});
  }
  async function read(folder,path,limit) {
    const f=await (await fileHandle(folder,path,false)).getFile();
    if(f.size>limit) fail('El archivo del respaldo excede el tamaño permitido.');
    return new Uint8Array(await f.arrayBuffer());
  }
  async function optionalRead(folder,path,limit) { try{return await read(folder,path,limit);}catch(e){if(e.name==='NotFoundError')return null;throw e;} }
  async function write(folder,path,data,guard=noop) {
    guard(); const handle=await fileHandle(folder,path,true); guard(); const stream=await handle.createWritable();
    try { guard();await stream.write(data);guard();await stream.close();guard(); }
    catch(e){try{await stream.abort();}catch(_){}throw e;}
  }
  async function parseHeader(raw,password) {
    let h;try{h=JSON.parse(dec.decode(raw));}catch(_){fail('El archivo principal del respaldo está dañado.');}
    if(!h||h.format!=='MegaControl'||h.version!==1||!UUID.test(h.workspace)||typeof h.salt!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(h.salt)) fail('Formato de respaldo no compatible.');
    let recovery,key,clear;
    try {
      const unlock=await cryptoApi().unlockUser('respaldo',password,h.workspace+'|'+h.salt);
      recovery=await unlock.unwrapRecoveryKey(unb64(h.wrappedKey)); key=await cryptoApi().unlock(recovery,h.workspace);
      clear=await key.decrypt(unb64(h.manifest),'backup-manifest-v1|'+h.salt);
      const manifest=JSON.parse(dec.decode(clear));validateSnapshot(manifest.snapshot,h.workspace);
      if(!Array.isArray(manifest.files)||manifest.files.length!==manifest.snapshot.objects.length||manifest.snapshot.tables.mega_audit_workspace[0].key_fingerprint!==key.fingerprint) fail('No se pudo verificar la clave del respaldo.');
      const expected=new Set(manifest.snapshot.objects.map(o=>o.name));
      for(const f of manifest.files) { parts(f.name,h.workspace);if(!expected.delete(f.name)||!/^[0-9a-f]{64}$/.test(f.sha256)||!Number.isInteger(f.size)||f.size<29||f.size>LIMIT) fail('Inventario de documentos inválido.'); }
      if(expected.size) fail('El inventario de documentos está incompleto.');
      return {header:h,manifest,key,recovery};
    } catch(e){if(e.message.includes('contraseña')||e.message.includes('descifrar')) fail('La contraseña no coincide o el respaldo está dañado.');throw e;}
    finally{if(clear)clear.fill(0);}
  }
  async function checkRows(snapshot,key,guard=noop) {
    const decoded={records:[],prices:[],queries:[]};
    async function row(value,context) { let data;try{guard();data=await key.decrypt(standard(value),context);guard();return JSON.parse(dec.decode(data));}finally{if(data)data.fill(0);} }
    for(const r of snapshot.tables.mega_audit_records) {
      const metadata=await row(r.encrypted_metadata,r.id+'|metadata');
      decoded.records.push({...r,metadata});
      if(r.encrypted_review) await row(r.encrypted_review,'audit-review-v1|'+r.id);
    }
    for(const p of snapshot.tables.mega_product_prices) decoded.prices.push({...p,price:await row(p.encrypted_price,'product-price-v1|'+p.product_tag+'|'+p.version)});
    for(const q of snapshot.tables.mega_product_queries) decoded.queries.push({...q,query:await row(q.encrypted_query,'product-query-v1|'+q.id)});
    decoded.chat={};
    for(const [name,items]of Object.entries(snapshot.tables))if(name.startsWith('mega_chat_')){
      decoded.chat[name]=[];
      for(const r of items){let value=null;
        if(r.encrypted_body)value=await row(r.encrypted_body,'chat-message-v1|'+r.id);
        if(r.encrypted_resolution)value=await row(r.encrypted_resolution,'chat-case-v1|'+(r.case_id||r.id)+'|'+r.revision);
        if(r.encrypted_product)value=await row(r.encrypted_product,'chat-product-v1|'+r.product_tag+'|'+r.version);
        decoded.chat[name].push(value?{...r,content:value}:r);
      }
    }
    return decoded;
  }
  async function verifyFile(data,f,key,workspace,guard=noop) {
    if(data.length!==f.size||await hash(data)!==f.sha256) fail('Documento incompleto o alterado: '+f.name);
    const p=parts(f.name,workspace);let clear;
    try{guard();clear=await key.decrypt(data,(p.kind==='image'?'chat-image-v1|'+p.id:p.id+'|'+p.kind));guard();}finally{if(clear)clear.fill(0);}
  }
  async function save(options) {
    const {folder,password,snapshot,key,recovery,guard=noop,progress=noop}=options;
    const workspace=snapshot.workspace_id;validateSnapshot(snapshot,workspace);guard();
    if(key.fingerprint!==snapshot.tables.mega_audit_workspace[0].key_fingerprint) fail('La clave no pertenece a este equipo.');
    const previousRaw=await optionalRead(folder,HEADER,JSON_LIMIT);
    if(!previousRaw&&typeof folder.entries==='function') {
      for await(const [name]of folder.entries())if(!['documents','recuperar.html',HEADER,PREVIOUS].includes(name))fail('Selecciona una carpeta vacía o una carpeta de respaldo de MegaControl.');
    }
    const previous=previousRaw?await parseHeader(previousRaw,password):null;guard();
    if(previous&&(previous.header.workspace!==workspace||previous.key.fingerprint!==key.fingerprint)) fail('Esta carpeta corresponde a otro equipo. Selecciona otra carpeta.');
    await checkRows(snapshot,key,guard);
    const old=new Map(previous?previous.manifest.files.map(f=>[f.name,f]):[]), files=[];
    let downloaded=0,reused=0,totalBytes=0;
    for(const o of snapshot.objects) {
      guard();let f=old.get(o.name),data=f?await optionalRead(folder,'documents/'+f.sha256+'.bin',LIMIT):null,valid=false;
      if(data)try{if(f&&f.updated_at===o.updated_at){await verifyFile(data,f,key,workspace,guard);valid=true;}}catch(e){guard();}
      if(!valid) {
        if(data)data.fill(0);data=await options.download(o.name,o.bucket||'mega-audit-documents');guard();
        if(!(data instanceof Uint8Array)||data.length<29||data.length>LIMIT||(o.size!==null&&o.size!==undefined&&Number(o.size)!==data.length)) fail('Tamaño de documento inesperado.');
        f={name:o.name,...(o.bucket?{bucket:o.bucket}:{}),size:data.length,sha256:await hash(data),updated_at:o.updated_at};
        const local='documents/'+f.sha256+'.bin';
        await verifyFile(data,f,key,workspace,guard);await write(folder,local,data,guard);
        const saved=await read(folder,local,LIMIT);try{await verifyFile(saved,f,key,workspace,guard);}finally{saved.fill(0);} downloaded++;totalBytes+=data.length;
      } else reused++;
      files.push(f);data.fill(0);progress({done:files.length,total:snapshot.objects.length,downloaded,reused,bytes:totalBytes});
    }
    guard();await options.authorize();guard();
    const salt=previous?previous.header.salt:b64(root.crypto.getRandomValues(new Uint8Array(16)));
    const unlock=await cryptoApi().unlockUser('respaldo',password,workspace+'|'+salt);guard();
    const clear=enc.encode(JSON.stringify({snapshot,files}));let header;
    try { header=enc.encode(JSON.stringify({format:'MegaControl',version:1,workspace,salt,wrappedKey:b64(await unlock.wrapRecoveryKey(recovery)),manifest:b64(await key.encrypt(clear,'backup-manifest-v1|'+salt))})); }finally{clear.fill(0);}
    guard();await options.authorize();guard();await write(folder,'recuperar.html',enc.encode(options.recoveryPage),guard);
    if(previousRaw) await write(folder,PREVIOUS,previousRaw,guard);
    await write(folder,HEADER,header,guard);
    const saved=await read(folder,HEADER,JSON_LIMIT);await parseHeader(saved,password);guard();
    return {records:snapshot.tables.mega_audit_records.length,files:files.length,downloaded,reused,bytes:totalBytes};
  }
  async function open(folder,password,progress=noop,guard=noop,previous=false) {
    const value=await parseHeader(await read(folder,previous?PREVIOUS:HEADER,JSON_LIMIT),password);guard();
    value.decoded=await checkRows(value.manifest.snapshot,value.key,guard);
    let done=0;
    for(const f of value.manifest.files){const data=await read(folder,'documents/'+f.sha256+'.bin',LIMIT);try{await verifyFile(data,f,value.key,value.header.workspace,guard);}finally{data.fill(0);}progress({done:++done,total:value.manifest.files.length});}
    guard();return value;
  }
  async function restore(folder,password,output,progress=noop,guard=noop,previous=false) {
    const value=await open(folder,password,progress,guard,previous), prefix='MegaControl-recuperado-'+Date.now()+'-'+root.crypto.randomUUID().slice(0,8);
    const target=await output.getDirectoryHandle(prefix,{create:true});
    for(const f of value.manifest.files){let clear;const data=await read(folder,'documents/'+f.sha256+'.bin',LIMIT),p=parts(f.name,value.header.workspace);
      try{await verifyFile(data,f,value.key,value.header.workspace,guard);clear=await value.key.decrypt(data,(p.kind==='image'?'chat-image-v1|'+p.id:p.id+'|'+p.kind));guard();await write(target,'archivos/'+p.id+'/'+(p.kind==='image'?'imagen.webp':p.kind==='pdf'?'original.pdf':'original.xlsx'),clear,guard);await write(target,'storage/'+(p.kind==='image'?'mega-chat-images':'mega-audit-documents')+'/'+f.name,data,guard);}
      finally{data.fill(0);if(clear)clear.fill(0);}
    }
    guard();await write(target,'datos-recuperados.json',enc.encode(JSON.stringify({snapshot:value.manifest.snapshot,...value.decoded},null,2)),guard);
    await write(target,'inventario.json',enc.encode(JSON.stringify({workspace:value.header.workspace,files:value.manifest.files},null,2)),guard);
    await write(target,'clave-privada.txt',enc.encode(value.recovery+'\n'),guard);
    await write(target,'LEEME.txt',enc.encode('MegaControl: recuperación verificada.\nLos archivos de esta carpeta y la clave están DESCIFRADOS; guárdalos en privado.\narchivos/: PDF y Excel originales por identificador. datos-recuperados.json: datos completos y metadatos legibles.\nstorage/: copias cifradas para recuperar Supabase sin cambiar rutas.\nLas cuentas de acceso de Supabase Auth y sus contraseñas no se copian. Para recuperar un proyecto completo se deben restablecer por separado.\nLa recuperación no modifica la base de datos activa. Consulta supabase/RESPALDOS.md para la restauración controlada de datos.\n'),guard);
    return {folder:prefix,records:value.decoded.records.length,files:value.manifest.files.length};
  }
  // This function is also embedded in recuperar.html; it works completely offline.
  function recoveryUi() {
    const byId=id=>document.getElementById(id), form=byId('recovery-form'), feedback=byId('feedback');let working=false;
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(working)return;
      const action=event.submitter&&event.submitter.value||'verify', password=byId('password').value;
      if(typeof window.showDirectoryPicker!=='function'){feedback.textContent='Abre esta herramienta en Chrome o Edge de computadora para seleccionar las carpetas.';return;}
      let selection;try{selection=window.showDirectoryPicker({mode:'read',id:'megacontrol-recovery'});selection.catch(()=>{});}catch(e){feedback.textContent=e.message;return;}working=true;
      for(const b of form.querySelectorAll('button'))b.disabled=true;
      try {
        const folder=await selection;feedback.textContent='Verificando datos, clave y documentos…';
        const progress=p=>{feedback.textContent='Verificados '+p.done+' de '+p.total+' documentos.';};
        const value=await AuditBackup.open(folder,password,progress,undefined,byId('previous').checked);
        if(action==='restore') {
          // A separate click retains the browser gesture for choosing the destination.
          feedback.textContent='Copia verificada. Pulsa «Elegir destino y recuperar»; los archivos recuperados serán privados y sin cifrar.';
          const next=document.createElement('button');next.type='button';next.textContent='Elegir destino y recuperar';form.after(next);
          next.addEventListener('click',async()=>{next.disabled=true;
            try{const target=window.showDirectoryPicker({mode:'readwrite',id:'megacontrol-restored'});target.catch(()=>{});const result=await AuditBackup.restore(folder,password,await target,progress,undefined,byId('previous').checked);feedback.textContent='Recuperados '+result.records+' registros y '+result.files+' documentos en '+result.folder+'.';next.remove();}
            catch(e){feedback.textContent=e.name==='AbortError'?'Recuperación cancelada.':e.message;next.disabled=false;}
          });
        } else feedback.textContent='Respaldo verificado: '+value.decoded.records.length+' registros y '+value.manifest.files.length+' documentos. La clave funciona y los archivos se pueden descifrar.';
      }catch(e){feedback.textContent=e.name==='AbortError'?'Selección cancelada.':e.message;}
      finally{working=false;byId('password').value='';for(const b of form.querySelectorAll('button'))b.disabled=false;}
    });
  }
  function offlinePage(cryptoSource,backupSource) {
    const safe=s=>s.replace(/<\/script/gi,'<\\/script');
    return '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Recuperar respaldo · MegaControl</title><style>body{font:16px system-ui;max-width:650px;margin:48px auto;padding:20px;color:#123d35;background:#f4f8f6}input,button{font:inherit;padding:12px;margin:8px 0}input[type=password]{display:block;width:90%}button{cursor:pointer}#feedback{line-height:1.6}</style><h1>Recuperar respaldo de MegaControl</h1><p>Selecciona la carpeta completa del respaldo y escribe su contraseña. Esta herramienta funciona sin internet en Chrome o Edge de computadora.</p><form id="recovery-form"><label>Contraseña del respaldo<input id="password" type="password" required minlength="12" maxlength="1024" autocomplete="off"></label><label><input id="previous" type="checkbox"> Usar el respaldo anterior si el último guardado se interrumpió</label><p><button value="verify">Verificar respaldo</button> <button value="restore">Recuperar archivos y datos</button></p></form><p id="feedback" role="status" aria-live="polite"></p><script>'+safe(cryptoSource)+'<\/script><script>'+safe(backupSource)+'<\/script><script>AuditBackup.recoveryUi();<\/script></html>';
  }
  const api=Object.freeze({save,open,restore,offlinePage,recoveryUi,validateSnapshot,hash,TABLES});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.AuditBackup=api;
})(typeof globalThis!=='undefined'?globalThis:this);
