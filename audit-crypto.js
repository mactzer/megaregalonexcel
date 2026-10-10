(function (root) {
  "use strict";

  const PREFIX = "MEGA1.";
  const VERSION = 1;
  const IV_LENGTH = 12;
  const TAG_LENGTH = 16;
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const encoder = new TextEncoder();

  function cryptoProvider() {
    if (!root.crypto || !root.crypto.subtle || typeof root.crypto.getRandomValues !== "function") {
      throw new Error("El cifrado necesita un navegador actualizado y una dirección HTTPS o localhost.");
    }
    return root.crypto;
  }

  function copyBytes(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    throw new Error("Los datos deben ser bytes (Uint8Array o ArrayBuffer).");
  }

  function encodeBase64Url(value) {
    const bytes = copyBytes(value);
    let result = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const remaining = bytes.length - i;
      const chunk = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      result += ALPHABET[(chunk >>> 18) & 63] + ALPHABET[(chunk >>> 12) & 63];
      if (remaining > 1) result += ALPHABET[(chunk >>> 6) & 63];
      if (remaining > 2) result += ALPHABET[chunk & 63];
    }
    return result;
  }

  function decodeBase64Url(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
      throw new Error("El texto base64url no es válido.");
    }
    const result = new Uint8Array(Math.floor(value.length * 6 / 8));
    let bits = 0;
    let accumulator = 0;
    let offset = 0;
    for (const character of value) {
      accumulator = (accumulator << 6) | ALPHABET.indexOf(character);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        result[offset++] = (accumulator >>> bits) & 255;
      }
    }
    // Los bits de relleno deben ser cero: una clave tiene una sola representación.
    if (encodeBase64Url(result) !== value) throw new Error("El texto base64url no es válido.");
    return result;
  }

  function parseRecoveryKey(value) {
    const key = typeof value === "string" ? value.trim() : "";
    if (!/^MEGA1\.[A-Za-z0-9_-]{43}$/.test(key)) {
      throw new Error("La clave de recuperación debe comenzar con MEGA1. y contener la clave completa generada por la aplicación.");
    }
    try {
      const bytes = decodeBase64Url(key.slice(PREFIX.length));
      if (bytes.length !== 32) throw new Error();
      return bytes;
    } catch (_) {
      throw new Error("La clave de recuperación no es válida. Copia la clave completa sin modificarla.");
    }
  }

  function createRecoveryKey() {
    const crypto = cryptoProvider();
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    try {
      return PREFIX + encodeBase64Url(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  function hex(value) {
    return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function validateWorkspace(workspaceId) {
    if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 256) {
      throw new Error("Falta el identificador del historial compartido o no es válido.");
    }
  }

  function normalizeUsername(value) {
    const username = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(username) || username.includes("..")) {
      throw new Error("El usuario debe tener entre 3 y 32 caracteres: letras sin acentos, números, punto, guion o guion bajo; debe comenzar y terminar con una letra o un número y no incluir puntos consecutivos.");
    }
    return username;
  }

  async function encryptEnvelope(crypto, key, data, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const cipher = await crypto.subtle.encrypt({
      name: "AES-GCM", iv, additionalData: aad, tagLength: TAG_LENGTH * 8
    }, key, data);
    const envelope = new Uint8Array(1 + IV_LENGTH + cipher.byteLength);
    envelope[0] = VERSION;
    envelope.set(iv, 1);
    envelope.set(new Uint8Array(cipher), 1 + IV_LENGTH);
    return envelope;
  }

  async function decryptEnvelope(crypto, key, envelope, aad) {
    if (envelope.length < 1 + IV_LENGTH + TAG_LENGTH || envelope[0] !== VERSION) {
      throw new Error("El documento cifrado está incompleto o su versión no es compatible.");
    }
    return new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM", iv: envelope.slice(1, 1 + IV_LENGTH),
      additionalData: aad, tagLength: TAG_LENGTH * 8
    }, key, envelope.slice(1 + IV_LENGTH)));
  }

  async function unlockUser(username, password, workspaceId) {
    const crypto = cryptoProvider();
    validateWorkspace(workspaceId);
    const normalizedUsername = normalizeUsername(username);
    if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
      throw new Error("La contraseña debe tener entre 12 y 1024 caracteres. Usa una frase larga y difícil de adivinar.");
    }
    const encodedPassword = encoder.encode(password);
    let passwordKey;
    try {
      passwordKey = await crypto.subtle.importKey("raw", encodedPassword, "PBKDF2", false, ["deriveBits"]);
    } finally {
      encodedPassword.fill(0);
    }
    const userSalt = encoder.encode("mega-audit:user:v1|" + workspaceId + "|" + normalizedUsername);
    const passwordMaterial = new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-256", salt: userSalt, iterations: 600000
    }, passwordKey, 256));
    let masterKey;
    try {
      masterKey = await crypto.subtle.importKey("raw", passwordMaterial, "HKDF", false, ["deriveKey", "deriveBits"]);
    } finally {
      passwordMaterial.fill(0);
    }
    const parameters = purpose => ({
      name: "HKDF", hash: "SHA-256", salt: encoder.encode(workspaceId),
      info: encoder.encode("mega-audit:user-" + purpose + ":v1")
    });
    // La credencial enviada a Auth y la clave privada de envoltura son derivaciones
    // independientes. Conocer authPassword no permite descifrar la clave del equipo.
    const [authMaterial, wrappingKey] = await Promise.all([
      crypto.subtle.deriveBits(parameters("auth"), masterKey, 256),
      crypto.subtle.deriveKey(parameters("wrap"), masterKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
    ]);
    const authBytes = new Uint8Array(authMaterial);
    let authPassword;
    try {
      authPassword = encodeBase64Url(authBytes);
    } finally {
      authBytes.fill(0);
    }
    const aad = encoder.encode("mega-audit:user-key:v1|" + workspaceId + "|" + normalizedUsername);

    async function wrapRecoveryKey(recoveryKey) {
      const secret = parseRecoveryKey(recoveryKey);
      try {
        return await encryptEnvelope(crypto, wrappingKey, secret, aad);
      } finally {
        secret.fill(0);
      }
    }

    async function unwrapRecoveryKey(value) {
      const envelope = copyBytes(value);
      let secret;
      try {
        secret = await decryptEnvelope(crypto, wrappingKey, envelope, aad);
        if (secret.length !== 32) throw new Error("Longitud de clave incorrecta.");
        return PREFIX + encodeBase64Url(secret);
      } catch (_) {
        throw new Error("No se pudo abrir la clave del historial. Revisa el usuario y la contraseña; la clave guardada también puede estar alterada.");
      } finally {
        if (secret) secret.fill(0);
      }
    }

    return Object.freeze({ authPassword, wrapRecoveryKey, unwrapRecoveryKey });
  }

  async function unlock(recoveryKey, workspaceId) {
    const crypto = cryptoProvider();
    validateWorkspace(workspaceId);
    const secret = parseRecoveryKey(recoveryKey);
    let masterKey;
    try {
      masterKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
    } finally {
      secret.fill(0);
    }
    const parameters = purpose => ({
      name: "HKDF", hash: "SHA-256", salt: encoder.encode(workspaceId),
      info: encoder.encode("megaregalonexcel/audit/" + purpose + "/v1")
    });
    const [encryptionKey, indexKey, fingerprintMaterial] = await Promise.all([
      crypto.subtle.deriveKey(parameters("aes-gcm"), masterKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
      crypto.subtle.deriveKey(parameters("hmac"), masterKey, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]),
      crypto.subtle.deriveBits(parameters("fingerprint"), masterKey, 256)
    ]);
    const fingerprintBytes = new Uint8Array(fingerprintMaterial);
    let fingerprint;
    try {
      fingerprint = hex(await crypto.subtle.digest("SHA-256", fingerprintBytes));
    } finally {
      fingerprintBytes.fill(0);
    }

    function additionalData(context) {
      if (typeof context !== "string" || !context.length || context.length > 1024) {
        throw new Error("Falta el contexto del documento cifrado o no es válido.");
      }
      return encoder.encode(workspaceId + "|" + context);
    }

    async function encrypt(value, context) {
      const data = copyBytes(value);
      const aad = additionalData(context);
      try {
        return await encryptEnvelope(crypto, encryptionKey, data, aad);
      } finally {
        data.fill(0);
      }
    }

    async function decrypt(value, context) {
      const envelope = copyBytes(value);
      const aad = additionalData(context);
      if (envelope.length < 1 + IV_LENGTH + TAG_LENGTH || envelope[0] !== VERSION) {
        throw new Error("El documento cifrado está incompleto o su versión no es compatible.");
      }
      try {
        return await decryptEnvelope(crypto, encryptionKey, envelope, aad);
      } catch (_) {
        throw new Error("No se pudo descifrar el documento. Comprueba la clave y el historial; el archivo también puede estar alterado.");
      }
    }

    async function blindIndex(salida) {
      const number = String(salida);
      if (!/^\d{1,60}$/.test(number)) {
        throw new Error("El número de salida debe contener entre 1 y 60 dígitos.");
      }
      return hex(await crypto.subtle.sign("HMAC", indexKey,
        encoder.encode("megaregalonexcel/audit/salida/v1|" + number)));
    }

    async function productIndex(code) {
      if (typeof code !== 'string' && !(typeof code === 'number' && Number.isFinite(code))) throw new Error('Código de producto inválido.');
      const value = String(code).trim();
      if (!value || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Código de producto inválido.');
      return hex(await crypto.subtle.sign('HMAC', indexKey, encoder.encode('megaregalonexcel/catalog/product/v1|' + value)));
    }
    async function documentIndex(value, movement) {
      const data = copyBytes(value);
      try {
        if (!data.length) throw new Error('Falta el PDF de la operación.');
        if (movement !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(movement)) throw new Error('Movimiento inválido.');
        const digest = hex(await crypto.subtle.digest('SHA-256', data));
        return hex(await crypto.subtle.sign('HMAC', indexKey, encoder.encode('megaregalonexcel/audit/document/v1|' + digest + (movement ? '|movement|' + movement : ''))));
      } finally { data.fill(0); }
    }
    return Object.freeze({ encrypt, decrypt, blindIndex, productIndex, documentIndex, fingerprint });
  }

  const api = Object.freeze({ createRecoveryKey, unlock, unlockUser, normalizeUsername, encodeBase64Url, decodeBase64Url });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AuditCrypto = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
