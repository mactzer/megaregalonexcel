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

function fakePdf(options = {}) {
  const text = (value, x, y, size = 9) => `BT /F1 ${size} Tf ${x} ${y} Td (${value.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const cells = [
    ['Codigo', 10], ['Descripcion', 110], ['Empaque', 350], ['Estilo', 430],
    ['Ref.', 500], ['I.V.', 580], ['Costo', 640], ['P/Venta', 700],
    ['Unidades', 760], ['Total', 820], ['Unidades', 890], ['Total', 950]
  ];
  const product = ['0001234567890', 'Producto ficticio de descripcion completa', 'Caja', 'Estilo A', 'REF-001 COMPLETA', '7%', '10.00', '12.00', '2', '20.00', '0', '0.00'];
  if(options.price)product[7]=options.price;
  if(options.code)product[0]=options.code;
  const exempt = ['0000000000012', 'Producto ficticio exento completo', 'Unidad', 'Estilo B', 'REF-002 COMPLETA', '0%', '5.00', '6.00', '3', '15.00', '0', '0.00'];
  const fractional = ['0000000000025', 'Producto fraccionario ficticio', 'Unidad', 'Estilo C', 'REF-003', '0%', '0.40', '0.50', '2.5', '1.00', '0', '0.00'];
  const bulkQuantity = options.bulkUnits || '1,800.00';
  const bulk = ['0000000001800', 'Producto a granel ficticio', 'Unidad', 'Estilo D', 'REF-004', '0%', '0.35', '0.40', options.missingUnits ? '' : bulkQuantity, '630.00', '0', '0.00'];
  const groupedRows = options.groupedUnits ? [
    ...cells.map(([, x], i) => text(fractional[i], x, 415)),
    ...cells.flatMap(([, x], i) => options.splitGroupedUnits && i === 8
      ? [text('1,', x, 395), text('800.00', x + 10, 395, 8)] : [text(bulk[i], x, 395)])
  ] : [];
  const footer = options.groupedUnits ? [['SubTotal: 666.00', 360], ['Impuesto 1.40', 340], ['Total Neto: 667.40', 320]]
    : [['SubTotal: 35.00', 400], ['Impuesto 1.40', 380], ['Total Neto: 36.40', 360]];
  const textContent = [text('MegaControl - DOCUMENTO FICTICIO, SIN VALOR COMERCIAL', 10, 565), text(`Numero: ${options.number || '00123'}`, 10, 540), text(`Fecha: ${options.invoiceDate === undefined ? '08/10/2026' : options.invoiceDate}`, 10, 520),
    ...cells.map(([label, x]) => text(label, x, 480)), ...cells.map(([, x], i) => text(product[i], x, 455)), ...cells.map(([, x], i) => text(exempt[i], x, 435)),
    ...groupedRows, ...footer.map(([label, y]) => text(label, 10, y))].join('\n');
  const content = options.portrait ? `q\n0.55 0 0 1 0 247 cm\n${textContent}\nQ` : textContent;
  const mediaBox = options.portrait ? '595 842' : '1020 595';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaBox}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
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
  const colleague = await Crypto.unlockUser('colega', PASSWORD, WORKSPACE);
  const colleagueWrapped = Buffer.from(await colleague.wrapRecoveryKey(key)).toString('base64');
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
    for (const [kind, bytes] of [['pdf', fakePdf({ number })], ['excel', excel]]) storage.set(`${WORKSPACE}/${owner}/${id}/${kind}.bin`, Buffer.from(await master.encrypt(new Uint8Array(bytes), `${id}|${kind}`)));
  }
  return { key, master, authPassword: unlock.authPassword, wrapped, colleagueWrapped, pdf, excel, records, storage, numberTag: await master.blindIndex('00123') };
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
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm':'application/wasm' };
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); response.end(contents);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.TRAZA_CHROMIUM || process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
});

after(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function mobileLogin(h, username='administrador') {
  await h.page.goto(`${origin}/movil.html`);
  await h.page.locator('#login-button:not([disabled])').waitFor();
  await h.page.locator('#username').fill(username);
  await h.page.locator('#password').fill(PASSWORD);
  await h.page.locator('#login-button').click();
  await h.page.locator('#workspace').waitFor({ state: 'visible' });
  await h.page.locator('#scan:not([disabled])').waitFor();
}

async function mobileLookup(h,code='0001234567890'){
 await h.page.locator('#barcode').fill(code);await h.page.locator('#search').click();await h.page.locator('#result').waitFor({state:'visible'});await h.page.locator('#search:not([disabled])').waitFor();
}
async function fictionalPrice(cents,version=1){
 const code='0001234567890',tag=await fixture.master.productIndex(code),encrypted=await fixture.master.encrypt(new TextEncoder().encode(JSON.stringify({code,cents})),`product-price-v1|${tag}|${version}`);
 return {workspace_id:WORKSPACE,product_tag:tag,encrypted_price:Buffer.from(encrypted).toString('base64'),version,updated_by:OWNER,updated_at:'2026-10-10T03:00:00.000Z'};
}
test('mobile salidas: latest invoice selects 8.99 despite later upload of 9.99, history survives cache and admin override', async () => {
  const h = await harness({ mobile: true });
  try {
    await setArchivedPdf(h, 0, { number: '29317', invoiceDate: '8/10/2026', price: '9.99' }, { salida_numero: '90000' });
    await setArchivedPdf(h, 2, { number: '29345', invoiceDate: '9/10/2026', price: '8.99' }, { salida_numero: '29345' });
    h.state.records[0].created_at = '2026-10-30T20:00:00.000Z';
    h.state.records[2].created_at = '2026-10-09T20:00:00.000Z';
    h.state.records = [h.state.records[0], h.state.records[2]];
    await mobileLogin(h); const downloads = h.state.requests.filter(r => r.pathname.startsWith('/storage/')).length;
    await mobileLookup(h);
    assert.match(await h.page.locator('.price').innerText(), /8\.99/);
    assert.deepEqual(await h.page.locator('.product-salidas tbody tr').allTextContents(), ['29345Última salidaUSD\u00a08.9909/10/2026', '29317USD\u00a09.9908/10/2026']);
    const details = await h.page.locator('#result dl').innerText();
    assert.match(details, /Salida de origen\s+29345/); assert.match(details, /Fecha de factura\s+09\/10\/2026/);
    assert.doesNotMatch(details, /Registrado|30\/10/);
    await mobileLogin(h); await mobileLookup(h);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/')).length, downloads, 'Cached history must not reopen PDFs');
    await h.page.locator('#edit-price').click(); await h.page.locator('#price-input').fill('7.99'); await h.page.locator('#save-price').click();
    await h.page.waitForFunction(() => /7\.99/.test(document.querySelector('.price').textContent));
    assert.match(await h.page.locator('.original-price').innerText(), /8\.99/);
    assert.deepEqual(await h.page.locator('.product-salidas tbody tr').allTextContents(), ['29345Última salidaUSD\u00a08.9909/10/2026', '29317USD\u00a09.9908/10/2026']);
    await checkNoOverflow(h.page);
    await h.page.screenshot({ path: path.join(OUTPUT, 'mobile-salidas.png'), fullPage: true });
    await h.page.locator('#logout').click(); assert.equal(await h.page.locator('.product-salidas').count(), 0);
  } finally { await h.close(); }
});

test('mobile salidas: invalid and missing invoice dates stay visible with a warning, never use registration date', async () => {
  const h = await harness({ mobile: true });
  try {
    await setArchivedPdf(h, 0, { number: '99999', invoiceDate: '29/02/2025', price: '9.99' });
    await setArchivedPdf(h, 2, { number: '29345', invoiceDate: '9/10/2026', price: '8.99' });
    await setArchivedPdf(h, 3, { number: '99998', invoiceDate: '', price: '6.99' });
    h.state.records = [h.state.records[0], h.state.records[2], h.state.records[3]];
    await mobileLogin(h); await mobileLookup(h);
    assert.match(await h.page.locator('.price').innerText(), /8\.99/);
    assert.match(await h.page.locator('#result').innerText(), /2 coincidencias sin fecha de factura válida/);
    const rows = await h.page.locator('.product-salidas tbody tr').allTextContents();
    assert.equal(rows.length, 3); assert.match(rows[0], /^29345.*09\/10\/2026$/);
    assert.match(rows[1], /^99999.*No disponible en el PDF$/); assert.match(rows[2], /^99998.*No disponible en el PDF$/);
    assert.equal(await h.page.locator('.latest-salida').count(), 0);
    await checkNoOverflow(h.page);
  } finally { await h.close(); }
});

test('mobile prices: administrator saves 9.99 to 7.99, colleague reads shared override and original PDF stays unchanged',async()=>{
 const h=await harness({mobile:true});let worker;
 try{
  await setArchivedPdf(h,0,{price:'9.99'});h.state.records=h.state.records.slice(0,1);
  const row={...h.state.records[0]},original=Buffer.from(h.state.storage.get(`${WORKSPACE}/${OWNER}/${row.id}/pdf.bin`));
  await mobileLogin(h);await mobileLookup(h);assert.match(await h.page.locator('.price').innerText(),/9\.99/);
  await h.page.locator('#edit-price').click();await h.page.locator('#price-input').fill('7,99');await h.page.locator('#save-price').click();await h.page.waitForFunction(()=>/7\.99/.test(document.querySelector('.price').textContent));
  assert.match(await h.page.locator('#price-notice').innerText(),/guardado/);assert.match(await h.page.locator('#result').innerText(),/9\.99/);
  const saved=[...h.state.prices.values()][0],write=h.state.requests.find(r=>r.pathname.endsWith('mega_product_price_set'));
  assert.doesNotMatch(write.body,/0001234567890|7[.,]99/);const clear=await fixture.master.decrypt(new Uint8Array(Buffer.from(saved.encrypted_price,'base64')),`product-price-v1|${saved.product_tag}|1`);assert.deepEqual(JSON.parse(new TextDecoder().decode(clear)),{code:'0001234567890',cents:799});clear.fill(0);
  assert.deepEqual(h.state.records[0],row);assert.deepEqual(h.state.storage.get(`${WORKSPACE}/${OWNER}/${row.id}/pdf.bin`),original);
  const reads=h.state.requests.filter(r=>r.pathname.startsWith('/storage/')).length;await mobileLookup(h);assert.equal(h.state.requests.filter(r=>r.pathname.startsWith('/storage/')).length,reads);
  worker=await harness({mobile:true,role:'user'});worker.state.records=h.state.records.map(r=>({...r}));worker.state.storage=new Map(h.state.storage);worker.state.prices=new Map(h.state.prices);
  await mobileLogin(worker,'colega');await mobileLookup(worker,'001234567890');assert.match(await worker.page.locator('.price').innerText(),/7\.99/);assert.equal(await worker.page.locator('#edit-price').count(),0);
  const error=await worker.page.evaluate(async()=>{try{await(await MobileSession.ready).AuditCloud.mobile.setPrice('0001234567890',599,1);return'';}catch(e){return e.message;}});assert.match(error,/admin|permiso/i);assert.equal(worker.state.priceCalls,0);
  await checkNoOverflow(h.page);await checkNoOverflow(worker.page);
 }finally{if(worker)await worker.close();await h.close();}
});
test('mobile prices: missing schema has activation instructions, and checking activation enables the admin editor',async()=>{
 const h=await harness({mobile:true});try{
 h.state.records=h.state.records.slice(0,1);h.state.missingPrices=true;await mobileLogin(h);await mobileLookup(h);
 assert.match(await h.page.locator('#result').innerText(),/pendientes de activación/);assert.equal(await h.page.locator('#result a[href="supabase/precios.sql"]').count(),1);assert.equal(await h.page.locator('#price-form').count(),0);
 h.state.missingPrices=false;await h.page.locator('#check-prices').click();await h.page.locator('#edit-price').waitFor({state:'visible'});assert.equal(h.state.priceCalls,0);
 }finally{await h.close();}
});
test('mobile prices: conflict, revoked administrator, bad ciphertext and failed verification do not confirm stale prices',async()=>{
 for(const failure of ['conflict','revocation','tamper','network']){
  const h=await harness({mobile:true});try{
   h.state.records=h.state.records.slice(0,1);await mobileLogin(h);await mobileLookup(h);
   if(failure==='conflict'||failure==='revocation'){
    await h.page.locator('#edit-price').click();await h.page.locator('#price-input').fill('7.99');
    if(failure==='conflict'){const price=await fictionalPrice(899);h.state.prices.set(price.product_tag,price);}else h.state.role='user';
    await h.page.locator('#save-price').click();await h.page.waitForFunction(()=>document.querySelector('#price-notice').textContent.includes('administrador')||document.querySelector('#price-notice').textContent.includes('administración'));
    assert.doesNotMatch(await h.page.locator('#price-notice').innerText(),/guardado/i);assert.doesNotMatch(await h.page.locator('.price').innerText(),/7\.99/);
    assert.equal(h.state.priceCalls,failure==='conflict'?1:0);
   }else{
    if(failure==='tamper'){const price=await fictionalPrice(799);h.state.prices.set(price.product_tag,{...price,version:2});}else h.state.failPrice=500;
    await h.page.locator('#search').click();await h.page.waitForFunction(()=>document.querySelector('#status').classList.contains('error'));await h.page.locator('#search:not([disabled])').waitFor();assert.equal(await h.page.locator('#result').isVisible(),false);
   }
  }finally{await h.close();}
 }
});
test('mobile prices: late save after logout cannot restore a product or a session',async()=>{
 const h=await harness({mobile:true});let release;try{
  h.state.records=h.state.records.slice(0,1);await mobileLogin(h);await mobileLookup(h);
  h.state.slowPriceSave=new Promise(r=>release=r);await h.page.locator('#edit-price').click();await h.page.locator('#price-input').fill('7.99');await h.page.locator('#save-price').click();
  await h.page.waitForFunction(()=>document.querySelector('#save-price').disabled);
  for(let attempt=0;attempt<100&&!h.state.prices.size;attempt++)await h.page.waitForTimeout(20);
  assert.equal(h.state.prices.size,1,'The server already committed before logout');
  await h.page.locator('#logout').click();release();await h.page.locator('#login-panel').waitFor({state:'visible'});
  assert.equal(await h.page.locator('#result').textContent(),'');assert.equal(await h.page.evaluate(async()=>(await MobileSession.ready).AuditCloud.status().authenticated),false);
 }finally{if(release)release();await h.close();}
});
test('mobile navigation: Archivo and browser history preserve the session and the retained price editor',async()=>{
 const h=await harness({mobile:true});try{
  h.state.records=h.state.records.slice(0,1);await mobileLogin(h);await mobileLookup(h);await h.page.evaluate(async()=>{window.__owner=await MobileSession.ready;window.__generation=window.__owner.AuditCloud.status().generation;});
  await h.page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,640,360);window.__navigationStream=canvas.captureStream(10);navigator.mediaDevices.getUserMedia=async()=>window.__navigationStream;});
  await h.page.locator('#scan').click();await h.page.waitForFunction(()=>document.querySelector('#video').srcObject&&document.querySelector('#video').readyState>=2);
  const owner=h.page.frameLocator('#engine');await h.page.locator('.bottom [data-mobile-section="archive"]').click();await owner.locator('#audit-page').waitFor({state:'visible'});await owner.locator('#app-profile').getByText('@administrador',{exact:true}).waitFor();
  assert.equal(await h.page.evaluate(()=>window.__navigationStream.getTracks().every(t=>t.readyState==='ended')),true);
  await h.page.locator('.bottom [data-mobile-section="converter"]').click();await owner.locator('#drop-zone').waitFor({state:'visible'});await h.page.locator('.bottom [data-mobile-section="scanner"]').click();await h.page.locator('#workspace').waitFor({state:'visible'});
  await h.page.locator('#edit-price').click();await h.page.locator('#price-input').fill('7.99');await h.page.locator('#save-price').click();await h.page.waitForFunction(()=>/7\.99/.test(document.querySelector('.price').textContent));
  await h.page.goBack();await owner.locator('#drop-zone').waitFor({state:'visible'});await h.page.goForward();await h.page.locator('#workspace').waitFor({state:'visible'});
  assert.equal(await h.page.evaluate(async()=>{const w=await MobileSession.ready;return w===window.__owner&&w.AuditCloud.status().generation===window.__generation&&w.AuditCloud.status().authenticated;}),true);assert.equal(h.state.requests.filter(r=>r.pathname==='/auth/v1/token').length,1);
  await h.page.locator('.bottom [data-mobile-section="archive"]').click();await owner.locator('#app-profile button').first().click();await owner.getByRole('button',{name:'Cerrar sesión',exact:true}).click();await h.page.locator('.bottom [data-mobile-section="scanner"]').click();await h.page.locator('#login-panel').waitFor({state:'visible'});
 }finally{await h.close();}
});
test('mobile navigation: scanner launched from index uses the parent account without another engine',async()=>{
 const h=await harness({mobile:true});try{
  h.state.records=h.state.records.slice(0,1);await login(h.page);await h.page.evaluate(()=>{window.__api=AuditCloud;TrazaUI.navigate('scanner');});
  const scanner=h.page.frameLocator('#scanner-frame');await scanner.locator('#workspace').waitFor({state:'visible'});await scanner.locator('#scan:not([disabled])').waitFor();assert.equal(await scanner.locator('#engine').count(),0);
  await scanner.locator('.bottom [data-mobile-section="archive"]').click();await h.page.locator('#audit-page').waitFor({state:'visible'});assert.equal(await h.page.evaluate(()=>AuditCloud===window.__api&&AuditCloud.status().authenticated),true);assert.equal(h.state.requests.filter(r=>r.pathname==='/auth/v1/token').length,1);
 }finally{await h.close();}
});
test('mobile scanner: C++ reader recognizes small Code128 and EAN13 labels including upside-down sheets and photo lookup',async()=>{
 const labels=JSON.parse(fs.readFileSync(path.join(ROOT,'tests/fixtures/label-barcodes.json'),'utf8'));
 const h=await harness({mobile:true});try{
  await setArchivedPdf(h,0,{code:labels.text});h.state.records=h.state.records.slice(0,1);await mobileLogin(h);
  const result=await h.page.evaluate(async labels=>{
   const timings=[],texts=[];
   for(const format of ['Code128','EAN13'])for(const upsideDown of [false,true]){
    const canvas=document.createElement('canvas');canvas.width=900;canvas.height=1600;const ctx=canvas.getContext('2d');ctx.fillStyle='#888';ctx.fillRect(0,0,900,1600);
    if(upsideDown){ctx.translate(900,1600);ctx.rotate(Math.PI);}
    const bits=labels.symbols[format].row;
    for(let row=0;row<5;row++)for(let col=0;col<2;col++){
     ctx.save();ctx.translate(200+col*350,350+row*170);ctx.rotate(8*Math.PI/180);ctx.fillStyle='white';ctx.fillRect(-130,-90,300,150);ctx.fillStyle='black';ctx.font='16px sans-serif';ctx.fillText('ETIQUETA FICTICIA',-100,-65);ctx.font='26px sans-serif';ctx.fillText('$3.49',-100,-35);
     [...bits].forEach((bit,i)=>{if(bit==='1')ctx.fillRect(-100+i*1.5,0,1.5,38);});ctx.font='12px sans-serif';ctx.fillText(labels.text,-100,55);ctx.restore();
    }
    const file=new File([await new Promise(r=>canvas.toBlob(r,'image/jpeg',.9))],'etiquetas-ficticias.jpg',{type:'image/jpeg'});const start=performance.now(),found=await MobileScanner.photo(file);timings.push(performance.now()-start);texts.push(found.map(x=>x.text));
    if(format==='Code128'&&upsideDown){const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#photo-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
   }
   return{timings,texts};
  },labels);
  assert.deepEqual(result.texts,Array.from({length:4},()=>[labels.text]));assert.ok(result.timings.every(ms=>ms<5000),JSON.stringify(result.timings));
  await h.page.waitForFunction(code=>document.querySelector('#barcode').value===code&&document.querySelector('#result').textContent.includes('PRODUCTO ENCONTRADO'),labels.text);
  assert.equal(h.state.requests.filter(r=>r.pathname.endsWith('mega_product_price_set')).length,0);await checkNoOverflow(h.page);
 }finally{await h.close();}
});
test('mobile scanner: cancelling photo preparation releases controls while the WASM download is stalled',async()=>{
 const h=await harness({mobile:true});let release;
 try{
  const pending=new Promise(r=>release=r);
  await h.context.route('**/vendor/zxing_reader.wasm',async route=>{await pending;await route.fulfill({contentType:'application/wasm',body:fs.readFileSync(path.join(ROOT,'vendor/zxing_reader.wasm'))});});
  h.state.records=h.state.records.slice(0,1);await mobileLogin(h);
  await h.page.evaluate(async()=>{const c=document.createElement('canvas');c.width=300;c.height=200;const b=await new Promise(r=>c.toBlob(r,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([b],'ficticia.png',{type:'image/png'}));const input=document.querySelector('#photo-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await h.page.locator('#cancel').waitFor({state:'visible'});await h.page.locator('#cancel').click();await h.page.locator('#photo-button:not([disabled])').waitFor({timeout:2000});assert.equal(await h.page.locator('#result').isVisible(),false);assert.equal(await h.page.evaluate(async()=>(await MobileSession.ready).AuditCloud.status().authenticated),true);release();
 }finally{if(release)release();await h.close();}
});
test('mobile scanner: reads the label number as a small tilted Code 128 and releases the camera', async () => {
  const h = await harness({ mobile: true });
  try {
    h.state.records = h.state.records.slice(0, 1);
    await mobileLogin(h);
    await h.page.evaluate(() => {
      // Code 128 B: start 104, thirteen characters, checksum 68, stop 106.
      // This validates the same printed number; it is not the supplied photograph.
      const patterns = [[2,1,1,2,1,4],[2,2,3,1,1,2],[3,2,1,1,2,2],[2,1,3,2,1,2],[2,2,3,2,1,1],[2,2,3,1,1,2],[3,1,1,2,2,2],[2,2,3,2,1,1],[1,2,3,1,2,2],[2,2,1,1,3,2],[1,2,3,1,2,2],[3,2,1,1,2,2],[3,1,1,2,2,2],[3,1,1,2,2,2],[1,4,1,2,2,1],[2,3,3,1,1,1,2]];
      const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 600;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1000, 600);
      ctx.translate(500, 300); ctx.rotate(12 * Math.PI / 180); ctx.fillStyle = 'black';
      let x = -178;
      for (const pattern of patterns) for (let i = 0; i < pattern.length; i++) {
        const width = pattern[i] * 2; if (i % 2 === 0) ctx.fillRect(x, -30, width, 60); x += width;
      }
      window.__label = canvas;
      window.__mobileStream = canvas.captureStream(10);
      navigator.mediaDevices.getUserMedia = async () => window.__mobileStream;
    });
    const decoded = await h.page.evaluate(() => {
      for (let attempt = 0; attempt < 7; attempt++) {
        try { return MobileScanner.decode(window.__label, undefined, attempt); } catch (_) {}
      }
      return null;
    });
    assert.equal(decoded, '6952682030988');
    await h.page.locator('#scan').click();
    await h.page.waitForFunction(() => document.querySelector('#barcode').value === '6952682030988');
    await h.page.waitForFunction(() => document.querySelector('#result').textContent.includes('SIN COINCIDENCIA'));
    assert.equal(await h.page.evaluate(() => window.__mobileStream.getTracks().every(track => track.readyState === 'ended')), true);
    assert.equal(await h.page.locator('#history li').count(), 1);
  } finally { await h.close(); }
});

test('mobile scanner: requests continuous focus and applies zoom only on capable cameras', async () => {
  const h = await harness({ mobile: true });
  try {
    h.state.records = h.state.records.slice(0, 1);
    await mobileLogin(h);
    await h.page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 640, 360);
      window.__mobileStream = canvas.captureStream(10);
      window.__cameraConstraints = [];
      const track = window.__mobileStream.getVideoTracks()[0];
      track.getCapabilities = () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 4, step: .1 } });
      track.getSettings = () => ({ zoom: 1 });
      track.applyConstraints = async value => { window.__cameraConstraints.push(value); };
      navigator.mediaDevices.getUserMedia = async () => window.__mobileStream;
    });
    await h.page.locator('#scan').click();
    await h.page.locator('#zoom-control').waitFor({ state: 'visible' });
    assert.equal(await h.page.evaluate(() => window.__cameraConstraints.some(value => value.advanced[0].focusMode === 'continuous')), true);
    await h.page.locator('#camera-zoom').evaluate(input => { input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await h.page.waitForFunction(() => window.__cameraConstraints.some(value => value.advanced[0].zoom === 2));
    await h.page.locator('#stop').click();
    assert.equal(await h.page.locator('#zoom-control').isVisible(), false);
    assert.equal(await h.page.evaluate(() => window.__mobileStream.getTracks().every(track => track.readyState === 'ended')), true);
  } finally { await h.close(); }
});

test('mobile scanner: encrypted index survives reload, queries have no PDF requests, and slow access fails in five seconds', async () => {
  const h = await harness({ mobile: true });
  let release;
  try {
    h.state.records = h.state.records.slice(0, 1);
    await mobileLogin(h);
    const firstDownloads = h.state.requests.filter(r => r.pathname.startsWith('/storage/')).length;
    assert.equal(firstDownloads, 1);
    const ciphertext = await h.page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('megacontrol-encrypted-catalog', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, transaction = db.transaction('catalogs');
          const entries = transaction.objectStore('catalogs').getAll();
          transaction.oncomplete = () => { resolve(entries.result); db.close(); };
        };
      });
    });
    assert.equal(typeof ciphertext[0], 'string');
    assert.doesNotMatch(ciphertext[0], /Producto ficticio|0001234567890/);
    await mobileLogin(h);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/')).length, firstDownloads, 'Reopening the page reuses authenticated encrypted data');
    const delay = new Promise(resolve => { release = resolve; });
    await h.context.route('**/rest/v1/mega_audit_members?*', async route => { await delay; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ role: 'admin' }]) }); });
    await h.page.locator('#barcode').fill('0001234567890');
    const started = performance.now();
    await h.page.locator('#search').click();
    await h.page.waitForFunction(() => document.querySelector('#status').textContent.includes('cinco segundos'));
    assert.ok(performance.now() - started < 5500, 'A stalled service cannot keep verification running indefinitely');
    assert.equal(await h.page.locator('#result').isVisible(), false);
    release();
    assert.match(await h.page.locator('#history').textContent(), /Aún no/);
  } finally { if (release) release(); await h.close(); }
});

test('mobile scanner: decrypts original PDF, preserves barcode, shows source price, and clears everything on logout', async () => {
  const h = await harness({ mobile: true });
  try {
    await mobileLogin(h);
    await h.page.locator('#barcode').fill('0001234567890');
    await h.page.locator('#search').click();
    await h.page.waitForFunction(() => document.querySelector('#result').textContent.includes('PRODUCTO ENCONTRADO'));
    assert.match(await h.page.locator('#result').innerText(), /Producto ficticio de descripcion completa/);
    assert.match(await h.page.locator('#result').innerText(), /12\.00/);
    assert.match(await h.page.locator('#result').innerText(), /0001234567890/);
    assert.match(await h.page.locator('#result').innerText(), /00123/);
    assert.equal(h.state.recordCalls, 0, 'Mobile lookup never registers a new audit');
    await checkNoOverflow(h.page);
    await h.page.locator('#logout').click();
    assert.equal(await h.page.locator('#result').textContent(), '');
    assert.equal(await h.page.locator('#password').inputValue(), '');
    assert.match(await h.page.locator('#history').innerText(), /Aún no/);
    assert.equal(await h.page.locator('#workspace').isVisible(), false);
  } finally { await h.close(); }
});

test('mobile scanner: complete absence and unreadable PDF have distinct outcomes; manual input survives camera denial', async () => {
  const h = await harness({ mobile: true });
  try {
    h.state.records = h.state.records.slice(0, 1);
    await mobileLogin(h);
    await h.page.locator('#barcode').fill('9999999999999');
    await h.page.locator('#search').click();
    await h.page.waitForFunction(() => document.querySelector('#result').textContent.includes('SIN COINCIDENCIA'));
    assert.match(await h.page.locator('#result').innerText(), /1 PDF revisados/);
    await setArchivedPdf(h, 0, {}, { total_units: 6 });
    h.state.failStorage = 500;
    await h.page.locator('#refresh-catalog').click();
    await h.page.locator('#scan:not([disabled])').waitFor();
    await h.page.locator('#search').click();
    await h.page.waitForFunction(() => document.querySelector('#result').textContent.includes('CONSULTA INCOMPLETA'));
    assert.doesNotMatch(await h.page.locator('#result').innerText(), /SIN COINCIDENCIA/);
    await h.page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
    await h.page.locator('#scan').click();
    await h.page.waitForFunction(() => document.querySelector('#status').textContent.includes('denegado'));
    assert.equal(await h.page.locator('#camera').isVisible(), false);
    assert.equal(await h.page.locator('#search').isEnabled(), true);
  } finally { await h.close(); }
});

test('mobile scanner: authorization loss aborts lookup and removes previous product and session history', async () => {
  const h = await harness({ mobile: true });
  try {
    await mobileLogin(h);
    await h.page.locator('#barcode').fill('0001234567890');
    await h.page.locator('#search').click();
    await h.page.waitForFunction(() => document.querySelector('#result').textContent.includes('PRODUCTO ENCONTRADO'));
    await h.context.route('**/rest/v1/mega_audit_members?*', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'unauthorized' }) }));
    await h.page.locator('#search').click();
    await h.page.locator('#login-panel').waitFor({ state: 'visible' });
    assert.equal(await h.page.locator('#result').textContent(), '');
    assert.equal(await h.page.locator('#workspace').isVisible(), false);
    assert.match(await h.page.locator('#history').innerText(), /Aún no/);
  } finally { await h.close(); }
});

test('mobile scanner: ZXing reads an actual EAN-13 from a camera stream and stops tracks after one lookup', async () => {
  const h = await harness({ mobile: true });
  try {
    h.state.records = h.state.records.slice(0, 1);
    await mobileLogin(h);
    await h.page.evaluate(() => {
      // A standards-encoded fictional EAN-13, rendered as real black/white bars.
      const left = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
      const even = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
      const code = '4006381333931', parity = 'LGLLGG';
      let bits = '101';
      for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? left : even)[Number(code[i])];
      bits += '01010';
      for (let i = 7; i < 13; i++) bits += left[Number(code[i])].replace(/[01]/g, value => value === '0' ? '1' : '0');
      bits += '101';
      const canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 300;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 700, 300); ctx.fillStyle = 'black';
      [...bits].forEach((value, i) => { if (value === '1') ctx.fillRect(110 + i * 5, 40, 5, 220); });
      window.__mobileStream = canvas.captureStream(10);
      navigator.mediaDevices.getUserMedia = async () => window.__mobileStream;
    });
    await h.page.locator('#scan').click();
    await h.page.waitForFunction(() => document.querySelector('#barcode').value === '4006381333931');
    await h.page.waitForFunction(() => document.querySelector('#result').textContent.includes('SIN COINCIDENCIA'));
    assert.equal(await h.page.evaluate(() => window.__mobileStream.getTracks().every(track => track.readyState === 'ended')), true);
    assert.equal(await h.page.locator('#history li').count(), 1, 'Repeated video frames do not create repeated lookups');
  } finally { await h.close(); }
});

test('mobile scanner: indexed absence makes no PDF requests, and cancelling access verification cannot restore a result', async () => {
  const h = await harness({ mobile: true });
  let release;
  try {
    h.state.records = h.state.records.filter((_, i) => i !== 1);
    await mobileLogin(h);
    const downloads = h.state.requests.filter(r => r.pathname.startsWith('/storage/')).length;
    await h.page.locator('#barcode').fill('9999999999999');
    const started = performance.now();
    await h.page.locator('#search').click();
    await h.page.waitForFunction(() => document.querySelector('#result').textContent.includes('SIN COINCIDENCIA'));
    assert.ok(performance.now() - started < 5000, 'Indexed query completes within five seconds');
    assert.match(await h.page.locator('#result').innerText(), /27 PDF revisados/);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/')).length, downloads);
    const delay = new Promise(resolve => { release = resolve; });
    await h.context.route('**/rest/v1/mega_audit_members?*', async route => { await delay; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ role: 'admin' }]) }); });
    await h.page.locator('#barcode').fill('0001234567890');
    await h.page.locator('#search').click();
    await h.page.locator('#cancel').waitFor({ state: 'visible' });
    await h.page.locator('#cancel').click();
    await h.page.locator('#search:not([disabled])').waitFor();
    release();
    assert.equal(await h.page.locator('#result').textContent(), '');
    assert.equal(await h.page.locator('#result').isVisible(), false);
    assert.equal(await h.page.locator('#history li').count(), 1, 'A cancelled lookup adds no completed query');
  } finally { if (release) release(); await h.close(); }
});

async function harness(options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || (options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }), deviceScaleFactor: options.deviceScaleFactor || 1, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = { records: fixture.records.map(row => ({ ...row })), storage: new Map(fixture.storage), requests: [], downloads: [], recordCalls: 0, failRecord: 0, failList: 0, failStorage: 0, slowRecord: null, slowStorage: null, slowDocuments: new Map(), slowConfirmation: null, noCount: false, role: options.role || 'admin', external: [] };
  Object.assign(state,{prices:new Map(),priceCalls:0,missingPrices:false,failPrice:0,slowPriceSave:null,actor:OWNER});
  page.on('download', download => state.downloads.push(download.suggestedFilename()));
  await context.addInitScript(() => {
    window.__picker = { cancel: false, failWrite: false, files: [], calls: [] };
    window.__events = [];
    window.__failExcelDownload = false;
    window.__attemptedExcelBytes = [];
    window.__blobUrls = new Set();
    window.__revokedBlobUrls = [];
    const createUrl = URL.createObjectURL;
    const revokeUrl = URL.revokeObjectURL;
    URL.createObjectURL = function (blob) {
      const url = createUrl.call(this, blob);
      window.__blobUrls.add(url);
      window.__latestBlobUrl = url;
      return url;
    };
    URL.revokeObjectURL = function (url) {
      window.__blobUrls.delete(url);
      window.__revokedBlobUrls.push(url);
      return revokeUrl.call(this, url);
    };
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
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && /\.xlsx$/i.test(this.download)) {
        window.__events.push('download:' + this.download);
        if (window.__failExcelDownload) {
          const url = this.href;
          window.__attemptedExcelBytes.push(fetch.call(window, url).then(response => response.arrayBuffer()).then(bytes => Array.from(new Uint8Array(bytes))));
          throw new Error('Fictional browser download initialization failure');
        }
      }
      return click.call(this);
    };
    window.showSaveFilePicker = async function (options) {
      window.__events.push('picker'); window.__picker.calls.push({ options, active: navigator.userActivation.isActive });
      if (window.__picker.cancel) throw new DOMException('Cancelled', 'AbortError');
      const name = window.__picker.chosenName || options.suggestedName;
      return { name, async createWritable() {
        let data;
        return { async write(value) { if (window.__picker.failWrite) throw new Error('Fictional local write failure'); data = Array.from(value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value instanceof Uint8Array ? value : new Uint8Array(value)); },
          async close() { window.__picker.files.push({ name, bytes: data }); }, async abort() {} };
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
      state.actor=name==='administrador'?OWNER:OTHER;
      await json({ access_token: 'fictional-token', refresh_token: 'fictional-refresh', expires_in: 3600, user: { id: name === 'administrador' ? OWNER : OTHER, email: `${name}@usuarios.megaregalonexcel.invalid` } }); return;
    }
    if (pathname === '/auth/v1/signup') { const body = request.postDataJSON(); await json({ access_token: 'fictional-user-token', refresh_token: 'fictional-refresh', user: { id: OTHER, email: body.email } }); return; }
    if (pathname === '/auth/v1/logout') { await route.fulfill({ status: 204 }); return; }
    if (pathname === '/rest/v1/mega_audit_members') { await json([{ role: state.role }]); return; }
    if (pathname === '/rest/v1/mega_audit_workspace') { await json([{ key_fingerprint: fixture.master.fingerprint }]); return; }
    if (pathname === '/rest/v1/mega_audit_user_keys') { await json([{ wrapped_key:state.actor===OTHER ? fixture.colleagueWrapped : fixture.wrapped }]); return; }
    if(pathname==='/rest/v1/mega_product_prices'){
      if(state.missingPrices){await json({code:'PGRST205'},404);return;}
      if(state.failPrice){await json({code:'fictional_error'},state.failPrice);return;}
      const tag=(url.searchParams.get('product_tag')||'').replace(/^eq\./,'');await json(state.prices.has(tag)?[state.prices.get(tag)]:[]);return;
    }
    if(pathname==='/rest/v1/rpc/mega_product_price_set'){
      state.priceCalls++; const b=request.postDataJSON(),prior=state.prices.get(b.p_product_tag);
      if(state.role!=='admin'){await json({code:'42501'},403);return;}
      if((prior?prior.version:0)!==b.p_expected_version){await json({code:'40001'},409);return;}
      const row={workspace_id:WORKSPACE,product_tag:b.p_product_tag,encrypted_price:b.p_encrypted_price,version:b.p_expected_version+1,updated_by:state.actor,updated_at:'2026-10-10T04:00:00.000Z'};state.prices.set(row.product_tag,row);
      if(state.slowPriceSave)await state.slowPriceSave;await json(row);return;
    }
    if (pathname === '/rest/v1/rpc/mega_audit_authors' || pathname === '/rest/v1/rpc/mega_audit_list_members') {
      await json([{ user_id: OWNER, username: 'administrador', role: state.role }, { user_id: OTHER, username: 'colega', role: 'user' }]); return;
    }
    if (pathname === '/rest/v1/rpc/mega_audit_add_member') { const body = request.postDataJSON(); await json({ user_id: OTHER, username: body.p_username, role: body.p_role }); return; }
    if (pathname === '/rest/v1/rpc/mega_audit_record') {
      state.recordCalls++;
      if (state.slowRecord) await state.slowRecord;
      if (state.failRecord) { await json({ code: 'fictional_error' }, state.failRecord); return; }
      const body = request.postDataJSON();
      let row = state.records.find(row => row.id === body.p_id);
      if (!row) { row = { id: body.p_id, created_by: OWNER, workspace_id: WORKSPACE, created_at: '2026-10-09T03:00:00.000Z', salida_tag: body.p_salida_tag, encrypted_metadata: body.p_encrypted_metadata }; state.records.unshift(row); }
      await json(row); return;
    }
    if (pathname === '/rest/v1/mega_audit_records') {
      if (state.slowConfirmation && url.searchParams.has('id')) await state.slowConfirmation;
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
      for (const [id, delay] of state.slowDocuments) if (location.includes(id)) await delay;
      if (state.failStorage) { await json({ code: 'fictional_error' }, state.failStorage); return; }
      const bytes = state.storage.get(location);
      if (!bytes) { await json({ code: 'not_found' }, 404); return; }
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: bytes }); return;
    }
    throw new Error(`Unimplemented fictional Supabase route: ${method} ${pathname}`);
  });
  return { context, page, state, errors, async close() { try { assert.deepEqual(state.external, [], 'No external visual services or production requests'); assert.deepEqual(errors, [], 'No browser JavaScript errors'); } finally { await context.close(); } } };
}

async function login(page, filename = 'index.html', options = {}) {
  await page.goto(`${origin}/${filename}#archivo`);
  await page.locator('#audit-cloud-login-username').fill('administrador');
  await page.locator('#audit-cloud-login-password').fill(PASSWORD);
  await page.locator('#audit-bar').getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.waitForFunction(() => window.AuditCloud && typeof window.AuditCloud.status === 'function' && window.AuditCloud.status().authenticated);
  await page.getByRole('button', { name: /^Abrir detalle de salida / }).first().waitFor();
  if (options.waitUnits !== false) await waitUnits(page);
}

async function waitUnits(page) {
  // This prepares a page of original PDFs. Product lookups have their separate
  // five-second limit; slower CI workers still must finish all archive checks.
  await page.waitForFunction(() => {
    const cells = [...document.querySelectorAll('.audit-table tbody [data-unit-state]')];
    return cells.length > 0 && cells.every(cell => cell.dataset.unitState && cell.dataset.unitState !== 'checking');
  }, null, { timeout: 30000 });
}

async function setArchivedPdf(h, index, pdfOptions, overrides = {}) {
  const row = h.state.records[index];
  const clear = await fixture.master.decrypt(new Uint8Array(Buffer.from(row.encrypted_metadata, 'base64')), `${row.id}|metadata`);
  let metadata;
  try { metadata = { ...JSON.parse(new TextDecoder().decode(clear)), ...overrides }; }
  finally { clear.fill(0); }
  row.encrypted_metadata = Buffer.from(await fixture.master.encrypt(new TextEncoder().encode(JSON.stringify(metadata)), `${row.id}|metadata`)).toString('base64');
  const pdf = Buffer.isBuffer(pdfOptions) ? pdfOptions : fakePdf({ number: metadata.salida_numero, ...pdfOptions });
  h.state.storage.set(`${WORKSPACE}/${row.created_by}/${row.id}/pdf.bin`, Buffer.from(await fixture.master.encrypt(new Uint8Array(pdf), `${row.id}|pdf`)));
  return { row, metadata, pdf };
}

async function convert(page) {
  await page.evaluate(() => window.TrazaUI.navigate('converter'));
  assert.equal(await page.locator('#drop-zone').isVisible(), true);
  assert.equal(await page.locator('#converter-title').innerText(), 'Nueva salida');
  await page.locator('#file-input').setInputFiles({ name: 'Salida ficticia 00123.pdf', mimeType: 'application/pdf', buffer: fixture.pdf });
  await page.locator('#export-button:not([disabled])').waitFor();
  assert.equal(await page.locator('#salida-number').inputValue(), '00123');
}

async function waitNotBusy(page) { await page.locator('#export-button:not([disabled])').waitFor(); }
async function profile(page) { await page.locator('#app-profile button').first().click(); }
async function checkNoOverflow(page) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Viewport must not scroll horizontally'); }

async function downloadAction(h, action) {
  const pending = h.page.waitForEvent('download');
  await action();
  const download = await pending;
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(await download.path()) };
}

async function downloadNotice(page, name) {
  const notice = page.locator('#traza-save-notice');
  await notice.waitFor({ state: 'visible' });
  assert.equal(await notice.getAttribute('role'), 'status');
  assert.equal(await notice.locator('#traza-saved-file-name').innerText(), name);
  assert.match(await notice.locator('#traza-saved-file-message').innerText(), /descarga.*navegador|descarga.*iniciad|iniciad.*descarga/i);
  assert.equal(await notice.getByRole('button', { name: 'Descargar una copia', exact: true }).count(), 0, 'Excel requires one browser download with no additional copy action');
  return notice;
}

async function savedNotice(page, name) {
  const notice = page.locator('#traza-save-notice');
  await notice.waitFor({ state: 'visible' });
  assert.equal(await notice.getAttribute('role'), 'status');
  assert.equal(await notice.locator('#traza-saved-file-name').innerText(), name);
  assert.match(await notice.locator('#traza-saved-file-message').innerText(), /guardad.*carpeta/i);
  await notice.getByRole('button', { name: 'Descargar una copia', exact: true }).waitFor({ state: 'visible' });
  return notice;
}

async function copySavedFile(h, expected, name) {
  const pickerCalls = await h.page.evaluate(() => window.__picker.calls.length);
  const requests = h.state.requests.length;
  const pending = h.page.waitForEvent('download');
  await h.page.locator('#traza-save-notice').getByRole('button', { name: 'Descargar una copia', exact: true }).click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), name);
  assert.equal(Buffer.compare(fs.readFileSync(await download.path()), expected), 0, 'The browser download must copy the exact bytes saved in the chosen folder');
  assert.equal(await h.page.evaluate(() => window.__picker.calls.length), pickerCalls, 'Copy never opens another folder picker');
  assert.equal(h.state.requests.length, requests, 'Copy never registers, uploads or fetches the document again');
  assert.match(await h.page.locator('#traza-saved-file-message').innerText(), /descarga.*copia.*panel de descargas/i);
}

async function editArchived(page) {
  await page.getByRole('button', { name: /^Abrir detalle de salida / }).first().click();
  await page.getByText('Página 1 de 1', { exact: true }).waitFor();
  await page.locator('#traza-document-detail').getByRole('button', { name: /Editar Excel/ }).click();
  await page.locator('#export-button:not([disabled])').waitFor();
  assert.equal(await page.evaluate(() => window.TrazaUI.currentSection), 'converter');
  assert.equal(await page.locator('#converter-title').innerText(), 'Editar Excel');
  assert.equal(await page.locator('#drop-zone').isVisible(), false, 'Editing a stored PDF does not ask the user to upload it again');
  assert.match(await page.locator('#step-upload').innerText(), /PDF del Archivo/);
  assert.equal(await page.locator('#salida-number').inputValue(), '00123');
  assert.equal(await page.locator('#salida-number').evaluate(input => input.readOnly), true, 'An archived re-export must keep its original audit number');
}

async function usePortraitPreview(h) {
  const row = h.state.records[0];
  const location = `${WORKSPACE}/${row.created_by}/${row.id}/pdf.bin`;
  h.state.storage.set(location, Buffer.from(await fixture.master.encrypt(new Uint8Array(fakePdf({ portrait: true })), `${row.id}|pdf`)));
}

async function openPreview(page) {
  await page.getByRole('button', { name: /^Abrir detalle de salida / }).first().click();
  await page.getByText('Página 1 de 1', { exact: true }).waitFor();
  await page.locator('.traza-preview-scroll[aria-busy="false"] [data-testid="pdf-preview"]').waitFor({ state: 'visible' });
}

async function previewGeometry(page) {
  return page.locator('[data-testid="pdf-preview"]').evaluate(canvas => {
    const bounds = canvas.getBoundingClientRect(), scroll = canvas.closest('.traza-preview-scroll');
    const style = getComputedStyle(canvas), scrollStyle = getComputedStyle(scroll);
    return { width: bounds.width, height: bounds.height, bitmapWidth: canvas.width, bitmapHeight: canvas.height,
      styleWidth: canvas.style.width, styleHeight: canvas.style.height, maxHeight: style.maxHeight,
      available: scroll.clientWidth - parseFloat(scrollStyle.paddingLeft) - parseFloat(scrollStyle.paddingRight),
      scrollWidth: scroll.scrollWidth, scrollClientWidth: scroll.clientWidth, busy: scroll.getAttribute('aria-busy') };
  });
}

function assertCrispPortrait(geometry, density) {
  assert.equal(geometry.busy, 'false');
  assert.match(geometry.styleWidth, /^\d+(\.\d+)?px$/, 'Canvas has an explicit CSS width independent of its pixel buffer');
  assert.match(geometry.styleHeight, /^\d+(\.\d+)?px$/, 'Canvas has an explicit CSS height independent of its pixel buffer');
  assert.ok(Math.abs(geometry.width / geometry.height - 595 / 842) < 0.001, 'Displayed portrait preserves the PDF page aspect ratio');
  assert.ok(Math.abs(geometry.bitmapWidth / geometry.bitmapHeight - 595 / 842) < 0.002, 'PDF.js raster preserves the PDF page aspect ratio');
  assert.ok(geometry.bitmapWidth >= geometry.width * density - 1, `At least ${density} raster pixels per displayed horizontal pixel`);
  assert.ok(geometry.bitmapHeight >= geometry.height * density - 1, `At least ${density} raster pixels per displayed vertical pixel`);
  assert.ok(geometry.bitmapWidth * geometry.bitmapHeight <= 16000000, 'Raster fits the configured memory limit');
  assert.ok(geometry.bitmapWidth <= 8192 && geometry.bitmapHeight <= 8192, 'Raster dimensions fit the configured canvas limit');
}

for (const density of [1, 3]) {
  test(`PDF preview: crisp portrait at DPR ${density}, no 650 px height distortion, and actual-width rerender`, async () => {
    const h = await harness({ viewport: { width: 950, height: 1000 }, deviceScaleFactor: density });
    try {
      await usePortraitPreview(h);
      await login(h.page);
      await openPreview(h.page);
      const first = await previewGeometry(h.page);
      assertCrispPortrait(first, Math.max(2, density));
      assert.ok(first.height > 650, 'A stacked portrait preview must not be clamped to 650 CSS pixels');
      assert.ok(Math.abs(first.width - first.available) <= 2, 'Fit-to-width uses the actual preview content width');
      await checkNoOverflow(h.page);
      const before = h.state.requests.filter(request => request.pathname.startsWith('/storage/') && request.method === 'GET').length;
      await h.page.setViewportSize({ width: 1080, height: 1000 });
      await h.page.waitForFunction(previous => {
        const canvas = document.querySelector('[data-testid="pdf-preview"]');
        return canvas && canvas.width > previous && canvas.closest('.traza-preview-scroll').getAttribute('aria-busy') === 'false';
      }, first.bitmapWidth);
      const resized = await previewGeometry(h.page);
      assertCrispPortrait(resized, Math.max(2, density));
      assert.ok(Math.abs(resized.width - resized.available) <= 2);
      assert.equal(h.state.requests.filter(request => request.pathname.startsWith('/storage/') && request.method === 'GET').length, before, 'Resizing rerenders the already decrypted PDF without fetching it again');
      await checkNoOverflow(h.page);
      if (density === 1) await h.page.locator('#traza-document-detail').screenshot({ path: path.join(OUTPUT, 'desktop-crisp-portrait.png') });
    } finally { await h.close(); }
  });
}

test('PDF preview: zoom, fit and enlarged dialog rerender locally, preserve aspect, and return keyboard focus', async () => {
  const h = await harness({ viewport: { width: 950, height: 1000 } });
  try {
    await usePortraitPreview(h);
    await login(h.page);
    const verifiedPdfReads = h.state.requests.filter(request => request.pathname.startsWith('/storage/') && request.method === 'GET').length;
    await openPreview(h.page);
    const initial = await previewGeometry(h.page);
    await h.page.getByRole('button', { name: 'Ampliar vista previa', exact: true }).click();
    await h.page.waitForFunction(previous => {
      const canvas = document.querySelector('[data-testid="pdf-preview"]');
      return canvas && canvas.width > previous && canvas.closest('.traza-preview-scroll').getAttribute('aria-busy') === 'false';
    }, initial.bitmapWidth);
    const zoomed = await previewGeometry(h.page);
    assertCrispPortrait(zoomed, 2);
    assert.ok(Math.abs(zoomed.width - initial.width * 1.25) < 2, 'Zoom increases the displayed page by 25 percent');
    assert.ok(zoomed.scrollWidth > zoomed.scrollClientWidth, 'Only the local PDF viewport scrolls when zoomed');
    await checkNoOverflow(h.page);
    await h.page.getByRole('button', { name: 'Reducir vista previa', exact: true }).click();
    await h.page.waitForFunction(previous => {
      const canvas = document.querySelector('[data-testid="pdf-preview"]');
      return canvas && Math.abs(canvas.width - previous) <= 2 && canvas.closest('.traza-preview-scroll').getAttribute('aria-busy') === 'false';
    }, initial.bitmapWidth);
    await h.page.getByRole('button', { name: 'Ampliar vista previa', exact: true }).click();
    await h.page.getByRole('button', { name: 'Ajustar a ancho', exact: true }).click();
    await h.page.waitForFunction(previous => {
      const canvas = document.querySelector('[data-testid="pdf-preview"]');
      return canvas && Math.abs(canvas.width - previous) <= 2 && canvas.closest('.traza-preview-scroll').getAttribute('aria-busy') === 'false';
    }, initial.bitmapWidth);
    assert.equal(await h.page.locator('.traza-preview-zoom').innerText(), '100%');
    const opener = h.page.getByRole('button', { name: 'Ver PDF ampliado', exact: true });
    await opener.click();
    const dialog = h.page.getByRole('dialog', { name: /^Vista ampliada/ });
    await dialog.waitFor({ state: 'visible' });
    await h.page.waitForFunction(previous => {
      const canvas = document.querySelector('dialog [data-testid="pdf-preview"]');
      return canvas && canvas.width > previous && canvas.closest('.traza-preview-scroll').getAttribute('aria-busy') === 'false';
    }, initial.bitmapWidth);
    assert.equal(await h.page.locator('[data-testid="pdf-preview"]').count(), 1, 'The enlarged view uses the same active PDF view');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
    const enlarged = await previewGeometry(h.page);
    assertCrispPortrait(enlarged, 2);
    await h.page.setViewportSize({ width: 1200, height: 1000 });
    await h.page.waitForFunction(previous => {
      const canvas = document.querySelector('dialog [data-testid="pdf-preview"]');
      return canvas && canvas.width > previous && canvas.closest('.traza-preview-scroll').getAttribute('aria-busy') === 'false';
    }, enlarged.bitmapWidth);
    assertCrispPortrait(await previewGeometry(h.page), 2);
    await checkNoOverflow(h.page);
    await dialog.screenshot({ path: path.join(OUTPUT, 'desktop-large-pdf.png') });
    for (let step = 0; step < 8; step++) await dialog.getByRole('button', { name: 'Ampliar vista previa', exact: true }).click();
    await dialog.locator('.traza-preview-scroll[aria-busy="false"]').waitFor();
    assert.equal(await dialog.locator('.traza-preview-zoom').innerText(), '300%');
    const capped = await previewGeometry(h.page);
    assert.ok(capped.bitmapWidth * capped.bitmapHeight <= 16000000, 'Large 300% zoom respects the raster pixel limit');
    assert.ok(capped.bitmapWidth <= 8192 && capped.bitmapHeight <= 8192, 'Large 300% zoom respects maximum canvas dimensions');
    assert.ok(Math.abs(capped.width / capped.height - 595 / 842) < 0.001, 'Memory limits preserve the displayed PDF page aspect ratio');
    await checkNoOverflow(h.page);
    await dialog.getByRole('button', { name: 'Ajustar a ancho', exact: true }).click();
    await dialog.locator('.traza-preview-scroll[aria-busy="false"]').waitFor();
    await h.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await opener.evaluate(element => element === document.activeElement), true, 'Escape returns focus to the enlarged-preview opener');
    await h.page.locator('#traza-document-detail .traza-preview-scroll[aria-busy="false"] [data-testid="pdf-preview"]').waitFor({ state: 'visible' });
    const restored = await previewGeometry(h.page);
    assertCrispPortrait(restored, 2);
    assert.ok(Math.abs(restored.width - restored.available) <= 2, 'Closing the dialog fits the current detail panel width');
    assert.equal(await h.page.locator('.traza-preview-zoom').innerText(), '100%');
    assert.equal(h.state.requests.filter(request => request.pathname.startsWith('/storage/') && request.method === 'GET').length, verifiedPdfReads + 1, 'After independent units verification, zoom, fit, modal and resize retrieve the preview PDF only once');
    assert.equal(h.state.recordCalls, 0, 'Preview never creates a new audit record');
    await checkNoOverflow(h.page);
  } finally { await h.close(); }
});

test('mobile 390 px PDF preview: crisp local zoom and enlarged view without page overflow', async () => {
  const h = await harness({ mobile: true });
  try {
    await usePortraitPreview(h);
    await login(h.page);
    await openPreview(h.page);
    assertCrispPortrait(await previewGeometry(h.page), 2);
    await h.page.getByRole('button', { name: 'Ampliar vista previa', exact: true }).click();
    await h.page.locator('.traza-preview-scroll[aria-busy="false"]').waitFor();
    await checkNoOverflow(h.page);
    await h.page.locator('#traza-document-detail').screenshot({ path: path.join(OUTPUT, 'mobile-crisp-portrait.png') });
    await h.page.getByRole('button', { name: 'Ver PDF ampliado', exact: true }).click();
    const dialog = h.page.getByRole('dialog', { name: /^Vista ampliada/ });
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('.traza-preview-scroll[aria-busy="false"]').waitFor();
    assertCrispPortrait(await previewGeometry(h.page), 2);
    await checkNoOverflow(h.page);
    await dialog.screenshot({ path: path.join(OUTPUT, 'mobile-large-pdf.png') });
    await h.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await h.page.getByRole('button', { name: 'Ver PDF ampliado', exact: true }).evaluate(element => element === document.activeElement), true);
    await checkNoOverflow(h.page);
  } finally { await h.close(); }
});

for (const enlarge of [false, true]) {
  test(`PDF preview: late ${enlarge ? 'enlarged' : 'zoom'} render is cancelled after logout and cannot restore a document`, async () => {
    const h = await harness();
    try {
      await login(h.page);
      await h.page.evaluate(() => {
        window.__holdPreview = false;
        window.__releasePreviews = [];
        window.__previewCancels = 0;
        const library = window.pdfjsLib, getDocument = library.getDocument;
        function delayedGetDocument(...args) {
          const loading = getDocument.apply(library, args);
          const promise = loading.promise.then(pdf => {
            const getPage = pdf.getPage.bind(pdf);
            pdf.getPage = async function (...pageArgs) {
              const page = await getPage(...pageArgs), render = page.render.bind(page);
              page.render = function (...renderArgs) {
                const task = render(...renderArgs);
                return { promise: task.promise.then(async value => {
                  if (window.__holdPreview) {
                    window.__previewWaiting = true;
                    await new Promise(resolve => window.__releasePreviews.push(resolve));
                  }
                  return value;
                }), cancel() { window.__previewCancels++; task.cancel(); } };
              };
              return page;
            };
            return pdf;
          });
          return new Proxy(loading, { get(target, property) {
            if (property === 'promise') return promise;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        }
        window.pdfjsLib = new Proxy(library, { get(target, property) {
          return property === 'getDocument' ? delayedGetDocument : Reflect.get(target, property, target);
        } });
      });
      await openPreview(h.page);
      await h.page.evaluate(() => { window.__holdPreview = true; });
      await h.page.getByRole('button', { name: enlarge ? 'Ver PDF ampliado' : 'Ampliar vista previa', exact: true }).click();
      await h.page.waitForFunction(() => window.__previewWaiting);
      if (enlarge) await h.page.keyboard.press('Escape');
      await profile(h.page);
      await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      assert.equal(await h.page.evaluate(() => window.AuditCloud.status().authenticated), false);
      await h.page.evaluate(() => {
        window.__holdPreview = false;
        for (const release of window.__releasePreviews.splice(0)) release();
      });
      await h.page.waitForTimeout(200);
      assert.ok(await h.page.evaluate(() => window.__previewCancels > 0), 'Leaving the document cancels pending PDF.js render tasks');
      assert.equal(await h.page.locator('[data-testid="pdf-preview"]').count(), 0);
      assert.equal(await h.page.locator('#traza-document-detail').count(), 0);
      assert.equal(await h.page.locator('dialog[open]').count(), 0);
      assert.equal(await h.page.evaluate(() => window.__blobUrls.size), 0);
      assert.equal(await h.page.locator('.audit-table tbody tr').count(), 0);
    } finally { await h.close(); }
  });
}

test('desktop: real encrypted archive, official author, damaged records, count, preview and document bytes', async () => {
  const h = await harness();
  try {
    await login(h.page);
    await checkNoOverflow(h.page);
    assert.equal(await h.page.title(), 'MegaControl | Control de salidas');
    const logo = h.page.locator('.traza-brand-symbol');
    const logoUrl = 'megacontrol-logo.png?v=megacontrol-logo-1';
    assert.equal(await logo.getAttribute('src'), logoUrl);
    assert.equal(await logo.evaluate(async image => {
      await image.decode();
      return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    }), true, 'The header logo must decode as an image');
    const favicon = await h.page.locator('link[rel="icon"]').getAttribute('href');
    assert.equal(favicon, logoUrl);
    assert.equal(await h.page.evaluate(async href => {
      const image = new Image();
      image.src = href;
      await image.decode();
      return image.naturalWidth > 0 && image.naturalHeight > 0;
    }, favicon), true, 'The favicon must decode as an image');
    await h.page.locator('#traza-sidebar').screenshot({ path: path.join(OUTPUT, 'desktop-sidebar.png') });
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
    const excel = await downloadAction(h, () => detail.getByRole('button', { name: 'Guardar Excel', exact: true }).click());
    const files = await h.page.evaluate(() => window.__picker.files);
    assert.deepEqual(Buffer.from(files[0].bytes), fixture.pdf);
    assert.deepEqual(excel.bytes, fixture.excel);
    assert.equal(files.length, 1, 'Only the PDF uses the native folder picker');
    assert.equal(h.state.downloads.length, 1, 'Excel appears in browser downloads once');
    await downloadNotice(h.page, excel.name);
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

test('converter: navigation keeps loaded PDF and session; native Excel table and text barcodes; one browser download after audit', async () => {
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
    const saved = await downloadAction(h, () => h.page.locator('#export-button').click());
    const result = await h.page.evaluate(() => ({ picker: window.__picker, events: window.__events }));
    assert.equal(result.picker.calls.length, 0, 'Excel uses browser downloads even when the native folder picker is available');
    const auditPosition = result.events.indexOf('fetch:/rest/v1/rpc/mega_audit_record');
    const downloadPosition = result.events.indexOf('download:Salida 00123 revisada.xlsx');
    assert.ok(auditPosition >= 0 && downloadPosition > auditPosition, 'The browser download starts only after audit registration');
    assert.equal(h.state.recordCalls, 1);
    assert.equal(saved.name, 'Salida 00123 revisada.xlsx');
    assert.equal(h.state.downloads.length, 1);
    await downloadNotice(h.page, saved.name);
    const bytes = saved.bytes;
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

for (const splitGroupedUnits of [false, true]) {
  test(`converter: last-row 1,800.00 units ${splitGroupedUnits ? 'split across PDF text items' : 'in one PDF text item'} remains numeric 1800 in a native Excel table`, async () => {
    const h = await harness();
    try {
      await login(h.page);
      await h.page.evaluate(() => window.TrazaUI.navigate('converter'));
      const pdf = fakePdf({ groupedUnits: true, splitGroupedUnits });
      const extracted = await h.page.evaluate(async bytes => {
        const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
        try { const doc = await task.promise; return (await (await doc.getPage(1)).getTextContent()).items.map(item => item.str); }
        finally { await task.destroy(); }
      }, Array.from(pdf));
      if (splitGroupedUnits) {
        assert.ok(extracted.includes('1,') && extracted.includes('800.00'), 'The fixture exercises physically separate PDF.js numeric text items');
      } else {
        assert.ok(extracted.includes('1,800.00'), 'The fixture exercises the complete grouped numeric PDF.js text item');
      }
      await h.page.locator('#file-input').setInputFiles({ name: 'Unidades agrupadas ficticias.pdf', mimeType: 'application/pdf', buffer: pdf });
      await waitNotBusy(h.page);
      assert.equal(await h.page.locator('#preview-count').innerText(), '4 filas', 'The final bulk product remains visible');
      const previewHeaders = await h.page.locator('#table-wrap thead th').allInnerTexts();
      const unitsIndex = previewHeaders.indexOf('SALIDAS - UNIDADES');
      const lastCells = await h.page.locator('#table-wrap tbody tr').last().locator('td').allInnerTexts();
      assert.ok(unitsIndex >= 0);
      assert.equal(lastCells[unitsIndex].replace(/,/g, ''), '1800.00');
      assert.match(await h.page.locator('#calculated-totals').innerText(), /Total de unidades: 1,807[.]50/);
      const saved = await downloadAction(h, () => h.page.locator('#export-button').click());
      const bytes = saved.bytes;
      const book = XLSX.read(bytes, { type: 'buffer' });
      const sheet = book.Sheets.Datos;
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const headings = rows[0], quantityColumn = headings.indexOf('Salidas - Unidades');
      const costColumn = headings.indexOf('Costo'), amountColumn = headings.indexOf('Salidas - Total');
      assert.equal(sheet.A5.t, 's'); assert.equal(sheet.A5.v, '0000000001800');
      const cell = sheet[XLSX.utils.encode_cell({ r: 4, c: quantityColumn })];
      assert.equal(cell.t, 'n'); assert.equal(cell.v, 1800);
      assert.equal(rows[3][quantityColumn], 2.5, 'Legitimate fractional units remain fractional');
      assert.equal(rows[4][costColumn], 0.35, 'Small decimal costs remain unchanged');
      assert.equal(rows[4][amountColumn], 630, 'The bulk row amount remains unchanged');
      assert.ok(XLSX.CFB.find(XLSX.CFB.read(bytes, { type: 'buffer' }), '/xl/tables/table1.xml'), 'The exported products use an actual native Excel table');
      assert.equal(h.state.recordCalls, 1);
      const registered = h.state.records.find(row => row.id !== fixture.records[0].id && row.created_at === '2026-10-09T03:00:00.000Z');
      const clear = await fixture.master.decrypt(new Uint8Array(Buffer.from(registered.encrypted_metadata, 'base64')), `${registered.id}|metadata`);
      try { assert.equal(JSON.parse(new TextDecoder().decode(clear)).total_units, 1807.5); }
      finally { clear.fill(0); }
      if (!splitGroupedUnits) await h.page.screenshot({ path: path.join(OUTPUT, 'desktop-grouped-units.png'), fullPage: true });
    } finally { await h.close(); }
  });
}

test('converter: download initialization failure and repeated download reuse one registered audit and exact bytes', async () => {
  const h = await harness();
  try {
    await login(h.page); await convert(h.page);
    await h.page.evaluate(() => { window.__failExcelDownload = true; });
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(h.state.recordCalls, 1);
    assert.equal(h.state.downloads.length, 0, 'A failed browser download does not create a partial download');
    assert.equal(await h.page.evaluate(() => window.__picker.calls.length), 0);
    assert.equal(await h.page.getByRole('button', { name: 'Descargar una copia', exact: true }).isVisible().catch(() => false), false);
    const count = h.state.records.length;
    const attempted = Buffer.from(await h.page.evaluate(() => window.__attemptedExcelBytes[0]));
    await h.page.evaluate(() => { window.__failExcelDownload = false; });
    const retried = await downloadAction(h, () => h.page.locator('#export-button').click());
    assert.deepEqual(retried.bytes, attempted, 'Retry preserves the bytes encrypted for the original audit');
    assert.equal(h.state.recordCalls, 1, 'Retry retrieves the registered record instead of creating another');
    assert.equal(h.state.records.length, count);
    const repeated = await downloadAction(h, () => h.page.locator('#export-button').click());
    assert.deepEqual(repeated.bytes, retried.bytes, 'A later repeat downloads the identical Excel');
    assert.equal(h.state.recordCalls, 1, 'A successful repeated download also preserves idempotency');
    assert.equal(h.state.records.length, count);
    assert.equal(h.state.downloads.length, 2, 'Each successful click creates one browser download');
    h.state.failList = 401;
    await h.page.locator('#export-button').click();
    await h.page.waitForFunction(() => !window.AuditCloud.status().authenticated);
    assert.equal(h.state.downloads.length, 2, 'Revoked access blocks downloading a previously cached Excel');
  } finally { await h.close(); }
});

test('converter: audit HTTP 500, network failure and session 401 never produce an unregistered download', async () => {
  const h = await harness();
  try {
    await login(h.page); await convert(h.page);
    h.state.failRecord = 500;
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(h.state.records.length, fixture.records.length);
    assert.match(await h.page.locator('#message').innerText(), /Supabase|500|operación/i);
    h.state.failRecord = 0;
    await h.context.route('**/rest/v1/rpc/mega_audit_record', route => route.abort('failed'));
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.match(await h.page.locator('#message').innerText(), /conectar|conexión/i);
    await h.context.unroute('**/rest/v1/rpc/mega_audit_record');
    h.state.failRecord = 401;
    await h.page.locator('#export-button').click();
    await h.page.waitForFunction(() => !window.AuditCloud.status().authenticated);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(await h.page.locator('#traza-save-notice').count(), 0);
    assert.equal(h.state.records.length, fixture.records.length);
  } finally { await h.close(); }
});

test('converter: an audit response arriving after logout cannot start an Excel download or restore its confirmation', async () => {
  const h = await harness();
  let release;
  try {
    await login(h.page); await convert(h.page);
    h.state.slowRecord = new Promise(resolve => { release = resolve; });
    await h.page.locator('#export-button').click();
    await h.page.waitForFunction(() => window.__events.some(event => event === 'fetch:/rest/v1/rpc/mega_audit_record'));
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    release(); h.state.slowRecord = null;
    await h.page.waitForTimeout(200);
    assert.equal(await h.page.evaluate(() => window.AuditCloud.status().authenticated), false);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(await h.page.locator('#traza-save-notice').count(), 0);
    assert.equal(await h.page.evaluate(() => window.__blobUrls.size), 0, 'A late audit cannot recreate decrypted document URLs');
  } finally { if (release) release(); await h.close(); }
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
    await h.page.locator('#traza-sidebar').screenshot({ path: path.join(OUTPUT, 'mobile-sidebar.png') });
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
    assert.match(await back.getAttribute('href'), /(?:index\.html.*)?#nueva-salida/);
    await back.click();
    await h.page.waitForFunction(() => window.TrazaUI.currentSection === 'converter');
    assert.equal(await h.page.evaluate(() => window.AuditCloud.status().authenticated), true, 'The archive entry point shares the converter session');
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

for (const kind of ['PDF', 'Excel']) {
test(`archive: a ${kind} body arriving after logout cannot restore plaintext, write or download`, async () => {
  const h = await harness();
  try {
    await login(h.page);
    await h.page.evaluate(() => { window.__delayBody = true; });
    await h.page.locator('.audit-table tbody tr').first().getByRole('button', { name: 'Guardar ' + kind, exact: true }).click();
    await h.page.waitForFunction(() => window.__bodyWaiting);
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await h.page.evaluate(() => { window.__delayBody = false; window.__releaseBody(); });
    await h.page.waitForTimeout(200);
    assert.equal(await h.page.evaluate(() => window.AuditCloud.status().authenticated), false);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(await h.page.locator('.audit-table tbody tr').count(), 0);
    assert.equal(await h.page.locator('[data-testid="pdf-preview"]').count(), 0);
  } finally { await h.close(); }
});
}

test('archive Excel: storage HTTP 500, network loss and session 401 never download an unauthorized file', async () => {
  const h = await harness();
  try {
    await login(h.page);
    const button = h.page.locator('.audit-table tbody tr').first().getByRole('button', { name: 'Guardar Excel', exact: true });
    h.state.failStorage = 500;
    await button.click();
    await h.page.getByText(/Supabase.*500|500.*Supabase|No se pudo completar la operación/i).first().waitFor();
    assert.equal(h.state.downloads.length, 0);
    assert.equal(await h.page.evaluate(() => window.__picker.calls.length), 0);
    h.state.failStorage = 0;
    const fail = route => route.abort('failed');
    await h.context.route('**/storage/v1/object/**', fail);
    await button.click();
    await h.page.getByText(/No se pudo conectar con Supabase/i).first().waitFor();
    assert.equal(h.state.downloads.length, 0);
    await h.context.unroute('**/storage/v1/object/**', fail);
    h.state.failStorage = 401;
    await button.click();
    await h.page.waitForFunction(() => !window.AuditCloud.status().authenticated);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(await h.page.locator('#traza-save-notice').count(), 0);
    assert.equal(h.state.recordCalls, 0);
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

test('intranet: an authorized user edits a saved PDF and exports a native Excel copy without inserting another audit', async () => {
  const h = await harness();
  let authenticated = false;
  const user = { id: 2, username: 'operador', display_name: 'Usuario ficticio', role: 'user', active: true };
  const record = { id: fixture.records[0].id, salida_numero: '00123', pdf_name: 'Documento interno ficticio.pdf', excel_name: 'Salida 00123.xlsx',
    created_at: '2026-10-09T02:30:00Z', username: 'administrador', user_display_name: 'Autor oficial ficticio', row_count: 34, total_units: 523.8 };
  const originalPdf = fakePdf({ groupedUnits: true });
  const requests = [];
  try {
    await h.context.route(`${origin}/index.html*`, route => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('<html lang="es"', '<html lang="es" data-audit-required="true"') }));
    await h.context.route(`${origin}/api/**`, route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      requests.push({ pathname, method: request.method() });
      let result;
      if (pathname === '/api/login') { authenticated = true; result = { user, csrf_token: 'fictional-csrf' }; }
      else if (pathname === '/api/logout') { authenticated = false; result = {}; }
      else if (pathname === '/api/status') result = { mode: 'intranet', authenticated, user: authenticated ? user : null, csrf_token: authenticated ? 'fictional-csrf' : null };
      else if (pathname === '/api/audits') result = { records: [record], total: 1, page_size: 25 };
      else if (pathname === `/api/audits/${record.id}`) result = { record };
      else if (pathname === `/api/audits/${record.id}/pdf`) return route.fulfill({ contentType: 'application/pdf', body: originalPdf });
      else throw new Error(`Unexpected fictional intranet route: ${request.method()} ${pathname}`);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
    });
    await h.page.goto(`${origin}/index.html#archivo`);
    await h.page.locator('#audit-login-username').fill('operador');
    await h.page.locator('#audit-login-password').fill(PASSWORD);
    await h.page.locator('#audit-bar').getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await h.page.getByRole('button', { name: 'Editar Excel', exact: true }).waitFor();
    await waitUnits(h.page);
    assert.match(await h.page.locator('.audit-table tbody [data-unit-state]').innerText(), /4 productos\s+1,807\.5 unidades/, 'The internal archive replaces obsolete metadata totals with actual stored PDF units');
    assert.match(await h.page.locator('#audit-page').innerText(), /Unidades verificadas en esta página: 1,807\.5/);
    await h.page.getByRole('button', { name: 'Editar Excel', exact: true }).click();
    await h.page.locator('#export-button:not([disabled])').waitFor();
    assert.equal(await h.page.evaluate(() => window.AuditClient.status().mode), 'intranet');
    assert.equal(await h.page.locator('#converter-title').innerText(), 'Editar Excel');
    assert.equal(await h.page.locator('#drop-zone').isVisible(), false);
    assert.equal(await h.page.locator('#salida-number').inputValue(), '00123');
    assert.equal(await h.page.locator('#salida-number').evaluate(input => input.readOnly), true);
    await h.page.locator('input[data-column="descripcion"]').check();
    await h.page.locator('#excel-file-name').fill('Salida 00123 interna editada.xlsx');
    await h.page.evaluate(() => { window.__events = []; });
    const saved = await downloadAction(h, () => h.page.locator('#export-button').click());
    const bytes = saved.bytes;
    const book = XLSX.read(bytes, { type: 'buffer' });
    assert.equal(book.Sheets.Datos.A2.t, 's');
    assert.equal(book.Sheets.Datos.A2.v, '0001234567890');
    assert.equal(book.Sheets.Datos.A3.v, '0000000000012');
    assert.ok(XLSX.CFB.find(XLSX.CFB.read(bytes, { type: 'buffer' }), '/xl/tables/table1.xml'), 'The internal edited Excel contains a native table');
    const events = await h.page.evaluate(() => window.__events);
    assert.ok(events.indexOf(`fetch:/api/audits/${record.id}`) < events.indexOf('download:' + saved.name), 'The internal server authorizes the existing audit before the Excel download');
    assert.equal(await h.page.evaluate(() => window.__picker.calls.length), 0);
    assert.equal(requests.filter(r => r.pathname === '/api/audits' && r.method === 'POST').length, 0, 'An internal re-export never creates another audit');
    assert.equal(requests.filter(r => r.pathname === `/api/audits/${record.id}`).length, 2, 'The server authorizes opening and saving the existing record');
    assert.equal(requests.filter(r => r.pathname === `/api/audits/${record.id}/pdf`).length, 2, 'The internal archive verifies the original PDF once, then the editor retrieves its own authorized copy');
    await downloadNotice(h.page, saved.name);
    assert.equal(h.state.downloads.length, 1, 'The internal re-export downloads once without a second copy action');
    await h.page.evaluate(() => {
      const converter = window.TrazaConverter;
      window.TrazaConverter = Object.freeze({ ...converter, async analyzeUnits(options) {
        const result = await converter.analyzeUnits(options);
        window.__heldInternalUnitsBytes = options.data;
        window.__internalUnitsWaiting = true;
        await new Promise(resolve => { window.__releaseInternalUnits = resolve; });
        return result;
      } });
      window.TrazaUI.navigate('archive');
    });
    await h.page.waitForFunction(() => window.__internalUnitsWaiting);
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    assert.equal(await h.page.evaluate(() => window.AuditClient.status().authenticated), false);
    assert.equal(await h.page.evaluate(() => !window.__heldInternalUnitsBytes.byteLength || window.__heldInternalUnitsBytes.every(value => value === 0)), true, 'Internal logout clears the original PDF buffer immediately, before the delayed analysis returns');
    await h.page.evaluate(() => window.__releaseInternalUnits());
    await h.page.waitForTimeout(100);
    assert.equal(await h.page.locator('.audit-table tbody tr').count(), 0);
    assert.equal(await h.page.locator('#results').isVisible(), false);
    assert.equal(await h.page.locator('#traza-save-notice').count(), 0);
  } finally { await h.close(); }
});

test('archive editor: authorized stored PDF, chosen columns, native Excel table and text barcodes without another audit record', async () => {
  const h = await harness({ role: 'user' });
  try {
    await login(h.page);
    const count = h.state.records.length;
    await editArchived(h.page);
    await h.page.locator('input[data-column="descripcion"]').check();
    await h.page.locator('input[data-column="ref"]').check();
    await h.page.locator('input[data-rename="codigo"]').fill('Código elegido');
    await h.page.locator('#excel-file-name').fill('Salida 00123 columnas elegidas.xlsx');
    await h.page.evaluate(() => { window.__events = []; });
    const saved = await downloadAction(h, () => h.page.locator('#export-button').click());
    assert.equal(saved.name, 'Salida 00123 columnas elegidas.xlsx', 'The browser download uses the edited Excel filename');
    const events = await h.page.evaluate(() => window.__events);
    assert.ok(events.indexOf('fetch:/rest/v1/mega_audit_records') < events.indexOf('download:' + saved.name), 'An archived re-export is authorized before the single browser download');
    assert.equal(await h.page.evaluate(() => window.__picker.calls.length), 0);
    const bytes = saved.bytes;
    const book = XLSX.read(bytes, { type: 'buffer' });
    assert.deepEqual(book.SheetNames, ['Datos', 'Resumen', 'Información', 'Respaldo original']);
    const rows = XLSX.utils.sheet_to_json(book.Sheets.Datos, { header: 1 });
    assert.equal(rows[0][0], 'Código elegido');
    assert.equal(book.Sheets.Datos.A2.t, 's');
    assert.equal(book.Sheets.Datos.A2.v, '0001234567890');
    assert.equal(book.Sheets.Datos.A3.v, '0000000000012');
    assert.equal(rows[1][rows[0].indexOf('Descripción')], 'Producto ficticio de descripcion completa');
    assert.equal(rows[1][rows[0].indexOf('Ref.')], 'REF-001 COMPLETA');
    const table = XLSX.CFB.find(XLSX.CFB.read(bytes, { type: 'buffer' }), '/xl/tables/table1.xml');
    assert.ok(table, 'An edited archive Excel must contain a native table');
    assert.match(Buffer.from(table.content).toString(), /<autoFilter/);
    assert.equal(h.state.recordCalls, 0);
    assert.equal(h.state.records.length, count);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'POST').length, 0);
    assert.ok(h.state.requests.some(r => r.pathname === '/rest/v1/mega_audit_records' && new URLSearchParams(r.search).get('id') === `eq.${fixture.records[0].id}`), 'Re-export checks that the original record is still authorized');
    await downloadNotice(h.page, saved.name);
    assert.equal(h.state.downloads.length, 1, 'The re-export automatically appears in browser downloads exactly once');
    await h.page.screenshot({ path: path.join(OUTPUT, 'desktop-archive-editor-saved.png'), fullPage: true });

    await h.page.locator('input[data-column="codigo"]').uncheck();
    await h.page.locator('#excel-file-name').fill('Salida 00123 sin código.xlsx');
    const second = await downloadAction(h, () => h.page.locator('#export-button').click());
    const secondBook = XLSX.read(second.bytes, { type: 'buffer' });
    const headings = XLSX.utils.sheet_to_json(secondBook.Sheets.Datos, { header: 1 })[0];
    assert.ok(!headings.includes('Código elegido') && !headings.includes('Código de barras'), 'The user can omit barcodes from the edited main sheet');
    assert.equal(h.state.recordCalls, 0);
    assert.equal(h.state.records.length, count);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'POST').length, 0);
    await downloadNotice(h.page, second.name);
    await h.page.evaluate(() => window.TrazaUI.navigate('archive'));
    await h.page.getByRole('button', { name: /^Abrir detalle de salida / }).first().waitFor();
    const original = h.page.waitForEvent('download');
    await h.page.evaluate(() => { delete window.showSaveFilePicker; });
    await h.page.locator('.audit-table tbody tr').first().getByRole('button', { name: 'Guardar Excel', exact: true }).click();
    assert.deepEqual(fs.readFileSync(await (await original).path()), fixture.excel, 'Editing preserves the original encrypted Excel in the archive');
  } finally { await h.close(); }
});

test('archive editor: download initialization failure creates no download; exact-byte retry reuses the original audit', async () => {
  const h = await harness();
  try {
    await login(h.page); await editArchived(h.page);
    const count = h.state.records.length;
    await h.page.evaluate(() => { window.__failExcelDownload = true; });
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(await h.page.evaluate(() => window.__picker.calls.length), 0);
    assert.equal(await h.page.getByRole('button', { name: 'Descargar una copia', exact: true }).isVisible().catch(() => false), false);
    const attempted = Buffer.from(await h.page.evaluate(() => window.__attemptedExcelBytes[0]));
    await h.page.evaluate(() => { window.__failExcelDownload = false; });
    const saved = await downloadAction(h, () => h.page.locator('#export-button').click());
    assert.deepEqual(saved.bytes, attempted);
    await downloadNotice(h.page, saved.name);
    const repeat = await downloadAction(h, () => h.page.locator('#export-button').click());
    assert.deepEqual(repeat.bytes, saved.bytes);
    assert.equal(h.state.downloads.length, 2);
    assert.equal(h.state.recordCalls, 0);
    assert.equal(h.state.records.length, count);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'POST').length, 0);
  } finally { await h.close(); }
});

test('archive editor: re-export HTTP 500, network loss and revoked session never write or download', async () => {
  const h = await harness();
  try {
    await login(h.page); await editArchived(h.page);
    h.state.failList = 500;
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.match(await h.page.locator('#message').innerText(), /Supabase|500|operación/i);
    h.state.failList = 0;
    const fail = route => route.abort('failed');
    await h.context.route('**/rest/v1/mega_audit_records?*', fail);
    await h.page.locator('#export-button').click(); await waitNotBusy(h.page);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.match(await h.page.locator('#message').innerText(), /conectar|conexión/i);
    await h.context.unroute('**/rest/v1/mega_audit_records?*', fail);
    h.state.failList = 401;
    await h.page.locator('#export-button').click();
    await h.page.waitForFunction(() => !window.AuditCloud.status().authenticated);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(await h.page.getByRole('button', { name: 'Descargar una copia', exact: true }).isVisible().catch(() => false), false);
    assert.equal(h.state.recordCalls, 0);
    assert.equal(h.state.records.length, fixture.records.length);
    assert.equal(await h.page.locator('#results').isVisible(), false, 'Revocation immediately clears the decoded archive editor');
  } finally { await h.close(); }
});

test('archive editor: a decrypted PDF response arriving after logout cannot open the editor', async () => {
  const h = await harness();
  try {
    await login(h.page);
    await h.page.getByRole('button', { name: /^Abrir detalle de salida / }).first().click();
    await h.page.getByText('Página 1 de 1', { exact: true }).waitFor();
    await h.page.evaluate(() => { window.__delayBody = true; });
    await h.page.locator('#traza-document-detail').getByRole('button', { name: /Editar Excel/ }).click();
    await h.page.waitForFunction(() => window.__bodyWaiting);
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await h.page.evaluate(() => { window.__delayBody = false; window.__releaseBody(); });
    await h.page.waitForTimeout(200);
    assert.equal(await h.page.evaluate(() => window.AuditCloud.status().authenticated), false);
    assert.equal(await h.page.evaluate(() => window.TrazaUI.currentSection), 'archive');
    assert.equal(await h.page.locator('#results').isVisible(), false);
    assert.equal(await h.page.locator('#traza-document-detail').count(), 0);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(await h.page.getByRole('button', { name: 'Descargar una copia', exact: true }).isVisible().catch(() => false), false);
  } finally { await h.close(); }
});

test('archive editor: authorization arriving after logout cannot save a file or restore a copy', async () => {
  const h = await harness();
  let release;
  try {
    await login(h.page); await editArchived(h.page);
    h.state.slowConfirmation = new Promise(resolve => { release = resolve; });
    await h.page.evaluate(() => { window.__events = []; });
    await h.page.locator('#export-button').click();
    await h.page.waitForFunction(() => window.__events.some(event => event === 'fetch:/rest/v1/mega_audit_records'));
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    release(); h.state.slowConfirmation = null;
    await h.page.waitForTimeout(200);
    assert.equal(await h.page.evaluate(() => window.AuditCloud.status().authenticated), false);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(h.state.recordCalls, 0);
    assert.equal(await h.page.locator('#results').isVisible(), false);
    assert.equal(await h.page.getByRole('button', { name: 'Descargar una copia', exact: true }).isVisible().catch(() => false), false);
  } finally { if (release) release(); await h.close(); }
});

test('archive editor: a late first document cannot replace a more recent edit selection', async () => {
  const h = await harness();
  let release;
  try {
    await login(h.page);
    const first = fixture.records[0].id;
    h.state.slowDocuments.set(first, new Promise(resolve => { release = resolve; }));
    await h.page.evaluate(() => { window.__events = []; });
    const edit = h.page.getByRole('button', { name: /^Editar Excel de salida / });
    await edit.first().click();
    await h.page.waitForFunction(id => window.__events.some(event => event.includes(id) && event.includes('/storage/')), first);
    await edit.nth(1).click();
    await h.page.locator('#export-button:not([disabled])').waitFor();
    assert.equal(await h.page.locator('#salida-number').inputValue(), '30002');
    assert.equal(await h.page.evaluate(() => window.TrazaUI.currentSection), 'converter');
    release(); h.state.slowDocuments.clear();
    await h.page.waitForTimeout(200);
    assert.equal(await h.page.locator('#salida-number').inputValue(), '30002', 'The late first response must not replace the newer selection');
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(h.state.recordCalls, 0);
  } finally { if (release) release(); await h.close(); }
});

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile 390 px' : 'desktop'}: Excel downloads once and shows its filename without a second copy action`, async () => {
    const h = await harness({ mobile });
    try {
      await login(h.page); await convert(h.page);
      const saved = await downloadAction(h, () => h.page.locator('#export-button').click());
      const notice = await downloadNotice(h.page, saved.name);
      assert.equal(h.state.downloads.length, 1, 'The original click starts exactly one browser download');
      assert.equal(await h.page.evaluate(() => window.__picker.calls.length), 0, 'Browser download preferences handle the folder and any opening behavior');
      await checkNoOverflow(h.page);
      await h.page.waitForFunction(() => {
        const bounds = document.getElementById('traza-save-notice').getBoundingClientRect();
        return bounds.x >= -1 && bounds.y >= -1 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
      }).catch(async error => {
        await h.page.screenshot({ path: path.join(OUTPUT, `${mobile ? 'mobile' : 'desktop'}-save-visibility-failure.png`), fullPage: true });
        const geometry = await h.page.locator('#traza-save-notice').boundingBox();
        throw new Error(error.message + ' Notice geometry: ' + JSON.stringify(geometry));
      });
      const box = await notice.boundingBox();
      const viewport = h.page.viewportSize();
      assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'Save confirmation stays visible inside the viewport within native scroll rounding');
      const calls = h.state.recordCalls;
      await h.page.screenshot({ path: path.join(OUTPUT, `${mobile ? 'mobile' : 'desktop'}-save-confirmation.png`), fullPage: true });
      await notice.getByRole('button', { name: 'Cerrar confirmación de guardado', exact: true }).click();
      assert.equal(await notice.isVisible(), false);
      const repeated = await downloadAction(h, () => h.page.locator('#export-button').click());
      assert.deepEqual(repeated.bytes, saved.bytes);
      assert.equal(h.state.recordCalls, calls, 'Repeating the download never creates another audit entry');
      await downloadNotice(h.page, saved.name);
      const url = await h.page.evaluate(() => window.__latestBlobUrl);
      await h.page.locator('#reset-button').click();
      assert.equal(await notice.isVisible(), false, 'Loading another PDF clears the previous download confirmation');
      assert.equal(await h.page.evaluate(value => window.__revokedBlobUrls.includes(value), url), true, 'Reset releases the downloaded cleartext Blob URL');
      assert.equal(await h.page.locator('#drop-zone').isVisible(), true);
    } finally { await h.close(); }
  });
}

test('archive folder downloads: exact PDF copy and cleanup on document, navigation and session changes', async () => {
  const h = await harness();
  try {
    await login(h.page);
    const rows = h.page.locator('.audit-table tbody tr');
    await rows.first().getByRole('button', { name: 'Guardar PDF', exact: true }).click();
    await h.page.waitForFunction(() => window.__picker.files.length === 1);
    const saved = await h.page.evaluate(() => window.__picker.files[0]);
    const notice = await savedNotice(h.page, saved.name);
    await copySavedFile(h, fixture.pdf, saved.name);
    let url = await h.page.evaluate(() => window.__latestBlobUrl);
    await h.page.getByRole('button', { name: /^Abrir detalle de salida / }).nth(1).click();
    assert.equal(await notice.isVisible(), false, 'Changing the selected document clears its old saved copy');
    assert.equal(await h.page.evaluate(value => window.__revokedBlobUrls.includes(value), url), true);
    await h.page.getByText('Página 1 de 1', { exact: true }).waitFor();
    await h.page.locator('#traza-document-detail').getByRole('button', { name: 'Guardar PDF', exact: true }).click();
    await h.page.waitForFunction(() => window.__picker.files.length === 2);
    await savedNotice(h.page, saved.name);
    url = await h.page.evaluate(() => window.__latestBlobUrl);
    await h.page.evaluate(() => window.TrazaUI.navigate('converter'));
    assert.equal(await notice.isVisible(), false);
    assert.equal(await h.page.evaluate(value => window.__revokedBlobUrls.includes(value), url), true);
    await h.page.evaluate(() => window.TrazaUI.navigate('archive'));
    await h.page.getByRole('button', { name: /^Abrir detalle de salida / }).first().waitFor();
    await rows.first().getByRole('button', { name: 'Guardar PDF', exact: true }).click();
    await h.page.waitForFunction(() => window.__picker.files.length === 3);
    await savedNotice(h.page, saved.name);
    url = await h.page.evaluate(() => window.__latestBlobUrl);
    await profile(h.page);
    await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    assert.equal(await notice.isVisible(), false);
    assert.equal(await h.page.evaluate(value => window.__revokedBlobUrls.includes(value), url), true);
    assert.equal(h.state.recordCalls, 0);
  } finally { await h.close(); }
});

test('converter: an unsigned visitor receives a visible login error and cannot save or copy an unregistered Excel', async () => {
  const h = await harness();
  try {
    await h.page.goto(`${origin}/index.html#nueva-salida`);
    await convert(h.page);
    await h.page.locator('#export-button').click();
    await waitNotBusy(h.page);
    assert.equal(await h.page.locator('#message').isVisible(), true);
    assert.match(await h.page.locator('#message').innerText(), /Inicia sesión.*antes de descargar/i);
    assert.equal(await h.page.evaluate(() => window.__picker.calls.length), 0);
    assert.equal(await h.page.evaluate(() => window.__picker.files.length), 0);
    assert.equal(h.state.recordCalls, 0);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'POST').length, 0);
    assert.equal(await h.page.getByRole('button', { name: 'Descargar una copia', exact: true }).isVisible().catch(() => false), false);
  } finally { await h.close(); }
});

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile 390 px' : 'desktop'} archive units: historical 523.8 metadata is recalculated from original PDFs with 1800 and 1700 units`, async () => {
    const h = await harness({ mobile });
    try {
      const first = await setArchivedPdf(h, 0, { groupedUnits: true }, { row_count: 34, total_units: 523.8 });
      const second = await setArchivedPdf(h, 2, { groupedUnits: true, bulkUnits: '1,700.00' }, { row_count: 12, total_units: 133 });
      h.state.records = [first.row, second.row];
      const originalMetadata = h.state.records.map(row => row.encrypted_metadata);
      await login(h.page);
      const cells = h.page.locator('.audit-table tbody [data-label="Unidades"]');
      assert.deepEqual(await cells.locator('> span:first-child').allInnerTexts(), ['1,807.5', '1,707.5']);
      assert.deepEqual(await cells.evaluateAll(list => list.map(cell => cell.dataset.unitState)), ['verified', 'verified']);
      assert.match(await h.page.locator('.traza-units-count').innerText(), /Unidades.*en esta página: 3,515/);
      assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'GET').length, 2, 'Units come from decrypting both authorized originals automatically');
      await openPreview(h.page);
      const facts = await h.page.locator('.traza-detail-facts').evaluate(dl => Object.fromEntries([...dl.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent])));
      assert.equal(facts.Productos, '4');
      assert.equal(facts.Unidades, '1,807.5');
      assert.deepEqual(h.state.records.map(row => row.encrypted_metadata), originalMetadata, 'Historical metadata is preserved; the verified counts come from the PDF without rewriting originals');
      assert.equal(h.state.recordCalls, 0);
      assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method !== 'GET').length, 0);
      assert.equal(h.state.downloads.length, 0);
      await checkNoOverflow(h.page);
      await h.page.screenshot({ path: path.join(OUTPUT, `${mobile ? 'mobile' : 'desktop'}-archive-verified-units.png`), fullPage: true });
    } finally { await h.close(); }
  });
}

test('archive units: refresh rechecks originals, filtered summaries stay correct, legitimate edited output numbers and loaded converter PDF are preserved', async () => {
  const h = await harness();
  try {
    const original = await setArchivedPdf(h, 0, { groupedUnits: true, number: '00999' }, { total_units: 523.8 });
    h.state.records = [original.row];
    await login(h.page);
    assert.equal(await h.page.locator('.audit-table tbody [data-label="Unidades"] > span:first-child').innerText(), '1,807.5');
    assert.match(await h.page.locator('.audit-table tbody tr').innerText(), /Salida 00123/);
    await convert(h.page);
    await h.page.locator('input[data-column="descripcion"]').check();
    await h.page.locator('#excel-file-name').fill('Mi salida cargada.xlsx');
    await h.page.evaluate(() => window.TrazaUI.navigate('archive'));
    await waitUnits(h.page);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'GET').length, 1, 'Navigation reuses only the verified scalar summary, with no retained plaintext PDF');
    await h.page.locator('#audit-cloud-search').fill('00123');
    await h.page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await waitUnits(h.page);
    assert.match(await h.page.locator('.traza-units-count').innerText(), /1,807\.5/);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'GET').length, 1);
    h.state.storage.set(`${WORKSPACE}/${original.row.created_by}/${original.row.id}/pdf.bin`, Buffer.from(await fixture.master.encrypt(new Uint8Array(fakePdf({ groupedUnits: true, bulkUnits: '1,700.00', number: '00999' })), `${original.row.id}|pdf`)));
    await h.page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await h.page.waitForFunction(() => document.querySelector('.audit-table tbody [data-label="Unidades"] > span:first-child')?.textContent === '1,707.5');
    assert.equal(await h.page.locator('#audit-cloud-search').inputValue(), '00123');
    assert.match(await h.page.locator('.traza-units-count').innerText(), /1,707\.5/);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'GET').length, 2, 'Refresh retrieves and decrypts the original again instead of displaying cached counts');
    await h.page.evaluate(() => window.TrazaUI.navigate('converter'));
    assert.equal(await h.page.locator('#salida-number').inputValue(), '00123');
    assert.equal(await h.page.locator('#excel-file-name').inputValue(), 'Mi salida cargada.xlsx');
    assert.equal(await h.page.locator('input[data-column="descripcion"]').isChecked(), true);
    assert.match(await h.page.locator('#calculated-totals').innerText(), /5[,.]00/);
    assert.equal(h.state.recordCalls, 0);
    assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'POST').length, 0);
  } finally { await h.close(); }
});

for (const failure of ['missing quantities', 'invalid PDF', 'HTTP 500', 'network loss']) {
  test(`archive units: ${failure} keeps its row and authorized documents, excludes obsolete metadata from the verified page sum`, async () => {
    const h = await harness();
    try {
      const good = await setArchivedPdf(h, 0, {});
      const bad = await setArchivedPdf(h, 2, failure === 'invalid PDF' ? Buffer.from('Fictional invalid PDF bytes') : { groupedUnits: true, missingUnits: failure === 'missing quantities' }, { total_units: 523.8 });
      h.state.records = [good.row, bad.row];
      const storagePath = `**/storage/v1/object/**/${bad.row.id}/pdf.bin`;
      let fail;
      if (failure === 'HTTP 500' || failure === 'network loss') {
        fail = route => failure === 'HTTP 500' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'fictional_error' }) }) : route.abort('failed');
        await h.context.route(storagePath, fail);
      }
      await login(h.page);
      const rows = h.page.locator('.audit-table tbody tr');
      assert.equal(await rows.count(), 2);
      assert.equal(await rows.first().locator('[data-label="Unidades"]').getAttribute('data-unit-state'), 'verified');
      assert.equal(await rows.nth(1).locator('[data-label="Unidades"]').getAttribute('data-unit-state'), 'unverified');
      assert.match(await rows.nth(1).innerText(), /no verificad|sin verificar|no disponibles/i);
      assert.doesNotMatch(await rows.nth(1).locator('[data-label="Unidades"]').innerText(), /523\.8/);
      assert.match(await h.page.locator('.traza-units-count').innerText(), /Unidades verificadas en esta página: 5(?:\D|$)/);
      for (const name of ['Guardar PDF', 'Guardar Excel']) assert.equal(await rows.nth(1).getByRole('button', { name, exact: true }).isEnabled(), true, 'A units check failure does not remove access to the original documents');
      assert.equal(h.state.recordCalls, 0);
      assert.equal(h.state.requests.filter(r => r.pathname.startsWith('/storage/') && r.method === 'POST').length, 0);
      if (fail) {
        await h.context.unroute(storagePath, fail);
        await h.page.getByRole('button', { name: 'Actualizar', exact: true }).click();
        await h.page.waitForFunction(() => {
          const cells = [...document.querySelectorAll('.audit-table tbody [data-unit-state]')];
          return cells.length === 2 && cells.every(cell => cell.dataset.unitState === 'verified');
        });
        assert.match(await h.page.locator('.traza-units-count').innerText(), /1,812\.5/);
      }
    } finally { await h.close(); }
  });
}

for (const action of ['logout', 'navigation']) {
  test(`archive units: a completed PDF analysis arriving after ${action} cannot restore records, totals or cleartext buffers`, async () => {
    const h = await harness();
    try {
      const original = await setArchivedPdf(h, 0, { groupedUnits: true }, { total_units: 523.8 });
      h.state.records = [original.row];
      await h.context.addInitScript(() => {
        window.addEventListener('DOMContentLoaded', () => {
          const converter = window.TrazaConverter;
          window.TrazaConverter = Object.freeze({ ...converter, async analyzeUnits(options) {
            const result = await converter.analyzeUnits(options);
            window.__heldUnitsBytes = options.data;
            window.__unitsAnalysisWaiting = true;
            await new Promise(resolve => { window.__releaseUnitsAnalysis = resolve; });
            return result;
          } });
        }, { once: true });
      });
      await login(h.page, 'index.html', { waitUnits: false });
      await h.page.waitForFunction(() => window.__unitsAnalysisWaiting);
      assert.equal(await h.page.locator('.audit-table tbody [data-unit-state]').getAttribute('data-unit-state'), 'checking');
      assert.doesNotMatch(await h.page.locator('.traza-units-count').innerText(), /523\.8|1,807\.5/);
      if (action === 'logout') {
        await profile(h.page);
        await h.page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      } else await h.page.evaluate(() => window.TrazaUI.navigate('converter'));
      assert.equal(await h.page.evaluate(() => !window.__heldUnitsBytes.byteLength || window.__heldUnitsBytes.every(value => value === 0)), true, 'Leaving the archive clears the decrypted PDF immediately, before the delayed parser returns');
      await h.page.evaluate(() => window.__releaseUnitsAnalysis());
      await h.page.waitForTimeout(150);
      assert.equal(await h.page.locator('.audit-table tbody tr').count(), 0);
      assert.equal(await h.page.locator('#traza-document-detail').count(), 0);
      assert.equal(await h.page.evaluate(() => !window.__heldUnitsBytes.byteLength || window.__heldUnitsBytes.every(value => value === 0)), true, 'The decrypted PDF buffer is cleared after a superseded analysis');
      assert.equal(await h.page.evaluate(() => window.__blobUrls.size), 0);
      assert.equal(h.state.downloads.length, 0);
      assert.equal(h.state.recordCalls, 0);
    } finally { await h.close(); }
  });
}

test('archive units: session HTTP 401 during automatic original-PDF verification immediately removes archive and keys', async () => {
  const h = await harness();
  try {
    h.state.records = [h.state.records[0]];
    await login(h.page);
    h.state.failStorage = 401;
    await h.page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await h.page.waitForFunction(() => !window.AuditCloud.status().authenticated);
    assert.equal(await h.page.locator('.audit-table tbody tr').count(), 0);
    assert.equal(await h.page.locator('#traza-document-detail').count(), 0);
    assert.equal(await h.page.locator('.traza-units-count').count(), 0);
    assert.equal(await h.page.evaluate(() => window.__blobUrls.size), 0);
    assert.equal(h.state.downloads.length, 0);
    assert.equal(h.state.recordCalls, 0);
  } finally { await h.close(); }
});
