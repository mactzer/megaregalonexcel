/* Run with: NODE_PATH=/path/to/playwright/node_modules node --test tests/traza.browser.cjs
 * A local HTTP server and encrypted fictional fixtures intercept every external request.
 * These are browser integration tests, never production Supabase account validation.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { chromium } = require('playwright');
const Crypto = require('../audit-crypto.js');
const XLSX = require('../vendor/xlsx.full.min.js');
const ExcelTable = require('../excel-table.js');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = process.env.TRAZA_BROWSER_OUTPUT || path.join(os.tmpdir(), 'traza-browser-results');
const WORKSPACE = '86551e44-7504-4d30-b453-c9e04b269a43';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'Frase ficticia para TRAZA 2026!';
let browser, server, origin, fixture;

function fakePdf() {
  const text = (value, x, y) => `BT /F1 9 Tf ${x} ${y} Td (${value.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const cells = [
    ['Codigo', 10], ['Descripcion', 110], ['Empaque', 350], ['Estilo', 430],
    ['Ref.', 500], ['I.V.', 580], ['Costo', 640], ['P/Venta', 700],
    ['Unidades', 760], ['Total', 820], ['Unidades', 890], ['Total', 950]
  ];
  const product = ['0001234567890', 'Producto ficticio de descripcion completa', 'Caja', 'Estilo A', 'REF-001 COMPLETA', '7%', '10.00', '12.00', '2', '20.00', '0', '0.00'];
  const exempt = ['0000000000012', 'Producto ficticio exento completo', 'Unidad', 'Estilo B', 'REF-002 COMPLETA', '0%', '5.00', '6.00', '3', '15.00', '0', '0.00'];
  const content = [text('TRAZA - DOCUMENTO FICTICIO, SIN VALOR COMERCIAL', 10, 565), text('Numero: 00123', 10, 540), text('Fecha: 08/10/2026', 10, 520),
    ...cells.map(([label, x]) => text(label, x, 480)), ...cells.map(([, x], i) => text(product[i], x, 455)), ...cells.map(([, x], i) => text(exempt[i], x, 435)),
    text('SubTotal: 35.00', 10, 400), text('Impuesto 1.40', 10, 380), text('Total Neto: 36.40', 10, 360)].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1020 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { output += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output);
}

async function fixtures() {
  const key = Crypto.createRecoveryKey();
  const master = await Crypto.unlock(key, WORKSPACE);
  const unlock = await Crypto.unlockUser('administrador', PASSWORD, WORKSPACE);
  const wrapped = Buffer.from(await unlock.wrapRecoveryKey(key)).toString('base64');
  const pdf = fakePdf();
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Codigo', 'Unidades'], ['0001234567890', 5]]), 'Datos');
  const excel = Buffer.from(ExcelTable.write(XLSX, workbook, { sheetName: 'Datos', headers: ['Codigo', 'Unidades'] }));
  const records = [], storage = new Map();
  for (let index = 0; index < 28; index++) {
    const id = `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`;
    const owner = index % 2 === 0 ? OWNER : OTHER;
    const number = index === 0 ? '00123' : String(30000 + index);
    const metadata = { salida_numero: number, pdf_name: 'Salida ficticia original con nombre completo.pdf', excel_name: `Salida ${number}.xlsx`, row_count: 2, total_units: 5,
      username: 'nombre_manipulado', user_display_name: 'Autor falso en metadatos' };
    const encrypted = await master.encrypt(new TextEncoder().encode(JSON.stringify(metadata)), `${id}|metadata`);
    records.push({ id, workspace_id: WORKSPACE, created_by: owner, created_at: new Date(Date.parse('2026-10-09T02:30:00.000Z') - index * 3600000).toISOString(),
      salida_tag: await master.blindIndex(number), encrypted_metadata: index === 1 ? 'AQAA' : Buffer.from(encrypted).toString('base64') });
    for (const [kind, bytes] of [['pdf', pdf], ['excel', excel]]) storage.set(`${WORKSPACE}/${owner}/${id}/${kind}.bin`, Buffer.from(await master.encrypt(new Uint8Array(bytes), `${id}|${kind}`)));
  }
  return { key, master, authPassword: unlock.authPassword, wrapped, pdf, excel, records, storage, numberTag: await master.blindIndex('00123') };
}

before(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  fixture = await fixtures();
  server = http.createServer((request, response) => {
    const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(ROOT, '.' + (requested === '/' ? '/index.html' : requested));
    if (!filename.startsWith(ROOT + path.sep)) { response.writeHead(403); response.end(); return; }
    fs.readFile(filename, (error, contents) => {
      if (error) { response.writeHead(404); response.end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); response.end(contents);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.TRAZA_CHROMIUM || process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
});

after(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function harness(options = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = { records: fixture.records.map(row => ({ ...row })), storage: new Map(fixture.storage), requests: [], recordCalls: 0, failRecord: 0, failList: 0, failStorage: 0, slowStorage: null, noCount: false, role: options.role || 'admin', external: [] };
  await context.addInitScript(() => {
    window.__picker = { cancel: false, failWrite: false, files: [], calls: [] };
    window.__events = [];
    const readBytes = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async function () {
      if (window.__delayBody && this.url.includes('/storage/')) {
        window.__bodyWaiting = true;
        await new Promise(resolve => { window.__releaseBody = resolve; });
      }
      return readBytes.call(this);
    };
    const fetch = window.fetch;
    window.fetch = function (url, options) { window.__events.push('fetch:' + new URL(String(url), location.href).pathname); return fetch.call(this, url, options); };
    window.showSaveFilePicker = async function (options) {
      window.__events.push('picker'); window.__picker.calls.push({ options, active: navigator.userActivation.isActive });
      if (window.__picker.cancel) throw new DOMException('Cancelled', 'AbortError');
      return { async createWritable() {
        let data;
        return { async write(value) { if (window.__picker.failWrite) throw new Error('Fictional local write failure'); data = Array.from(value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value instanceof Uint8Array ? value : new Uint8Array(value)); },
          async close() { window.__picker.files.push({ name: options.suggestedName, bytes: data }); }, async abort() {} };
      } };
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) { await route.continue(); return; }
    if (url.hostname !== 'aixsnmsmgyejcbtuilwt.supabase.co') { state.external.push(request.url()); await route.abort(); return; }
    const pathname = url.pathname, method = request.method();
    state.requests.push({ pathname, method, search: url.search, body: request.postData() });
    const json = async (data, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range', ...headers }, body: JSON.stringify(data) });
    if (pathname === '/auth/v1/settings') { await json({ external: { email: true }, disable_signup: false, mailer_autoconfirm: true }); return; }
    if (pathname === '/auth/v1/token') {
      const body = request.postDataJSON();
      const name = (body.email || 'administrador@x').split('@')[0];
      await json({ access_token: 'fictional-token', refresh_token: 'fictional-refresh', expires_in: 3600, user: { id: name === 'administrador' ? OWNER : OTHER, email: `${name}@usuarios.megaregalonexcel.invalid` } }); return;
    }
    if (pathname === '/auth/v1/signup') { const body = request.postDataJSON(); await json({ access_token: 'fictional-user-token', refresh_token: 'fictional-refresh', user: { id: OTHER, email: body.email } }); return; }
    if (pathname === '/auth/v1/logout') { await route.fulfill({ status: 204 }); return; }
    if (pathname === '/rest/v1/mega_audit_members') { await json([{ role: state.role }]); return; }
    if (pathname === '/rest/v1/mega_audit_workspace') { await json([{ key_fingerprint: fixture.master.fingerprint }]); return; }
    if (pathname === '/rest/v1/mega_audit_user_keys') { await json([{ wrapped_key: fixture.wrapped }]); return; }
    if (pathname === '/rest/v1/rpc/mega_audit_authors' || pathname === '/rest/v1/rpc/mega_audit_list_members') {
      await json([{ user_id: OWNER, username: 'administrador', role: state.role }, { user_id: OTHER, username: 'colega', role: 'user' }]); return;
    }
    if (pathname === '/rest/v1/rpc/mega_audit_add_member') { const body = request.postDataJSON(); await json({ user_id: OTHER, username: body.p_username, role: body.p_role }); return; }
    if (pathname === '/rest/v1/rpc/mega_audit_record') {
      state.recordCalls++;
      if (state.failRecord) { await json({ code: 'fictional_error' }, state.failRecord); return; }
      const body = request.postDataJSON();
      let row = state.records.find(row => row.id === body.p_id);
      if (!row) { row = { id: body.p_id, created_by: OWNER, workspace_id: WORKSPACE, created_at: '2026-10-09T03:00:00.000Z', salida_tag: body.p_salida_tag, encrypted_metadata: body.p_encrypted_metadata }; state.records.unshift(row); }
      await json(row); return;
    }
    if (pathname === '/rest/v1/mega_audit_records') {
      if (state.failList) { await json({ code: 'fictional_error' }, state.failList); return; }
      const eq = key => (url.searchParams.get(key) || '').replace(/^eq\./, '');
      let rows = state.records.filter(row => (!eq('id') || row.id === eq('id')) && (!eq('salida_tag') || row.salida_tag === eq('salida_tag')) && (!eq('created_by') || row.created_by === eq('created_by')));
      for (const clause of url.searchParams.getAll('created_at')) { if (clause.startsWith('gte.')) rows = rows.filter(row => row.created_at >= new Date(clause.slice(4)).toISOString()); if (clause.startsWith('lt.')) rows = rows.filter(row => row.created_at < new Date(clause.slice(3)).toISOString()); }
      const total = rows.length, offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || total);
      rows = rows.slice(offset, offset + limit);
      await json(rows, 200, state.noCount ? {} : { 'Content-Range': rows.length ? `${offset}-${offset + rows.length - 1}/${total}` : `*/${total}` }); return;
    }
    const storage = '/storage/v1/object/';
    if (pathname.startsWith(storage)) {
      const location = pathname.slice(storage.length).replace(/^authenticated\//, '').replace(/^mega-audit-documents\//, '');
      if (method === 'POST') { if (state.storage.has(location)) { await json({ code: 'Duplicate' }, 409); return; } state.storage.set(location, request.postDataBuffer()); await json({ Key: location }); return; }
      if (state.slowStorage) await state.slowStorage;
      if (state.failStorage) { await json({ code: 'fictional_error' }, state.failStorage); return; }
      const bytes = state.storage.get(location);
      if (!bytes) { await json({ code: 'not_found' }, 404); return; }
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: bytes }); return;
    }
    throw new Error(`Unimplemented fictional Supabase route: ${method} ${pathname}`);
  });
  return { context, page, state, errors, async close() { try { assert.deepEqual(state.external, [], 'No external visual services or production requests'); assert.deepEqual(errors, [], 'No browser JavaScript errors'); } finally { await context.close(); } } };
}

async function login(page, filename = 'index.html') {
  await page.goto(`${origin}/${filename}#archivo`);
  await page.locator('#audit-cloud-login-username').fill('administrador');
  await page.locator('#audit-cloud-login-password').fill(PASSWORD);
  await page.locator('#audit-bar').getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.waitForFunction(() => window.AuditCloud && typeof window.AuditCloud.status === 'function' && window.AuditCloud.status().authenticated);
  await page.getByRole('button', { name: /^Abrir detalle de salida / }).first().waitFor();
}

async function convert(page) {
  await page.evaluate(() => window.TrazaUI.navigate('converter'));
  await page.locator('#file-input').setInputFiles({ name: 'Salida ficticia 00123.pdf', mimeType: 'application/pdf', buffer: fixture.pdf });
  await page.locator('#export-button:not([disabled])').waitFor();
  assert.equal(await page.locator('#salida-number').inputValue(), '00123');
}

async function waitNotBusy(page) { await page.locator('#export-button:not([disabled])').waitFor(); }
async function profile(page) { await page.locator('#app-profile button').first().click(); }
async function checkNoOverflow(page) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Viewport must not scroll horizontally'); }

test('desktop: real encrypted archive, official author, damaged records, count, preview and document bytes', async () => {
  const h = await harness();
  try {
    await login(h.page);
    await checkNoOverflow(h.page);
    assert.equal(await h.page.title(), 'TRAZA | Centro documental');
    assert.equal(await h.page.locator('.audit-table tbody tr').count(), 25);
    assert.match(await h.page.locator('#audit-page').innerText(), /28 salidas|28 coincidencias|28/);
    assert.match(await h.page.locator('#audit-page').innerText(), /Unidades verificadas en esta página: 120/);
    assert.match(await h.page.locator('#audit-page').innerText(), /08\/10\/2026/);
    assert.match(await h.page.locator('#audit-page').innerText(), /21:30/);
    assert.doesNotMatch(await h.page.locator('#audit-page').innerText(), /nombre_manipulado|Autor falso/);
    const damaged = h.page.locator('.audit-table tbody tr').filter({ hasText: 'descifrar' });
    assert.equal(await damaged.count(), 1);
    await h.page.getByRole('button', { name: /^Abrir detalle de salida / }).first().click();
    await h.page.locator('[data-testid="pdf-preview"]').waitFor();
    await h.page.getByText('Página 1 de 1', { exact: true }).waitFor();
    const canvasHasInk = await h.page.locator('[data-testid="pdf-preview"]').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return canvas.width > 0 && pixels.some((value, index) => index % 4 !== 3 && value < 100);
    });
    assert.equal(canvasHasInk, true, 'PDF.js must render the actual fictional PDF');
    const detail = h.page.locator('#traza-document-detail');
    await detail.getByRole('button', { name: 'Guardar PDF', exact: true }).click();
    await h.page.waitForFunction(() => window.__picker.files.length === 1);
    await detail.getByRole('button', { name: 'Guardar Excel', exact: true }).click();
    await h.page.waitForFunction(() => window.__picker.files.length === 2);
    const files = await h.page.evaluate(() => window.__picker.files);
    assert.deepEqual(Buffer.from(files[0].bytes), fixture.pdf);
    assert.deepEqual(Buffer.from(files[1].bytes), fixture.excel);
    await h.page.screenshot({ path: path.join(OUTPUT, 'desktop-archive-detail.png'), fullPage: true });
  } finally { await h.close(); }
});

test('filters: leading zero blind index, author before pagination, Panama exclusive date bounds, refresh and clearing', async () => {
  const h = await harness();
  try {
    await login(h.page);
    await h.page.locator('#audit-cloud-search').fill('00123');
    await h.page.locator('#audit-cloud-from').fill('2026-10-08');
    await h.page.locator('#audit-cloud-to').fill('2026-10-08');
    await h.page.locator('#audit-cloud-author').selectOption(OWNER);
    await h.page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await h.page.waitForFunction(() => document.querySelectorAll('.audit-table tbody tr').length === 1);
    const query = h.state.requests.filter(r => r.pathname === '/rest/v1/mega_audit_records').at(-1);
    const params = new URLSearchParams(query.search);
    assert.equal(params.get('salida_tag'), `eq.${fixture.numberTag}`);
    assert.equal(params.get('created_by'), `eq.${OWNER}`);
    assert.deepEqual(params.getAll('created_at'), ['gte.2026-10-08T00:00:00-05:00', 'lt.2026-10-09T05:00:00.000Z']);
    assert.equal(params.get('offset'), '0');
    assert.ok(!query.search.includes('00123'), 'Commercial number never sent in plain text');
    await h.page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    assert.equal(await h.page.locator('#audit-cloud-search').inputValue(), '00123');
    await h.page.getByRole('button', { name: 'Limpiar', exact: true }).click();
    await h.page.waitForFunction(() => document.querySelectorAll('.audit-table tbody tr').length === 25);
    for (const id of ['search', 'from', 'to', 'author']) assert.equal(await h.page.locator(`#audit-cloud-${id}`).inputValue(), '');
    await h.page.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await h.page.waitForFunction(() => document.querySelectorAll('.audit-table tbody tr').length === 3);
    await h.page.locator('#audit-cloud-search').fill('00123');
    await h.page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await h.page.waitForFunction(() => document.querySelectorAll('.audit-table tbody tr').length === 1);
    assert.equal(new URLSearchParams(h.state.requests.filter(r => r.pathname === '/rest/v1/mega_audit_records').at(-1).search).get('offset'), '0');
    await h.page.locator('#audit-cloud-from').fill('2026-10-10');
    await h.page.locator('#audit-cloud-to').fill('2026-10-08');
    await h.page.getByRole('button', { name: 'Buscar', exact: true }).click();
    assert.match(await h.page.locator('#audit-page').innerText(), /Desde|posterior|fecha/i);
  } finally { await h.close(); }
});

test('converter: navigation keeps loaded PDF and session; native Excel table and text barcodes; picker before audit', async () => {
  const h = await harness();
  try {
    await login(h.page);
    await convert(h.page);
    for (const column of ['descripcion', 'ref', 'iv']) await h.page.locator(`input[data-column="${column}"]`).check();
    await h.page.evaluate(() => window.TrazaUI.navigate('archive'));
    await h.page.evaluate(() => window.TrazaUI.navigate('converter'));
    assert.equal(await h.page.locator('#salida-number').inputValue(), '00123');
    assert.match(await h.page.locator('#calculated-totals').innerText(), /5[,.]00.*35[,.]00.*1[,.]40.*36[,.]40/);
    await h.page.locator('#excel-file-name').fill('Salida 00123 revisada.xlsx');
    await h.page.evaluate(() => { window.__events = []; });
    await h.page.locator('#export-button').click();
    await h.page.waitForFunction(() => window.__picker.files.length === 1);
    const result = await h.page.evaluate(() => ({ picker: window.__picker, events: window.__events }));
    assert.equal(result.events[0], 'picker');
    assert.equal(result.picker.calls[0].active, true, 'Picker must retain original user activation');
    assert.equal(h.state.recordCalls, 1);
    assert.equal(result.picker.files[0].name, 'Salida 00123 revisada.xlsx');
    const bytes = Buffer.from(result.picker.files[0].bytes);
    const book = XLSX.read(bytes, { type: 'buffer' });
    assert.deepEqual(book.SheetNames, ['Datos', 'Resumen', 'Información', 'Respaldo original']);
    const sheet = book.Sheets.Datos;
    assert.equal(sheet.A2.t, 's'); assert.equal(sheet.A2.v, '0001234567890');
    const archive = XLSX.CFB.read(bytes, { type: 'buffer' });
    const table = XLSX.CFB.find(archive, '/xl/tables/table1.xml');
    assert.ok(table, 'Excel contains native table XML');
    assert.match(Buffer.from(table.content).toString(), /<autoFilter/);
    const heading = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];
    assert.ok(heading.indexOf('Salidas - Unidades') < heading.indexOf('Costo'));
    const values = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    assert.equal(values[1][heading.indexOf('Descripción')], 'Producto ficticio de descripcion completa');
    assert.equal(values[1][heading.indexOf('Ref.')], 'REF-001 COMPLETA');
    assert.equal(values[1][heading.indexOf('I.V.')], '7%');
    assert.equal(values[2][heading.indexOf('I.V.')], '0%');
    await h.page.screenshot({ path: path.join(OUTPUT, 'desktop-converter.png'), fullPage: true });
  } finally { await h.close(); }
});

test('converter: picker cancellation does not register or download; local write retry is idempotent', async () => {
  const h = await harness();
  try {
    await login(h.page); await convert(h.page);
    await h.page.evaluate(() => { window.__picker.cancel = true; });
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(h.state.recordCalls, 0);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    await h.page.evaluate(() => { window.__picker.cancel = false; window.__picker.failWrite = true; });
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(h.state.recordCalls, 1);
    const count = h.state.records.length;
    await h.page.evaluate(() => { window.__picker.failWrite = false; });
    await h.page.locator('#export-button').click();
    await h.page.waitForFunction(() => window.__picker.files.length === 1);
    assert.equal(h.state.recordCalls, 1, 'Retry must retrieve the registered record instead of creating another');
    assert.equal(h.state.records.length, count);
  } finally { await h.close(); }
});

test('converter: audit HTTP 500 and network failure never produce an unregistered download', async () => {
  const h = await harness();
  try {
    await login(h.page); await convert(h.page);
    h.state.failRecord = 500;
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.records.length, fixture.records.length);
    assert.match(await h.page.locator('#message').innerText(), /Supabase|500|operación/i);
    h.state.failRecord = 0;
    await h.context.route('**/rest/v1/rpc/mega_audit_record', route => route.abort('failed'));
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.match(await h.page.locator('#message').innerText(), /conectar|conexión/i);
  } finally { await h.close(); }
});

test('archive: cancelling document save makes no storage request; detail close and logout reject late documents', async () => {
  const h = await harness();
  let release;
  try {
    await login(h.page);
    await h.page.evaluate(() => { window.__picker.cancel = true; });
    const before = h.state.requests.filter(r => r.pathname.startsWith('/storage/')).length;
    await h.page.locator('.audit-table tbody tr').first().getByRole('button', { name: 'Guardar PDF', exact: true }).click();
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/')).length, before);
    h.state.slowStorage = new Promise(resolve => { release = resolve; });
    await h.page.getByRole('button', { name: /^Abrir detalle de salida / }).first().click();
    await h.page.locator('#traza-document-detail').waitFor();
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    assert.equal(await h.page.evaluate(() => window.AuditCloud.status().authenticated), false);
    assert.equal(await h.page.locator('.audit-table tbody tr').count(), 0);
    release(); h.state.slowStorage = null;
    await h.page.waitForTimeout(200);
    assert.equal(await h.page.locator('#traza-document-detail').count(), 0);
    assert.equal(await h.page.locator('[data-testid="pdf-preview"]').count(), 0);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(await h.page.locator('dialog[open]').count(), 0);
  } finally { if (release) release(); await h.close(); }
});

test('administration: accessible dialogs, recovery file, authoritative role checks, no permanent admin cards', async () => {
  const h = await harness();
  try {
    await login(h.page);
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Usuarios y permisos', exact: true }).click();
    const dialog = h.page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByText('@colega', { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /colega/);
    await h.page.keyboard.press('Escape');
    assert.equal(await h.page.locator('dialog[open]').count(), 0);
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Seguridad', exact: true }).click();
    const security = h.page.getByRole('dialog');
    await security.getByRole('button', { name: /Guardar.*recuperación/ }).click();
    await h.page.waitForFunction(() => window.__picker.files.length === 1);
    const saved = await h.page.evaluate(() => window.__picker.files[0]);
    assert.match(Buffer.from(saved.bytes).toString(), /\bMEGA1\.[A-Za-z0-9_-]{43}\b/);
    assert.doesNotMatch(await h.page.locator('#audit-page').innerText(), /MEGA1\./);
    await h.page.keyboard.press('Escape');
    h.state.role = 'user';
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Usuarios y permisos', exact: true }).click();
    await h.page.waitForFunction(() => window.AuditCloud.status().user.role === 'user');
    assert.equal(await h.page.locator('dialog[open]').count(), 0, 'Opening admin tools must verify current server role');
  } finally { await h.close(); }
});

test('user role: no admin menu and HTTP 401 immediately clears session and archive', async () => {
  const h = await harness({ role: 'user' });
  try {
    await login(h.page);
    await profile(h.page);
    assert.equal(await h.page.getByRole('button', { name: 'Usuarios y permisos', exact: true }).count(), 0);
    assert.equal(await h.page.getByRole('button', { name: 'Seguridad', exact: true }).count(), 0);
    await h.page.keyboard.press('Escape');
    h.state.failList = 401;
    await h.page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await h.page.waitForFunction(() => !window.AuditCloud.status().authenticated);
    assert.equal(await h.page.locator('.audit-table tbody tr').count(), 0);
  } finally { await h.close(); }
});

test('mobile 390 px: cards, no overflow, menu focus trap, Escape and focus return', async () => {
  const h = await harness({ mobile: true });
  try {
    await login(h.page);
    await checkNoOverflow(h.page);
    await h.page.screenshot({ path: path.join(OUTPUT, 'mobile-archive.png'), fullPage: true });
    const menu = h.page.locator('#traza-menu-button');
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    assert.equal(await h.page.locator('#app-main').getAttribute('inert'), '');
    await h.page.keyboard.press('Shift+Tab');
    assert.equal(await h.page.evaluate(() => document.querySelector('.traza-sidebar').contains(document.activeElement)), true);
    await h.page.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    assert.equal(await menu.evaluate(element => element === document.activeElement), true);
    await convert(h.page);
    await checkNoOverflow(h.page);
    await h.page.screenshot({ path: path.join(OUTPUT, 'mobile-converter.png'), fullPage: true });
  } finally { await h.close(); }
});

test('audit.html opens archive directly and offers navigation back to converter', async () => {
  const h = await harness();
  try {
    await login(h.page, 'audit.html');
    assert.equal(await h.page.evaluate(() => window.TrazaUI.currentSection), 'archive');
    const back = h.page.getByRole('link', { name: 'Nueva salida', exact: true }).first();
    assert.match(await back.getAttribute('href'), /index\.html.*nueva-salida/);
  } finally { await h.close(); }
});

test('archive: unknown total does not invent a global count; empty and failed searches have explicit states', async () => {
  const h = await harness();
  try {
    h.state.noCount = true;
    await login(h.page);
    assert.match(await h.page.locator('#audit-page').innerText(), /no disponible|sin total|total desconocido|mostrando|en esta página/i);
    const next = h.page.getByRole('button', { name: 'Siguiente', exact: true });
    assert.equal(await next.isEnabled(), true, 'A full page without Content-Range must allow requesting another page');
    await h.page.locator('#audit-cloud-search').fill('00000000000');
    await h.page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await h.page.getByText(/No hay salidas.*filtros|sin coincidencias/i).waitFor();
    h.state.failList = 500;
    await h.page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await h.page.getByRole('alert').filter({ hasText: /Supabase|500|operación/ }).waitFor();
  } finally { await h.close(); }
});

test('archive: a document body arriving after logout cannot restore plaintext or write a file', async () => {
  const h = await harness();
  try {
    await login(h.page);
    await h.page.evaluate(() => { window.__delayBody = true; });
    await h.page.locator('.audit-table tbody tr').first().getByRole('button', { name: 'Guardar PDF', exact: true }).click();
    await h.page.waitForFunction(() => window.__bodyWaiting);
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await h.page.evaluate(() => { window.__delayBody = false; window.__releaseBody(); });
    await h.page.waitForTimeout(200);
    assert.equal(await h.page.evaluate(() => window.AuditCloud.status().authenticated), false);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(await h.page.locator('.audit-table tbody tr').count(), 0);
    assert.equal(await h.page.locator('[data-testid="pdf-preview"]').count(), 0);
  } finally { await h.close(); }
});

test('quick date ranges use Panama days and a Monday start; invalid calendar dates are rejected', async () => {
  const h = await harness();
  try {
    await h.page.clock.setFixedTime(new Date('2026-10-09T02:30:00Z'));
    await login(h.page);
    const ranges = [['Hoy', '2026-10-08', '2026-10-08'], ['Esta semana', '2026-10-05', '2026-10-08'], ['Este mes', '2026-10-01', '2026-10-08']];
    for (const [label, from, to] of ranges) {
      await h.page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await h.page.locator('#audit-cloud-from').inputValue(), from);
      assert.equal(await h.page.locator('#audit-cloud-to').inputValue(), to);
    }
    await h.page.getByRole('button', { name: 'Todo', exact: true }).click();
    assert.equal(await h.page.locator('#audit-cloud-from').inputValue(), '');
    assert.equal(await h.page.locator('#audit-cloud-to').inputValue(), '');
    await h.page.evaluate(() => { const input = document.getElementById('audit-cloud-from'); input.type = 'text'; input.value = '2026-02-30'; });
    const before = h.state.requests.filter(request => request.pathname === '/rest/v1/mega_audit_records').length;
    await h.page.getByRole('button', { name: 'Buscar', exact: true }).click();
    assert.match(await h.page.locator('#audit-page').innerText(), /fecha.*válida|fecha.*real|fecha.*correcta/i);
    assert.equal(h.state.requests.filter(request => request.pathname === '/rest/v1/mega_audit_records').length, before);
  } finally { await h.close(); }
});

test('fallback downloads preserve exact bytes and identify browser download preferences', async () => {
  const h = await harness();
  try {
    await login(h.page); await convert(h.page);
    await h.page.evaluate(() => { delete window.showSaveFilePicker; });
    const pending = h.page.waitForEvent('download');
    await h.page.locator('#export-button').click();
    const download = await pending;
    assert.equal(h.state.recordCalls, 1);
    assert.equal(download.suggestedFilename(), 'Salida 00123.xlsx');
    const filename = await download.path();
    const bytes = fs.readFileSync(filename);
    assert.ok(XLSX.CFB.find(XLSX.CFB.read(bytes, { type: 'buffer' }), '/xl/tables/table1.xml'));
    assert.match(await h.page.locator('#message').innerText(), /descarga.*navegador|configuración.*descargas/i);
    await h.page.evaluate(() => window.TrazaUI.navigate('archive'));
    await h.page.getByRole('button', { name: /^Abrir detalle de salida / }).first().waitFor();
    const archived = h.page.waitForEvent('download');
    await h.page.locator('.audit-table tbody tr').first().getByRole('button', { name: 'Guardar Excel', exact: true }).click();
    const archivedDownload = await archived;
    assert.equal(Buffer.compare(fs.readFileSync(await archivedDownload.path()), bytes), 0);
  } finally { await h.close(); }
});

test('detail: closing a pending PDF restores focus and rejects the late preview', async () => {
  const h = await harness();
  try {
    await login(h.page);
    await h.page.evaluate(() => { window.__delayBody = true; });
    const selected = h.page.getByRole('button', { name: /^Abrir detalle de salida / }).first();
    await selected.click();
    await h.page.waitForFunction(() => window.__bodyWaiting);
    await h.page.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
    assert.equal(await selected.evaluate(element => element === document.activeElement), true);
    await h.page.evaluate(() => { window.__delayBody = false; window.__releaseBody(); });
    await h.page.waitForTimeout(200);
    assert.equal(await h.page.locator('#traza-document-detail').count(), 0);
    assert.equal(await h.page.locator('[data-testid="pdf-preview"]').count(), 0);
    await selected.click();
    await h.page.getByText('Página 1 de 1', { exact: true }).waitFor();
    await h.page.getByRole('button', { name: 'Limpiar', exact: true }).click();
    assert.equal(await h.page.locator('#traza-document-detail').count(), 0);
  } finally { await h.close(); }
});

test('administration: user creation keeps validation and rejects a role revoked while wrapping keys', async () => {
  const h = await harness();
  try {
    await login(h.page); await profile(h.page);
    await h.page.getByRole('button', { name: 'Usuarios y permisos', exact: true }).click();
    await h.page.locator('#audit-cloud-user-username').waitFor();
    const user = h.page.locator('#audit-cloud-user-username');
    const password = h.page.locator('#audit-cloud-user-password');
    const repeat = h.page.locator('#audit-cloud-user-repeat');
    await user.fill('companero'); await password.fill(PASSWORD); await repeat.fill('Otra frase ficticia distinta!');
    await h.page.getByRole('dialog').getByRole('button', { name: 'Crear usuario', exact: true }).click();
    await h.page.getByText(/contraseñas no coinciden/i).waitFor();
    assert.equal(h.state.requests.filter(r => r.pathname === '/rest/v1/rpc/mega_audit_add_member').length, 0);
    await repeat.fill(PASSWORD);
    await h.page.evaluate(() => {
      const original = window.AuditCrypto;
      window.AuditCrypto = Object.freeze({ ...original, async unlockUser(...args) {
        const unlocked = await original.unlockUser(...args);
        return { ...unlocked, async wrapRecoveryKey(...parameters) {
          window.__wrapWaiting = true;
          await new Promise(resolve => { window.__releaseWrap = resolve; });
          return unlocked.wrapRecoveryKey(...parameters);
        } };
      } });
    });
    await h.page.getByRole('dialog').getByRole('button', { name: 'Crear usuario', exact: true }).click();
    await h.page.waitForFunction(() => window.__wrapWaiting);
    h.state.role = 'user';
    await h.page.evaluate(() => window.__releaseWrap());
    await h.page.waitForFunction(() => window.AuditCloud.status().user.role === 'user');
    assert.equal(h.state.requests.filter(r => r.pathname === '/rest/v1/rpc/mega_audit_add_member').length, 0, 'Revoked admin role cannot grant access after wrapping');
    assert.equal(await h.page.locator('dialog[open]').count(), 0);
  } finally { await h.close(); }
});

test('intranet: shared shell keeps native login, profile, user dialog and logout working', async () => {
  const h = await harness();
  let authenticated = false;
  const user = { id: 1, username: 'admin', display_name: 'Administración ficticia', role: 'admin', active: true, created_at: '2026-10-09T02:30:00Z' };
  try {
    await h.context.route(`${origin}/index.html*`, route => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('<html lang="es"', '<html lang="es" data-audit-required="true"') }));
    await h.context.route(`${origin}/api/**`, route => {
      const pathname = new URL(route.request().url()).pathname;
      let result;
      if (pathname === '/api/login') { authenticated = true; result = { user, csrf_token: 'fictional-csrf' }; }
      else if (pathname === '/api/logout') { authenticated = false; result = {}; }
      else if (pathname === '/api/status') result = { mode: 'intranet', authenticated, user: authenticated ? user : null, csrf_token: authenticated ? 'fictional-csrf' : null };
      else if (pathname === '/api/audits') result = { records: [], total: 0 };
      else if (pathname === '/api/users') result = { users: [user] };
      else throw new Error(`Unexpected intranet route ${pathname}`);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
    });
    await h.page.goto(`${origin}/index.html#archivo`);
    await h.page.locator('#app-profile').getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    assert.equal(await h.page.locator('#audit-login-username').evaluate(element => element === document.activeElement), true);
    await h.page.locator('#audit-login-username').fill('admin');
    await h.page.locator('#audit-login-password').fill(PASSWORD);
    await h.page.locator('#audit-bar').getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await h.page.locator('#app-profile').getByText('@admin', { exact: true }).waitFor();
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Usuarios y permisos', exact: true }).click();
    await h.page.getByRole('dialog').waitFor();
    await h.page.locator('#audit-user-username').waitFor();
    assert.equal(await h.page.locator('#audit-page .audit-admin').count(), 0);
    await h.page.keyboard.press('Escape');
    assert.equal(await h.page.locator('dialog[open]').count(), 0);
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await h.page.locator('#app-profile').getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor();
  } finally { await h.close(); }
});
