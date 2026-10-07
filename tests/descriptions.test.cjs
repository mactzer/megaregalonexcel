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

// Posiciones del PDF de impresora (106): los encabezados están centrados,
// y el texto original del PDF puede atravesar los límites de otra columna.
const header = [
  ['Codigo', 18.12], ['Descripción', 67.5600015], ['Empaque', 191.27999475],
  ['Ref.', 279.120003], ['I.V.', 322.55999025], ['Costo', 349.55999025],
  ['P/Venta', 387.11997975], ['Unidades', 432.11997975], ['Total', 492.116],
  ['Unidades', 520.56], ['Total', 574.56]
];

function raw(str, x, width, y = 30) {
  return { str, x, width, y };
}

function parse(blocks, { styleHeader = false } = {}) {
  const columns = styleHeader ? [...header, ['Estilo', 235]] : header;
  context.fixture = {
    header: columns.map(([str, x]) => raw(str, x, str.length * 3, 10)),
    blocks: [
      ...blocks,
      raw('G 7.00', 309, 27),
      raw('2.79', 349.56, 14),
      raw('3.75', 387.12, 14),
      raw('72.00', 432.12, 17),
      raw('200.88', 492.116, 21)
    ]
  };
  return vm.runInContext(`
    (() => {
      const headerLine = groupLines(fixture.header.flatMap(splitTextItem))[0];
      const dataLine = groupLines(fixture.blocks.flatMap(splitTextItem))[0];
      return parseRow(dataLine, buildGeometry([headerLine], 0));
    })()
  `, context);
}

test('conserva la descripción que empieza antes del encabezado y separa el código corto', () => {
  const row = parse([
    raw('01 674630', 11.28, 28.37),
    raw('GANCHITO D/METAL', 65.242, 62),
    raw('12588', 268.56, 16.735)
  ]);
  assert.equal(row.codigo, '674630');
  assert.equal(row.codigo_completo, '01 674630');
  assert.equal(row.descripcion, 'GANCHITO D/METAL');
  assert.equal(row.ref, '12588');
  assert.equal(row.salidas_unidades, 72);
  assert.equal(row.costo, 2.79);
  assert.equal(row.salidas_total, 200.88);
  assert.equal(row.iv, 'G 7.00');
});

test('conserva una descripción de una palabra en su columna', () => {
  const row = parse([
    raw('01 715580', 11.28, 28.37),
    raw('LACITOS', 65.242, 25.673),
    raw('12588', 268.56, 16.735)
  ]);
  assert.equal(row.codigo, '715580');
  assert.equal(row.codigo_completo, '01 715580');
  assert.equal(row.descripcion, 'LACITOS');
});

test('conserva todo el bloque de descripción aunque atraviese el encabezado Empaque', () => {
  const description = 'DECORACION PARA HOGAR CON FLORES ARTIFICIALES';
  const row = parse([
    raw('01 0793969648009', 11.28, 48),
    raw(description, 65.242, 190),
    raw('DM543-26', 268.56, 29)
  ]);
  assert.equal(row.descripcion, description);
  assert.equal(row.empaque, '');
  assert.equal(row.estilo, '');
  assert.equal(row.ref, 'DM543-26');
  assert.equal(row.codigo_completo, '01 0793969648009');
});

test('extrae el código y la descripción cuando vienen en un solo bloque PDF', () => {
  const row = parse([
    raw('01 0793969648009 CARTERA D/MUJER CON FLORES', 11.28, 230),
    raw('DM543-26', 268.56, 29)
  ]);
  assert.equal(row.codigo, '0793969648009');
  assert.equal(row.codigo_completo, '01 0793969648009');
  assert.equal(row.descripcion, 'CARTERA D/MUJER CON FLORES');
  assert.equal(row.empaque, '');
  assert.equal(row.ref, 'DM543-26');
});

test('sin encabezado Estilo conserva Empaque completo aunque su ancho llegue a Ref.', () => {
  const row = parse([
    raw('01 6931220503122', 11.28, 48),
    raw('UÑAS FALSAS P/NIÑA', 65.242, 155),
    raw('UÑAS FALSAS', 242.28, 41.15),
    raw('12588', 268.56, 16.735)
  ]);
  assert.equal(row.descripcion, 'UÑAS FALSAS P/NIÑA');
  assert.equal(row.empaque, 'UÑAS FALSAS');
  assert.equal(row.estilo, '');
  assert.equal(row.ref, '12588');
});

test('con encabezado Estilo conserva el estilo de varias palabras y la referencia aparte', () => {
  const row = parse([
    raw('01 0793969648009', 11.28, 48),
    raw('CARTERA D/MUJER', 65.242, 80),
    raw('CAJA', 195, 15),
    raw('XL AZUL', 242.28, 25),
    raw('DM543-26', 268.56, 29)
  ], { styleHeader: true });
  assert.equal(row.descripcion, 'CARTERA D/MUJER');
  assert.equal(row.empaque, 'CAJA');
  assert.equal(row.estilo, 'XL AZUL');
  assert.equal(row.ref, 'DM543-26');
});
