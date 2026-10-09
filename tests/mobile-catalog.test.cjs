'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Catalog = require('../mobile-catalog.js');

test('catalog indexes 100 documents once, preserves newest price and zeroes, reuses cache and imports only changed records', async () => {
  let reads = 0, access = 0, stored;
  let snapshot = Array.from({ length: 100 }, (_, i) => ({ id: String(i), encrypted_metadata: 'revision-' + i }));
  const client = {
    snapshot: async () => snapshot,
    document: async id => { reads++; return { products: [{ codigo: '0001234567890', pventa: Number(id) + 12 }, { codigo: String(1000000000000 + Number(id)) }], salida: id, date: '2026-10-09T00:00:00Z' }; },
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
