const test=require('node:test'),assert=require('node:assert/strict'),V=require('../salida-versions.js');
const row=(code,quantity,extra={})=>({codigo:code,descripcion:'Producto '+code,ref:'REF-'+code,salidas_unidades:quantity,costo:9.99,pventa:12.99,salidas_total:quantity*9.99,...extra});
const source=rows=>({info:{numero:'001050',fecha:'8/10/2026',subtotal:100,impuesto:7,total_neto:107},rows});
test('salida comparison ignores whitespace, row order, print metadata and output columns; preserves zeroes, missing values and repeated lines',()=>{
 const a=V.create(source([row('000123',10),row('456',5)])),b=V.create({...source([row('456',5),row(' 000123 ',10,{descripcion:'Producto   000123',ref:'REF-000123'})]),printedAt:'later',columns:['cost']},'1050');assert.equal(a.identity,b.identity);assert.equal(a.canonical,b.canonical);assert.ok(V.compare(a,b).equal);assert.equal(a.rows.find(r=>r.codigo==='000123').codigo,'000123');
 assert.notEqual(V.create(source([row('000123',0)])).canonical,V.create(source([row('000123',null)])).canonical);
 assert.notEqual(V.create(source([row('000123',1)])).canonical,V.create(source([row('000123',1),row('000123',1)])).canonical);
 assert.notEqual(V.create(source([row('000123',1)])).canonical,V.create(source([row('123',1)])).canonical);
});
test('salida comparison detects additions, removals, quantities, cost, barcode and complete invoice totals',()=>{
 const a=V.create(source([row('shirt',10),row('pants',5),row('shoe',8),row('old',1)]));
 const b=V.create({...source([row('shirt',12,{costo:7.99}),row('pants',5),row('shoe-new',6,{ref:'REF-shoe',descripcion:'Producto shoe'}),row('new',2)]),info:{...source([]).info,total_neto:200}});
 const changes=V.compare(a,b);assert.equal(changes.changed.length,2);assert.equal(changes.added[0].codigo,'new');assert.equal(changes.removed[0].codigo,'old');assert.equal(changes.unchanged,1);assert.equal(changes.changed.find(r=>r.after.codigo==='shirt').fields.find(f=>f.key==='salidas_unidades').delta,2);assert.equal(changes.changed.find(r=>r.after.codigo==='shoe-new').fields.find(f=>f.key==='salidas_unidades').delta,-2);assert.ok(changes.changed.some(r=>r.fields.some(f=>f.key==='codigo')));assert.deepEqual(changes.document.map(f=>f.key),['total_neto']);
});
test('salida identity isolates suppliers and deliberately renamed output identifiers, with no integer precision loss',()=>{
 const a=source([row('001',1)]);assert.notEqual(V.create(a).identity,V.create({...a,context:'another-supplier'}).identity);assert.notEqual(V.create(a).identity,V.create(a,'999').identity);const long='9'.repeat(40);assert.equal(V.identifier('000'+long),long);assert.throws(()=>V.create({...a,rows:[]}));
 const issued=name=>({...a,info:{...a.info,emisor:name}});assert.equal(V.create(issued('CITY MALL, S.A.')).identity,V.create(issued('City Mall S. A.')).identity);assert.notEqual(V.create(issued('CITY MALL, S.A.')).identity,V.create(issued('OTRO EMISOR, S.A.')).identity);
});
