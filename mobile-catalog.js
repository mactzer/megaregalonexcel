(function (root) {
  'use strict';
  function cache(key) {
    async function run(mode, action) {
      if (!root.indexedDB) return null;
      const db = await new Promise((resolve, reject) => {
        const request = root.indexedDB.open('megacontrol-encrypted-catalog', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('catalogs');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction('catalogs', mode);
          const request = action(transaction.objectStore('catalogs'));
          transaction.oncomplete = () => resolve(request.result);
          transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });
      } finally { db.close(); }
    }
    return { read: () => run('readonly', store => store.get(key)), write: value => run('readwrite', store => store.put(value, key)) };
  }
  function canonical(code) {
    code = String(code).trim();
    return /^\d{12}$/.test(code) ? '0' + code : code;
  }
  function create(client) {
    let products = new Map(), documents = [], failed = 0, prepared = false, generation = 0, revision = '';
    const signature = rows => JSON.stringify(rows.map(row => [row.id, row.created_at, row.encrypted_metadata]));
    const guard = (epoch, signal) => { if (epoch !== generation || (signal && signal.aborted)) throw new Error('Preparación cancelada.'); };
    function clear() { generation++; prepared = false; products.clear(); documents = []; failed = 0; revision = ''; }
    async function prepare(progress, signal) {
      clear();
      const epoch = generation;
      const snapshot = await client.snapshot(signal);
      guard(epoch, signal);
      let previous = [];
      try {
        const ciphertext = await client.cache.read(); guard(epoch, signal);
        if (ciphertext) {
          const payload = await client.unseal(ciphertext); guard(epoch, signal);
          if (payload.version === 1 && Array.isArray(payload.documents)) previous = payload.documents;
        }
      } catch (_) { guard(epoch, signal); }
      const cached = new Map(previous.map(entry => [entry.id, entry]));
      const results = new Array(snapshot.length);
      let next = 0, done = 0, errors = 0, reused = 0;
      async function worker() {
        while (next < snapshot.length) {
          const index = next++, row = snapshot[index];
          guard(epoch, signal);
          try {
            let entry = cached.get(row.id);
            if (entry && entry.revision === row.encrypted_metadata && entry.doc && Array.isArray(entry.doc.products) && (!row.created_at || entry.doc.date === row.created_at)) reused++;
            else entry = { id: row.id, revision: row.encrypted_metadata, doc: await client.document(row.id, signal) };
            guard(epoch, signal); results[index] = entry;
          } catch (_) { guard(epoch, signal); errors++; }
          done++;
          if (progress) progress({ done, total: snapshot.length, failed: errors, cached: reused });
        }
      }
      // Two workers keep PDF memory bounded on phones. Results retain server order.
      await Promise.all([worker(), worker()]); guard(epoch, signal);
      const index = new Map();
      for (const entry of results) if (entry) {
        for (const product of entry.doc.products) {
          const code = canonical(product.codigo);
          if (code && !index.has(code)) index.set(code, { product, doc: { salida: entry.doc.salida, date: entry.doc.date } });
        }
      }
      guard(epoch, signal); products = index; documents = results.filter(Boolean); failed = errors; prepared = true; revision = signature(snapshot);
      // Cache only authenticated ciphertext, never PDF bytes or clear product data.
      try {
        if (reused !== snapshot.length || previous.length !== snapshot.length) {
          const ciphertext = await client.seal({ version: 1, documents }); guard(epoch, signal);
          await client.cache.write(ciphertext); guard(epoch, signal);
        }
      } catch (_) { guard(epoch, signal); }
      return { products: products.size, documents: snapshot.length, failed, cached: reused };
    }
    async function lookup(code, signal) {
      const epoch = generation;
      if (!prepared) throw new Error('Prepara el índice antes de consultar productos.');
      await client.verifyAccess(signal); guard(epoch, signal);
      return { match: products.get(canonical(code)) || null, failed, documents: documents.length + failed };
    }
    async function hasUpdates(signal) {
      const epoch = generation;
      if (!prepared) return true;
      const rows = await client.snapshot(signal); guard(epoch, signal);
      return signature(rows) !== revision;
    }
    return Object.freeze({ prepare, lookup, clear, hasUpdates });
  }
  const api = Object.freeze({ create, cache, canonical });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
