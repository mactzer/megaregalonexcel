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
  const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  // Invoice dates are day/month/year, not timestamps in the upload timezone.
  function invoiceDate(value) {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value || ''));
    if (!match) return '';
    const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  function compareNumber(a, b) {
    a = /^\d+$/.test(a) ? a.replace(/^0+(?=\d)/, '') : '';
    b = /^\d+$/.test(b) ? b.replace(/^0+(?=\d)/, '') : '';
    return a.length - b.length || (a > b ? 1 : a < b ? -1 : 0);
  }
  function newestFirst(a, b) {
    const aSalida=(a.doc.kind||'salida')==='salida',bSalida=(b.doc.kind||'salida')==='salida';
    if(aSalida!==bSalida)return aSalida?-1:1;
    const aDate = a.doc.invoiceDate || '', bDate = b.doc.invoiceDate || '';
    return (aDate > bDate ? -1 : aDate < bDate ? 1 : 0) || compareNumber(b.doc.salida, a.doc.salida) || a.id.localeCompare(b.id);
  }
  function create(client) {
    let products = new Map(),references=new Map(),searchable=[],documents = [], failed = 0, unidentified=0,prepared = false, generation = 0, revision = '', checkedAt=null, checkFailed=false;
    const signature = rows => JSON.stringify(rows.map(row => [row.id, row.created_at, row.metadata_revision||row.encrypted_metadata]));
    const guard = (epoch, signal) => { if (epoch !== generation || (signal && signal.aborted)) throw new Error('Preparación cancelada.'); };
    function clear() { generation++; prepared = false; products.clear();references.clear();searchable=[]; documents = []; failed = 0;unidentified=0; revision = '';checkedAt=null;checkFailed=false; }
    async function prepare(progress, signal) {
      clear();
      const epoch = generation;
      const snapshot = await client.snapshot(signal);
      guard(epoch, signal);
      let previous = [], cacheVersion = 0;
      try {
        const ciphertext = await client.cache.read(); guard(epoch, signal);
        if (ciphertext) {
          const payload = await client.unseal(ciphertext); guard(epoch, signal);
          cacheVersion = payload.version;
          if (Array.isArray(payload.documents)) {
            if (payload.version === 3) previous = payload.documents;
            // Old Salidas caches may contain the report's print date. Re-read
            // those PDFs once; approved imports already use their invoice date.
            else if (payload.version === 2) previous = payload.documents.filter(entry => entry && entry.doc && entry.doc.reviewed && ['factura','pedido','otro'].includes(entry.doc.kind));
          }
        }
      } catch (_) { guard(epoch, signal); }
      const cached = new Map(previous.map(entry => [entry.id, entry]));
      let shared = new Map(), sharedCount=0, sharedFailed=0,sharedChanged=false;
      if(client.shared){
        const missing=snapshot.filter(row=>{const entry=cached.get(row.id);return !entry||entry.revision!==row.encrypted_metadata;});
        if(missing.length)try{shared=await client.shared.read(missing,signal);guard(epoch,signal);}catch(_){guard(epoch,signal);sharedFailed++;}
      }
      const results = new Array(snapshot.length);
      let next = 0, done = 0, errors = 0, reused = 0;
      async function worker() {
        while (next < snapshot.length) {
          const index = next++, row = snapshot[index];
          guard(epoch, signal);
          try {
            let entry = cached.get(row.id);
            if (entry && entry.revision === row.encrypted_metadata && entry.doc && Array.isArray(entry.doc.products) && (!row.created_at || entry.doc.date === row.created_at)) {
              reused++;
              if(client.shared&&row.metadata_revision&&entry.sharedRevision!==row.metadata_revision)try{await client.shared.write(row,entry.doc,signal);guard(epoch,signal);entry.sharedRevision=row.metadata_revision;sharedChanged=true;}catch(_){guard(epoch,signal);sharedFailed++;}
            }
            else if(shared.has(row.id)){entry={id:row.id,revision:row.encrypted_metadata,sharedRevision:row.metadata_revision,doc:shared.get(row.id)};sharedCount++;}
            else {
              entry = { id: row.id, revision: row.encrypted_metadata, doc: await client.document(row.id, signal) };
              guard(epoch,signal);
              if(client.shared)try{await client.shared.write(row,entry.doc,signal);guard(epoch,signal);entry.sharedRevision=row.metadata_revision;sharedChanged=true;}catch(_){guard(epoch,signal);sharedFailed++;}
            }
            guard(epoch, signal); results[index] = entry;
          } catch (_) { guard(epoch, signal); errors++; }
          done++;
          if (progress) progress({ done, total: snapshot.length, failed: errors, cached: reused,shared:sharedCount });
        }
      }
      // Two workers keep PDF memory bounded on phones; invoice headers determine order.
      await Promise.all([worker(), worker()]); guard(epoch, signal);
      const index = new Map(),refIndex=new Map();
      for (const entry of results) if (entry) {
        const seen = new Set();
        for (const product of entry.doc.products) {
          const code = canonical(product.codigo);
          const rowKey = JSON.stringify([code, product.pventa]);
          if ((!code&&!product.ref) || seen.has(rowKey+product.ref)) continue;
          seen.add(rowKey+product.ref);
          const item={id:entry.id,product,doc:{salida:entry.doc.salida,archiveSalida:entry.doc.archiveSalida,invoiceDate:entry.doc.invoiceDate||'',kind:entry.doc.kind||'salida',format:entry.doc.format||'',reviewed:entry.doc.reviewed||false}};
          if(code){if(!index.has(code))index.set(code,{history:[]});index.get(code).history.push(item);}
          if(product.ref){const r=String(product.ref).trim().toUpperCase();if(!refIndex.has(r))refIndex.set(r,{history:[]});refIndex.get(r).history.push(item);}
        }
      }
      // Sort during preparation, never download or sort PDFs when scanning.
      for (const match of [...index.values(),...refIndex.values()]) {
        match.history.sort(newestFirst);
        const selected = match.history[0];
        match.product = selected.product; match.doc = selected.doc;
        match.unverifiedDates = match.history.filter(row => !row.doc.invoiceDate).length;
        const sameInvoice = match.history.filter(row => row.doc.invoiceDate === selected.doc.invoiceDate && row.doc.kind===selected.doc.kind && (selected.doc.kind==='salida'?row.doc.salida===selected.doc.salida:true));
        match.conflictingPrices = sameInvoice.some(row => row.product.pventa !== selected.product.pventa);
        if (match.conflictingPrices) match.product = { ...selected.product, pventa: null };
      }
      for(const match of refIndex.values()){
        const codes=new Set(match.history.map(r=>canonical(r.product.codigo)).filter(Boolean));
        if(codes.size>1){match.ambiguousReference=true;match.product={...match.product,pventa:null};}
      }
      for(const match of index.values())if(refIndex.get(String(match.product.ref||'').trim().toUpperCase())?.ambiguousReference)match.product={...match.product,referenceAmbiguous:true};
      searchable=[...index.values(),...[...refIndex.values()].filter(match=>match.history.every(row=>!row.product.codigo))].map(match=>({match,text:searchText(match.product.descripcion)+' '+searchText(match.product.ref)}));
      guard(epoch, signal); products = index;references=refIndex; documents = results.filter(Boolean); failed = errors; prepared = true; revision = signature(snapshot);
      unidentified=documents.reduce((n,entry)=>n+entry.doc.products.filter(p=>!p.codigo&&!p.ref).length,0);
      checkedAt=new Date().toISOString();checkFailed=false;
      // Cache only authenticated ciphertext, never PDF bytes or clear product data.
      try {
        if (cacheVersion !== 3 || reused !== snapshot.length || previous.length !== snapshot.length || sharedChanged) {
          const ciphertext = await client.seal({ version: 3, documents }); guard(epoch, signal);
          await client.cache.write(ciphertext); guard(epoch, signal);
        }
      } catch (_) { guard(epoch, signal); }
      return { products: searchable.length, documents: snapshot.length, failed,unidentified, cached: reused,shared:sharedCount,sharedFailed,checkedAt };
    }
    async function lookup(code, signal, mode = 'barcode') {
      const epoch = generation;
      if (!prepared) throw new Error('Prepara el índice antes de consultar productos.');
      if (!['barcode','reference','name'].includes(mode)) throw new Error('Elige buscar por código de barras, referencia o nombre.');
      await client.verifyAccess(signal); guard(epoch, signal);
      if(mode==='name'){
        const terms=searchText(code).split(' ').filter(Boolean),all=searchable.filter(entry=>terms.length&&terms.every(term=>entry.text.includes(term)));
        return {match:null,candidates:all.slice(0,50).map(entry=>entry.match),candidateCount:all.length,failed,unidentified,documents:documents.length+failed,checkedAt,stale:checkFailed};
      }
      const match = mode === 'reference' ? references.get(String(code).trim().toUpperCase()) : products.get(canonical(code));
      return { match: match || null, failed,unidentified, documents: documents.length + failed,checkedAt,stale:checkFailed };
    }
    async function hasUpdates(signal) {
      const epoch = generation;
      if (!prepared) return true;
      try{const rows = await client.snapshot(signal,{light:true}); guard(epoch, signal);const changed=signature(rows)!==revision;checkFailed=changed;if(!changed)checkedAt=new Date().toISOString();return changed;}
      catch(error){checkFailed=true;throw error;}
    }
    return Object.freeze({ prepare, lookup, clear, hasUpdates });
  }
  const api = Object.freeze({ create, cache, canonical, invoiceDate });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
