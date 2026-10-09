const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({
  pdfjsLib: { GlobalWorkerOptions: {} },
  document: { querySelector: () => ({ addEventListener() {} }) }
});
vm.runInContext(script, context);

function numberFrom(value) {
  context.value = value;
  return vm.runInContext('numberFrom(value)', context);
}

test('lee cantidades completas con separadores de miles, decimales y signos', () => {
  for (const [value, expected] of [
    ['1,800.00', 1800], ['1,800', 1800], ['25,600.75', 25600.75],
    ['1,234,567.89', 1234567.89], ['-1,800.00', -1800], ['+1,800.00', 1800],
    ['1 800.00', 1800], ['1\u00a0800.00', 1800], ['1, 800.00', 1800],
    ['1.800,00', 1800], ['25.600,75', 25600.75], ['1.234.567,89', 1234567.89]
  ]) {
    assert.equal(numberFrom(value), expected, value);
  }
});

test('conserva cantidades fraccionarias, ceros y campos numéricos ausentes', () => {
  for (const [value, expected] of [
    ['1.80', 1.8], ['1,80', 1.8], ['0.35', 0.35], ['0,125', 0.125],
    ['-1.80', -1.8], ['7.00', 7], ['0.00', 0], [0, 0],
    ['', ''], ['   ', ''], [null, ''], [undefined, ''], ['sin valor', '']
  ]) {
    assert.equal(numberFrom(value), expected, String(value));
  }
});

test('no convierte separadores inválidos en una cantidad parcial', () => {
  for (const value of ['1,80.00', '1.8.00', '1,800,00']) {
    assert.equal(numberFrom(value), '', value);
  }
});

test('conserva la última fila con miles, su código textual y los totales de unidades', () => {
  // Datos ficticios: mismas columnas del reporte, sin información empresarial.
  context.fixture = {
    header: [
      ['Codigo', 18], ['Descripción', 68], ['Empaque', 191], ['Ref.', 279],
      ['I.V.', 322], ['Costo', 350], ['P/Venta', 387], ['Unidades', 432],
      ['Total', 492], ['Unidades', 520], ['Total', 574]
    ],
    rows: [
      [['01 00012345', 11], ['PRODUCTO FICTICIO A', 65], ['E', 309], ['0.50', 350], ['4.00', 432], ['2.00', 492]],
      [['01 00098765', 11], ['PRODUCTO FICTICIO B', 65], ['G 7.00', 309], ['0.25', 350], ['1,800.00', 432], ['450.00', 492]]
    ]
  };
  const result = vm.runInContext(`
    (() => {
      const line = (blocks, y) => groupLines(blocks.flatMap(([str, x]) => splitTextItem({ str, x, width: str.length * 3, y })))[0];
      const header = line(fixture.header, 10);
      const geometry = buildGeometry([header], 0);
      const rows = fixture.rows.map((blocks, index) => parseRow(line(blocks, 30 + index * 10), geometry));
      state.rows = rows;
      state.documentInfo = { impuesto: '', subtotal: '', total_neto: '' };
      return { rows, totals: calculateTotals() };
    })()
  `, context);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[1].codigo, '00098765');
  assert.equal(result.rows[1].salidas_unidades, 1800);
  assert.equal(result.rows[1].costo, 0.25);
  assert.equal(result.rows[1].salidas_total, 450);
  assert.equal(result.totals.totalUnidades, 1804);
  assert.equal(result.totals.lineasSinUnidades, 0);
  assert.equal(result.totals.subtotal, 452);
  assert.equal(result.totals.impuesto, 31.5);
});
