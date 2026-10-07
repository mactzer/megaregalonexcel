const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({
  pdfjsLib: { GlobalWorkerOptions: {} },
  document: { querySelector: () => ({ addEventListener() {} }) }
});
vm.runInContext(script, context);

function parse(style, reference) {
  // Encabezados centrados y datos alineados a la izquierda, como en el reporte.
  const header = [
    ['Codigo', 18], ['Descripción', 67], ['Empaque', 191],
    ['Estilo', 235], ['Ref.', 279], ['I.V.', 322], ['Costo', 349],
    ['P/Venta', 387], ['Unidades', 432], ['Total', 492],
    ['Unidades', 520], ['Total', 574]
  ].map(([text, x]) => ({ text, x }));
  const items = [
    { text: '0793969648009', x: 18 },
    { text: 'CARTERA', x: 67 },
    ...style.map((text, i) => ({ text, x: 242 + i * 8 })),
    ...reference.map((text, i) => ({ text, x: 268 + i * 24 })),
    { text: 'G', x: 309 }, { text: '7.00', x: 318 },
    { text: '10.00', x: 349 }, { text: '2.00', x: 432 },
    { text: '20.00', x: 492 }
  ];
  context.fixture = { header, items };
  return vm.runInContext('parseRow({ items: fixture.items }, buildGeometry([{ items: fixture.header }], 0))', context);
}

test('conserva la referencia cuando Estilo está vacío', () => {
  const row = parse([], ['BG04536']);
  assert.equal(row.ref, 'BG04536');
  assert.equal(row.estilo, '');
  assert.equal(row.iv, 'G 7.00');
  assert.equal(row.salidas_total, 20);
});

test('separa Estilo y Ref. sin perder referencias numéricas ni de varias palabras', () => {
  for (const [style, reference, expected] of [
    [['CARTERA'], ['20055'], '20055'],
    [['Carteras'], ['SH-172', 'BLUE'], 'SH-172 BLUE'],
    [[], ['SH-172', 'BLUE'], 'SH-172 BLUE'],
    [['XL'], [], ''],
    [['XL', 'AZUL'], ['DM543-26'], 'DM543-26']
  ]) {
    const row = parse(style, reference);
    assert.equal(row.estilo, style.join(' '));
    assert.equal(row.ref, expected);
  }
});
