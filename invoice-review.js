(function(root){
  'use strict';
  const n=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  function create(options){
    const {host,parsed,file,onChange}=options;let confirmed=Boolean(options.readOnly),disposed=false,pdf=null,task=null,revision=0,working=false;
    const heading=n('h2','Revisar lectura del documento'),note=n('p',parsed.ocrWarning||'Compara los datos con el PDF. El precio de la factura y el precio de venta se conservan por separado. Puedes corregir o añadir productos.');
    const metadata=n('div');metadata.className='invoice-fields';const controls={};
    const admin=()=>{const s=root.AuditClient&&root.AuditClient.status();return Boolean(s&&s.authenticated&&s.user&&s.user.role==='admin');};
    function field(label,value,type='text'){const wrap=n('label',label),input=n('input');input.type=type;input.value=value||'';wrap.append(input);metadata.append(wrap);return input;}
    controls.kind=n('select');for(const [value,text]of [['salida','Salida'],['factura','Factura'],['pedido','Pedido'],['otro','Otro documento']]){const o=n('option',text);o.value=value;controls.kind.append(o);}controls.kind.value=parsed.documentInfo.kind||'otro';const kindLabel=n('label','Tipo de documento');kindLabel.append(controls.kind);metadata.append(kindLabel);
    controls.numero=field('Número del documento',parsed.documentInfo.numero);controls.numero.inputMode='numeric';controls.numero.maxLength=60;
    controls.fecha=field('Fecha impresa de la factura',parsed.documentInfo.fecha);controls.fecha.placeholder='dd/mm/aaaa';controls.fecha.maxLength=10;
    const preview=n('div'),canvas=n('canvas'),pageSelect=n('select'),readState=n('p','Cargando PDF original…');preview.className='invoice-original';canvas.setAttribute('aria-label','Documento original para revisar');
    const enlarge=n('button','Ampliar PDF');enlarge.type='button';let zoom=1;
    preview.append(pageSelect,enlarge,readState,canvas);const rowsHost=n('div');rowsHost.className='invoice-rows';
    const add=n('button','Añadir producto');add.type='button';add.className='audit-button audit-button-secondary';
    const selectedRows=new Set(),bulk=n('div'),bulkPrice=n('input'),bulkApply=n('button','Aplicar precio a productos seleccionados');bulk.className='invoice-fields';bulkPrice.type='number';bulkPrice.min='0';bulkPrice.step='0.01';bulkPrice.placeholder='Precio para el grupo';bulkPrice.setAttribute('aria-label','Precio de venta para productos seleccionados');bulkApply.type='button';bulk.append(bulkPrice,bulkApply);
    const confirmation=n('label'),checkbox=n('input');checkbox.type='checkbox';checkbox.id='invoice-confirm';confirmation.append(checkbox,n('span',admin()?'He comparado los códigos, cantidades y precios de venta con el documento.':'He revisado los datos. Quedan pendientes de aprobación de un administrador.'));
    const status=n('p');status.id='invoice-review-status';status.setAttribute('role','status');
    host.replaceChildren(heading,note,metadata,preview,bulk,rowsHost,add,confirmation,status);host.hidden=false;
    checkbox.checked=confirmed;
    function notify(){if(disposed||working||options.readOnly)return;confirmed=false;checkbox.checked=false;parsed.documentInfo.numero=controls.numero.value.trim();parsed.documentInfo.fecha=controls.fecha.value.trim();parsed.documentInfo.kind=controls.kind.value;onChange();}
    for(const input of Object.values(controls))input.addEventListener('input',notify);
    async function showPage(box){const r=++revision;if(disposed||!pdf)return;const page=await pdf.getPage(Number(pageSelect.value));if(disposed||r!==revision)return;
      const first=page.getViewport({scale:1}),vp=page.getViewport({scale:Math.min(3,1300/first.width)*zoom});canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);
      if(task)try{task.cancel();}catch(_){}task=page.render({canvasContext:canvas.getContext('2d'),viewport:vp});try{await task.promise;}catch(e){if(e.name==='RenderingCancelledException')return;throw e;}
      if(disposed||r!==revision)return;readState.textContent='Página '+pageSelect.value+' de '+pdf.numPages+'.';page.cleanup();
      canvas.style.width=zoom===1?'100%':'180%';
      if(box&&Number.isFinite(box.y0))canvas.parentElement.scrollTop=Math.max(0,box.y0*canvas.getBoundingClientRect().height-80);
    }
    pageSelect.addEventListener('change',()=>showPage().catch(e=>{if(!disposed)readState.textContent=e.message;}));enlarge.addEventListener('click',()=>{zoom=zoom===1?1.8:1;enlarge.textContent=zoom===1?'Ampliar PDF':'Ajustar PDF';showPage().catch(e=>{if(!disposed)readState.textContent=e.message;});});
    (async()=>{let buffer;try{buffer=new Uint8Array(await file.arrayBuffer());if(disposed){buffer.fill(0);return;}const loading=root.pdfjsLib.getDocument({data:buffer,isEvalSupported:false});pdf=await loading.promise;if(disposed){await pdf.destroy();return;}for(let i=1;i<=pdf.numPages;i++){const o=n('option','Página '+i);o.value=String(i);pageSelect.append(o);}await showPage();}catch(e){if(!disposed)readState.textContent='No se pudo mostrar la vista previa. Conserva y revisa el PDF original.';}})();
    function rowFields(){rowsHost.replaceChildren();parsed.rows.forEach((row,index)=>{
      const card=n('section');card.className='invoice-row';card.dataset.invoiceRow=String(index);card.append(n('h3','Producto '+(index+1)));
      const select=n('input');select.type='checkbox';select.checked=selectedRows.has(row);select.setAttribute('aria-label','Seleccionar producto '+(index+1)+' para precio de grupo');select.addEventListener('change',()=>{if(select.checked)selectedRows.add(row);else selectedRows.delete(row);});card.append(select);
      for(const [key,label,type]of [['codigo','Código de barras','text'],['ref','Referencia','text'],['descripcion','Descripción','text'],['salidas_unidades','Cantidad','number'],['costo','Precio de la factura','number'],['salidas_total','Importe de la factura','number'],['pventa','Precio de venta (USD)','number'],['iv','Impuesto I.V.','text']]){
        const wrap=n('label',label),input=n('input');input.type=type;input.dataset.field=key;input.setAttribute('aria-label',label+' del producto '+(index+1));input.value=row[key]===undefined?'':String(row[key]);
        if(type==='number'){input.min='0';input.step=key==='pventa'?'0.01':'any';input.inputMode='decimal';}
        input.maxLength=key==='descripcion'?2048:key==='codigo'||key==='ref'?80:32;
        if(key==='pventa'&&!admin())input.readOnly=true;
        if(key==='pventa')input.placeholder='Pendiente de definir';
        input.addEventListener('input',()=>{if(working||options.readOnly||key==='pventa'&&!admin())return;row[key]=type==='number'?(input.value===''?'':input.valueAsNumber):input.value.trim();if(key==='codigo')row.codigo_completo=row.codigo;if(key==='pventa')row.priceOrigin=input.value===''?'pending':'manual';notify();});wrap.append(input);card.append(wrap);
        if(key==='pventa'&&admin())for(const suggestion of row.priceSuggestions||[]){const use=n('button','Revisar precio sugerido '+Number(suggestion).toFixed(2));use.type='button';use.dataset.edit='true';use.addEventListener('click',()=>{if(working||options.readOnly||!admin())return;row.pventa=suggestion;row.priceOrigin='manual';input.value=String(suggestion);notify();});card.append(use);}
        if(key==='pventa'&&admin()&&Number.isFinite(row.costo)){const use=n('button','Usar precio de factura como venta');use.type='button';use.dataset.edit='true';use.addEventListener('click',()=>{if(working||options.readOnly||!admin())return;row.pventa=Math.round(row.costo*100)/100;row.priceOrigin='manual';input.value=String(row.pventa);notify();});card.append(use);}
      }
      const original=n('button','Ver fila en el PDF');original.type='button';original.addEventListener('click',()=>{if(row.page&&pdf){pageSelect.value=String(row.page);showPage(row.box).catch(e=>{if(!disposed)readState.textContent=e.message;});}});const remove=n('button','Quitar producto');remove.type='button';remove.dataset.edit='true';remove.addEventListener('click',()=>{if(working||options.readOnly)return;parsed.rows.splice(index,1);rowFields();notify();});card.append(original,remove);rowsHost.append(card);
    });}
    add.addEventListener('click',()=>{if(working||options.readOnly)return;parsed.rows.push({codigo:'',codigo_completo:'',ref:'',descripcion:'',empaque:'',estilo:'',iv:'DESCONOCIDO',salidas_unidades:'',costo:'',pventa:'',salidas_total:'',entradas_unidades:'',entradas_total:'',fila_original:'Ingresado durante la revisión',priceOrigin:'pending',page:1});rowFields();setBusy(false);notify();});
    bulkApply.addEventListener('click',()=>{if(working||options.readOnly||!admin())return;const v=bulkPrice.valueAsNumber;if(!Number.isFinite(v)||v<0||Math.abs(v*100-Math.round(v*100))>.001){status.textContent='Escribe un precio con hasta dos decimales.';return;}for(const row of selectedRows)if(parsed.rows.includes(row)){row.pventa=v;row.priceOrigin='manual';}rowFields();setBusy(false);notify();});
    checkbox.addEventListener('change',()=>{if(working||options.readOnly)return;confirmed=checkbox.checked;onChange();});rowFields();
    function source(){return root.InvoiceFormats.validateSaved({version:1,kind:controls.kind.value,format:parsed.documentInfo.format||'otro',numero:controls.numero.value.trim(),fecha:controls.fecha.value.trim(),pdfSha256:parsed.pdfSha256,rows:parsed.rows});}
    function valid(){try{source();status.textContent=confirmed?(admin()?'Lectura confirmada. Se compartirá con el equipo.':'Se enviará para revisión de un administrador.'):'Revisa los datos y marca la confirmación antes de guardar.';return confirmed;}catch(e){status.textContent=e.message;return false;}}
    function setBusy(value){working=value;for(const el of [...Object.values(controls),...rowsHost.querySelectorAll('input,button[data-edit]'),add,checkbox])el.disabled=value||Boolean(options.readOnly);bulkPrice.disabled=bulkApply.disabled=value||Boolean(options.readOnly)||!admin();}
    setBusy(false);
    return {source,valid,setBusy,confirmed:()=>confirmed,adminConfirmed:()=>confirmed&&admin(),dispose(){disposed=true;revision++;if(task)try{task.cancel();}catch(_){}if(pdf)pdf.destroy().catch(()=>{});canvas.width=canvas.height=0;host.replaceChildren();host.hidden=true;}};
  }
  root.InvoiceReview=Object.freeze({create});
})(typeof globalThis!=='undefined'?globalThis:this);
