(function () {
  "use strict";

  const configured = window.SUPABASE_AUDIT_CONFIG;
  if (!configured || !configured.url || !configured.publishableKey || !configured.workspaceId ||
      document.documentElement.dataset.auditRequired === "true") return;

  const CONFIG = Object.freeze({
    url: String(configured.url).replace(/\/$/, ""),
    key: String(configured.publishableKey),
    workspace: String(configured.workspaceId).toLowerCase()
  });
  const PAGE_SIZE = 25;
  const FILE_LIMIT = 25 * 1024 * 1024;
  const BUCKET = "mega-audit-documents";
  const ALIAS_DOMAIN = "usuarios.megaregalonexcel.invalid";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let session = null;
  let member = null;
  let username = "";
  let master = null;
  let recoveryKey = null;
  let refreshPromise = null;
  let busyLogin = false;
  let pageGeneration = 0;
  let inlineHistory = false;
  let generation = 0;
  const pending = new Map();
  const pendingMembers = new Map();

  function node(tag, text, classes) {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = String(text);
    if (classes) value.className = classes;
    return value;
  }

  function button(text, secondary) {
    const value = node("button", text, "audit-button" + (secondary ? " audit-button-secondary" : ""));
    value.type = "button";
    return value;
  }

  function feedback(container, text, error) {
    const value = node("p", text, "audit-message " + (error ? "audit-error" : "audit-success"));
    value.setAttribute("role", error ? "alert" : "status");
    container.replaceChildren(value);
  }

  function errorText(error) {
    const message = error && error.message ? error.message : "";
    if (message === "No se pudo completar la operación con Supabase.") {
      const status = error && error.status ? " HTTP " + error.status : "";
      const code = error && typeof error.code === "string" ? error.code.replace(/[^a-z0-9_.-]/gi, "").slice(0, 64) : "sin_codigo";
      return "Supabase rechazó la operación (código " + (code || "sin_codigo") + status + "). Revisa que Email esté activado y que el usuario y la contraseña sean los de esta aplicación.";
    }
    return message || "No se pudo completar la operación. Inténtalo nuevamente.";
  }

  function field(form, labelText, name, type, options) {
    options = options || {};
    const wrapper = node("div", undefined, "audit-field");
    const label = node("label", labelText);
    const input = node("input");
    input.id = "audit-cloud-" + name;
    input.name = name;
    input.type = type || "text";
    input.required = options.required !== false;
    input.maxLength = type === "password" ? 1024 : 32;
    input.setAttribute("autocomplete", options.autocomplete || (type === "password" ? "current-password" : "username"));
    if (options.minLength) input.minLength = options.minLength;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.placeholder) input.placeholder = options.placeholder;
    label.htmlFor = input.id;
    wrapper.append(label, input);
    form.append(wrapper);
    return input;
  }

  function passwordToggle(form, inputs) {
    const label = node("label", undefined, "audit-cloud-password-toggle");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("change", function () {
      for (const input of inputs) input.type = checkbox.checked ? "text" : "password";
    });
    label.append(checkbox, document.createTextNode(" Mostrar contraseña"));
    form.append(label);
  }

  function bytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error("No se pudo preparar el documento para cifrarlo.");
  }

  function base64(value) {
    const data = bytes(value);
    const chunks = [];
    for (let index = 0; index < data.length; index += 32768) {
      chunks.push(String.fromCharCode.apply(null, data.subarray(index, index + 32768)));
    }
    return btoa(chunks.join(""));
  }

  function unbase64(value) {
    if (typeof value !== "string" || value.length > 72000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error("Los datos cifrados recibidos no son válidos.");
    }
    try {
      const raw = atob(value);
      return Uint8Array.from(raw, function (character) { return character.charCodeAt(0); });
    } catch (error) { throw new Error("Los datos cifrados recibidos no son válidos."); }
  }

  function validateConfiguration() {
    let url;
    try { url = new URL(CONFIG.url); } catch (error) { throw new Error("La URL de Supabase no está configurada correctamente."); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !UUID.test(CONFIG.workspace)) {
      throw new Error("La configuración de la auditoría no es válida. Revisa la guía de Supabase.");
    }
    if (!window.AuditCrypto || !window.crypto || !window.crypto.subtle) {
      throw new Error("Abre esta página mediante HTTPS en una versión actual de Chrome o Edge para usar el cifrado.");
    }
  }

  function status() {
    return {
      mode: "supabase",
      authenticated: Boolean(session && member && master),
      user: session && member && master ? { id: session.user.id, username, display_name: username, role: member.role } : null
    };
  }

  async function ready() {
    validateConfiguration();
    return status();
  }

  function clearSession() {
    generation++;
    session = null;
    member = null;
    username = "";
    master = null;
    recoveryKey = null;
    refreshPromise = null;
    pending.clear();
    pendingMembers.clear();
    renderAccountBar();
    renderAuditPage();
  }

  function acceptSession(result) {
    if (!result || typeof result.access_token !== "string" || typeof result.refresh_token !== "string" || !result.user || !UUID.test(result.user.id)) {
      throw new Error("No se pudo iniciar una sesión. Desactiva la confirmación por correo en Supabase y revisa la guía de configuración.");
    }
    return Object.assign({}, result, { expires_at: Date.now() / 1000 + Number(result.expires_in || 3600) });
  }

  async function refreshIfNeeded() {
    if (!session || session.expires_at > Date.now() / 1000 + 45) return;
    if (!refreshPromise) {
      const epoch = generation;
      const refreshToken = session.refresh_token;
      refreshPromise = request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: refreshToken }, anonymous: true }).then(function (result) {
        if (epoch !== generation || !session) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
        const refreshed = acceptSession(result);
        if (refreshed.user.id !== session.user.id || refreshed.user.email !== username + "@" + ALIAS_DOMAIN) {
          throw new Error("No se pudo verificar la sesión renovada. Inicia sesión nuevamente.");
        }
        session = refreshed;
      }).catch(function (error) {
        if (epoch === generation) clearSession();
        throw error;
      }).finally(function () { refreshPromise = null; });
    }
    await refreshPromise;
  }

  async function request(path, options) {
    options = options || {};
    if (!options.anonymous) {
      if (!session) throw new Error("Inicia sesión en la auditoría antes de continuar.");
      await refreshIfNeeded();
    }
    const headers = new Headers(options.headers || {});
    headers.set("apikey", CONFIG.key);
    if (options.anonymous) headers.delete("Authorization");
    else headers.set("Authorization", "Bearer " + session.access_token);
    let body;
    if (options.body !== undefined) {
      if (options.binary) {
        headers.set("Content-Type", "application/octet-stream");
        body = options.body;
      } else {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(options.body);
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 30000);
    let response;
    try {
      response = await fetch(CONFIG.url + path, {
        method: options.method || "GET", headers, body, signal: controller.signal,
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer"
      });
    } catch (error) {
      throw new Error("No se pudo conectar con Supabase. Comprueba tu conexión e inténtalo nuevamente; el Excel aún no se ha descargado.");
    } finally { clearTimeout(timeout); }
    if (!response.ok) {
      let detail = {};
      try { detail = await response.json(); } catch (error) {}
      const error = new Error("No se pudo completar la operación con Supabase.");
      error.status = response.status;
      error.code = detail.code || detail.error_code || detail.error;
      const authCode = typeof error.code === "string" ? error.code.toLowerCase() : "";
      const authDescription = [detail.error_description, detail.msg, detail.message]
        .filter(function (value) { return typeof value === "string"; })
        .join(" ").toLowerCase();
      if ((response.status === 404 && path.startsWith("/rest/")) || detail.code === "PGRST205" || detail.code === "42P01" || detail.code === "PGRST202") {
        error.message = "Configuración inicial pendiente. Revisa la guía de Supabase y ejecuta el archivo SQL de instalación.";
      } else if (response.status === 404 && path.startsWith("/storage/")) {
        error.message = "No se encontró el documento cifrado de esta salida. Solicita al administrador que revise el almacenamiento.";
      } else if (path.startsWith("/auth/") && (authCode === "invalid_credentials" || authCode === "invalid_grant" || /invalid login|invalid credential|invalid password|credentials/i.test(authDescription))) {
        error.message = "El usuario o la contraseña no coinciden. Respeta las mayúsculas y los espacios de la contraseña que creaste para esta versión.";
      } else if (authCode === "email_not_confirmed") {
        error.message = "La confirmación por correo está activada. Desactívala en Supabase según la guía: este acceso utiliza usuario y contraseña.";
      } else if (authCode === "signup_disabled" || authCode === "signup_not_allowed") {
        error.message = "Supabase tiene desactivado el registro de usuarios. Activa «Allow new users to sign up» en Authentication → Sign In / Providers → Email.";
      } else if (authCode === "email_address_invalid" || authCode === "email_address_not_authorized") {
        error.message = "Supabase rechazó el identificador interno. Comprueba que el proveedor Email esté activado y que Confirm email esté desactivado.";
      } else if (authCode === "user_already_exists" || authCode === "email_exists") {
        error.message = "Ese usuario ya existe. Usa otro nombre o su contraseña actual para darle acceso.";
      } else if (path.startsWith("/auth/") && authCode) {
        // A safe provider code is more useful than the old generic message, but
        // never expose the response body, password, token or internal URL.
        const safeCode = authCode.replace(/[^a-z0-9_.-]/g, "").slice(0, 64) || "desconocido";
        error.message = "Supabase rechazó la operación (código " + safeCode + ", HTTP " + response.status + "). Revisa la configuración de Authentication y vuelve a intentarlo.";
      } else if (response.status === 429) {
        error.message = "Se hicieron demasiados intentos. Espera unos minutos y vuelve a intentarlo.";
      } else if (response.status === 401 && !options.anonymous) {
        clearSession();
        error.message = "Tu sesión ha terminado. Inicia sesión nuevamente.";
      } else if (response.status === 403) {
        error.message = "Tu cuenta no tiene permiso para esta operación. Revisa su acceso a la auditoría.";
      } else if (typeof detail.message === "string" && /MEMBER_EXISTS|member already exists|ya tiene acceso/i.test(detail.message)) {
        error.message = "Ese usuario ya pertenece a la auditoría. Su cuenta y su clave se conservan.";
      } else if (path.startsWith("/auth/")) {
        // Some GoTrue versions return only `message` and omit `error_code`.
        // Keep the response useful without exposing its body or any secret.
        const safeCode = (authCode || "sin_codigo").replace(/[^a-z0-9_.-]/g, "").slice(0, 64) || "sin_codigo";
        error.message = "Supabase rechazó el inicio de sesión (código " + safeCode + ", HTTP " + response.status + "). Revisa el usuario, la contraseña y la configuración de Email.";
      }
      throw error;
    }
    if (options.raw) return response;
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch (error) { throw new Error("Supabase devolvió una respuesta inválida. Inténtalo nuevamente."); }
  }

  function rpc(name, args) {
    return request("/rest/v1/rpc/" + name, { method: "POST", body: args });
  }

  function ownQuery(table, columns) {
    return "/rest/v1/" + table + "?workspace_id=eq." + CONFIG.workspace + "&user_id=eq." + session.user.id + "&select=" + columns;
  }

  async function login(rawUsername, password) {
    validateConfiguration();
    const normalized = window.AuditCrypto.normalizeUsername(rawUsername);
    const userUnlock = await window.AuditCrypto.unlockUser(normalized, password, CONFIG.workspace);
    const result = await request("/auth/v1/token?grant_type=password", {
      method: "POST", anonymous: true,
      body: { email: normalized + "@" + ALIAS_DOMAIN, password: userUnlock.authPassword }
    });
    const verified = acceptSession(result);
    if (verified.user.email !== normalized + "@" + ALIAS_DOMAIN) throw new Error("No se pudo verificar el usuario de esta sesión.");
    session = verified;
    username = normalized;
    const epoch = ++generation;
    try {
      const membership = await request(ownQuery("mega_audit_members", "role"));
      if (!Array.isArray(membership) || membership.length !== 1 || !["admin", "user"].includes(membership[0].role)) {
        throw new Error("Tu cuenta está creada, pero aún no tiene acceso al historial. El administrador debe autorizarla; para la primera cuenta, sigue la guía de Supabase.");
      }
      member = membership[0];
      const workspaces = await request("/rest/v1/mega_audit_workspace?id=eq." + CONFIG.workspace + "&select=key_fingerprint");
      if (!Array.isArray(workspaces) || workspaces.length !== 1) throw new Error("No se encontró la auditoría configurada. Revisa la guía de Supabase.");
      let fingerprint = workspaces[0].key_fingerprint;
      if (!fingerprint) {
        if (member.role !== "admin") throw new Error("El administrador debe iniciar sesión una vez para preparar el cifrado del historial.");
        const key = window.AuditCrypto.createRecoveryKey();
        const unlocked = await window.AuditCrypto.unlock(key, CONFIG.workspace);
        const wrapped = await userUnlock.wrapRecoveryKey(key);
        await rpc("mega_audit_initialize_key", {
          p_workspace_id: CONFIG.workspace, p_key_fingerprint: unlocked.fingerprint, p_wrapped_key: base64(wrapped)
        });
        fingerprint = unlocked.fingerprint;
      }
      const keys = await request(ownQuery("mega_audit_user_keys", "wrapped_key"));
      if (!Array.isArray(keys) || keys.length !== 1) {
        throw new Error("Tu cuenta todavía no tiene la clave cifrada del historial. Solicita al administrador que complete tu acceso.");
      }
      let key;
      try { key = await userUnlock.unwrapRecoveryKey(unbase64(keys[0].wrapped_key)); }
      catch (error) { throw new Error("No se pudo desbloquear la clave cifrada de tu cuenta. Solicita ayuda al administrador; el historial se conserva."); }
      const unlocked = await window.AuditCrypto.unlock(key, CONFIG.workspace);
      if (unlocked.fingerprint !== fingerprint) throw new Error("La clave de esta cuenta no coincide con la auditoría. Solicita ayuda al administrador.");
      if (epoch !== generation || !session) throw new Error("La sesión cambió. Inténtalo nuevamente.");
      master = unlocked;
      recoveryKey = key;
      renderAccountBar();
      renderAuditPage();
      window.dispatchEvent(new CustomEvent("audit:authenticated", { detail: status() }));
    } catch (error) {
      if (epoch === generation) clearSession();
      throw error;
    }
  }

  async function signup(rawUsername, password) {
    validateConfiguration();
    const normalized = window.AuditCrypto.normalizeUsername(rawUsername);
    const unlock = await window.AuditCrypto.unlockUser(normalized, password, CONFIG.workspace);
    // Supabase exposes these settings without an authenticated session. Check
    // them before deriving/sending the signup request so an installation error
    // is actionable instead of appearing as a generic provider failure.
    let settings;
    try {
      settings = await request("/auth/v1/settings", { anonymous: true });
    } catch (error) {
      // Older GoTrue versions may not expose this endpoint. The signup request
      // still returns a specific provider error, so preserve compatibility.
      if (error.status !== 404) throw error;
    }
    if (settings && settings.external && settings.external.email === false) {
      throw new Error("Supabase tiene desactivado el proveedor Email. Actívalo en Authentication → Sign In / Providers → Email.");
    }
    if (settings && settings.disable_signup === true) {
      throw new Error("Supabase tiene desactivado el registro. Activa «Allow new users to sign up» en Authentication → Sign In / Providers → Email.");
    }
    if (settings && settings.mailer_autoconfirm === false) {
      throw new Error("Supabase está esperando confirmación por correo. Desactiva «Confirm email»: este acceso usa usuario y contraseña y no envía correos reales.");
    }
    const result = await request("/auth/v1/signup", {
      method: "POST", anonymous: true,
      body: { email: normalized + "@" + ALIAS_DOMAIN, password: unlock.authPassword }
    });
    if (result && result.user && !result.access_token) {
      throw new Error("Supabase creó la cuenta, pero exige confirmar un correo. Desactiva «Confirm email» en Authentication y después inicia sesión con el usuario y la contraseña que acabas de crear.");
    }
    const verified = acceptSession(result);
    if (verified.user.email !== normalized + "@" + ALIAS_DOMAIN) throw new Error("No se pudo verificar la cuenta creada. Revisa la configuración de acceso.");
    return { username: normalized, unlock, userId: verified.user.id };
  }

  async function createMember(rawUsername, password, role) {
    if (!status().authenticated || member.role !== "admin") throw new Error("Inicia sesión como administrador para crear usuarios.");
    const epoch = generation;
    let created;
    try { created = await signup(rawUsername, password); }
    catch (error) {
      if (!["user_already_exists", "email_exists"].includes(error.code)) throw error;
      const normalized = window.AuditCrypto.normalizeUsername(rawUsername);
      created = { username: normalized, unlock: await window.AuditCrypto.unlockUser(normalized, password, CONFIG.workspace) };
    }
    // Verifica la contraseña del usuario sin reemplazar la sesión administradora.
    const targetResult = await request("/auth/v1/token?grant_type=password", {
      method: "POST", anonymous: true,
      body: { email: created.username + "@" + ALIAS_DOMAIN, password: created.unlock.authPassword }
    });
    const target = acceptSession(targetResult);
    if (target.user.email !== created.username + "@" + ALIAS_DOMAIN ||
        (created.userId && target.user.id !== created.userId)) {
      throw new Error("No se pudo verificar la cuenta del compañero.");
    }
    if (epoch !== generation || !recoveryKey) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
    const roleValue = role === "admin" ? "admin" : "user";
    let previous = pendingMembers.get(created.username);
    if (previous && (previous.authPassword !== created.unlock.authPassword || previous.role !== roleValue || previous.userId !== target.user.id)) {
      throw new Error("Hay un intento pendiente para este usuario. Usa la misma contraseña y los mismos permisos para reintentarlo.");
    }
    if (!previous) {
      previous = {
        authPassword: created.unlock.authPassword, role: roleValue, userId: target.user.id,
        wrapped: base64(await created.unlock.wrapRecoveryKey(recoveryKey))
      };
      pendingMembers.set(created.username, previous);
    }
    if (epoch !== generation) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
    const added = await rpc("mega_audit_add_member", {
      p_workspace_id: CONFIG.workspace, p_username: created.username,
      p_wrapped_key: previous.wrapped, p_role: roleValue
    });
    if (!added || added.user_id !== target.user.id || added.username !== created.username || added.role !== roleValue) {
      throw new Error("No se pudo confirmar el acceso del usuario. Repite el intento con la misma contraseña y permisos.");
    }
    pendingMembers.delete(created.username);
  }

  function newIdempotencyKey() {
    if (!window.crypto || !window.crypto.getRandomValues) throw new Error("Actualiza tu navegador para usar la auditoría.");
    if (typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    const value = new Uint8Array(16);
    window.crypto.getRandomValues(value);
    value[6] = (value[6] & 15) | 64;
    value[8] = (value[8] & 63) | 128;
    const hex = Array.from(value, function (item) { return item.toString(16).padStart(2, "0"); }).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  function recordPath(record, kind) {
    if (!record || !UUID.test(record.id) || !UUID.test(record.created_by)) throw new Error("El registro recibido no es válido.");
    return CONFIG.workspace + "/" + record.created_by + "/" + record.id + "/" + kind + ".bin";
  }

  async function decryptedRecord(record, key) {
    if (!record || !UUID.test(record.id) || !UUID.test(record.created_by) || record.workspace_id !== CONFIG.workspace) {
      throw new Error("El registro recibido no pertenece a esta auditoría.");
    }
    const clear = await (key || master).decrypt(unbase64(record.encrypted_metadata), record.id + "|metadata");
    let metadata;
    try { metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear)); }
    catch (error) { throw new Error("No se pudo leer la información de una salida cifrada."); }
    if (!metadata || !/^\d{1,60}$/.test(String(metadata.salida_numero)) || !Number.isInteger(metadata.row_count) ||
        metadata.row_count < 0 || !Number.isFinite(metadata.total_units) || metadata.total_units < 0 ||
        typeof metadata.username !== "string" || typeof metadata.pdf_name !== "string" || typeof metadata.excel_name !== "string") {
      throw new Error("La información cifrada de una salida no es válida.");
    }
    return Object.assign({}, metadata, { id: record.id, created_by: record.created_by, created_at: record.created_at, workspace_id: record.workspace_id });
  }

  async function getDocument(record, kind, key) {
    if (!["pdf", "excel"].includes(kind)) throw new Error("Documento no válido.");
    const response = await request("/storage/v1/object/authenticated/" + BUCKET + "/" + recordPath(record, kind), { raw: true });
    const length = Number(response.headers.get("Content-Length"));
    if (length > FILE_LIMIT + 64) throw new Error("El documento guardado excede el tamaño permitido.");
    const encrypted = new Uint8Array(await response.arrayBuffer());
    if (encrypted.length > FILE_LIMIT + 64) throw new Error("El documento guardado excede el tamaño permitido.");
    try { return await (key || master).decrypt(encrypted, record.id + "|" + kind); }
    catch (error) { throw new Error("No se pudo verificar ni descifrar este documento. Solicita al administrador que revise el archivo guardado."); }
  }

  function equalBytes(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
    return difference === 0;
  }

  async function putDocument(path, ciphertext) {
    try {
      await request("/storage/v1/object/" + BUCKET + "/" + path, { method: "POST", binary: true, body: ciphertext });
    } catch (error) {
      if (error.status !== 409 && error.code !== "Duplicate" && error.code !== "ResourceAlreadyExists") throw error;
      const response = await request("/storage/v1/object/authenticated/" + BUCKET + "/" + path, { raw: true });
      const existing = new Uint8Array(await response.arrayBuffer());
      if (!equalBytes(existing, ciphertext)) throw new Error("Ya existe otro documento para este intento. No se ha sobrescrito; vuelve a cargar el PDF para generar una salida nueva.");
    }
  }

  async function prepareRecord(options, id, key, owner) {
    const number = String(options.salidaNumero);
    if (!/^\d{1,60}$/.test(number)) throw new Error("Ingresa un número de salida válido antes de descargar.");
    if (!options.pdfFile || typeof options.pdfFile.arrayBuffer !== "function") throw new Error("Vuelve a cargar el PDF original antes de descargar.");
    const excel = bytes(options.excelBytes);
    if (options.pdfFile.size > FILE_LIMIT || excel.length > FILE_LIMIT) throw new Error("La auditoría admite hasta 25 MB por documento.");
    if (!Number.isInteger(options.rowCount) || options.rowCount < 0 || !Number.isFinite(options.totalUnits) || options.totalUnits < 0) {
      throw new Error("Las cantidades de esta salida no son válidas.");
    }
    const pdf = new Uint8Array(await options.pdfFile.arrayBuffer());
    if (pdf.length > FILE_LIMIT) throw new Error("La auditoría admite hasta 25 MB por documento.");
    const metadata = {
      salida_numero: number, pdf_name: String(options.pdfFile.name || "Documento.pdf"), excel_name: "Salida " + number + ".xlsx",
      row_count: options.rowCount, total_units: options.totalUnits, username, user_display_name: username
    };
    const payload = new TextEncoder().encode(JSON.stringify(metadata));
    const encrypted = await Promise.all([
      key.encrypt(payload, id + "|metadata"), key.encrypt(pdf, id + "|pdf"), key.encrypt(excel, id + "|excel"), key.blindIndex(number)
    ]);
    return { id, owner, metadata, pdf, excel: new Uint8Array(excel), encryptedMetadata: base64(encrypted[0]), encryptedPdf: encrypted[1], encryptedExcel: encrypted[2], tag: encrypted[3] };
  }

  async function record(options) {
    const account = await ready();
    if (!account.authenticated) {
      const input = document.getElementById("audit-cloud-login-username");
      if (input) input.focus();
      throw new Error("Inicia sesión en la auditoría antes de descargar el Excel.");
    }
    const id = String(options.idempotencyKey || newIdempotencyKey()).toLowerCase();
    if (!UUID.test(id)) throw new Error("El identificador de esta descarga no es válido. Vuelve a cargar el PDF.");
    const epoch = generation;
    const key = master;
    const owner = session.user.id;
    let snapshot = pending.get(id);
    if (!snapshot) {
      pending.clear();
      snapshot = await prepareRecord(options, id, key, owner);
      if (epoch !== generation) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
      pending.set(id, snapshot);
    } else if (snapshot.owner !== owner || snapshot.metadata.salida_numero !== String(options.salidaNumero)) {
      throw new Error("Este intento corresponde a otra cuenta o salida. Vuelve a cargar el PDF.");
    }
    const previous = await request("/rest/v1/mega_audit_records?workspace_id=eq." + CONFIG.workspace + "&id=eq." + id + "&select=*");
    if (!Array.isArray(previous)) throw new Error("Supabase devolvió un registro inválido.");
    let saved;
    if (previous.length) {
      if (previous.length !== 1 || previous[0].created_by !== owner) throw new Error("Este identificador ya pertenece a otro registro. Vuelve a cargar el PDF.");
      saved = await decryptedRecord(previous[0], key);
      for (const name of ["salida_numero", "pdf_name", "excel_name", "row_count", "total_units", "username"]) {
        if (saved[name] !== snapshot.metadata[name]) throw new Error("Este intento ya contiene otra salida. No se ha sobrescrito.");
      }
      const documents = await Promise.all([getDocument(previous[0], "pdf", key), getDocument(previous[0], "excel", key)]);
      if (!equalBytes(documents[0], snapshot.pdf) || !equalBytes(documents[1], snapshot.excel)) {
        throw new Error("Los documentos de este intento ya son distintos. No se han sobrescrito.");
      }
    } else {
      const row = { id, created_by: owner };
      await putDocument(recordPath(row, "pdf"), snapshot.encryptedPdf);
      if (epoch !== generation) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
      await putDocument(recordPath(row, "excel"), snapshot.encryptedExcel);
      if (epoch !== generation) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
      let result = await rpc("mega_audit_record", {
        p_id: id, p_workspace_id: CONFIG.workspace, p_salida_tag: snapshot.tag,
        p_encrypted_metadata: snapshot.encryptedMetadata, p_idempotency_key: id
      });
      if (Array.isArray(result) && result.length === 1) result = result[0];
      if (!result || result.id !== id || result.created_by !== owner || result.encrypted_metadata !== snapshot.encryptedMetadata) {
        throw new Error("No se pudo confirmar esta salida. Reintenta la descarga; no se creará un duplicado.");
      }
      saved = await decryptedRecord(result, key);
    }
    if (epoch !== generation) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
    saved.username = username;
    saved.user_display_name = username;
    pending.delete(id);
    window.dispatchEvent(new CustomEvent("audit:recorded", { detail: saved }));
    return saved;
  }

  function saveBlob(data, name, mime) {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const link = node("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function renderAccountBar() {
    const bar = document.getElementById("audit-bar");
    if (!bar) return;
    const panel = node("section", undefined, "audit-panel audit-cloud-panel");
    if (status().authenticated) {
      const account = node("div", undefined, "audit-account");
      const text = node("div");
      text.append(node("strong", "@" + username + (member.role === "admin" ? " · Administrador" : ""), "audit-account-name"));
      text.append(node("span", "Auditoría compartida · los documentos se cifran en este navegador antes de subirse.", "audit-muted"));
      const actions = node("div", undefined, "audit-actions");
      if (!document.body.classList.contains("audit-document")) {
        const history = button(inlineHistory ? "Ocultar historial" : "Historial compartido", true);
        history.addEventListener("click", function () {
          inlineHistory = !inlineHistory;
          let page = document.getElementById("audit-page");
          if (!page) {
            page = node("div");
            page.id = "audit-page";
            bar.after(page);
          }
          page.hidden = !inlineHistory;
          renderAccountBar();
          renderAuditPage();
          if (inlineHistory) page.scrollIntoView({ block: "start", behavior: "smooth" });
        });
        actions.append(history);
      }
      let adminToggle = null;
      if (member.role === "admin") {
        adminToggle = button("Administrar usuarios", true);
        adminToggle.setAttribute("aria-expanded", "false");
        adminToggle.setAttribute("aria-controls", "audit-admin-panel");
        actions.append(adminToggle);
      }
      const logout = button("Cerrar sesión", true);
      logout.addEventListener("click", async function () {
        logout.disabled = true;
        try { await request("/auth/v1/logout", { method: "POST", body: {} }); }
        catch (error) { /* Las claves y la sesión local se eliminan incluso sin conexión. */ }
        finally { clearSession(); }
      });
      actions.append(logout);
      account.append(text, actions);
      panel.append(account);
      if (member.role === "admin") {
        const note = node("div", undefined, "audit-cloud-recovery");
        note.append(node("span", "Guarda una copia privada de la clave de recuperación fuera de la nube. Permite descifrar todo el historial.", "audit-muted"));
        const download = button("Guardar clave de recuperación", true);
        download.addEventListener("click", function () {
          if (!status().authenticated || member.role !== "admin" || !recoveryKey) return;
          saveBlob("CLAVE PRIVADA DE RECUPERACIÓN — AUDITORÍA\nNo la compartas ni la subas a GitHub o Supabase. Permite descifrar el historial completo.\n\nAuditoría: " + CONFIG.workspace + "\n\n" + recoveryKey + "\n", "Clave de recuperación auditoría.txt", "text/plain;charset=utf-8");
        });
        note.append(download);
        panel.append(note);
        const adminDetails = renderUserManagement(panel);
        adminDetails.id = "audit-admin-panel";
        adminDetails.hidden = true;
        adminToggle.addEventListener("click", function () {
          const open = adminDetails.hidden;
          adminDetails.hidden = !open;
          adminDetails.open = open;
          adminToggle.setAttribute("aria-expanded", open ? "true" : "false");
          adminToggle.textContent = open ? "Ocultar usuarios" : "Administrar usuarios";
          if (open) adminDetails.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      }
    } else {
      panel.append(node("h2", "Inicia sesión en la auditoría"));
      panel.append(node("p", "Acceso con usuario y contraseña. No necesitas correo. Al recargar la página, inicia sesión otra vez para desbloquear tus documentos.", "audit-muted"));
      const form = node("form", undefined, "audit-form audit-cloud-form");
      const name = field(form, "Usuario", "login-username", "text", { minLength: 3 });
      const password = field(form, "Contraseña", "login-password", "password");
      const submit = button("Iniciar sesión");
      submit.type = "submit";
      form.append(submit);
      passwordToggle(form, [password]);
      const result = node("div");
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (busyLogin) return;
        busyLogin = true;
        submit.disabled = true;
        feedback(result, "Comprobando acceso y desbloqueando el historial…", false);
        try { await login(name.value, password.value); }
        catch (error) {
          feedback(result, errorText(error), true);
          // clearSession reconstruye el formulario; conserva el aviso en el formulario visible.
          const visible = document.querySelector("#audit-bar .audit-cloud-login-feedback");
          if (visible && visible !== result) feedback(visible, errorText(error), true);
          const visibleName = document.getElementById("audit-cloud-login-username");
          if (visibleName && visibleName !== name) visibleName.value = name.value;
        } finally {
          password.value = "";
          busyLogin = false;
          submit.disabled = false;
        }
      });
      result.className = "audit-cloud-login-feedback";
      panel.append(form, result);
      const signupDetails = node("details", undefined, "audit-cloud-signup");
      signupDetails.append(node("summary", "Crear mi cuenta"));
      const createForm = node("form", undefined, "audit-form audit-cloud-form");
      const newUsername = field(createForm, "Usuario nuevo", "signup-username", "text", { minLength: 3, autocomplete: "off" });
      const newPassword = field(createForm, "Contraseña nueva", "signup-password", "password", { minLength: 12, autocomplete: "new-password" });
      const repeatPassword = field(createForm, "Repite la contraseña", "signup-repeat", "password", { minLength: 12, autocomplete: "new-password" });
      const create = button("Crear cuenta");
      create.type = "submit";
      createForm.append(create);
      passwordToggle(createForm, [newPassword, repeatPassword]);
      const createFeedback = node("div");
      createForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (newPassword.value !== repeatPassword.value) {
          feedback(createFeedback, "Las contraseñas no coinciden. Usa «Mostrar contraseña» para revisarlas.", true);
          return;
        }
        create.disabled = true;
        feedback(createFeedback, "Creando la cuenta…", false);
        try {
          const created = await signup(newUsername.value, newPassword.value);
          name.value = created.username;
          createForm.reset();
          feedback(createFeedback, "Cuenta @" + created.username + " creada. El administrador debe darle acceso al historial. Si es la primera cuenta, sigue el paso «Administrador inicial» de la guía de Supabase.", false);
          const setup = node("a", "Configurar la primera cuenta administradora", "audit-cloud-setup-link");
          setup.href = "supabase-setup.html?user=" + encodeURIComponent(created.userId) + "&username=" + encodeURIComponent(created.username);
          createFeedback.append(setup, node("p", "Este paso requiere acceso al panel del proyecto Supabase y solo corresponde al propietario que realiza la instalación inicial.", "audit-muted"));
        } catch (error) { feedback(createFeedback, errorText(error), true); }
        finally { create.disabled = false; }
      });
      signupDetails.append(node("p", "Usa de 3 a 32 caracteres: letras sin acentos, números, punto, guion o guion bajo. La contraseña debe tener al menos 12 caracteres.", "audit-muted"), createForm, createFeedback);
      panel.append(signupDetails);
    }
    bar.replaceChildren(panel);
    const privacy = document.querySelector(".privacy-note");
    if (privacy) {
      const dot = node("span", undefined, "privacy-dot");
      dot.setAttribute("aria-hidden", "true");
      privacy.replaceChildren(dot, document.createTextNode("Conversión local · auditoría cifrada en Supabase"));
    }
  }

  function formatWhen(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return { date: "Fecha no disponible", time: "" };
    const fields = Object.fromEntries(new Intl.DateTimeFormat("es-PA", {
      timeZone: "America/Panama", day: "2-digit", month: "2-digit", year: "numeric"
    }).formatToParts(date).map(function (part) { return [part.type, part.value]; }));
    return {
      date: fields.day + "/" + fields.month + "/" + fields.year,
      time: new Intl.DateTimeFormat("es-PA", { timeZone: "America/Panama", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date)
    };
  }

  function documentButton(record, kind, label, result) {
    const download = button(label, true);
    download.classList.add("audit-button-small");
    download.addEventListener("click", async function () {
      download.disabled = true;
      result.replaceChildren();
      const epoch = generation;
      const key = master;
      try {
        if (!status().authenticated) throw new Error("Inicia sesión nuevamente para abrir los documentos.");
        const clear = await getDocument(record, kind, key);
        if (epoch !== generation) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
        saveBlob(clear, kind === "pdf" ? record.pdf_name : record.excel_name, kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      } catch (error) { feedback(result, errorText(error), true); }
      finally { download.disabled = false; }
    });
    return download;
  }

  function renderAuditPage() {
    const page = document.getElementById("audit-page");
    if (!page) return;
    const pageEpoch = ++pageGeneration;
    page.replaceChildren();
    if (!status().authenticated || page.hidden) return;
    const panel = node("section", undefined, "audit-panel");
    panel.append(node("h2", "Historial de salidas"));
    panel.append(node("p", "Busca por número, filtra por fecha y abre el PDF o el Excel original. La fecha y la hora las registra Supabase; los documentos se descifran únicamente en tu navegador.", "audit-muted"));
    const overview = node("div", undefined, "audit-stats");
    function stat(label, value) {
      const card = node("div", undefined, "audit-stat");
      const number = node("strong", value, "audit-stat-value");
      card.append(number, node("span", label, "audit-stat-label"));
      overview.append(card);
      return number;
    }
    const totalStat = stat("Salidas encontradas", "—");
    const unitsStat = stat("Unidades visibles", "—");
    const latestStat = stat("Última fecha", "—");
    panel.append(overview);
    const form = node("form", undefined, "audit-form audit-search");
    const search = field(form, "Número de salida", "search", "search", { required: false, maxLength: 60, placeholder: "Ejemplo: 29307", autocomplete: "off" });
    search.parentElement.classList.add("audit-field-wide");
    const from = field(form, "Desde", "from", "date", { required: false, autocomplete: "off" });
    const to = field(form, "Hasta", "to", "date", { required: false, autocomplete: "off" });
    const submit = button("Buscar");
    submit.type = "submit";
    const clear = button("Ver todas", true);
    const refresh = button("Actualizar", true);
    form.append(submit, clear, refresh);
    const result = node("div");
    const recordsArea = node("div");
    panel.append(form, result, recordsArea);
    page.append(panel);
    let query = "";
    let fromValue = "";
    let toValue = "";
    let pageNumber = 1;
    let loadGeneration = 0;
    async function loadRecords() {
      const sequence = ++loadGeneration;
      const epoch = generation;
      const key = master;
      result.replaceChildren();
      recordsArea.replaceChildren(node("p", "Cargando y descifrando el historial…", "audit-state"));
      totalStat.textContent = unitsStat.textContent = latestStat.textContent = "—";
      submit.disabled = clear.disabled = refresh.disabled = true;
      try {
        let path = "/rest/v1/mega_audit_records?workspace_id=eq." + CONFIG.workspace + "&select=*&order=created_at.desc,id.desc&limit=" + PAGE_SIZE + "&offset=" + ((pageNumber - 1) * PAGE_SIZE);
        if (query) path += "&salida_tag=eq." + await key.blindIndex(query);
        if (fromValue) path += "&created_at=gte." + encodeURIComponent(fromValue + "T00:00:00-05:00");
        if (toValue) {
          const end = new Date(toValue + "T00:00:00-05:00");
          end.setUTCDate(end.getUTCDate() + 1);
          path += "&created_at=lt." + encodeURIComponent(end.toISOString());
        }
        const responses = await Promise.all([
          request(path, { headers: { Prefer: "count=exact" }, raw: true }),
          rpc("mega_audit_authors", { p_workspace_id: CONFIG.workspace })
        ]);
        const response = responses[0];
        const authors = responses[1];
        if (!Array.isArray(authors)) throw new Error("No se pudo verificar quién generó cada salida.");
        const authorNames = new Map(authors.filter(function (author) {
          return author && UUID.test(author.user_id) && typeof author.username === "string";
        }).map(function (author) { return [author.user_id, author.username]; }));
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error("El historial recibido no es válido.");
        const outcomes = await Promise.allSettled(rows.map(function (record) { return decryptedRecord(record, key); }));
        if (epoch !== generation || pageEpoch !== pageGeneration || sequence !== loadGeneration) return;
        const decoded = outcomes.filter(function (outcome) { return outcome.status === "fulfilled"; }).map(function (outcome) { return outcome.value; });
        const range = response.headers.get("Content-Range") || "";
        const count = /\/(\d+)$/.exec(range);
        const total = count ? Number(count[1]) : rows.length;
        totalStat.textContent = String(total);
        unitsStat.textContent = decoded.reduce(function (sum, record) { return sum + (Number(record.total_units) || 0); }, 0).toLocaleString("es-PA", { maximumFractionDigits: 2 });
        latestStat.textContent = decoded.length ? formatWhen(decoded[0].created_at).date : "—";
        recordsArea.replaceChildren();
        if (!rows.length) {
          const filtered = query || fromValue || toValue;
          recordsArea.append(node("p", filtered ? "No hay salidas con los filtros indicados." : "Todavía no hay salidas registradas. Descarga un Excel en el conversor para crear el primer registro.", "audit-empty"));
        } else {
          const wrap = node("div", undefined, "audit-table-wrap");
          const table = node("table", undefined, "audit-table");
          const head = node("thead");
          const header = node("tr");
          for (const title of ["Salida", "Generada por", "Fecha y hora (Panamá)", "Productos / unidades", "Documentos"]) {
            const cell = node("th", title);
            cell.scope = "col";
            header.append(cell);
          }
          head.append(header);
          const body = node("tbody");
          let failedRows = 0;
          for (let index = 0; index < outcomes.length; index++) {
            const outcome = outcomes[index];
            if (outcome.status !== "fulfilled") {
              failedRows++;
              const opaque = rows[index] || {};
              const row = node("tr", undefined, "audit-cloud-unreadable");
              const label = node("td", "No se pudo descifrar esta salida");
              label.append(node("span", String(opaque.id || "Identificador no válido"), "audit-muted"));
              const officialName = authorNames.get(opaque.created_by);
              const when = formatWhen(opaque.created_at);
              row.append(label, node("td", officialName ? "@" + officialName : String(opaque.created_by || "Autor no disponible")), node("td", when.date + " " + when.time), node("td", "No disponible"), node("td", "Documento no verificado"));
              body.append(row);
              continue;
            }
            const record = outcome.value;
            const row = node("tr");
            const salida = node("td");
            salida.append(node("strong", "Salida " + record.salida_numero));
            const officialName = authorNames.get(record.created_by);
            const user = node("td", officialName ? "@" + officialName : record.created_by);
            user.title = "Autor registrado por Supabase: " + record.created_by;
            const when = formatWhen(record.created_at);
            const time = node("td", when.date, "audit-number");
            time.append(node("span", when.time, "audit-muted"));
            const quantities = node("td", record.row_count + " productos", "audit-number");
            quantities.append(node("span", record.total_units.toLocaleString("es-PA", { maximumFractionDigits: 2 }) + " unidades", "audit-muted"));
            const docs = node("td");
            const actions = node("div", undefined, "audit-documents");
            actions.append(documentButton(record, "pdf", "PDF original", result), documentButton(record, "excel", "Excel", result));
            docs.append(actions);
            row.append(salida, user, time, quantities, docs);
            body.append(row);
          }
          table.append(head, body);
          wrap.append(table);
          recordsArea.append(wrap);
          if (failedRows) feedback(result, failedRows + (failedRows === 1 ? " salida no pudo descifrarse" : " salidas no pudieron descifrarse") + ". Las demás se muestran. Solicita al administrador que revise los registros indicados.", true);
        }
        const pagination = node("div", undefined, "audit-pagination");
        pagination.append(node("span", total + (total === 1 ? " salida" : " salidas") + " · Página " + pageNumber + " de " + Math.max(1, Math.ceil(total / PAGE_SIZE)), "audit-muted"));
        const actions = node("div", undefined, "audit-actions");
        const previous = button("Anterior", true);
        const next = button("Siguiente", true);
        previous.disabled = pageNumber <= 1;
        next.disabled = pageNumber * PAGE_SIZE >= total;
        previous.addEventListener("click", function () { pageNumber--; loadRecords(); });
        next.addEventListener("click", function () { pageNumber++; loadRecords(); });
        actions.append(previous, next);
        pagination.append(actions);
        recordsArea.append(pagination);
      } catch (error) {
        if (epoch !== generation || pageEpoch !== pageGeneration || sequence !== loadGeneration) return;
        recordsArea.replaceChildren();
        feedback(result, errorText(error), true);
      } finally {
        if (pageEpoch === pageGeneration && sequence === loadGeneration) submit.disabled = clear.disabled = refresh.disabled = false;
      }
    }
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const value = search.value.trim();
      if (value && !/^\d{1,60}$/.test(value)) {
        feedback(result, "Ingresa solo el número exacto de la salida.", true);
        return;
      }
      if (from.value && to.value && from.value > to.value) {
        feedback(result, "La fecha «Desde» no puede ser posterior a «Hasta».", true);
        return;
      }
      query = value;
      fromValue = from.value;
      toValue = to.value;
      pageNumber = 1;
      loadRecords();
    });
    clear.addEventListener("click", function () { search.value = ""; from.value = ""; to.value = ""; query = ""; fromValue = ""; toValue = ""; pageNumber = 1; loadRecords(); });
    refresh.addEventListener("click", function () { loadRecords(); });
    loadRecords();
  }

  function renderUserManagement(parent) {
    const userGeneration = generation;
    const details = node("details", undefined, "audit-admin");
    details.append(node("summary", "Administrar usuarios"));
    const body = node("div", undefined, "audit-admin-body");
    body.append(node("p", "Crea una cuenta por compañero. Su contraseña desbloquea una copia cifrada de la clave del equipo; nunca se envía a Supabase tal como la escribes.", "audit-muted"));
    const form = node("form", undefined, "audit-form audit-cloud-form");
    const name = field(form, "Usuario", "user-username", "text", { minLength: 3, autocomplete: "off" });
    const password = field(form, "Contraseña inicial o actual", "user-password", "password", { minLength: 12, autocomplete: "new-password" });
    const repeat = field(form, "Repite la contraseña", "user-repeat", "password", { minLength: 12, autocomplete: "new-password" });
    const roleWrapper = node("div", undefined, "audit-field");
    const roleLabel = node("label", "Permisos");
    const role = node("select");
    role.id = "audit-cloud-user-role";
    roleLabel.htmlFor = role.id;
    const user = node("option", "Usuario");
    user.value = "user";
    const admin = node("option", "Administrador");
    admin.value = "admin";
    role.append(user, admin);
    roleWrapper.append(roleLabel, role);
    const submit = button("Crear usuario");
    submit.type = "submit";
    form.append(roleWrapper, submit);
    passwordToggle(form, [password, repeat]);
    const result = node("div");
    const usersArea = node("div");
    body.append(form, result, usersArea);
    details.append(body);
    parent.append(details);
    let loaded = false;
    async function loadUsers() {
      usersArea.replaceChildren(node("p", "Cargando usuarios…", "audit-state"));
      try {
        const users = await rpc("mega_audit_list_members", { p_workspace_id: CONFIG.workspace });
        if (userGeneration !== generation) return;
        if (!Array.isArray(users)) throw new Error("La lista de usuarios no es válida.");
        const wrap = node("div", undefined, "audit-table-wrap");
        const table = node("table", undefined, "audit-table");
        const head = node("thead");
        const headings = node("tr");
        for (const label of ["Usuario", "Permisos", "Creado (Panamá)"]) {
          const cell = node("th", label);
          cell.scope = "col";
          headings.append(cell);
        }
        head.append(headings);
        const tbody = node("tbody");
        for (const user of users) {
          const row = node("tr");
          const when = formatWhen(user.created_at);
          row.append(node("td", "@" + user.username), node("td", user.role === "admin" ? "Administrador" : "Usuario"), node("td", when.date + " " + when.time));
          tbody.append(row);
        }
        table.append(head, tbody);
        wrap.append(table);
        usersArea.replaceChildren(wrap);
      } catch (error) {
        if (userGeneration !== generation) return;
        usersArea.replaceChildren();
        feedback(result, errorText(error), true);
      }
    }
    details.addEventListener("toggle", function () {
      if (details.open && !loaded) { loaded = true; loadUsers(); }
    });
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (password.value !== repeat.value) {
        feedback(result, "Las contraseñas no coinciden. Revisa ambas con «Mostrar contraseña».", true);
        return;
      }
      submit.disabled = true;
      feedback(result, "Creando usuario y cifrando su acceso…", false);
      try {
        await createMember(name.value, password.value, role.value);
        if (userGeneration !== generation) return;
        form.reset();
        feedback(result, "Usuario creado. Ya puede iniciar sesión con su usuario y contraseña.", false);
        loaded = true;
        await loadUsers();
      } catch (error) {
        if (userGeneration === generation) feedback(result, errorText(error), true);
      } finally { submit.disabled = false; }
    });
    return details;
  }

  function initialise() {
    try {
      validateConfiguration();
      renderAccountBar();
      renderAuditPage();
    } catch (error) {
      const bar = document.getElementById("audit-bar");
      if (bar) feedback(bar, errorText(error), true);
    }
  }

  window.AuditCloud = Object.freeze({ ready, record, newIdempotencyKey });
  window.addEventListener("audit:recorded", function () { if (document.getElementById("audit-page")) renderAuditPage(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialise, { once: true });
  else initialise();
})();
