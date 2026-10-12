'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Formats=require('../invoice-formats'),Catalog=require('../mobile-catalog');
function source(){return {version:1,kind:'factura',format:'feduro',numero:'55002',fecha:'12/10/2026',pdfSha256:'a'.repeat(64),rows:[{codigo:'1234509876543',ref:'HB-001',descripcion:'Producto ficticio',salidas_unidades:6,costo:10,pventa:19.99,salidas_total:60,entradas_unidades:'',entradas_total:'',priceOrigin:'manual'}]};}
function feduroPage(nameRuns){
 let sourceRun=0;const words=[],run=(text,x,y,native=true)=>{const id=sourceRun++;for(const m of text.matchAll(/\S+/g))words.push({text:m[0],...(native?{sourceRun:id}:{}),x0:x+m.index*4,x1:x+(m.index+m[0].length)*4,y0:y,y1:y+8,confidence:100});};
 run('FEDURO',80,80);run('Numero: 55002',80,100);run('Fecha: 12/10/2026',80,120);run('Descripcion',100,300);run('Cantidad',450,300);run('- HB-000001 -',90,400);
 for(const [i,name]of nameRuns.entries())run(name.text,90+(name.x||0),420+(name.y||0),name.native!==false);
 run('(0012345678905) (0 CJ) (6.000 UN)',90,464);run('6',465,400);run('10.00',580,400);run('60.00',710,400);
 return {page:1,width:1000,height:1400,words};
}
test('Feduro descriptions use original PDF runs to restore unknown words, keep word boundaries and preserve source identifiers',()=>{
 const p=feduroPage([{text:'1234500 PERFUME'},{text:'F E M M E',y:12},{text:'E D P',x:90,y:12},{text:'N A T',x:140,y:12},{text:'Z Y Q A N',y:24}]);
 const {rows}=Formats.extract([p]);assert.equal(rows.length,1);const r=rows[0];assert.equal(r.descripcion,'PERFUME FEMME EDP NAT ZYQAN');assert.equal(r.ref,'HB-000001');assert.equal(r.codigo,'0012345678905');assert.equal(r.costo,10);assert.equal(r.salidas_unidades,6);assert.equal(r.pventa,'');assert.match(r.fila_original,/HB-000001/);assert.match(r.fila_original,/1234500/);assert.match(r.fila_original,/F E M M E/);assert.match(r.fila_original,/0012345678905/);
});
test('Feduro cleanup preserves product numbers, sizes and normal names; OCR without native word boundaries remains reviewable',()=>{
 for(const name of ['212 VIP FICTICIO 100 ML','91 EDT 100ML','PERFUME HB001 EDICION 26','SPF 50 PA+++','FORMULA A B']){
  const r=Formats.extract([feduroPage([{text:name}])]).rows[0];assert.equal(r.descripcion,name);
 }
 const r=Formats.extract([feduroPage([{text:'F E M M E E D P',native:false}])]).rows[0];assert.equal(r.descripcion,'F E M M E E D P','Without native boundaries, avoid guessing where one word ends and another begins');
 const missing=Formats.extract([feduroPage([])]).rows;assert.equal(missing.length,1,'A row with missing description must remain available for manual review');assert.equal(missing[0].descripcion,'');assert.equal(missing[0].ref,'HB-000001');
 const s=source();s.rows[0].descripcion='Nombre confirmado A B';assert.equal(Formats.validateSaved(s).rows[0].descripcion,s.rows[0].descripcion,'Confirmed manual descriptions are not rewritten');
});
test('invoice confirmed metadata validates dates, strict amounts, identifiers, limits and allows only known fields',()=>{
 const s=source();s.rows[0].password='never retained';s.extra='never retained';const out=Formats.validateSaved(s);assert.equal(out.extra,undefined);assert.equal(out.rows[0].password,undefined);assert.equal(out.rows[0].pventa,19.99);
 for(const mutate of [s=>s.fecha='31/02/2026',s=>s.pdfSha256='wrong',s=>s.rows[0].codigo=s.rows[0].ref='',s=>s.rows[0].salidas_unidades=NaN,s=>s.rows[0].pventa=19.999,s=>s.rows[0].priceOrigin='pending',s=>s.rows[0].descripcion='x'.repeat(2049)]){const s=source();mutate(s);assert.throws(()=>Formats.validateSaved(s));}
 assert.equal(Formats.numeric('1,800.00'),1800);assert.equal(Formats.numeric('35.1234'),35.1234);assert.equal(Formats.numeric('12/0000'),'');assert.equal(Formats.date('03/08/2026'),'03/08/2026');
});
test('invoice indexes preserve Salidas priority, printed dates, reference lookup, small revision checks and no PDF reads',async()=>{
 const docs=new Map([['invoice',{kind:'factura',format:'feduro',reviewed:true,salida:'55002',invoiceDate:'2026-10-12',products:[{codigo:'1234509876543',ref:'HB-001',pventa:19.99}]}],['salida',{kind:'salida',salida:'29345',invoiceDate:'2026-10-09',products:[{codigo:'1234509876543',ref:'HB-001',pventa:8.99}]}],['reference',{kind:'factura',salida:'55003',invoiceDate:'2026-10-12',products:[{codigo:'',ref:'117775N/TOL',pventa:42.99}]}]]);
 let reads=0,lastOptions;const snapshot=async(_,options)=>{lastOptions=options;return [...docs.keys()].map(id=>({id,encrypted_metadata:options?.light?undefined:'cipher'+id,metadata_revision:'hash'+id}));};
 const cat=Catalog.create({snapshot,document:async id=>{reads++;return docs.get(id);},cache:{read:async()=>null,write:async()=>{}},seal:async v=>v,verifyAccess:async()=>{}});
 await cat.prepare();assert.equal((await cat.lookup('1234509876543')).match.product.pventa,8.99);assert.equal((await cat.lookup('hb-001')).match.product.pventa,8.99);assert.equal((await cat.lookup('117775n/tol')).match.product.pventa,42.99);assert.equal((await cat.lookup('1234509876543')).match.history.length,2);
 for(let i=0;i<100;i++)await cat.lookup('117775N/TOL');assert.equal(reads,3);assert.equal(await cat.hasUpdates(),false);assert.equal(lastOptions.light,true);
});
test('ambiguous references require the exact barcode and cannot borrow a shared reference override',async()=>{
 const cat=Catalog.create({snapshot:async()=>[{id:'one',encrypted_metadata:'v1'}],document:async()=>({kind:'factura',salida:'55002',invoiceDate:'2026-10-12',products:[{codigo:'1234509876543',ref:'VAR-01',pventa:5.99},{codigo:'1234509876550',ref:'VAR-01',pventa:7.99},{codigo:'',ref:'SOLO-REF',pventa:8.99}]}),cache:{read:async()=>null,write:async()=>{}},seal:async v=>v,verifyAccess:async()=>{}});
 assert.equal((await cat.prepare()).products,3);const match=(await cat.lookup('VAR-01')).match;assert.equal(match.ambiguousReference,true);assert.equal(match.product.pventa,null);assert.equal((await cat.lookup('1234509876543')).match.product.referenceAmbiguous,true);assert.equal((await cat.lookup('1234509876543')).match.product.pventa,5.99);assert.equal((await cat.lookup('SOLO-REF')).match.product.pventa,8.99);
});
test('unidentified fiscal rows retain actual cost and manual prices but never create a barcode or a reference',async()=>{
 const s=source();Object.assign(s.rows[0],{codigo:'',ref:'',numero_linea:1,informacion_interes:'STOCK^Garpac:5555^PT:99988877',descuento_unitario:2.8,impuesto_importe:27.05,valor_item:413.45});s.totals={subtotal:60,impuesto:4.2,total_neto:64.2};const saved=Formats.validateSaved(s);assert.equal(saved.rows[0].codigo,'');assert.equal(saved.rows[0].ref,'');assert.equal(saved.rows[0].informacion_interes,s.rows[0].informacion_interes);assert.deepEqual(saved.totals,s.totals);
 let stored;const cat=Catalog.create({snapshot:async()=>[{id:'invoice',encrypted_metadata:'v1'}],document:async()=>({kind:'factura',salida:'55003',products:saved.rows}),cache:{read:async()=>stored,write:async v=>stored=v},seal:async v=>v,unseal:async v=>v,verifyAccess:async()=>{}});
 assert.equal((await cat.prepare()).unidentified,1);for(const code of ['5555','99988877','1']){const result=await cat.lookup(code);assert.equal(result.match,null);assert.equal(result.unidentified,1);}
 await cat.prepare();assert.equal((await cat.lookup('99988877')).unidentified,1,'The encrypted-cache replay also flags missing identities');
 for(const key of ['descuento_unitario','impuesto_importe','valor_item']){const bad=structuredClone(s);bad.rows[0][key]=NaN;assert.throws(()=>Formats.validateSaved(bad));}
});
