'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Chat=require('../product-chat-cloud.js');
const base={version:1,result:'found',code:'0001234567890',description:'Producto ficticio',ref:'REF-001',cents:0,source:'Precio de la última factura',salida:'00123',invoiceDate:'2026-10-15',checkedAt:'2026-10-15T12:00:00Z'};
test('chat cards retain leading zeroes and true zero prices; reference-only queries never invent a barcode',()=>{
 assert.equal(Chat.code(' 0001234567890 '),'0001234567890');assert.equal(Chat.product({...base}).cents,0);assert.equal(Chat.product({...base,cents:null}).cents,null);assert.throws(()=>Chat.code('000 1234567890'));
 const p=Chat.product({...base,identifier:'reference',code:'REF 001',cents:null});assert.equal(p.identifier,'reference');assert.equal(p.code,'REF 001');
 assert.throws(()=>Chat.product({...base,cents:7.99}));assert.throws(()=>Chat.body({version:1,text:'x'.repeat(4001)},'text'));assert.throws(()=>Chat.body({version:1,text:'foto sin imagen'},'image'));assert.throws(()=>Chat.body({version:1,sticker:'uploaded-arbitrary-sticker'},'sticker'));
});
