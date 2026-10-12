(function(root){
  'use strict';
  const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
  const norm=v=>clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  function numeric(v){v=clean(v).replace(/^[\s$]+/,'');if(!/^(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?|\d+(?:[.,]\d{1,4})?)$/.test(v))return '';const n=Number(v.includes('.')?v.replace(/,/g,''):v.replace(',','.'));return Number.isFinite(n)&&n>=0?n:'';}
  function date(v){const m=/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(clean(v));if(!m)return '';const d=new Date(Date.UTC(+m[3],+m[2]-1,+m[1]));return d.getUTCFullYear()===+m[3]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[1]?m[1].padStart(2,'0')+'/'+m[2].padStart(2,'0')+'/'+m[3]:'';}
  function group(words){const out=[];for(const w of [...words].sort((a,b)=>a.y0-b.y0||a.x0-b.x0)){const mid=(w.y0+w.y1)/2;let line=out.find(l=>Math.abs(l.mid-mid)<Math.max(5,Math.min(w.y1-w.y0,l.height)*.6));if(!line){line={words:[],mid,height:w.y1-w.y0};out.push(line);}line.words.push(w);}return out.sort((a,b)=>a.mid-b.mid).map(l=>({...l,text:clean(l.words.sort((a,b)=>a.x0-b.x0).map(w=>w.text).join(' '))}));}
  function tsv(value){const rows=String(value||'').trim().split('\n'),out=[];for(const row of rows.slice(1)){const c=row.split('\t');if(c[0]!=='5'||c.length<12||!clean(c.slice(11).join('\t')))continue;const [x,y,w,h]=c.slice(6,10).map(Number);if([x,y,w,h].every(Number.isFinite)&&w>0&&h>0)out.push({text:clean(c.slice(11).join('\t')),x0:x,y0:y,x1:x+w,y1:y+h,confidence:Number(c[10])});}return out;}
  function region(p,x0,x1,y0,y1){return p.words.filter(w=>(w.x0+w.x1)/2>=x0*p.width&&(w.x0+w.x1)/2<x1*p.width&&(w.y0+w.y1)/2>=y0&&(w.y0+w.y1)/2<y1);}
  function value(p,bounds,y,tolerance){const words=region(p,bounds[0],bounds[1],y-tolerance,y+tolerance);return words.filter(w=>numeric(w.text)!=='').sort((a,b)=>(b.confidence||0)-(a.confidence||0)).map(w=>numeric(w.text))[0]??'';}
  function header(p,word,fallback,after=0){const w=p.words.find(w=>norm(w.text).replace(/[.:]/g,'')===word&&w.y0>after);return w?(w.x0+w.x1)/2/p.width:fallback;}
  function item(p,y,y1,descBounds,quantity,cost,total,ref,code){const words=region(p,descBounds[0],descBounds[1],y,y1),lines=group(words);return {codigo:code||'',codigo_completo:code||'',descripcion:clean(lines.map(l=>l.text).join(' ')).slice(0,2048),ref:ref||'',empaque:'',estilo:'',iv:'DESCONOCIDO',salidas_unidades:quantity,costo:cost,pventa:'',salidas_total:total,entradas_unidades:'',entradas_total:'',fila_original:clean(group(region(p,0,1,y,y1)).map(l=>l.text).join(' ')),page:p.page,box:{x0:0,y0:y/p.height,x1:1,y1:y1/p.height},priceOrigin:'pending'};}
  function fiscalGeometry(p){
    const description=p.words.find(w=>norm(w.text)==='DESCRIPCION'),no=description&&p.words.find(w=>norm(w.text)==='NO.'&&Math.abs(w.y0-description.y0)<12);
    if(!no||!description)return null;
    const center=w=>(w.x0+w.x1)/2/p.width,near=word=>p.words.find(w=>norm(w.text)===word&&Math.abs(w.y0-no.y0)<12);
    const interest=near('INFORMACION'),quantity=near('CANTIDAD'),unit=near('UNIDAD'),discount=near('DESCUENTO'),amount=near('MONTO'),tax=near('ITBMS');
    const values=p.words.filter(w=>norm(w.text)==='VALOR'&&Math.abs(w.y0-no.y0)<12).sort((a,b)=>a.x0-b.x0);
    if(!interest||!quantity||!unit||!discount||!amount||!tax||values.length!==2)return null;
    const columns=[quantity,unit,values[0],discount,amount,tax,values[1]].map(center),bounds=[];
    for(let i=0;i<columns.length;i++)bounds.push([i?(columns[i-1]+columns[i])/2:(quantity.x0-5)/p.width,i+1<columns.length?(columns[i]+columns[i+1])/2:Math.min(1,columns[i]+.06)]);
    return {no:[(no.x0-10)/p.width,(no.x1+4)/p.width],desc:[(no.x1+3)/p.width,(interest.x0-14)/p.width],interest:[(interest.x0-14)/p.width,(quantity.x0-5)/p.width],bounds,end:Math.max(...p.words.filter(w=>w.y0>=no.y0&&w.y0<=no.y0+14).map(w=>w.y1))};
  }
  function fiscalRows(p,g,format,first){
    const footer=group(p.words).find(l=>/DESGLOSE\s+ITBMS|VALOR\s+TOTAL|TOTAL\s+NETO/i.test(l.text)&&l.mid>(first?g.end:70));
    const stop=footer?Math.min(...footer.words.map(w=>w.y0)):p.height*.97;
    const numbers=region(p,g.no[0],g.no[1],first?g.end:0,stop).filter(w=>/^[1-9]\d{0,4}$/.test(w.text)).sort((a,b)=>a.y0-b.y0);
    const rows=[];
    for(let i=0;i<numbers.length;i++){
      const a=numbers[i],y=a.y0-1,y1=i+1<numbers.length?numbers[i+1].y0-1:stop,mid=(a.y0+a.y1)/2,tol=Math.max(5,(a.y1-a.y0)*.55);
      const r=item(p,y,y1,g.desc,value(p,g.bounds[0],mid,tol),value(p,g.bounds[2],mid,tol),value(p,g.bounds[4],mid,tol),'','');
      r.numero_linea=Number(a.text);r.informacion_interes=clean(group(region(p,g.interest[0],g.interest[1],y,y1)).map(l=>l.text).join(' '));
      r.empaque=clean(region(p,g.bounds[1][0],g.bounds[1][1],mid-tol,mid+tol).map(w=>w.text).join(' '));
      r.descuento_unitario=value(p,g.bounds[3],mid,tol);r.impuesto_importe=value(p,g.bounds[5],mid,tol);r.valor_item=value(p,g.bounds[6],mid,tol);
      if(r.impuesto_importe===0)r.iv='0%';else if(r.salidas_total>0&&r.impuesto_importe!==''){const rate=Math.round(r.impuesto_importe/r.salidas_total*100);if([7,10,15].includes(rate)&&Math.abs(r.impuesto_importe-r.salidas_total*rate/100)<=.025)r.iv=rate+'%';}
      if(format==='feduro'){
        const barcode=/[({\[]\s*(\d[\d\s]{6,25}\d)\s*[)}\]]/.exec(r.informacion_interes);if(barcode){const code=barcode[1].replace(/\s/g,'');if(code.length>=8&&code.length<=14)r.codigo=r.codigo_completo=code;}
        const ref=/^((?:(?:[A-Z]\s*){1,4}|(?:\d\s*){2})-\s*(?:[A-Z0-9]\s*){3,16}|\d{8,12})(?=\s+-\s+|$)/i.exec(r.descripcion);
        if(ref)r.ref=ref[1].replace(/\s/g,'');
      }
      if(r.descripcion&&r.salidas_unidades!=='')rows.push(r);
    }
    return rows;
  }
  function extract(pages){
    const all=pages.map(p=>group(p.words).map(l=>l.text).join('\n')).join('\n'),upper=norm(all);
    const format=/NEVADA/.test(upper)?'nevada':/FEDURO/.test(upper)?'feduro':/SKECHERS|BOBS SKILLZ|BOBS MODA|GO RUN CONSISTENT/.test(upper)?'skechers':'otro';
    const kind=format==='nevada'?'pedido':'factura';let number='',invoiceDate='';
    const numberMatch=all.match(/(?:PEDIDO\s*(?:NO\.?|N[º°])|N[uú]mero\s*:|N\.?\s*Documento\s*Fiscal)\s*([0-9]{1,60})(?=\s|$)/i);if(numberMatch)number=numberMatch[1];
    const dateMatch=all.match(/Fecha(?:\s+de)?\s*(?:Emisi[oó]n)?\s*[:.]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/i);if(dateMatch)invoiceDate=date(dateMatch[1]);
    // Nevada puts the emission value on the next line, underneath its heading.
    if(!invoiceDate){for(const p of pages){const heading=p.words.find(w=>/^FECHA/.test(norm(w.text)));if(heading){const candidate=region(p,Math.max(0,heading.x0/p.width-.02),Math.min(1,heading.x0/p.width+.3),heading.y1,heading.y1+p.height*.05).find(w=>date(w.text));if(candidate){invoiceDate=date(candidate.text);break;}}}}
    if(!number&&format==='skechers'){for(const p of pages){const label=group(p.words).find(l=>/DOCUMENTO\s+FISCAL/i.test(l.text));if(label){const candidates=region(p,.1,.55,label.mid-12,label.mid+20).filter(w=>/^\d{5,60}$/.test(w.text));if(candidates.length){number=candidates[candidates.length-1].text;break;}}}}
    const rows=[];
    const fiscal=/COMPROBANTE AUXILIAR DE FACTURA ELECTRONICA/.test(upper)?pages.map(p=>fiscalGeometry(p)).find(Boolean):null;
    for(const p of pages){
      if(fiscal){const own=fiscalGeometry(p);rows.push(...fiscalRows(p,own||fiscal,format,Boolean(own)));continue;}
      if(format==='nevada'||format==='feduro'){
        const table=p.words.find(w=>norm(w.text)==='DESCRIPCION');const start=table?table.y1:p.height*.3;
        const qCenter=header(p,format==='nevada'?'CANT':'CANTIDAD',format==='nevada'?.645:.48,start-30),qBounds=[qCenter-.026,qCenter+.028];
        let anchors;
        if(format==='nevada'){
          anchors=region(p,.27,.365,start,p.height*.94).filter(w=>/^[A-Z]{2,}(?:[-]|$)/i.test(w.text)&&!['DESCRIPCION','SUBTOTAL','PAGINA','PARA'].includes(norm(w.text)));
        }else{
          anchors=region(p,.075,.26,start,p.height*.97).filter(w=>/^(?:[A-Z]{1,4}-[A-Z0-9]{3,}|\d{2}-\d{3,12}|\d{8,12})$/i.test(w.text.replace(/^-/,''))&&!/[(){}]/.test(w.text));
          if(p.ocr){
            // A pen mark can destroy a reference while the barcode line remains
            // legible. Use that line to retain the product for human review.
            const codes=region(p,.075,.3,start,p.height*.97).filter(w=>/^[({\[]\d{8,14}[)}\]]?$/.test(w.text));
            if(codes.length>=anchors.length&&codes.length){anchors=codes.map(w=>{
              const values=region(p,.45,.76,w.y0-p.height*.038,w.y0-p.height*.006).filter(t=>numeric(t.text)!=='');
              const first=values.sort((a,b)=>b.y0-a.y0)[0];return {...(first||{...w,y0:w.y0-p.height*.02,y1:w.y1-p.height*.02}),barcode:w.text.replace(/[(){}\[\]]/g,'')};
            });}
          }
        }
        if(!anchors.length)anchors=region(p,qBounds[0],qBounds[1],start,p.height*.94).filter(w=>numeric(w.text)!==''&&numeric(w.text)>0&&w.confidence>=15);
        const unique=[];for(const a of anchors.sort((a,b)=>a.y0-b.y0))if(a.barcode||!unique.some(b=>Math.abs(b.y0-a.y0)<12))unique.push(a);
        for(let i=0;i<unique.length;i++){
          const a=unique[i],y=a.y0-Math.max(8,(a.y1-a.y0)*.5),y1=i+1<unique.length?unique[i+1].y0-8:Math.min(p.height*.96,a.y1+p.height*.06),tol=Math.max(12,a.y1-a.y0),mid=(a.y0+a.y1)/2;
          let quantity=value(p,qBounds,mid,tol);
          if(p.ocr&&format==='feduro'&&quantity===0)quantity='';
          if(p.ocr&&format==='feduro'&&Number.isInteger(quantity)&&quantity>10000){const raw=String(quantity);quantity=/0000$/.test(raw)?quantity/10000:'';}
          if(p.ocr&&format==='nevada'&&(quantity>1000||quantity===0))quantity='';
          if(format==='nevada'){
            const codeWords=region(p,.1,.3,y,y+tol*2),candidate=codeWords.find(w=>/^\d{8,14}$/.test(w.text)),desc=region(p,.29,.58,y,y1);
            if(!desc.some(w=>/[A-Za-z]/.test(w.text)))continue;
            const cost=value(p,[.724,.782],(a.y0+a.y1)/2,tol),total=value(p,[.845,.94],(a.y0+a.y1)/2,tol);
            if(p.ocr&&quantity!==''&&cost>0&&total>0&&Math.abs(quantity*cost-total)>.02)quantity='';
            const r=item(p,y,y1,[.29,.58],quantity,cost,total,'',candidate?candidate.text:'');r.empaque='pza';r.priceSuggestions=region(p,.78,.84,y,y1).filter(w=>/^\d{1,5}[.,]\d{2}$/.test(w.text)&&w.confidence>25).map(w=>numeric(w.text)).slice(0,3);rows.push(r);
          }else{
            const text=clean(group(region(p,.075,.45,y,y1)).map(l=>l.text).join(' ')),barcode=/[({\[]\s*(\d[\d\s]{6,20}\d)\s*[)}\]]/.exec(text),code=a.barcode||(barcode?barcode[1].replace(/\s/g,''):'');
            const ref=/(?:^|\s)([A-Z]{1,4}-[A-Z0-9]+|\d{2}-\d{3,12}|\d{8,12})(?=\s|$)/i.exec(text);
            const r=item(p,y,y1,[.075,.45],quantity,value(p,[.565,.625],mid,tol),value(p,[.695,.765],mid,tol),ref?ref[1]:'',code.length>=8&&code.length<=14?code:'');
            if((!r.descripcion||!/[A-Za-z]/.test(r.descripcion))&&!a.barcode)continue;
            r.priceSuggestions=region(p,.34,.46,y,y1).filter(w=>/^\d{1,5}[.,]\d{2}$/.test(w.text)&&w.confidence>25).map(w=>numeric(w.text)).slice(0,3);
            const tax=value(p,[.765,.825],(a.y0+a.y1)/2,tol);if(tax===0)r.iv='0%';else if(tax!==''&&r.salidas_total!==''&&Math.abs(tax/r.salidas_total-.07)<.003)r.iv='7%';rows.push(r);
          }
        }
      }else if(format==='skechers'){
        const label=p.words.find(w=>norm(w.text)==='CANTIDAD'),start=label?(p.ocr?Math.min(label.y1,p.height*.54):label.y1):p.height*.54;
        const quantities=region(p,.23,.3,start,p.height*.95).filter(w=>numeric(w.text)!==''&&numeric(w.text)>0&&numeric(w.text)<10000);
        const selected=[];for(const q of quantities.sort((a,b)=>a.y0-b.y0))if(!selected.some(x=>Math.abs(x.y0-q.y0)<15))selected.push(q);
        for(const qty of selected){
          const y=qty.y0-10,y1=Math.min(p.height,qty.y1+p.height*.018),codeWord=region(p,.07,.22,y,y1).find(w=>!/^CODIGO|ITEM$/i.test(w.text)),cost=value(p,[.72,.795],(qty.y0+qty.y1)/2,20),total=value(p,[.80,.88],(qty.y0+qty.y1)/2,20);
          const r=item(p,y,y1,[.29,.66],numeric(qty.text),cost,total,codeWord?codeWord.text:'','');if(r.descripcion)rows.push(r);
        }
      }else{
        // Unrecognized layouts still get a review screen and their full OCR text.
        // Conservatively propose rows containing a code and a description.
        for(const line of group(p.words)){
          const m=/^\s*(\d{8,14}|[A-Z]{1,4}[-/][A-Z0-9/-]+)\s+(.{4,})$/i.exec(line.text);if(!m||!/[a-z]/i.test(m[2]))continue;
          const r=item(p,line.words[0].y0,line.words[0].y1+8,[0,1],'','','',/^\d+$/.test(m[1])?'':m[1],/^\d+$/.test(m[1])?m[1]:'');r.descripcion=m[2];rows.push(r);
        }
      }
    }
    if(pages.some(p=>p.ocr)&&invoiceDate&&Number(invoiceDate.slice(-4))>new Date().getFullYear()+1)invoiceDate='';
    const info={numero:number,fecha:invoiceDate,referencia:'',destino:'',subtotal:'',impuesto:'',total_neto:'',kind:format==='otro'?'otro':kind,format};
    if(fiscal){for(const line of group(region(pages[pages.length-1],.69,1,0,pages[pages.length-1].height))){const m=/^(Total Neto|Total Impuesto|Total)\s+([\d.,]+)$/.exec(line.text);if(m)info[{'Total Neto':'subtotal','Total Impuesto':'impuesto','Total':'total_neto'}[m[1]]]=numeric(m[2]);}}
    return {rows,ocrWarning:pages.some(p=>p.ocr)?'Lectura de un escaneo: puede omitir productos o confundir cifras. Compara todas las filas, el número y la fecha con el PDF; añade o corrige lo que falte. Los precios manuscritos requieren confirmación.':'',rawLines:pages.flatMap(p=>group(p.words).map((l,i)=>({pagina:p.page,linea:i+1,texto:l.text}))),documentInfo:info,pages};
  }
  function validateSaved(s){
    if(!s||s.version!==1||!['salida','factura','pedido','otro'].includes(s.kind)||typeof s.format!=='string'||s.format.length>64||!/^\d{1,60}$/.test(s.numero)||!date(s.fecha)||!/^[a-f0-9]{64}$/.test(s.pdfSha256)||!Array.isArray(s.rows)||!s.rows.length||s.rows.length>1000)throw new Error('La lectura confirmada del documento no es válida.');
    const rows=s.rows.map(r=>{
      if(typeof r.codigo!=='string'||r.codigo.length>80||typeof r.ref!=='string'||r.ref.length>80||(!r.codigo&&!r.ref&&r.pventa!==''&&!Number.isInteger(r.numero_linea))||typeof r.descripcion!=='string'||!r.descripcion.trim()||r.descripcion.length>2048||!Number.isFinite(r.salidas_unidades)||r.salidas_unidades<0||!['pdf','manual','pending'].includes(r.priceOrigin)||!(r.pventa===''||Number.isFinite(r.pventa)&&r.pventa>=0&&r.pventa<=9999999.99&&Math.abs(r.pventa*100-Math.round(r.pventa*100))<.001))throw new Error('Revisa la descripción, las unidades y el precio de cada producto. Las filas sin código o referencia quedarán pendientes de identificación.');
      for(const f of ['costo','salidas_total','entradas_unidades','entradas_total'])if(!(r[f]===''||Number.isFinite(r[f])&&r[f]>=0))throw new Error('Hay un importe inválido en la lectura confirmada.');
      if(/[\x00-\x1f\x7f]/.test(r.codigo+r.ref+r.descripcion))throw new Error('Texto inválido en la lectura confirmada.');
      const copy={};
      for(const [key,limit]of [['codigo',80],['codigo_completo',160],['ref',80],['descripcion',2048],['empaque',128],['estilo',128],['iv',64],['fila_original',8192]]){copy[key]=String(r[key]||'');if(copy[key].length>limit)throw new Error('Hay texto demasiado largo en la lectura.');}
      for(const key of ['salidas_unidades','costo','pventa','salidas_total','entradas_unidades','entradas_total'])copy[key]=r[key];
      copy.priceOrigin=r.priceOrigin;
      if(copy.pventa!==''&&copy.priceOrigin==='pending')throw new Error('Confirma el origen del precio de venta.');
      copy.page=Number.isInteger(r.page)&&r.page>0&&r.page<=1000?r.page:1;
      if(r.box&&[r.box.x0,r.box.x1,r.box.y0,r.box.y1].every(v=>Number.isFinite(v)&&v>=0&&v<=1))copy.box={x0:r.box.x0,x1:r.box.x1,y0:r.box.y0,y1:r.box.y1};
      copy.priceSuggestions=Array.isArray(r.priceSuggestions)?r.priceSuggestions.filter(v=>Number.isFinite(v)&&v>=0&&v<=9999999.99).slice(0,3):[];
      if(r.numero_linea!==undefined){if(!Number.isInteger(r.numero_linea)||r.numero_linea<1||r.numero_linea>99999)throw new Error('Número de fila inválido.');copy.numero_linea=r.numero_linea;}
      if(r.informacion_interes!==undefined){if(typeof r.informacion_interes!=='string'||r.informacion_interes.length>2048)throw new Error('Información adicional inválida.');copy.informacion_interes=r.informacion_interes;}
      for(const key of ['descuento_unitario','impuesto_importe','valor_item'])if(r[key]!==undefined){if(!(r[key]===''||Number.isFinite(r[key])&&r[key]>=0))throw new Error('Importe fiscal inválido.');copy[key]=r[key];}
      return copy;
    });
    const value={version:1,kind:s.kind,format:s.format,numero:s.numero,fecha:date(s.fecha),pdfSha256:s.pdfSha256,rows};
    if(s.totals!==undefined){value.totals={};for(const key of ['subtotal','impuesto','total_neto']){const v=s.totals&&s.totals[key];if(!(v===''||Number.isFinite(v)&&v>=0))throw new Error('Totales de factura inválidos.');value.totals[key]=v;}}
    if(new TextEncoder().encode(JSON.stringify(value)).length>160000)throw new Error('La lectura es demasiado grande. Divide el documento antes de guardarlo.');return value;
  }
  const api=Object.freeze({extract,tsv,group,numeric,date,validateSaved});if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.InvoiceFormats=api;
})(typeof globalThis!=='undefined'?globalThis:this);
