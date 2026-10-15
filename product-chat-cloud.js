(function(root){
 'use strict';
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 const STATES=Object.freeze({pending:'Pendiente de revisión',in_progress:'En proceso',resolved:'Resuelto',unidentifiable:'No identificable'});
 const STICKERS=Object.freeze({ok:['👍','Confirmado'],checking:['🔎','Lo estoy revisando'],thanks:['🙌','¡Gracias!'],box:['📦','En bodega'],wait:['⏳','Un momento'],done:['✅','Resuelto']});
 function text(value,max,empty=true){if(typeof value!=='string'||value.length>max||!empty&&!value.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw new Error('Texto inválido o demasiado largo.');return value;}
 function code(value){value=text(String(value??'').trim(),80,false);if(/\s/.test(value))throw new Error('El código no puede contener espacios.');return /^\d{12}$/.test(value)?'0'+value:value;}
 function product(p){
  if(!p||p.version!==1||!['found','missing','incomplete'].includes(p.result))throw new Error('Tarjeta de producto inválida.');
  if(p.identifier==='reference')text(p.code,80,false);else code(p.code);text(p.description,2048);text(p.ref,120);text(p.salida,60);text(p.source,120);
  if(p.cents!==null&&(!Number.isSafeInteger(p.cents)||p.cents<0||p.cents>999999999))throw new Error('Precio inválido.');
  if(!Number.isFinite(Date.parse(p.checkedAt)))throw new Error('Falta la fecha de consulta.');
  if(p.sourceCode){if(p.identifier==='reference')text(p.sourceCode,80,false);else code(p.sourceCode);}if(p.invoiceDate&&!/^\d{4}-\d{2}-\d{2}$/.test(p.invoiceDate))throw new Error('Fecha de factura inválida.');
  if(p.note!==undefined)text(p.note,500);return p;
 }
 function body(value,kind){
  if(!value||value.version!==1)throw new Error('Mensaje no compatible.');
  if(['text','image'].includes(kind))text(value.text,4000,kind==='image');
  else if(kind==='sticker'){if(!STICKERS[value.sticker])throw new Error('Sticker no válido.');}
  else product(value.product);
  if(kind==='image'&&!value.image)throw new Error('Falta la imagen del mensaje.');
  if(value.image&&!['image/webp','image/jpeg','image/png'].includes(value.image.mime))throw new Error('Imagen no válida.');
  return value;
 }
 function create(options){
  const {workspace,request,context}=options,base='/rest/v1/';
  let registry=null,registryScope=null,registryTime=0;
  const invalidate=()=>{registry=null;registryTime=0;};
  const rpc=async(name,args,signal)=>{try{return await request(base+'rpc/mega_chat_'+name,{method:'POST',body:{p_workspace_id:workspace,...args},signal});}catch(error){
    if(error.code==='42501')error.message='Tu cuenta no tiene permisos para esta operación. Comprueba tu acceso.';
    if(error.code==='40001')error.message='Otro administrador cambió estos datos. Cierra y vuelve a abrir la consulta antes de guardar.';
    if(error.code==='23505')error.message='El identificador pertenece a otro envío. Recupera la conversación antes de reintentar.';
    if(error.code==='54000')error.message=name==='image_prepare'?'Se alcanzó el límite de 80 MB de fotos del chat. Puedes seguir enviando mensajes de texto.':'Espera un momento antes de enviar más mensajes.';
    throw error;
   }};
  const select=(table,query,signal)=>request(base+'mega_chat_'+table+'?workspace_id=eq.'+workspace+'&'+query,{signal});
  const checked=async(ctx,work)=>{const result=await work;ctx.guard();return result;};
  async function decode(row,ctx){
   if(!row||row.workspace_id!==workspace||!UUID.test(row.id)||!UUID.test(row.created_by)||!Number.isSafeInteger(row.seq)||!Number.isFinite(Date.parse(row.created_at)))throw new Error('Mensaje recibido inválido.');
   const value=body(await ctx.open(row.encrypted_body,'chat-message-v1|'+row.id),row.kind);ctx.guard();return {...row,body:value};
  }
  async function list({before=0,after=0,parent=null,id=null,signal}={}){
   const ctx=context();let query='select=*&order=seq.desc&limit=41';
   if(before)query+='&seq=lt.'+Number(before);if(after)query='select=*&order=seq.asc&limit=100&seq=gt.'+Number(after);
   if(parent){if(!UUID.test(parent))throw new Error('Conversación inválida.');query+='&parent_id=eq.'+parent;}
   if(id){if(!UUID.test(id))throw new Error('Mensaje inválido.');query+='&id=eq.'+id;}
   const rows=await checked(ctx,select('messages',query,signal));if(!Array.isArray(rows))throw new Error('Historial inválido.');
   const more=rows.length>(after?99:40),selected=after?rows:rows.slice(0,40),result=[];
   for(const row of selected)try{result.push(await decode(row,ctx));}catch(error){ctx.guard();result.push({...row,damaged:true});}
   ctx.guard();return {messages:result.sort((a,b)=>a.seq-b.seq),more};
  }
  async function ticket(value,kind='text',parent=null,mentions=[]){
   const ctx=context(),id=root.crypto.randomUUID();body(value,kind);if(parent&&!UUID.test(parent))throw new Error('Conversación inválida.');
   const encrypted=await ctx.seal(value,'chat-message-v1|'+id);ctx.guard();
   return {id,workspace,owner:ctx.user.id,kind,parent,mentions:mentions.filter(UUID.test.bind(UUID)).slice(0,20),encrypted};
  }
  async function send(t,signal){
   const ctx=context();if(!t||t.workspace!==workspace||t.owner!==ctx.user.id||!UUID.test(t.id))throw new Error('El envío pertenece a otra cuenta.');
   const row=await checked(ctx,rpc('send',{p_id:t.id,p_kind:t.kind,p_body:t.encrypted,p_parent:t.parent,p_mentions:t.mentions},signal));
   if(row.id!==t.id||row.encrypted_body!==t.encrypted||row.created_by!==ctx.user.id)throw new Error('El envío no se confirmó. Reintenta el mismo mensaje.');
   const result=await decode(row,ctx);ctx.guard();return result;
  }
  async function cases({status='open',before=null,ids=[],signal}={}){
   const ctx=context();let q='select=*&order=updated_at.desc,id.desc&limit=41';
   if(ids.length){if(ids.some(id=>!UUID.test(id)))throw new Error('Caso inválido.');q+='&id=in.('+ids.slice(0,100).join(',')+')';}
   else if(status==='open')q+='&status=in.(pending,in_progress)';else if(STATES[status])q+='&status=eq.'+status;
   if(before){if(!Number.isFinite(Date.parse(before.time))||!UUID.test(before.id))throw new Error('Página inválida.');q+='&or=(updated_at.lt.'+encodeURIComponent(before.time)+',and(updated_at.eq.'+encodeURIComponent(before.time)+',id.lt.'+before.id+'))';}
   const rows=await checked(ctx,select('cases',q,signal));for(const c of rows){if(!STATES[c.status]||!UUID.test(c.id))throw new Error('Caso inválido.');if(c.encrypted_resolution)c.resolution=await ctx.open(c.encrypted_resolution,'chat-case-v1|'+c.id+'|'+c.revision);}
   ctx.guard();return {cases:ids.length?rows:rows.slice(0,40),more:rows.length>40};
  }
  async function openCase(p,t=null,signal){
   const ctx=context();product(p);if(p.result==='found')throw new Error('Este producto ya tiene coincidencia.');
   if(!t)t=await ticket({version:1,product:p},'case');if(t.owner!==ctx.user.id)throw new Error('El envío pertenece a otra cuenta.');
   const tag=await ctx.index('chat-case|'+(p.identifier==='reference'?'reference|'+p.code.trim().toUpperCase():'barcode|'+code(p.code)));ctx.guard();return checked(ctx,rpc('case_open',{p_id:t.id,p_tag:tag,p_body:t.encrypted},signal));
  }
  async function follow(id,signal){const ctx=context();if(!UUID.test(id))throw new Error('Caso inválido.');return checked(ctx,rpc('case_follow',{p_id:id},signal));}
  async function caseTicket(c,status,assigned,note,p=null){
   const ctx=context();if(ctx.user.role!=='admin')throw new Error('Solo administradores pueden gestionar casos.');
   if(!UUID.test(c.id)||!STATES[status]||assigned&&!UUID.test(assigned))throw new Error('Caso inválido.');text(note,1000,false);if(p)product(p);
   const resolution={version:1,note,product:p},encrypted=await ctx.seal(resolution,'chat-case-v1|'+c.id+'|'+(c.revision+1));ctx.guard();
   return {owner:ctx.user.id,id:c.id,expected:c.revision,status,assigned:assigned||null,encrypted};
  }
  async function updateCase(t,signal){const ctx=context();if(t.owner!==ctx.user.id)throw new Error('El cambio pertenece a otra cuenta.');return checked(ctx,rpc('case_update',{p_id:t.id,p_expected:t.expected,p_status:t.status,p_assigned:t.assigned,p_resolution:t.encrypted},signal));}
  async function caseHistory(id,before=2147483647,signal){
   const ctx=context();if(!UUID.test(id))throw new Error('Caso inválido.');const rows=await checked(ctx,select('case_events','select=*&case_id=eq.'+id+'&revision=lt.'+Number(before)+'&order=revision.desc&limit=21',signal));
   for(const r of rows.slice(0,20))r.resolution=await ctx.open(r.encrypted_resolution,'chat-case-v1|'+id+'|'+r.revision);ctx.guard();return {events:rows.slice(0,20),more:rows.length>20};
  }
  async function catalogProduct(raw,signal){
   const ctx=context(),c=code(raw),tag=await ctx.index('chat-product|'+c);ctx.guard();let rows;
   try{rows=await checked(ctx,select('products','select=*&product_tag=eq.'+tag+'&limit=1',signal));}catch(error){if(['42P01','PGRST205'].includes(error.code))return null;throw error;}
   if(!rows.length)return null;const row=rows[0],p=product(await ctx.open(row.encrypted_product,'chat-product-v1|'+tag+'|'+row.version));
   if(code(p.code)!==c||p.result!=='found')throw new Error('La asociación no corresponde al código.');ctx.guard();return {...row,product:p};
  }
  function registeredMatch(row){const p=row.product;return {product:{codigo:p.code,descripcion:p.description,ref:p.ref,pventa:p.cents===null?null:p.cents/100,lookupCode:p.sourceCode||p.code},doc:{salida:p.salida,invoiceDate:p.invoiceDate||'',kind:'registered',reviewed:true},history:[],registration:{updatedAt:row.updated_at,updatedBy:row.updated_by,version:row.version}};}
  async function searchProducts(raw,mode,signal){
   const ctx=context();if(!registry||registryScope!==ctx.scope||Date.now()-registryTime>120000){
    const all=[];for(let offset=0;;offset+=100){let rows;try{rows=await checked(ctx,select('products','select=*&order=product_tag.asc&limit=100&offset='+offset,signal));}catch(error){if(['42P01','PGRST205'].includes(error.code))return [];throw error;}
     for(const row of rows){const p=product(await ctx.open(row.encrypted_product,'chat-product-v1|'+row.product_tag+'|'+row.version));ctx.guard();all.push({...row,product:p});}if(rows.length<100)break;
    }registry=all;registryScope=ctx.scope;registryTime=Date.now();
   }
   const normalize=value=>String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim(),terms=normalize(raw).split(' ').filter(Boolean);
   return registry.filter(row=>mode==='reference'?normalize(row.product.ref)===normalize(raw):terms.length&&terms.every(term=>normalize(row.product.description+' '+row.product.ref).includes(term))).slice(0,50).map(registeredMatch);
  }
  async function productTicket(p,expected=0){
   const ctx=context();if(ctx.user.role!=='admin')throw new Error('Solo administradores pueden registrar productos.');product(p);text(p.note,500,false);if(p.identifier==='reference')throw new Error('Registra el código de barras real de la etiqueta; la referencia no se convierte en código de barras.');if(!p.description.trim()||p.result!=='found')throw new Error('Escribe la descripción del producto.');
   const tag=await ctx.index('chat-product|'+code(p.code));ctx.guard();const encrypted=await ctx.seal(p,'chat-product-v1|'+tag+'|'+(expected+1));ctx.guard();return {tag,expected,encrypted,owner:ctx.user.id};
  }
  async function putProduct(t,signal){const ctx=context();if(t.owner!==ctx.user.id)throw new Error('Cambio de otra cuenta.');const result=await checked(ctx,rpc('product_put',{p_tag:t.tag,p_expected:t.expected,p_product:t.encrypted},signal));invalidate();return result;}
  async function notifications(signal){const ctx=context();if(ctx.access)await ctx.access(signal);ctx.guard();const rows=await checked(ctx,select('notifications','select=*&read_at=is.null&user_id=eq.'+ctx.user.id+'&order=id.desc&limit=100',signal));return rows;}
  async function read(through,signal,only=false){const ctx=context();if(!Number.isSafeInteger(through)||through<1)return;return checked(ctx,rpc('read',{p_through:through,p_only:only},signal));}
  async function members(signal){const ctx=context();return checked(ctx,rpc('members',{},signal));}
  async function imageTicket(file,parent=null,caption='',mentions=[]){
   const ctx=context();if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>24*1024*1024)throw new Error('Usa una imagen JPG, PNG o WebP de hasta 24 MB.');
   const bitmap=await root.createImageBitmap(file);let data;
   try{ctx.guard();
    let width=bitmap.width,height=bitmap.height;if(width*height>50000000)throw new Error('La imagen es demasiado grande.');
    const canvas=root.document.createElement('canvas');const scale=Math.min(1,1200/Math.max(width,height));canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    let blob;for(const quality of [.78,.62,.45,.3]){blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));if(blob&&blob.size<=163840)break;}
    if(!blob||blob.size>163840)throw new Error('La foto no se pudo reducir a 160 KB. Recorta el producto y prueba de nuevo.');
    data=new Uint8Array(await blob.arrayBuffer());ctx.guard();const t=await ticket({version:1,text:caption,image:{mime:blob.type}},'image',parent,mentions);ctx.guard();
    t.image=await ctx.encryptBytes(data,'chat-image-v1|'+t.id);ctx.guard();return t;
   }finally{bitmap.close();if(data)data.fill(0);}
  }
  async function sendImage(t,signal){
   const ctx=context();if(t.owner!==ctx.user.id||t.workspace!==workspace||!t.image)throw new Error('Imagen de otra cuenta.');
   const f=await checked(ctx,rpc('image_prepare',{p_id:t.id,p_size:t.image.byteLength},signal));
   const path='/storage/v1/object/mega-chat-images/'+f.path;
   try{await checked(ctx,request(path,{method:'POST',binary:true,body:t.image,headers:{'x-upsert':'false'},signal}));}catch(error){if(error.status!==409&&error.code!=='Duplicate')throw error;}
   const response=await checked(ctx,request('/storage/v1/object/authenticated/mega-chat-images/'+f.path,{method:'HEAD',raw:true,signal}));await response.arrayBuffer();ctx.guard();if(Number(response.headers.get('content-length'))!==t.image.byteLength)throw new Error('No se confirmó la imagen. Reintenta.');
   return send(t,signal);
  }
  async function image(message,signal){
   const ctx=context();if(message.kind!=='image'||!UUID.test(message.id)||!UUID.test(message.created_by))throw new Error('Imagen inválida.');
   const path=workspace+'/'+message.created_by+'/'+message.id+'/image.bin',response=await checked(ctx,request('/storage/v1/object/authenticated/mega-chat-images/'+path,{raw:true,signal}));
   if(Number(response.headers.get('content-length'))>163904)throw new Error('Imagen excede el tamaño permitido.');
   const bytes=new Uint8Array(await response.arrayBuffer());ctx.guard();let clear;try{if(bytes.length>163904)throw new Error('Imagen demasiado grande.');clear=await ctx.decryptBytes(bytes,'chat-image-v1|'+message.id);ctx.guard();return new Blob([clear],{type:message.body.image.mime});}finally{bytes.fill(0);if(clear)clear.fill(0);}
  }
  return Object.freeze({invalidate,searchProducts,list,ticket,send,cases,openCase,follow,caseTicket,updateCase,caseHistory,catalogProduct,productTicket,putProduct,notifications,read,members,imageTicket,sendImage,image});
 }
 const api=Object.freeze({create,code,product,body,STATES,STICKERS});if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ProductChatCloud=api;
})(typeof globalThis!=='undefined'?globalThis:this);
