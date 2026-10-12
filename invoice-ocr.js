(function(root){
  'use strict';
  let loading=null;
  function load(){if(root.Tesseract)return Promise.resolve();if(loading)return loading;loading=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=new URL('vendor/ocr/tesseract.min.js',location.href).href;s.onload=resolve;s.onerror=()=>{loading=null;reject(new Error('No se pudo cargar la lectura de imágenes. Puedes revisar el PDF e ingresar sus productos.'));};document.head.append(s);});return loading;}
  async function read(pdf,textPages,context){
    const guard=()=>{if(context.assertCurrent)context.assertCurrent();if(context.signal&&context.signal.aborted)throw new Error('Lectura cancelada.');};
    const pages=[],progress=context.progress||(()=>{});let worker=null,canvas=null,cropCanvas=null,renderTask=null;
    let rejectCancel;const cancellation=new Promise((_,reject)=>{rejectCancel=reject;});cancellation.catch(()=>{});const race=p=>Promise.race([p,cancellation]);
    let cancelled=false;const stop=()=>{cancelled=true;rejectCancel(new Error('Lectura cancelada.'));if(renderTask)try{renderTask.cancel();}catch(_){}if(worker)worker.terminate().catch(()=>{});if(canvas)canvas.width=canvas.height=0;};
    if(context.signal)context.signal.addEventListener('abort',stop,{once:true});context.cancelOcr=stop;
    try{
      for(let n=1;n<=pdf.numPages;n++){
        guard();const typed=textPages.find(p=>p.page===n);
        if(typed&&typed.words.length>=8){pages.push(typed);continue;}
        const page=await pdf.getPage(n);guard();const first=page.getViewport({scale:1}),scale=Math.min(3,2200/Math.max(first.width,first.height)),vp=page.getViewport({scale});
        canvas=document.createElement('canvas');canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);renderTask=page.render({canvasContext:canvas.getContext('2d',{willReadFrequently:true}),viewport:vp});await renderTask.promise;renderTask=null;guard();
        if(!worker){await race(load());guard();const created=root.Tesseract.createWorker('eng',1,{workerPath:new URL('vendor/ocr/worker.min.js',location.href).href,corePath:new URL('vendor/ocr/',location.href).href,langPath:new URL('vendor/ocr/',location.href).href,workerBlobURL:false,gzip:true,logger:m=>{if(!cancelled)progress({page:n,total:pdf.numPages,status:m.status,progress:m.progress||0});}});created.then(w=>{if(cancelled)w.terminate().catch(()=>{});},()=>{});worker=await race(created);guard();await race(worker.setParameters({tessedit_pageseg_mode:'6',preserve_interword_spaces:'1'}));}
        progress({page:n,total:pdf.numPages,status:'recognizing text',progress:0});
        const result=await race(worker.recognize(canvas,{}, {text:true,tsv:true}));guard();let words=root.InvoiceFormats.tsv(result.data.tsv),width=canvas.width,height=canvas.height;
        const detected=root.InvoiceFormats.extract([{page:n,width,height,words}]).documentInfo.format;
        if(['nevada','feduro','skechers'].includes(detected)){
          const high=page.getViewport({scale:Math.min(3,3300/Math.max(first.width,first.height))}),factor=high.height/height;
          canvas.width=Math.ceil(high.width);canvas.height=Math.ceil(high.height);renderTask=page.render({canvasContext:canvas.getContext('2d',{willReadFrequently:true}),viewport:high});await renderTask.promise;renderTask=null;guard();
          const top=Math.floor(canvas.height*(detected==='skechers'?.54:.28)),crop=document.createElement('canvas');cropCanvas=crop;crop.width=canvas.width;crop.height=canvas.height-top;
          crop.getContext('2d').drawImage(canvas,0,top,crop.width,crop.height,0,0,crop.width,crop.height);
          const detail=await race(worker.recognize(crop,{}, {text:true,tsv:true}));guard();
          words=words.filter(w=>w.y1*factor<top).map(w=>({...w,x0:w.x0*factor,x1:w.x1*factor,y0:w.y0*factor,y1:w.y1*factor})).concat(root.InvoiceFormats.tsv(detail.data.tsv).map(w=>({...w,y0:w.y0+top,y1:w.y1+top})));
          width=canvas.width;height=canvas.height;crop.width=crop.height=0;cropCanvas=null;
        }
        pages.push({page:n,width,height,words,ocr:true});
        canvas.width=canvas.height=0;canvas=null;page.cleanup();
      }
      guard();return root.InvoiceFormats.extract(pages);
    }finally{if(context.signal)context.signal.removeEventListener('abort',stop);context.cancelOcr=null;if(worker)await worker.terminate().catch(()=>{});if(canvas)canvas.width=canvas.height=0;if(cropCanvas)cropCanvas.width=cropCanvas.height=0;}
  }
  root.InvoiceOCR=Object.freeze({read});
})(typeof globalThis!=='undefined'?globalThis:this);
