'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Formats=require('../invoice-formats'),Catalog=require('../mobile-catalog');
function source(){return {version:1,kind:'factura',format:'feduro',numero:'55002',fecha:'12/10/2026',pdfSha256:'a'.repeat(64),rows:[{codigo:'1234509876543',ref:'HB-001',descripcion:'Producto ficticio',salidas_unidades:6,costo:10,pventa:19.99,salidas_total:60,entradas_unidades:'',entradas_total:'',priceOrigin:'manual'}]};}
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
