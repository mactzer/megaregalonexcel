"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");
const AuditCrypto = require("../audit-crypto.js");
const encoder = new TextEncoder();
const keyA = "MEGA1." + AuditCrypto.encodeBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i));
const keyB = "MEGA1." + AuditCrypto.encodeBase64Url(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
test('product indexes separate prices from salida indexes, workspaces and keys',async()=>{
 const a=await AuditCrypto.unlock(keyA,'a'),b=await AuditCrypto.unlock(keyB,'a'),c=await AuditCrypto.unlock(keyA,'b');
 const tag=await a.productIndex('6900004248146');assert.match(tag,/^[a-f0-9]{64}$/);assert.equal(tag,await a.productIndex('6900004248146'));assert.notEqual(tag,await a.blindIndex('6900004248146'));assert.notEqual(tag,await b.productIndex('6900004248146'));assert.notEqual(tag,await c.productIndex('6900004248146'));
 for(const value of [null,undefined,{},NaN,Infinity,'','abc\x7f'])await assert.rejects(()=>a.productIndex(value));
 const data=await a.encrypt(encoder.encode(JSON.stringify({code:'6900004248146',cents:799})),`product-price-v1|${tag}|1`);
 await assert.rejects(()=>a.decrypt(data,`product-price-v1|${tag}|2`));await assert.rejects(()=>c.decrypt(data,`product-price-v1|${tag}|1`));
});

test("las claves generadas contienen 32 bytes aleatorios y son distintas", () => {
  const first = AuditCrypto.createRecoveryKey();
  const second = AuditCrypto.createRecoveryKey();
  assert.match(first, /^MEGA1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(AuditCrypto.decodeBase64Url(first.slice(6)).length, 32);
  assert.notEqual(first, second);
});

test("cifra y recupera sin cambios el contenido UTF-8 y todos los valores binarios", async () => {
  const unlocked = await AuditCrypto.unlock(keyA, "empresa-a");
  const text = encoder.encode("Salida 001234 — Eddie Rivera; descripción: muñeca, costo 10.00");
  const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (const bytes of [text, binary, new Uint8Array()]) {
    const encrypted = await unlocked.encrypt(bytes, "documento:123:pdf");
    assert.equal(encrypted[0], 1);
    assert.equal(encrypted.length, bytes.length + 29);
    assert.deepEqual(await unlocked.decrypt(encrypted.buffer, "documento:123:pdf"), bytes);
    if (bytes.length) assert.equal(Buffer.from(encrypted).includes(Buffer.from(bytes)), false);
  }
});

test("cada cifrado usa un IV diferente incluso para el mismo documento", async () => {
  const unlocked = await AuditCrypto.unlock(keyA, "empresa-a");
  const bytes = encoder.encode("El mismo PDF");
  const first = await unlocked.encrypt(bytes, "pdf");
  const second = await unlocked.encrypt(bytes, "pdf");
  assert.notDeepEqual(first.slice(1, 13), second.slice(1, 13));
  assert.notDeepEqual(first, second);
  assert.deepEqual(await unlocked.decrypt(first, "pdf"), bytes);
  assert.deepEqual(await unlocked.decrypt(second, "pdf"), bytes);
});

test("no descifra con otra clave, otro historial ni otro contexto", async () => {
  const [correct, wrongKey, wrongWorkspace] = await Promise.all([
    AuditCrypto.unlock(keyA, "empresa-a"), AuditCrypto.unlock(keyB, "empresa-a"),
    AuditCrypto.unlock(keyA, "empresa-b")
  ]);
  const encrypted = await correct.encrypt(encoder.encode("Documento confidencial"), "salida:123:pdf");
  await assert.rejects(wrongKey.decrypt(encrypted, "salida:123:pdf"), /No se pudo descifrar/);
  await assert.rejects(wrongWorkspace.decrypt(encrypted, "salida:123:pdf"), /No se pudo descifrar/);
  await assert.rejects(correct.decrypt(encrypted, "salida:123:excel"), /No se pudo descifrar/);
});

test("detecta alteraciones del IV, texto cifrado y etiqueta de autenticación", async () => {
  const unlocked = await AuditCrypto.unlock(keyA, "empresa-a");
  const encrypted = await unlocked.encrypt(encoder.encode("Contenido para comprobar integridad"), "pdf");
  for (const position of [1, 13, encrypted.length - 1]) {
    const tampered = encrypted.slice();
    tampered[position] ^= 1;
    await assert.rejects(unlocked.decrypt(tampered, "pdf"), /No se pudo descifrar/);
  }
  const futureVersion = encrypted.slice();
  futureVersion[0] = 2;
  await assert.rejects(unlocked.decrypt(futureVersion, "pdf"), /versión no es compatible/);
  await assert.rejects(unlocked.decrypt(encrypted.slice(0, 28), "pdf"), /incompleto/);
});

test("la búsqueda cifra el número de salida y conserva sus ceros iniciales", async () => {
  const [first, same, otherWorkspace, otherKey] = await Promise.all([
    AuditCrypto.unlock(keyA, "empresa-a"), AuditCrypto.unlock(keyA, "empresa-a"),
    AuditCrypto.unlock(keyA, "empresa-b"), AuditCrypto.unlock(keyB, "empresa-a")
  ]);
  const index = await first.blindIndex("001234");
  assert.match(index, /^[0-9a-f]{64}$/);
  assert.equal(index, await same.blindIndex("001234"));
  assert.notEqual(index, await first.blindIndex("1234"));
  assert.notEqual(index, await otherWorkspace.blindIndex("001234"));
  assert.notEqual(index, await otherKey.blindIndex("001234"));
  assert.equal(await first.blindIndex(1234), await first.blindIndex("1234"));
  for (const invalid of ["", "Salida 1234", " 1234 ", "1.2", "-1", "1".repeat(61), null]) {
    await assert.rejects(first.blindIndex(invalid), /entre 1 y 60 dígitos/);
  }
});

test("la huella identifica la clave dentro de un historial sin exponerla", async () => {
  const [first, same, otherWorkspace, otherKey] = await Promise.all([
    AuditCrypto.unlock(keyA, "empresa-a"), AuditCrypto.unlock(" \n" + keyA + "\t ", "empresa-a"),
    AuditCrypto.unlock(keyA, "empresa-b"), AuditCrypto.unlock(keyB, "empresa-a")
  ]);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.fingerprint, same.fingerprint);
  assert.notEqual(first.fingerprint, otherWorkspace.fingerprint);
  assert.notEqual(first.fingerprint, otherKey.fingerprint);
  assert.notEqual(first.fingerprint, await first.blindIndex("1234"));
});

test("rechaza contraseñas, claves incompletas y base64url no canónico", async () => {
  const wrongPadding = keyA.slice(0, -1) + "9";
  for (const invalid of ["MiPassword1234", keyA.slice(1), keyA.slice(0, -1), keyA + "=", wrongPadding, null, 123]) {
    await assert.rejects(AuditCrypto.unlock(invalid, "empresa-a"), /clave/);
  }
  for (const workspace of ["", " ", null, "a".repeat(257)]) {
    await assert.rejects(AuditCrypto.unlock(keyA, workspace), /historial compartido/);
  }
  for (const value of ["A", "Zg==", "Zh", "a b", "***"]) {
    assert.throws(() => AuditCrypto.decodeBase64Url(value), /base64url/);
  }
});

test("base64url conserva bytes de todos los tamaños y vistas con desplazamiento", () => {
  const source = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let length = 0; length <= source.length; length++) {
    const bytes = source.subarray(0, length);
    const encoded = AuditCrypto.encodeBase64Url(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(AuditCrypto.decodeBase64Url(encoded), bytes);
  }
  assert.deepEqual(AuditCrypto.decodeBase64Url(AuditCrypto.encodeBase64Url(source.subarray(7, 19))), source.subarray(7, 19));
});

test("la API avisa si falta WebCrypto", () => {
  const source = fs.readFileSync(require.resolve("../audit-crypto.js"), "utf8");
  const sandbox = { TextEncoder, Uint8Array, ArrayBuffer };
  vm.runInNewContext(source, sandbox);
  assert.throws(() => sandbox.AuditCrypto.createRecoveryKey(), /HTTPS o localhost/);
});

test("el navegador mantiene las claves en memoria sin acceder a almacenamiento persistente", async () => {
  const source = fs.readFileSync(require.resolve("../audit-crypto.js"), "utf8");
  let storageAccesses = 0;
  const sandbox = { TextEncoder, Uint8Array, ArrayBuffer, crypto: globalThis.crypto };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches"]) {
    Object.defineProperty(sandbox, name, { get() { storageAccesses++; throw new Error("No guardar secretos."); } });
  }
  vm.runInNewContext(source, sandbox);
  const recovery = sandbox.AuditCrypto.createRecoveryKey();
  const master = await sandbox.AuditCrypto.unlock(recovery, "empresa-a");
  const bytes = encoder.encode("Documento privado");
  const encrypted = await master.encrypt(bytes, "pdf");
  assert.deepEqual(await master.decrypt(encrypted, "pdf"), bytes);
  const user = await sandbox.AuditCrypto.unlockUser("eddie", "Frase Segura 1234", "empresa-a");
  assert.equal(await user.unwrapRecoveryKey(await user.wrapRecoveryKey(recovery)), recovery);
  assert.equal(storageAccesses, 0);
});

test("el formato AES-GCM y los índices son interoperables con primitivas independientes", async () => {
  const unlocked = await AuditCrypto.unlock(keyA, "empresa-a");
  assert.equal(await unlocked.blindIndex("001234"), "1f1719c701e9ca1dc5a4db6ceeb1639151449f8d934b6ec049824756ab94509e");
  assert.equal(unlocked.fingerprint, "57ebeacdb695d6929eacd1d81fca27d8d2ab93eb88d9f8ec6dd470d3fd1987dd");
  const bytes = encoder.encode("Contenido validado por Node/OpenSSL");
  const envelope = await unlocked.encrypt(bytes, "pdf");
  const aesKey = nodeCrypto.hkdfSync("sha256", Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
    Buffer.from("empresa-a"), Buffer.from("megaregalonexcel/audit/aes-gcm/v1"), 32);
  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", aesKey, envelope.slice(1, 13));
  decipher.setAAD(Buffer.from("empresa-a|pdf"));
  decipher.setAuthTag(envelope.slice(-16));
  const decrypted = Buffer.concat([decipher.update(envelope.slice(13, -16)), decipher.final()]);
  assert.deepEqual(new Uint8Array(decrypted), bytes);
});

test("el usuario normaliza mayúsculas y espacios externos, sin alterar la contraseña", async () => {
  assert.equal(AuditCrypto.normalizeUsername("  Eddie.Rivera "), "eddie.rivera");
  const [first, normalized, changedCase, changedWhitespace] = await Promise.all([
    AuditCrypto.unlockUser(" Eddie.Rivera ", "Frase Segura 1234", "empresa-a"),
    AuditCrypto.unlockUser("eddie.rivera", "Frase Segura 1234", "empresa-a"),
    AuditCrypto.unlockUser("eddie.rivera", "frase segura 1234", "empresa-a"),
    AuditCrypto.unlockUser("eddie.rivera", "Frase Segura 1234 ", "empresa-a")
  ]);
  assert.match(first.authPassword, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.authPassword, normalized.authPassword);
  assert.notEqual(first.authPassword, changedCase.authPassword);
  assert.notEqual(first.authPassword, changedWhitespace.authPassword);
});

test("cada usuario puede envolver y recuperar la clave compartida con IV fresco", async () => {
  const user = await AuditCrypto.unlockUser("eddie", "Mi frase larga de prueba 123", "empresa-a");
  const first = await user.wrapRecoveryKey(keyA);
  const second = await user.wrapRecoveryKey(keyA);
  assert.equal(first.length, 61);
  assert.notDeepEqual(first, second);
  assert.equal(Buffer.from(first).includes(Buffer.from(AuditCrypto.decodeBase64Url(keyA.slice(6)))), false);
  assert.equal(await user.unwrapRecoveryKey(first), keyA);
  assert.equal(await user.unwrapRecoveryKey(second.buffer), keyA);
});

test("la envoltura no abre con otra contraseña, usuario o equipo, ni si fue alterada", async () => {
  const [correct, wrongPassword, wrongUsername, wrongWorkspace] = await Promise.all([
    AuditCrypto.unlockUser("eddie", "Frase Segura 1234", "empresa-a"),
    AuditCrypto.unlockUser("eddie", "Otra frase Segura 1234", "empresa-a"),
    AuditCrypto.unlockUser("compañero".replace("ñ", "n"), "Frase Segura 1234", "empresa-a"),
    AuditCrypto.unlockUser("eddie", "Frase Segura 1234", "empresa-b")
  ]);
  const wrapped = await correct.wrapRecoveryKey(keyA);
  for (const wrong of [wrongPassword, wrongUsername, wrongWorkspace]) {
    assert.notEqual(correct.authPassword, wrong.authPassword);
    await assert.rejects(wrong.unwrapRecoveryKey(wrapped), /No se pudo abrir/);
  }
  const tampered = wrapped.slice();
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(correct.unwrapRecoveryKey(tampered), /No se pudo abrir/);
  await assert.rejects(correct.unwrapRecoveryKey(wrapped.slice(0, 28)), /No se pudo abrir/);
});

test("Auth recibe una derivación distinta a la clave AES que abre la envoltura", async () => {
  const password = "Frase Segura 1234";
  const username = "eddie";
  const workspace = "empresa-a";
  const user = await AuditCrypto.unlockUser(username, password, workspace);
  const material = nodeCrypto.pbkdf2Sync(password, "mega-audit:user:v1|empresa-a|eddie", 600000, 32, "sha256");
  const auth = Buffer.from(nodeCrypto.hkdfSync("sha256", material, Buffer.from(workspace), Buffer.from("mega-audit:user-auth:v1"), 32));
  const wrappingKey = Buffer.from(nodeCrypto.hkdfSync("sha256", material, Buffer.from(workspace), Buffer.from("mega-audit:user-wrap:v1"), 32));
  assert.equal(user.authPassword, auth.toString("base64url"));
  assert.notDeepEqual(auth, wrappingKey);
  const wrapped = await user.wrapRecoveryKey(keyA);
  const decryptWith = key => {
    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, wrapped.slice(1, 13));
    decipher.setAAD(Buffer.from("mega-audit:user-key:v1|empresa-a|eddie"));
    decipher.setAuthTag(wrapped.slice(-16));
    return Buffer.concat([decipher.update(wrapped.slice(13, -16)), decipher.final()]);
  };
  assert.deepEqual(new Uint8Array(decryptWith(wrappingKey)), AuditCrypto.decodeBase64Url(keyA.slice(6)));
  assert.throws(() => decryptWith(auth), /authenticate/);
});

test("rechaza usuarios inválidos, contraseñas cortas y claves de recuperación inválidas", async () => {
  for (const username of ["ed", "-eddie", "eddie_", "eddie.", "ed..die", "nombre apellido", "eddie@empresa.com", "niño", "a".repeat(33), null]) {
    assert.throws(() => AuditCrypto.normalizeUsername(username), /usuario/);
    await assert.rejects(AuditCrypto.unlockUser(username, "Frase Segura 1234", "empresa-a"), /usuario/);
  }
  for (const password of ["", "12345678901", null, "a".repeat(1025)]) {
    await assert.rejects(AuditCrypto.unlockUser("eddie", password, "empresa-a"), /contraseña/);
  }
  const user = await AuditCrypto.unlockUser("eddie", "Frase Segura 1234", "empresa-a");
  await assert.rejects(user.wrapRecoveryKey("contraseña"), /clave de recuperación/);
});
