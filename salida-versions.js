(function(root){
  'use strict';
  const textKeys=['codigo','codigo_completo','descripcion','empaque','estilo','ref','iv'];
  const numberKeys=['salidas_unidades','costo','pventa','salidas_total','entradas_unidades','entradas_total','descuento_unitario','descuento_total','impuesto_importe','importe_total'];
  const labels={codigo:'Código de barras',codigo_completo:'Código completo',descripcion:'Descripción',empaque:'Empaque',estilo:'Estilo',ref:'Referencia',iv:'I.V.',salidas_unidades:'Cantidad',costo:'Costo',pventa:'Precio de venta',salidas_total:'Importe de salida',entradas_unidades:'Unidades de entrada',entradas_total:'Importe de entrada',descuento_unitario:'Descuento unitario',descuento_total:'Descuento total',impuesto_importe:'Impuesto del producto',importe_total:'Importe total',fecha:'Fecha de factura',referencia:'Referencia de factura',destino:'Destino',subtotal:'Subtotal',impuesto:'Impuesto',total_neto:'Total neto'};
  const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
  const number=value=>Number.isFinite(value)?(Object.is(value,-0)?0:value):null;
  function identifier(value){const result=text(value);if(!/^\d{1,60}$/.test(result))throw new Error('No se pudo confirmar el identificador de la salida.');return result.replace(/^0+(?=\d)/,'');}
  function date(value){const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text(value));if(!m)return text(value);return [m[3],m[2].padStart(2,'0'),m[1].padStart(2,'0')].join('-');}
  function row(source){const result={};for(const key of textKeys)result[key]=text(source[key]);for(const key of numberKeys)result[key]=number(source[key]);return result;}
  function create(source,recordedNumber){
    if(!source||!Array.isArray(source.rows)||!source.rows.length||source.rows.length>50000||!source.info)throw new Error('Falta el contenido verificable de la salida.');
    const id=identifier(recordedNumber??source.info.numero),printed=identifier(source.info.numero||recordedNumber);
    const issuer=text(source.info.emisor).toUpperCase().replace(/[\s.,]+/g,'');
    const context=text(source.context||(issuer?'salida-emisor:'+issuer:source.info.format||'salida-nativa'));
    // A deliberately edited output identifier remains a separate context. Barcode
    // digits and leading zeroes are always preserved in the actual product data.
    const identity=JSON.stringify(['mega-salida-identity-v1',context,id,printed]);
    const info={numero:printed,fecha:date(source.info.fecha),referencia:text(source.info.referencia),destino:text(source.info.destino),subtotal:number(source.info.subtotal),impuesto:number(source.info.impuesto),total_neto:number(source.info.total_neto)};
    const rows=source.rows.map(row).sort((a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;});
    const canonical=JSON.stringify({version:1,context,info,rows});
    return {version:1,identity,context,number:id,printedNumber:text(source.info.numero||recordedNumber),info,rows,canonical};
  }
  function compare(before,after){
    let old=before.rows.map(r=>({...r})),next=after.rows.map(r=>({...r}));const added=[],removed=[],changed=[],document=[];let unchanged=0;
    // Cancel exact rows as a multiset, preserving repeated legitimate lines.
    const exact=new Map();for(const item of next){const key=JSON.stringify(item);if(!exact.has(key))exact.set(key,[]);exact.get(key).push(item);}const remaining=[];
    for(const item of old){const entries=exact.get(JSON.stringify(item));if(entries?.length){entries.pop();unchanged++;}else remaining.push(item);}old=remaining;next=[...exact.values()].flat();
    function pair(key){const left=new Map(),right=new Map(),pairedOld=new Set(),pairedNew=new Set();for(const item of old){if(!item[key])continue;if(!left.has(item[key]))left.set(item[key],[]);left.get(item[key]).push(item);}for(const item of next){if(!item[key])continue;if(!right.has(item[key]))right.set(item[key],[]);right.get(item[key]).push(item);}
      for(const [value,items]of left){if(items.length!==1||right.get(value)?.length!==1)continue;const previous=items[0],current=right.get(value)[0],fields=[];pairedOld.add(previous);pairedNew.add(current);
      for(const field of [...textKeys,...numberKeys])if(previous[field]!==current[field])fields.push({key:field,label:labels[field],before:previous[field],after:current[field],delta:field==='salidas_unidades'&&Number.isFinite(previous[field])&&Number.isFinite(current[field])?Number((current[field]-previous[field]).toPrecision(12)):null});
      changed.push({before:previous,after:current,fields});}old=old.filter(item=>!pairedOld.has(item));next=next.filter(item=>!pairedNew.has(item));}
    pair('codigo');pair('ref');pair('descripcion');removed.push(...old);added.push(...next);
    for(const key of Object.keys(after.info))if(before.info[key]!==after.info[key])document.push({key,label:labels[key]||key,before:before.info[key],after:after.info[key]});
    return {equal:before.canonical===after.canonical,added,removed,changed,document,unchanged};
  }
  const api=Object.freeze({create,compare,identifier,labels,textKeys,numberKeys});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SalidaVersions=api;
})(typeof globalThis!=='undefined'?globalThis:this);
