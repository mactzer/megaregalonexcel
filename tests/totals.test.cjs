const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function totals(quantities) {
  const context = vm.createContext({
    pdfjsLib: { GlobalWorkerOptions: {} },
    document: { querySelector: () => ({ addEventListener() {} }) },
    quantities
  });
  vm.runInContext(script, context);
  return vm.runInContext(`
    state.rows = quantities.map(salidas_unidades => ({ salidas_unidades, salidas_total: 10 }));
    state.documentInfo = { impuesto: 0, subtotal: '', total_neto: '' };
    calculateTotals();
  `, context);
}

test('suma las unidades de todas las filas, incluidas las de productos repetidos', () => {
  const result = totals([2,4,4,2,6,4,4,5,6,4,3,2,5,3,5,5,4,5,17,2,3,4,4,6,8,6,6,24,36,36,48]);
  assert.equal(result.totalUnidades, 273);
  assert.equal(result.lineasSinUnidades, 0);
  assert.equal(result.subtotal, 310);
});

test('incluye todas las filas, aunque la vista previa solo muestre las primeras cien', () => {
  assert.equal(totals(Array(120).fill(2)).totalUnidades, 240);
});

test('distingue cero unidades de cantidades ausentes y conserva cantidades fraccionarias', () => {
  const result = totals([0, 1.25, 2.5, '', null, undefined]);
  assert.equal(result.totalUnidades, 3.75);
  assert.equal(result.lineasSinUnidades, 3);
});
