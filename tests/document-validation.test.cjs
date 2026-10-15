'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Validation=require('../document-validation.js');
test('PDF validation preserves zeroes and distinguishes missing data, mismatches and unavailable printed totals',()=>{
  const row={codigo:'0000123456789',descripcion:'Artículo',costo:0,salidas_unidades:0,salidas_total:0};
  const totals={subtotal:0,totalUnidades:0,impuesto:0,totalNeto:0,invalidTaxRows:[]};
  const good=Validation.inspect([row],{subtotal:0,impuesto:0,total_neto:0,total_unidades:0},totals);assert.equal(good.complete,true);assert.ok(good.comparisons.every(r=>r.state==='ok'));
  const missing=Validation.inspect([{...row,costo:'',salidas_unidades:''}],{},totals);assert.equal(missing.needsReview,true);assert.equal(missing.affected[0].code,'0000123456789');assert.deepEqual(missing.affected[0].fields,['Cantidad','Costo']);assert.ok(missing.comparisons.every(r=>r.state==='unavailable'));
  const mismatch=Validation.inspect([row],{subtotal:1,impuesto:2,total_neto:3,total_unidades:4},totals);assert.equal(mismatch.needsReview,true);assert.deepEqual(mismatch.comparisons.map(r=>r.difference),[-4,-1,-2,-3]);
  assert.equal(Validation.inspect([row],{subtotal:0.01},totals).complete,true);
  assert.equal(Validation.inspect([row],{subtotal:0.02},totals).complete,false);
});

test('only products missing both barcode and reference receive the identification warning; financial blanks remain distinct from zeroes',()=>{
  const rows=[{codigo:'0000123456789',ref:'',costo:'',salidas_unidades:1,salidas_total:''},{codigo:'',ref:'REF-001',costo:0,salidas_unidades:0,salidas_total:0},{codigo:' ',ref:' ',descripcion:'Sin etiqueta',costo:'',salidas_unidades:'',salidas_total:''}];
  const report=Validation.inspect(rows,{}, {totalUnidades:1,subtotal:0,impuesto:'',totalNeto:'',invalidTaxRows:[]});
  assert.deepEqual(report.missingIdentifiers,[3]);assert.equal(report.needsReview,true);assert.equal(report.affected.length,2);assert.equal(rows[0].codigo,'0000123456789');assert.equal(rows[0].costo,'');assert.equal(rows[1].costo,0);assert.equal(rows[2].salidas_unidades,'');
});
