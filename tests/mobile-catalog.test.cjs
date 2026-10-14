'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Catalog = require('../mobile-catalog.js');

test('barcode and reference queries remain separate, even when numeric identifiers collide; blanks and zero prices keep their meaning',async()=>{
 const products=[{codigo:'0001234500001',ref:'654321',pventa:5.99},{codigo:'123456',ref:'0001234500001',pventa:9.99},{codigo:'0012345678905',ref:'123456',pventa:0},{codigo:'654322',ref:'NO-PRICE',pventa:''}];
 let stored;
 const catalog=Catalog.create({snapshot:async()=>[{id:'one',encrypted_metadata:'v1'}],document:async()=>({salida:'55001',invoiceDate:'2026-10-12',products}),cache:{read:async()=>stored,write:async v=>stored=v},seal:async v=>v,unseal:async v=>v,verifyAccess:async()=>{}});
 for(let cycle=0;cycle<2;cycle++){
  await catalog.prepare();assert.equal((await catalog.lookup('654321')).match,null,'A reference is not evidence that the scanned barcode exists');
  assert.equal((await catalog.lookup('654321',undefined,'reference')).match.product.codigo,'0001234500001');
  assert.equal((await catalog.lookup('123456')).match.product.pventa,9.99);assert.equal((await catalog.lookup('123456',undefined,'reference')).match.product.pventa,0);
  assert.equal((await catalog.lookup('0001234500001')).match.product.pventa,5.99);assert.equal((await catalog.lookup('0001234500001',undefined,'reference')).match.product.pventa,9.99);
  assert.equal((await catalog.lookup('NO-PRICE')).match,null);assert.equal((await catalog.lookup('654322')).match.product.pventa,'');
  await assert.rejects(catalog.lookup('123456',undefined,'automatic'),/Elige/);
 }
});
test('cache migration reparses Salidas print dates once, retains approved invoice metadata and selects the actual latest price',async()=>{
 const code='0001234500001',doc=(salida,invoiceDate,pventa)=>({salida,invoiceDate,products:[{codigo:code,pventa}]}),docs=new Map([['old',doc('55001','2026-10-08',9.99)],['latest',doc('55002','2026-10-09',8.99)]]);
 const imported={kind:'factura',reviewed:true,salida:'55003',invoiceDate:'2026-10-12',products:[{codigo:'0012345678905',pventa:7.99}]};
 let stored={version:2,documents:[{id:'old',revision:'v1',doc:doc('55001','2026-10-20',9.99)},{id:'latest',revision:'v1',doc:docs.get('latest')},{id:'import',revision:'v1',doc:imported}]},reads=[];
 const catalog=Catalog.create({snapshot:async()=>['old','latest','import'].map(id=>({id,encrypted_metadata:'v1'})),document:async id=>{reads.push(id);return docs.get(id);},cache:{read:async()=>stored,write:async v=>stored=v},seal:async v=>v,unseal:async v=>v,verifyAccess:async()=>{}});
 await catalog.prepare();assert.deepEqual(reads.sort(),['latest','old']);assert.equal(stored.version,3);assert.equal((await catalog.lookup(code)).match.product.pventa,8.99);assert.equal((await catalog.lookup('0012345678905')).match.product.pventa,7.99);
 await catalog.prepare();assert.equal(reads.length,2,'The corrected cache avoids repeated PDF reads');
});

test('catalog indexes 100 documents once, preserves newest price and zeroes, reuses cache and imports only changed records', async () => {
  let reads = 0, access = 0, stored;
  let snapshot = Array.from({ length: 100 }, (_, i) => ({ id: String(i), encrypted_metadata: 'revision-' + i }));
  const client = {
    snapshot: async () => snapshot,
    document: async id => { reads++; return { products: [{ codigo: '0001234567890', pventa: Number(id) + 12 }, { codigo: String(1000000000000 + Number(id)) }], salida: id, invoiceDate: new Date(Date.UTC(2026, 9, 9 - Number(id))).toISOString().slice(0, 10), date: '2026-10-09T00:00:00Z' }; },
    cache: { read: async () => stored, write: async value => { stored = value; } },
    // Persistence encryption is exercised with real keys in browser tests.
    seal: async value => structuredClone(value), unseal: async value => structuredClone(value),
    verifyAccess: async () => { access++; }
  };
  const catalog = Catalog.create(client);
  await catalog.prepare(); assert.equal(reads, 100);
  const started = performance.now();
  for (let i = 0; i < 1000; i++) assert.equal((await catalog.lookup('0001234567890')).match.product.pventa, 12);
  assert.ok(performance.now() - started < 5000);
  assert.equal(reads, 100, 'Queries cannot download or parse PDFs');
  assert.equal(access, 1000, 'Every query verifies current access');
  assert.equal((await catalog.lookup('001234567890')).match.product.codigo, '0001234567890');
  assert.equal((await catalog.lookup('001234567890')).match.history.length, 100);
  assert.equal((await catalog.lookup('9999999999999')).match, null);
  catalog.clear(); await assert.rejects(catalog.lookup('0001234567890'), /Prepara/);
  await catalog.prepare(); assert.equal(reads, 100, 'A new session can reuse the encrypted cache');
  assert.equal(await catalog.hasUpdates(), false);
  snapshot = snapshot.map((entry, i) => i === 3 ? { ...entry, encrypted_metadata: 'changed' } : entry);
  assert.equal(await catalog.hasUpdates(), true);
  await catalog.prepare(); assert.equal(reads, 101);
  snapshot = snapshot.slice(1);
  await catalog.prepare(); assert.equal((await catalog.lookup('0001234567890')).match.product.pventa, 13, 'Removed sources disappear');
  assert.equal(stored.documents.length, 99, 'Removed sources also disappear from persisted data');
});

test('catalog keeps failed documents distinct from absence and prevents authorization or cancellation from returning cached products', async () => {
  let authorized = true, release;
  const catalog = Catalog.create({
    snapshot: async () => [{ id: 'broken', encrypted_metadata: 'v1' }],
    document: async () => { throw new Error('Unreadable'); },
    cache: { read: async () => null, write: async () => {} }, seal: async value => value,
    verifyAccess: async () => { if (!authorized) throw new Error('Revoked'); if (release) await release.promise; }
  });
  const prepared = await catalog.prepare(); assert.equal(prepared.failed, 1);
  assert.equal((await catalog.lookup('0123456789012')).failed, 1);
  authorized = false; await assert.rejects(catalog.lookup('0123456789012'), /Revoked/);
  authorized = true;
  let resolve;
  release = { promise: new Promise(done => { resolve = done; }) };
  const controller = new AbortController();
  const pending = catalog.lookup('0123456789012', controller.signal);
  controller.abort(); resolve(); await assert.rejects(pending, /cancelada/);
});

test('invoice dates use day/month/year and reject impossible calendar dates', () => {
  assert.equal(Catalog.invoiceDate('8/10/2026'), '2026-10-08');
  assert.equal(Catalog.invoiceDate('10/8/2026'), '2026-08-10');
  assert.equal(Catalog.invoiceDate('29/02/2024'), '2024-02-29');
  for (const value of ['29/02/2025', '31/04/2026', '0/10/2026', '8/13/2026', '', undefined, '2026-10-08']) assert.equal(Catalog.invoiceDate(value), '');
});

test('invoice chronology wins over upload time, keeps every salida, migrates old cache and reuses headers', async () => {
  const code = '0001234567890';
  const doc = (salida, invoiceDate, pventa, date) => ({ salida, invoiceDate, date, products: [{ codigo: code, pventa }] });
  const docs = new Map([
    ['corrected-old', doc('29317', '2026-10-08', 9.99, '2026-10-30T00:00:00Z')],
    ['latest-invoice', doc('29345', '2026-10-09', 8.99, '2026-10-09T00:00:00Z')],
    ['large-old-number', doc('99999', '2026-10-07', 6.99, '2026-10-31T00:00:00Z')],
    ['missing-date', doc('999999', '', 1.99, '2026-11-01T00:00:00Z')]
  ]);
  let reads = 0, stored = { version: 1, documents: [{ id: 'corrected-old', revision: 'v1', doc: { ...docs.get('corrected-old'), invoiceDate: undefined } }] };
  const snapshot = () => [...docs].map(([id, d]) => ({ id, encrypted_metadata: 'v1', created_at: d.date }));
  const catalog = Catalog.create({
    snapshot: async () => snapshot(), document: async id => { reads++; return docs.get(id); },
    cache: { read: async () => stored, write: async value => { stored = value; } },
    seal: async value => structuredClone(value), unseal: async value => structuredClone(value), verifyAccess: async () => {}
  });
  await catalog.prepare();
  let match = (await catalog.lookup(code)).match;
  assert.equal(match.product.pventa, 8.99);
  assert.equal(match.doc.salida, '29345');
  assert.deepEqual(match.history.map(row => [row.doc.salida, row.product.pventa, row.doc.invoiceDate]), [
    ['29345', 8.99, '2026-10-09'], ['29317', 9.99, '2026-10-08'], ['99999', 6.99, '2026-10-07'], ['999999', 1.99, '']
  ]);
  assert.equal(match.unverifiedDates, 1);
  assert.equal(reads, 4, 'Old cache must reparse invoices instead of using upload dates');
  assert.equal(stored.version, 3);
  await catalog.prepare(); assert.equal(reads, 4, 'Headers and full history survive the encrypted cache');
  docs.set('same-date-higher-number', doc('00029346', '2026-10-09', 7.99, '2026-10-01T00:00:00Z'));
  await catalog.prepare(); match = (await catalog.lookup(code)).match;
  assert.equal(reads, 5, 'Only new documents require parsing');
  assert.equal(match.doc.salida, '00029346'); assert.equal(match.product.pventa, 7.99);
  docs.delete('same-date-higher-number'); await catalog.prepare();
  assert.equal((await catalog.lookup(code)).match.product.pventa, 8.99);
  assert.equal(reads, 5);
});

test('same-day salida numbers compare without integer precision loss and conflicting invoice prices require review', async () => {
  const code = '0001234567890', large = '9007199254740993';
  const docs = new Map([
    ['first', { salida: '9007199254740992', invoiceDate: '2026-10-09', products: [{ codigo: code, pventa: 12 }] }],
    ['last', { salida: large, invoiceDate: '2026-10-09', products: [{ codigo: code, pventa: 8.99 }, { codigo: code, pventa: 8.99 }, { codigo: code, pventa: 9.99 }] }]
  ]);
  const catalog = Catalog.create({
    snapshot: async () => [...docs.keys()].map(id => ({ id, encrypted_metadata: id })), document: async id => docs.get(id),
    cache: { read: async () => null, write: async () => {} }, seal: async value => value, verifyAccess: async () => {}
  });
  await catalog.prepare(); const match = (await catalog.lookup(code)).match;
  assert.equal(match.doc.salida, large); assert.equal(match.conflictingPrices, true);
  assert.equal(match.product.pventa, null, 'Conflicting prices cannot silently choose one');
  assert.equal(match.history.length, 3, 'Identical duplicate lines are collapsed, different prices are retained');
  assert.deepEqual(match.history.map(row => row.product.pventa), [8.99, 9.99, 12]);
});


test('local name search handles accents, partial references and several distinct barcodes without treating a name as an exact code',async()=>{
 const catalog=Catalog.create({snapshot:async()=>[{id:'one',encrypted_metadata:'r1'}],document:async()=>({salida:'9',invoiceDate:'2026-10-14',products:[{codigo:'0000123456789',descripcion:'Perfume Ámbar',ref:'HB-001',pventa:9.99},{codigo:'0000123456790',descripcion:'Perfume Ámbar',ref:'HB-002',pventa:7.99}]}),cache:{read:async()=>null,write:async()=>{}},seal:async v=>v,unseal:async v=>v,verifyAccess:async()=>{}});
 await catalog.prepare();const result=await catalog.lookup('perfume ambar',undefined,'name');assert.equal(result.candidateCount,2);assert.equal(result.match,null);assert.equal((await catalog.lookup('HB-00',undefined,'name')).candidateCount,2);assert.equal((await catalog.lookup('Ámbar')).match,null);
});

test('new devices reuse the shared index, changed documents are reparsed once and shared failures keep the local reader functional',async()=>{
 let reads=0,writes=0,revision='v1';const doc={products:[{codigo:'0000123456789',descripcion:'Artículo',ref:'A',pventa:0}],salida:'9'};
 const catalog=Catalog.create({snapshot:async()=>[{id:'one',encrypted_metadata:revision}],document:async()=>{reads++;return doc;},shared:{read:async()=>revision==='v1'?new Map([['one',doc]]):new Map(),write:async()=>{writes++;throw new Error('Unavailable');}},cache:{read:async()=>null,write:async()=>{}},seal:async v=>v,unseal:async v=>v,verifyAccess:async()=>{}});
 const first=await catalog.prepare();assert.equal(reads,0);assert.equal(first.shared,1);assert.equal((await catalog.lookup('0000123456789')).match.product.pventa,0);
 revision='v2';const changed=await catalog.prepare();assert.equal(reads,1);assert.equal(writes,1);assert.equal(changed.failed,0);assert.equal(changed.sharedFailed,1);assert.equal((await catalog.lookup('0000123456789')).match.product.pventa,0);
});

test('an existing local cache seeds the shared catalog once without rereading PDFs',async()=>{
 let stored={version:3,documents:[{id:'one',revision:'cipher',doc:{products:[{codigo:'0000123456789',ref:'A',descripcion:'Artículo',pventa:1}],salida:'9'}}]},reads=0,writes=0;
 const catalog=Catalog.create({snapshot:async()=>[{id:'one',encrypted_metadata:'cipher',metadata_revision:'a'.repeat(32)}],document:async()=>{reads++;throw new Error('No PDF read expected');},shared:{read:async()=>new Map(),write:async()=>{writes++;}},cache:{read:async()=>stored,write:async value=>stored=value},seal:async v=>v,unseal:async v=>v,verifyAccess:async()=>{}});
 assert.equal((await catalog.prepare()).cached,1);assert.equal(reads,0);assert.equal(writes,1);await catalog.prepare();assert.equal(writes,1);assert.equal(reads,0);
});
