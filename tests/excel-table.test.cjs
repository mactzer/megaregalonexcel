const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const XLSX = require('../vendor/xlsx.full.min.js');
const ExcelTable = require('../excel-table.js');

const defaultHeaders = ['Código de barras', 'Salidas - Unidades', 'Costo', 'Salidas - Total'];

function fixture(headers = defaultHeaders) {
  const workbook = XLSX.utils.book_new();
  const products = [
    ['085907617605', 2, 1.30, 2.60],
    ['001234', 3, 3.55, 10.65]
  ];
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...products.map(row => row.slice(0, headers.length)),
    [],
    ['Subtotal', 13.25],
    ['Impuesto', 0.93],
    ['Total Neto', 14.18],
    ['Total de unidades', 5],
    ['Estado', 'CALCULADO DESDE LAS LÍNEAS'],
    ['Base gravada', 13.25],
    ['Base exenta (0 %)', 0]
  ]);
  sheet['!cols'] = headers.map((header, i) => ({ wch: i ? 15 : 20 }));
  for (const address of ['B2', 'C2', 'D2', 'B3', 'C3', 'D3', 'B5', 'B6', 'B7', 'B8', 'B10', 'B11']) {
    if (sheet[address]) sheet[address].z = '0.00';
  }
  if (headers.length === 4) {
    sheet.B5.f = 'ROUND(SUM(D2:D3),2)';
    sheet.B7.f = 'ROUND(B5+B6,2)';
    sheet.B8.f = 'ROUND(SUM(B2:B3),2)';
  }
  XLSX.utils.book_append_sheet(workbook, sheet, 'Datos');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Concepto', 'Valor calculado'], ['Subtotal', 13.25]
  ]), 'Resumen');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Campo', 'Valor'], ['Número del documento', '29307']
  ]), 'Información');
  const backup = XLSX.utils.aoa_to_sheet([
    ['Página', 'Línea', 'Texto original'], [1, 1, 'Salida número 29307'],
    [1, 2, '085907617605 PRODUCTO COMPLETO']
  ]);
  backup['!autofilter'] = { ref: 'A1:C3' };
  XLSX.utils.book_append_sheet(workbook, backup, 'Respaldo original');
  return workbook;
}

function exportFixture(workbook, headers = defaultHeaders, engine = XLSX, exporter = ExcelTable) {
  const bytes = exporter.write(engine, workbook, { sheetName: 'Datos', headers });
  const archive = engine.CFB.read(bytes, { type: 'array' });
  return {
    bytes,
    xml(part) {
      const entry = engine.CFB.find(archive, `/${part}`);
      assert.ok(entry, `El archivo contiene ${part}`);
      return new TextDecoder().decode(entry.content);
    },
    workbook: engine.read(bytes, { type: 'array', cellNF: true })
  };
}

test('exporta una tabla nativa con filtros y filas alternas hasta el resumen', () => {
  const result = exportFixture(fixture());
  const table = result.xml('xl/tables/table1.xml');
  assert.match(table, /<table\b[^>]*\bid="1"[^>]*\bname="DatosTabla"[^>]*\bdisplayName="DatosTabla"[^>]*\bref="A1:D11"/);
  assert.match(table, /headerRowCount="1"/);
  assert.match(table, /totalsRowShown="0"/);
  assert.match(table, /<autoFilter ref="A1:D11"\s*\/>/);
  assert.match(table, /<tableColumns count="4">/);
  assert.equal([...table.matchAll(/<tableColumn\s/g)].length, 4);
  assert.match(table, /<tableStyleInfo[^>]*name="TableStyleLight1"[^>]*showRowStripes="1"/);
  const sheet = result.xml('xl/worksheets/sheet1.xml');
  const tablePartId = sheet.match(/<tableParts count="1"><tablePart r:id="([^"]+)"\s*\/><\/tableParts>/)?.[1];
  assert.ok(tablePartId, 'La hoja enlaza la tabla nativa');
  assert.doesNotMatch(sheet, /<autoFilter\b/);
  const relationships = result.xml('xl/worksheets/_rels/sheet1.xml.rels');
  assert.ok(relationships.includes(`Id="${tablePartId}"`));
  assert.match(relationships, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/table" Target="\.\.\/tables\/table1\.xml"/);
  assert.match(result.xml('[Content_Types].xml'), /<Override PartName="\/xl\/tables\/table1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.table\+xml"\s*\/>/);
  assert.doesNotMatch(result.xml('xl/workbook.xml'), /name="_xlnm\._FilterDatabase" localSheetId="0"/);
});

test('conserva códigos como texto, fórmulas, resultados, formatos y las otras hojas', () => {
  const result = exportFixture(fixture());
  const sheet = result.workbook.Sheets.Datos;
  assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.A2.v, '085907617605');
  assert.equal(sheet.A3.v, '001234');
  assert.equal(sheet.B2.t, 'n');
  assert.equal(sheet.B2.v, 2);
  assert.equal(sheet.C3.v, 3.55);
  assert.equal(sheet.B5.f, 'ROUND(SUM(D2:D3),2)');
  assert.equal(sheet.B5.v, 13.25);
  assert.equal(sheet.B7.f, 'ROUND(B5+B6,2)');
  assert.equal(sheet.B7.v, 14.18);
  assert.equal(sheet.B8.f, 'ROUND(SUM(B2:B3),2)');
  assert.equal(sheet.B8.v, 5);
  for (const address of ['B2', 'C3', 'D3', 'B5', 'B7', 'B8', 'B11']) {
    assert.equal(sheet[address].z, '0.00', address);
  }
  assert.deepEqual(result.workbook.SheetNames, ['Datos', 'Resumen', 'Información', 'Respaldo original']);
  assert.equal(result.workbook.Sheets.Resumen.B2.v, 13.25);
  assert.equal(result.workbook.Sheets.Información.B2.v, '29307');
  assert.equal(result.workbook.Sheets['Respaldo original'].C3.v, '085907617605 PRODUCTO COMPLETO');
  assert.match(result.xml('xl/worksheets/sheet4.xml'), /<autoFilter ref="A1:C3"\s*\/>/);
});

test('conserva nombres personalizados con signos XML, comillas y caracteres Unicode', () => {
  const headers = ['Código & "barra" <principal>', "Unidades 'salida' > 0", 'Costo Panamá ñ €', 'Total 😀'];
  const result = exportFixture(fixture(headers), headers);
  const table = result.xml('xl/tables/table1.xml');
  assert.ok(table.includes('name="Código &amp; &quot;barra&quot; &lt;principal&gt;"'));
  assert.ok(table.includes('name="Unidades &apos;salida&apos; &gt; 0"'));
  assert.ok(table.includes('name="Costo Panamá ñ €"'));
  assert.ok(table.includes('name="Total 😀"'));
  headers.forEach((header, index) => {
    assert.equal(result.workbook.Sheets.Datos[XLSX.utils.encode_cell({ r: 0, c: index })].v, header);
  });
});

test('una sola columna seleccionada conserva el resumen en B sin inventar otro encabezado', () => {
  const headers = ['Código de barras'];
  const result = exportFixture(fixture(headers), headers);
  assert.match(result.xml('xl/tables/table1.xml'), /ref="A1:A11"/);
  assert.match(result.xml('xl/tables/table1.xml'), /<tableColumns count="1">/);
  assert.equal([...result.xml('xl/tables/table1.xml').matchAll(/<tableColumn\s/g)].length, 1);
  const sheet = result.workbook.Sheets.Datos;
  assert.equal(sheet['!ref'], 'A1:B11');
  assert.equal(sheet.B1, undefined);
  assert.equal(sheet.B2, undefined);
  assert.equal(sheet.A2.v, '085907617605');
  assert.equal(sheet.B5.v, 13.25);
  assert.equal(sheet.B8.v, 5);
  assert.equal(sheet.B11.v, 0);
});

test('mantiene relaciones existentes de la hoja, como hipervínculos', () => {
  const workbook = fixture();
  workbook.Sheets.Datos.A2.l = { Target: 'https://example.com/producto' };
  const result = exportFixture(workbook);
  const relationships = result.xml('xl/worksheets/_rels/sheet1.xml.rels');
  assert.match(relationships, /Target="https:\/\/example\.com\/producto" TargetMode="External"/);
  assert.match(relationships, /Target="\.\.\/tables\/table1\.xml"/);
  assert.equal(result.workbook.Sheets.Datos.A2.l.Target, 'https://example.com/producto');
});

test('genera el archivo en el navegador sin depender de Buffer ni de Node', () => {
  const context = vm.createContext({ Uint8Array, ArrayBuffer, TextEncoder, TextDecoder });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../vendor/xlsx.full.min.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../excel-table.js'), 'utf8'), context);
  assert.equal(vm.runInContext('typeof Buffer', context), 'undefined');
  assert.equal(vm.runInContext('typeof require', context), 'undefined');
  const result = exportFixture(fixture(), defaultHeaders, context.XLSX, context.ExcelTable);
  assert.ok(result.bytes instanceof Uint8Array);
  assert.match(result.xml('xl/tables/table1.xml'), /ref="A1:D11"/);
  assert.equal(result.workbook.Sheets.Datos.A2.v, '085907617605');
  assert.equal(result.workbook.Sheets.Datos.B5.f, 'ROUND(SUM(D2:D3),2)');
  assert.equal(result.workbook.Sheets.Datos.B5.v, 13.25);
});
