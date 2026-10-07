const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

function appContext(extra = {}) {
  const context = vm.createContext({
    pdfjsLib: { GlobalWorkerOptions: {} },
    document: { querySelector: () => ({ addEventListener() {} }) },
    ...extra
  });
  vm.runInContext(script, context);
  return context;
}

function totals(rows, documentInfo = {}) {
  const context = appContext({ rows, documentInfo });
  return vm.runInContext(`
    state.rows = rows;
    state.documentInfo = { impuesto: '', subtotal: '', total_neto: '', ...documentInfo };
    calculateTotals();
  `, context);
}

test('reconoce las tasas gravadas y las marcas de productos exentos', () => {
  const context = appContext();
  for (const [value, expected] of [
    ['G 7.00', 7], ['G7.00', 7], ['7%', 7], ['0', 0],
    ['E 0.00', 0], ['E', 0], ['EXENTO', 0], ['', 0], ['   ', 0], [' g 7.00 ', 7],
    ['G 100.00', 100]
  ]) {
    context.value = value;
    assert.equal(vm.runInContext('getTaxRate(value)', context), expected, String(value));
  }
});

test('no inventa una tasa para códigos contradictorios, incompletos o inválidos', () => {
  const context = appContext();
  for (const value of [
    null, undefined, '?', 'G', 'E7', 'E 7.00', 'EXENTO 7%',
    'G -7', '-7%', 'G 101', '101%', 'G 7.00 0.00', 'G siete',
    'IVA 7 sin confirmar', '7.0.0', 'Infinity', 'NaN'
  ]) {
    context.value = value;
    assert.equal(vm.runInContext('getTaxRate(value)', context), null, String(value));
  }
});

test('aplica 7 % solo a los productos gravados y suma los exentos al total neto', () => {
  const result = totals([
    { iv: 'G 7.00', salidas_total: 100, salidas_unidades: 2 },
    { iv: 'E 0.00', salidas_total: 50, salidas_unidades: 3 }
  ]);
  assert.equal(result.subtotal, 150);
  assert.equal(result.subtotalGravado, 100);
  assert.equal(result.subtotalExento, 50);
  assert.equal(result.impuestoCalculado, 7);
  assert.equal(result.impuesto, 7);
  assert.equal(result.totalNeto, 157);
  assert.equal(result.totalUnidades, 5);
  assert.equal(result.lineasSinTasa, 0);
});

test('una factura solo con productos exentos tiene impuesto cero, no impuesto ausente', () => {
  const result = totals([
    { iv: 'E', salidas_total: 25 },
    { iv: 'EXENTO', salidas_total: 75 }
  ]);
  assert.equal(result.subtotalGravado, 0);
  assert.equal(result.subtotalExento, 100);
  assert.equal(result.impuestoCalculado, 0);
  assert.equal(result.impuesto, 0);
  assert.equal(result.totalNeto, 100);
  assert.equal(result.lineasSinTasa, 0);
});

test('I.V. vacío identifica los productos exentos del reporte del usuario', () => {
  const result = totals([
    { iv: '', salidas_total: 50 },
    { iv: '  ', salidas_total: 100 }
  ], { impuesto: 0 });
  assert.equal(result.subtotalGravado, 0);
  assert.equal(result.subtotalExento, 150);
  assert.equal(result.impuestoCalculado, 0);
  assert.equal(result.impuesto, 0);
  assert.equal(result.totalNeto, 150);
  assert.equal(result.lineasSinTasa, 0);
});

test('el impuesto impreso sirve para comparar y no sustituye el cálculo por producto', () => {
  const result = totals([
    { iv: 'G7.00', salidas_total: 100 },
    { iv: '0', salidas_total: 50 }
  ], { impuesto: 10.50 });
  assert.equal(result.impuestoCalculado, 7);
  assert.equal(result.impuesto, 7);
  assert.equal(result.impuestoPdf, 10.50);
  assert.equal(result.totalNeto, 157);
});

test('una tasa desconocida impide dar impuesto y total neto automáticos aunque el PDF imprima impuesto', () => {
  const result = totals([
    { iv: 'G 7.00', salidas_total: 100 },
    { iv: '?', salidas_total: 50 },
    { iv: 'G', salidas_total: 20 }
  ], { impuesto: 11.90 });
  assert.equal(result.subtotal, 170);
  assert.equal(result.lineasSinTasa, 2);
  assert.equal(result.impuesto, '');
  assert.equal(result.totalNeto, '');
  assert.equal(result.impuestoPdf, 11.90);
});

test('cuenta tasas ausentes aunque el producto tampoco tenga un importe detectado', () => {
  const result = totals([
    { iv: 'G 7.00', salidas_total: 100 },
    { iv: '?', salidas_total: '' },
    { iv: 'E', salidas_total: null },
    { salidas_total: undefined }
  ]);
  assert.equal(result.lineasSinTotal, 3);
  assert.equal(result.lineasSinTasa, 2);
  assert.equal(result.impuesto, '');
  assert.equal(result.totalNeto, '');
});

test('un importe de producto ausente también impide dar un total automático', () => {
  const result = totals([
    { iv: 'G 7.00', salidas_total: 100 },
    { iv: 'E 0.00', salidas_total: '' }
  ]);
  assert.equal(result.subtotal, 100);
  assert.equal(result.lineasSinTotal, 1);
  assert.equal(result.lineasSinTasa, 0);
  assert.equal(result.impuesto, '');
  assert.equal(result.totalNeto, '');
});

test('redondea el impuesto después de sumar las contribuciones de los productos', () => {
  const result = totals(Array.from({ length: 3 }, () => ({ iv: 'G 7.00', salidas_total: 0.07 })));
  assert.equal(result.subtotal, 0.21);
  assert.equal(result.impuestoCalculado, 0.01);
  assert.equal(result.impuesto, 0.01);
  assert.equal(result.totalNeto, 0.22);
});

test('reproduce el impuesto de 76.06 del PDF SALIDA PRUEBA 2 con sus 31 importes originales', () => {
  const amounts = [
    20, 20, 20, 20, 76.69, 20, 16.12, 25, 53.24, 20, 30,
    20, 96.87, 27.96, 66.93, 53.80, 21, 17.59, 59.79, 10,
    5.94, 16.72, 26, 30.72, 29.36, 40.74, 52.80, 76.03,
    20.97, 50.33, 41.94
  ];
  const result = totals(amounts.map(salidas_total => ({ iv: 'G 7.00', salidas_total })), {
    subtotal: 1086.55, impuesto: 76.06, total_neto: 1162.61
  });
  assert.equal(result.lineasConTotal, 31);
  // El PDF imprime 1086.55, pero sus importes por producto suman 1086.54.
  assert.equal(result.subtotalGravado, 1086.54);
  assert.equal(result.subtotalExento, 0);
  assert.equal(result.impuestoCalculado, 76.06);
  assert.equal(result.impuesto, 76.06);
  assert.equal(result.totalNeto, 1162.60);
  assert.equal(result.diferenciaSubtotal, -0.01);
  assert.equal(result.diferenciaTotalNeto, -0.01);
});

test('solo una confirmación manual explícita permite usar un impuesto en lugar de tasas desconocidas', () => {
  const rows = [{ iv: '?', salidas_total: 100 }];
  const automatic = totals(rows, { impuesto: 9, impuestoManualImporte: 7 });
  assert.equal(automatic.impuesto, '');
  assert.equal(automatic.totalNeto, '');

  const manual = totals(rows, { impuesto: 9, impuestoManual: true, impuestoManualImporte: 7 });
  assert.equal(manual.impuesto, 7);
  assert.equal(manual.totalNeto, 107);
  assert.equal(manual.impuestoPdf, 9);
  assert.equal(manual.lineasSinTasa, 1);
});

test('el impuesto manual cero es válido y el valor vacío o no finito no lo es', () => {
  const rows = [{ iv: '?', salidas_total: 100 }];
  const zero = totals(rows, { impuestoManual: true, impuestoManualImporte: 0 });
  assert.equal(zero.impuesto, 0);
  assert.equal(zero.totalNeto, 100);
  for (const impuestoManualImporte of ['', null, undefined, NaN, Infinity]) {
    const result = totals(rows, { impuestoManual: true, impuestoManualImporte });
    assert.equal(result.impuesto, '', String(impuestoManualImporte));
    assert.equal(result.totalNeto, '', String(impuestoManualImporte));
  }
});
