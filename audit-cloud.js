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
  let mobileCatalog = null;
  let member = null;
  let username = "";
  let master = null;
  let recoveryKey = null;
  let refreshPromise = null;
  let busyLogin = false;
  let pageGeneration = 0;
  let generation = 0;
  let archiveView = null;
  let profileCleanup = null;
  const openDialogs = new Set();
  const requests = new Set();
  const blobUrls = new Map();
  const archiveFilters = { query: "", from: "", to: "", author: "", page: 1 };
  const pending = new Map();
  const pendingMembers = new Map();
  const verifiedUnitSummaries = new Map();

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
      generation,
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
    if (mobileCatalog) mobileCatalog.clear();
    mobileCatalog = null;
    for (const controller of requests) controller.abort();
    requests.clear();
    disposeArchive();
    for (const dialog of openDialogs) dialog.close();
    for (const [url, timer] of blobUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    blobUrls.clear();
    session = null;
    member = null;
    username = "";
    master = null;
    recoveryKey = null;
    refreshPromise = null;
    clearPending();
    pendingMembers.clear();
    verifiedUnitSummaries.clear();
    Object.assign(archiveFilters, { query: "", from: "", to: "", author: "", page: 1 });
    window.dispatchEvent(new CustomEvent("audit:logout"));
    window.dispatchEvent(new CustomEvent("traza:session-cleared"));
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
      }).finally(function () { if (epoch === generation) refreshPromise = null; });
    }
    await refreshPromise;
  }

  async function request(path, options) {
    options = options || {};
    const epoch = generation;
    function current() {
      if (epoch !== generation || (!options.anonymous && !session)) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
      if (options.signal && options.signal.aborted) throw new Error("La vista cambió.");
    }
    if (!options.anonymous) {
      if (!session) throw new Error("Inicia sesión en la auditoría antes de continuar.");
      await refreshIfNeeded();
      current();
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
    requests.add(controller);
    const abort = function () { controller.abort(); };
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    const timeout = setTimeout(function () { controller.abort(); release(); }, 30000);
    function release() {
      clearTimeout(timeout);
      requests.delete(controller);
      if (options.signal) options.signal.removeEventListener("abort", abort);
    }
    let response;
    try {
      response = await fetch(CONFIG.url + path, {
        method: options.method || "GET", headers, body, signal: controller.signal,
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer"
      });
      current();
    } catch (error) {
      release();
      if (epoch !== generation) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
      if (options.signal && options.signal.aborted) throw new Error("La vista cambió.");
      throw new Error("No se pudo conectar con Supabase. Comprueba tu conexión e inténtalo nuevamente; el Excel aún no se ha descargado.");
    }
    if (!response.ok) {
      let detail = {};
      try { detail = await response.json(); } catch (error) {}
      finally { release(); }
      current();
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
    if (options.raw) {
      // Keep timeout and cancellation through the body, not just the headers.
      for (const method of ["arrayBuffer", "json", "blob", "text"]) {
        const read = response[method].bind(response);
        response[method] = async function () {
          try {
            const value = await read();
            try { current(); }
            catch (error) { if (method === "arrayBuffer") new Uint8Array(value).fill(0); throw error; }
            return value;
          }
          finally { release(); }
        };
      }
      return response;
    }
    if (response.status === 204) { release(); return null; }
    try { const result = await response.json(); current(); return result; }
    catch (error) { throw new Error("Supabase devolvió una respuesta inválida. Inténtalo nuevamente."); }
    finally { release(); }
  }

  function rpc(name, args) {
    return request("/rest/v1/rpc/" + name, { method: "POST", body: args });
  }

  function ownQuery(table, columns) {
    return "/rest/v1/" + table + "?workspace_id=eq." + CONFIG.workspace + "&user_id=eq." + session.user.id + "&select=" + columns;
  }

  async function login(rawUsername, password) {
    validateConfiguration();
    const startingEpoch = generation;
    const normalized = window.AuditCrypto.normalizeUsername(rawUsername);
    const userUnlock = await window.AuditCrypto.unlockUser(normalized, password, CONFIG.workspace);
    if (startingEpoch !== generation) throw new Error("La sesión cambió. Inténtalo nuevamente.");
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
      assertAccount(epoch);
      if (!Array.isArray(membership) || membership.length !== 1 || !["admin", "user"].includes(membership[0].role)) {
        throw new Error("Tu cuenta está creada, pero aún no tiene acceso al historial. El administrador debe autorizarla; para la primera cuenta, sigue la guía de Supabase.");
      }
      member = membership[0];
      const workspaces = await request("/rest/v1/mega_audit_workspace?id=eq." + CONFIG.workspace + "&select=key_fingerprint");
      assertAccount(epoch);
      if (!Array.isArray(workspaces) || workspaces.length !== 1) throw new Error("No se encontró la auditoría configurada. Revisa la guía de Supabase.");
      let fingerprint = workspaces[0].key_fingerprint;
      if (!fingerprint) {
        if (member.role !== "admin") throw new Error("El administrador debe iniciar sesión una vez para preparar el cifrado del historial.");
        const key = window.AuditCrypto.createRecoveryKey();
        const unlocked = await window.AuditCrypto.unlock(key, CONFIG.workspace);
        assertAccount(epoch, true);
        const wrapped = await userUnlock.wrapRecoveryKey(key);
        assertAccount(epoch, true);
        await rpc("mega_audit_initialize_key", {
          p_workspace_id: CONFIG.workspace, p_key_fingerprint: unlocked.fingerprint, p_wrapped_key: base64(wrapped)
        });
        assertAccount(epoch, true);
        fingerprint = unlocked.fingerprint;
      }
      const keys = await request(ownQuery("mega_audit_user_keys", "wrapped_key"));
      assertAccount(epoch);
      if (!Array.isArray(keys) || keys.length !== 1) {
        throw new Error("Tu cuenta todavía no tiene la clave cifrada del historial. Solicita al administrador que complete tu acceso.");
      }
      let key;
      try { key = await userUnlock.unwrapRecoveryKey(unbase64(keys[0].wrapped_key)); }
      catch (error) { throw new Error("No se pudo desbloquear la clave cifrada de tu cuenta. Solicita ayuda al administrador; el historial se conserva."); }
      assertAccount(epoch);
      const unlocked = await window.AuditCrypto.unlock(key, CONFIG.workspace);
      assertAccount(epoch);
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

  async function signup(rawUsername, password, viewGuard) {
    validateConfiguration();
    const epoch = generation;
    const guard = function () {
      if (epoch !== generation) throw new Error("La sesión cambió. Inténtalo nuevamente.");
      if (viewGuard) viewGuard();
    };
    const normalized = window.AuditCrypto.normalizeUsername(rawUsername);
    const unlock = await window.AuditCrypto.unlockUser(normalized, password, CONFIG.workspace);
    guard();
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
    guard();
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
    guard();
    if (result && result.user && !result.access_token) {
      throw new Error("Supabase creó la cuenta, pero exige confirmar un correo. Desactiva «Confirm email» en Authentication y después inicia sesión con el usuario y la contraseña que acabas de crear.");
    }
    const verified = acceptSession(result);
    if (verified.user.email !== normalized + "@" + ALIAS_DOMAIN) throw new Error("No se pudo verificar la cuenta creada. Revisa la configuración de acceso.");
    return { username: normalized, unlock, userId: verified.user.id };
  }

  async function createMember(rawUsername, password, role, viewGuard) {
    if (!status().authenticated || member.role !== "admin") throw new Error("Inicia sesión como administrador para crear usuarios.");
    const epoch = generation;
    const guard = function () { assertAccount(epoch, true); if (viewGuard) viewGuard(); };
    await requireAdmin(epoch);
    guard();
    let created;
    try { created = await signup(rawUsername, password, guard); }
    catch (error) {
      if (!["user_already_exists", "email_exists"].includes(error.code)) throw error;
      const normalized = window.AuditCrypto.normalizeUsername(rawUsername);
      created = { username: normalized, unlock: await window.AuditCrypto.unlockUser(normalized, password, CONFIG.workspace) };
    }
    guard();
    // Verifica la contraseña del usuario sin reemplazar la sesión administradora.
    const targetResult = await request("/auth/v1/token?grant_type=password", {
      method: "POST", anonymous: true,
      body: { email: created.username + "@" + ALIAS_DOMAIN, password: created.unlock.authPassword }
    });
    guard();
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
      guard();
      pendingMembers.set(created.username, previous);
    }
    await requireAdmin(epoch);
    guard();
    const added = await rpc("mega_audit_add_member", {
      p_workspace_id: CONFIG.workspace, p_username: created.username,
      p_wrapped_key: previous.wrapped, p_role: roleValue
    });
    guard();
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
    finally { clear.fill(0); }
    if (!metadata || !/^\d{1,60}$/.test(String(metadata.salida_numero)) || !Number.isInteger(metadata.row_count) ||
        metadata.row_count < 0 || !Number.isFinite(metadata.total_units) || metadata.total_units < 0 ||
        typeof metadata.username !== "string" || typeof metadata.pdf_name !== "string" || typeof metadata.excel_name !== "string") {
      throw new Error("La información cifrada de una salida no es válida.");
    }
    return Object.assign({}, metadata, { id: record.id, created_by: record.created_by, created_at: record.created_at, workspace_id: record.workspace_id });
  }

  async function getDocument(record, kind, key, guard, signal) {
    if (!["pdf", "excel"].includes(kind)) throw new Error("Documento no válido.");
    const response = await request("/storage/v1/object/authenticated/" + BUCKET + "/" + recordPath(record, kind), { raw: true, signal });
    if (guard) guard();
    const length = Number(response.headers.get("Content-Length"));
    if (length > FILE_LIMIT + 64) throw new Error("El documento guardado excede el tamaño permitido.");
    const encrypted = new Uint8Array(await response.arrayBuffer());
    if (guard) guard();
    if (encrypted.length > FILE_LIMIT + 64) throw new Error("El documento guardado excede el tamaño permitido.");
    let clear;
    try {
      clear = await (key || master).decrypt(encrypted, record.id + "|" + kind);
      if (guard) guard();
      return clear;
    }
    catch (error) { throw new Error("No se pudo verificar ni descifrar este documento. Solicita al administrador que revise el archivo guardado."); }
    finally { encrypted.fill(0); if (clear && guard) { try { guard(); } catch (_) { clear.fill(0); } } }
  }

  function equalBytes(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
    return difference === 0;
  }

  async function putDocument(path, ciphertext, guard) {
    try {
      await request("/storage/v1/object/" + BUCKET + "/" + path, { method: "POST", binary: true, body: ciphertext });
      guard();
    } catch (error) {
      guard();
      if (error.status !== 409 && error.code !== "Duplicate" && error.code !== "ResourceAlreadyExists") throw error;
      const response = await request("/storage/v1/object/authenticated/" + BUCKET + "/" + path, { raw: true });
      guard();
      const existing = new Uint8Array(await response.arrayBuffer());
      try {
        guard();
        if (!equalBytes(existing, ciphertext)) throw new Error("Ya existe otro documento para este intento. No se ha sobrescrito; vuelve a cargar el PDF para generar una salida nueva.");
      } finally { existing.fill(0); }
    }
  }

  async function prepareRecord(options, id, key, owner, guard) {
    const number = String(options.salidaNumero);
    if (!/^\d{1,60}$/.test(number)) throw new Error("Ingresa un número de salida válido antes de descargar.");
    if (!options.pdfFile || typeof options.pdfFile.arrayBuffer !== "function") throw new Error("Vuelve a cargar el PDF original antes de descargar.");
    const excel = bytes(options.excelBytes);
    if (options.pdfFile.size > FILE_LIMIT || excel.length > FILE_LIMIT) throw new Error("La auditoría admite hasta 25 MB por documento.");
    if (!Number.isInteger(options.rowCount) || options.rowCount < 0 || !Number.isFinite(options.totalUnits) || options.totalUnits < 0) {
      throw new Error("Las cantidades de esta salida no son válidas.");
    }
    const pdf = new Uint8Array(await options.pdfFile.arrayBuffer());
    let payload;
    let encrypted;
    let retained = false;
    try {
    guard();
    if (pdf.length > FILE_LIMIT) throw new Error("La auditoría admite hasta 25 MB por documento.");
    const metadata = {
      salida_numero: number, pdf_name: String(options.pdfFile.name || "Documento.pdf"), excel_name: String(options.excelName || "Salida " + number + ".xlsx"),
      row_count: options.rowCount, total_units: options.totalUnits, username, user_display_name: username
    };
    payload = new TextEncoder().encode(JSON.stringify(metadata));
    const outcomes = await Promise.allSettled([
      key.encrypt(payload, id + "|metadata"), key.encrypt(pdf, id + "|pdf"), key.encrypt(excel, id + "|excel"), key.blindIndex(number)
    ]);
    encrypted = outcomes.map(function (outcome) { return outcome.status === "fulfilled" ? outcome.value : null; });
    guard();
    const failed = outcomes.find(function (outcome) { return outcome.status === "rejected"; });
    if (failed) throw failed.reason;
    retained = true;
    return { id, owner, metadata, pdf, excel: new Uint8Array(excel), encryptedMetadata: base64(encrypted[0]), encryptedPdf: encrypted[1], encryptedExcel: encrypted[2], tag: encrypted[3] };
    } finally {
      if (payload) payload.fill(0);
      if (encrypted && encrypted[0]) encrypted[0].fill(0);
      if (!retained) {
        pdf.fill(0);
        if (encrypted) for (const value of encrypted) if (value && typeof value.fill === "function") value.fill(0);
      }
    }
  }

  async function record(options) {
    const viewGeneration = window.TrazaUI ? window.TrazaUI.generation : null;
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
    const guard = function () {
      assertAccount(epoch);
      if (!master || key !== master || account.generation !== epoch ||
          (window.TrazaUI && window.TrazaUI.generation !== viewGeneration)) {
        throw new Error("La sesión o la sección cambió. Vuelve a guardar desde Nueva salida.");
      }
    };
    let snapshot = pending.get(id);
    try {
    guard();
    if (!snapshot) {
      clearPending();
      snapshot = await prepareRecord(options, id, key, owner, guard);
      guard();
      pending.set(id, snapshot);
    } else if (snapshot.owner !== owner || snapshot.metadata.salida_numero !== String(options.salidaNumero)) {
      throw new Error("Este intento corresponde a otra cuenta o salida. Vuelve a cargar el PDF.");
    } else {
      snapshot.pdf = new Uint8Array(await options.pdfFile.arrayBuffer());
      guard();
      snapshot.excel = new Uint8Array(bytes(options.excelBytes));
    }
    const previous = await request("/rest/v1/mega_audit_records?workspace_id=eq." + CONFIG.workspace + "&id=eq." + id + "&select=*");
    guard();
    if (!Array.isArray(previous)) throw new Error("Supabase devolvió un registro inválido.");
    let saved;
    if (previous.length) {
      if (previous.length !== 1 || previous[0].created_by !== owner) throw new Error("Este identificador ya pertenece a otro registro. Vuelve a cargar el PDF.");
      saved = await decryptedRecord(previous[0], key);
      guard();
      for (const name of ["salida_numero", "pdf_name", "excel_name", "row_count", "total_units", "username"]) {
        if (saved[name] !== snapshot.metadata[name]) throw new Error("Este intento ya contiene otra salida. No se ha sobrescrito.");
      }
      const outcomes = await Promise.allSettled([getDocument(previous[0], "pdf", key, guard), getDocument(previous[0], "excel", key, guard)]);
      try {
        guard();
        const failed = outcomes.find(function (outcome) { return outcome.status === "rejected"; });
        if (failed) throw failed.reason;
        if (!equalBytes(outcomes[0].value, snapshot.pdf) || !equalBytes(outcomes[1].value, snapshot.excel)) {
          throw new Error("Los documentos de este intento ya son distintos. No se han sobrescrito.");
        }
      } finally { for (const outcome of outcomes) if (outcome.status === "fulfilled") outcome.value.fill(0); }
    } else {
      const row = { id, created_by: owner };
      await putDocument(recordPath(row, "pdf"), snapshot.encryptedPdf, guard);
      guard();
      await putDocument(recordPath(row, "excel"), snapshot.encryptedExcel, guard);
      guard();
      let result = await rpc("mega_audit_record", {
        p_id: id, p_workspace_id: CONFIG.workspace, p_salida_tag: snapshot.tag,
        p_encrypted_metadata: snapshot.encryptedMetadata, p_idempotency_key: id
      });
      guard();
      if (Array.isArray(result) && result.length === 1) result = result[0];
      if (!result || result.id !== id || result.created_by !== owner || result.encrypted_metadata !== snapshot.encryptedMetadata) {
        throw new Error("No se pudo confirmar esta salida. Reintenta la descarga; no se creará un duplicado.");
      }
      saved = await decryptedRecord(result, key);
    }
    guard();
    saved.username = username;
    saved.user_display_name = username;
    clearPending();
    window.dispatchEvent(new CustomEvent("audit:recorded", { detail: saved }));
    return saved;
    } finally {
      // Retain encrypted upload bytes for safe retries; keep clear copies only
      // while comparing the operation's documents.
      if (snapshot) {
        if (snapshot.pdf) snapshot.pdf.fill(0);
        if (snapshot.excel) snapshot.excel.fill(0);
        snapshot.pdf = snapshot.excel = null;
      }
    }
  }

  async function confirmArchivedRecord(recordId) {
    const id = String(recordId || "").toLowerCase();
    if (!UUID.test(id)) throw new Error("La salida seleccionada no es válida. Vuelve a abrirla desde el archivo.");
    const epoch = generation;
    const key = master;
    const viewGeneration = window.TrazaUI ? window.TrazaUI.generation : null;
    const guard = function () {
      assertAccount(epoch);
      if (!status().authenticated || !key || key !== master ||
          (window.TrazaUI && window.TrazaUI.generation !== viewGeneration)) {
        throw new Error("La sesión o la sección cambió. Vuelve a abrir la salida desde el archivo.");
      }
    };
    guard();
    // RLS checks current access again. Editing a local workbook must never
    // upload new documents or create another audit entry for this record.
    const rows = await request("/rest/v1/mega_audit_records?workspace_id=eq." + CONFIG.workspace + "&id=eq." + id + "&select=*&limit=2");
    guard();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== id) {
      throw new Error("Ya no tienes acceso a esta salida o el registro ya no está disponible. No se guardó el Excel.");
    }
    const archived = await decryptedRecord(rows[0], key);
    guard();
    return archived;
  }

  function clearPending() {
    for (const snapshot of pending.values()) {
      for (const name of ["pdf", "excel", "encryptedPdf", "encryptedExcel"]) {
        if (snapshot[name] && typeof snapshot[name].fill === "function") snapshot[name].fill(0);
      }
    }
    pending.clear();
  }

  function assertAccount(epoch, admin) {
    if (epoch !== generation || !session || (admin && (!member || member.role !== "admin"))) {
      throw new Error(admin ? "La sesión o los permisos cambiaron. Inicia sesión como administrador." : "La sesión cambió. Inicia sesión nuevamente.");
    }
  }

  async function requireAdmin(epoch) {
    assertAccount(epoch, true);
    if (!master || !recoveryKey) throw new Error("Inicia sesión como administrador para continuar.");
    const memberships = await request(ownQuery("mega_audit_members", "role"));
    assertAccount(epoch, true);
    if (!Array.isArray(memberships) || memberships.length !== 1 || memberships[0].role !== "admin") {
      if (Array.isArray(memberships) && memberships.length === 1 && memberships[0].role === "user") {
        member = memberships[0];
        for (const dialog of openDialogs) dialog.close();
        renderAccountBar();
      } else clearSession();
      throw new Error("Tu cuenta ya no tiene permisos de administración.");
    }
  }

  function saveBlob(data, name, mime) {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const link = node("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    blobUrls.set(url, null);
    try { link.click(); }
    catch (_) {
      URL.revokeObjectURL(url);
      blobUrls.delete(url);
      throw new Error("No se pudo iniciar la descarga. Inténtalo nuevamente.");
    } finally { link.remove(); }
    const timer = setTimeout(function () { URL.revokeObjectURL(url); blobUrls.delete(url); }, 30000);
    blobUrls.set(url, timer);
  }

  function clearBlobDownloads() {
    for (const [url, timer] of blobUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    blobUrls.clear();
  }

  function picker(name, kind) {
    if (typeof window.showSaveFilePicker !== "function") return null;
    const types = kind === "pdf" ? [{ description: "Documento PDF", accept: { "application/pdf": [".pdf"] } }] :
      kind === "excel" ? [{ description: "Libro de Excel", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] } }] :
      [{ description: "Archivo privado de recuperación", accept: { "text/plain": [".txt"] } }];
    // Called synchronously from the original click, before any await.
    try { return window.showSaveFilePicker({ suggestedName: name, types }); }
    catch (error) { return Promise.reject(error); }
  }

  async function writeDownload(clear, handle, name, mime, guard) {
    guard();
    if (!handle) { saveBlob(clear, name, mime); return "Se inició la descarga. Se usará la configuración de descargas del navegador."; }
    let stream;
    try {
      stream = await handle.createWritable();
      guard();
      await stream.write(new Blob([clear], { type: mime }));
      guard();
      await stream.close();
      guard();
      return "Archivo guardado en la carpeta elegida.";
    } catch (error) {
      if (stream) { try { await stream.abort(); } catch (_) {} }
      throw error;
    }
  }

  function navigateArchive(focusLogin) {
    if (window.TrazaUI) window.TrazaUI.navigate("archive");
    else location.hash = "archivo";
    if (focusLogin) requestAnimationFrame(function () {
      const input = document.getElementById("audit-cloud-login-username");
      if (input) input.focus();
    });
  }

  function createDialog(title, opener) {
    const dialog = node("dialog", undefined, "traza-dialog");
    const header = node("div", undefined, "traza-dialog-header");
    const heading = node("h2", title);
    heading.id = "traza-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const close = button("Cerrar", true);
    close.setAttribute("aria-label", "Cerrar " + title);
    close.addEventListener("click", function () { dialog.close(); });
    header.append(heading, close);
    dialog.append(header);
    const content = node("div", undefined, "traza-dialog-body");
    dialog.append(content);
    document.body.append(dialog);
    openDialogs.add(dialog);
    dialog.addEventListener("close", function () {
      openDialogs.delete(dialog);
      dialog.replaceChildren();
      dialog.remove();
      if (opener && opener.isConnected && !opener.closest("[hidden], [inert]")) opener.focus();
      else {
        const profile = document.querySelector("#app-profile button");
        if (profile) profile.focus();
      }
    }, { once: true });
    dialog.showModal();
    return { dialog, content };
  }

  function renderAccountBar() {
    if (profileCleanup) profileCleanup();
    const profile = document.getElementById("app-profile");
    const bar = document.getElementById("audit-bar");
    if (bar) bar.replaceChildren();
    if (profile) {
      profile.replaceChildren();
      if (!status().authenticated) {
        const signIn = button("Iniciar sesión");
        signIn.addEventListener("click", function () { navigateArchive(true); });
        profile.append(signIn);
      } else {
        const trigger = button("", true);
        trigger.className = "traza-profile-trigger";
        trigger.setAttribute("aria-expanded", "false");
        trigger.setAttribute("aria-controls", "traza-profile-menu");
        trigger.setAttribute("aria-label", "Perfil de @" + username);
        const initials = username.split(/[._-]+/).map(function (part) { return part[0]; }).join("").slice(0, 2).toUpperCase();
        const avatar = node("span", initials, "traza-profile-avatar");
        avatar.setAttribute("aria-hidden", "true");
        const identity = node("span", undefined, "traza-profile-name");
        identity.append(node("strong", "@" + username), node("span", member.role === "admin" ? "Administrador" : "Usuario", "traza-profile-role"));
        trigger.append(avatar, identity, node("span", "⌄"));
        const menu = node("div", undefined, "traza-profile-menu");
        menu.id = "traza-profile-menu";
        menu.hidden = true;
        const controller = new AbortController();
        profileCleanup = function () { controller.abort(); profileCleanup = null; };
        function closeMenu(restore) { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); if (restore) trigger.focus(); }
        trigger.addEventListener("click", function () {
          const open = menu.hidden;
          menu.hidden = !open;
          trigger.setAttribute("aria-expanded", String(open));
          if (open) menu.querySelector("button").focus();
        });
        document.addEventListener("click", function (event) { if (!profile.contains(event.target)) closeMenu(false); }, { signal: controller.signal });
        document.addEventListener("keydown", function (event) {
          if (menu.hidden) return;
          if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const choices = Array.from(menu.querySelectorAll("button"));
            const index = choices.indexOf(document.activeElement);
            choices[(index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length].focus();
          }
        }, { signal: controller.signal });
        if (member.role === "admin") {
          const users = button("Usuarios y permisos", true);
          const security = button("Seguridad", true);
          users.addEventListener("click", function () { closeMenu(false); openUsersDialog(users); });
          security.addEventListener("click", function () { closeMenu(false); openSecurityDialog(security); });
          menu.append(users, security);
        }
        const logout = button("Cerrar sesión", true);
        logout.addEventListener("click", function () {
          // Remove local secrets and documents immediately, even if Auth stalls.
          const token = session && session.access_token;
          clearSession();
          if (!token) return;
          const controller = new AbortController();
          const timer = setTimeout(function () { controller.abort(); }, 4000);
          fetch(CONFIG.url + "/auth/v1/logout?scope=local", {
            method: "POST", headers: { apikey: CONFIG.key, Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body: "{}", signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer"
          }).catch(function () {}).finally(function () { clearTimeout(timer); });
        });
        menu.append(logout);
        profile.append(trigger, menu);
      }
    }
    if (!status().authenticated && bar) renderLoginForm(bar);
    const privacy = document.querySelector(".privacy-note");
    if (privacy) {
      const dot = node("span", undefined, "privacy-dot");
      dot.setAttribute("aria-hidden", "true");
      privacy.replaceChildren(dot, document.createTextNode("Conversión local · documentos protegidos"));
    }
  }

  function renderLoginForm(bar) {
    const panel = node("section", undefined, "audit-panel audit-cloud-panel");
    panel.append(node("h2", "Iniciar sesión"), node("p", "Accede con tu usuario y contraseña para consultar y guardar salidas.", "audit-muted"));
    const form = node("form", undefined, "audit-form audit-cloud-form");
    const name = field(form, "Usuario", "login-username", "text", { minLength: 3 });
    const password = field(form, "Contraseña", "login-password", "password");
    const submit = button("Iniciar sesión");
    submit.type = "submit";
    form.append(submit);
    passwordToggle(form, [password]);
    const result = node("div", undefined, "audit-cloud-login-feedback");
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (busyLogin) return;
      busyLogin = true;
      submit.disabled = true;
      feedback(result, "Comprobando acceso…", false);
      const attemptedName = name.value;
      try { await login(attemptedName, password.value); }
      catch (error) {
        const visible = document.querySelector("#audit-bar .audit-cloud-login-feedback");
        if (visible) feedback(visible, errorText(error), true);
        const visibleName = document.getElementById("audit-cloud-login-username");
        if (visibleName) visibleName.value = attemptedName;
      } finally { password.value = ""; busyLogin = false; submit.disabled = false; }
    });
    panel.append(form, result);
    const details = node("details", undefined, "audit-cloud-signup");
    details.append(node("summary", "Crear mi cuenta"));
    const createForm = node("form", undefined, "audit-form audit-cloud-form");
    const newName = field(createForm, "Usuario nuevo", "signup-username", "text", { minLength: 3, autocomplete: "off" });
    const newPassword = field(createForm, "Contraseña nueva", "signup-password", "password", { minLength: 12, autocomplete: "new-password" });
    const repeat = field(createForm, "Repite la contraseña", "signup-repeat", "password", { minLength: 12, autocomplete: "new-password" });
    const create = button("Crear cuenta");
    create.type = "submit";
    createForm.append(create);
    passwordToggle(createForm, [newPassword, repeat]);
    const createFeedback = node("div");
    createForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (newPassword.value !== repeat.value) { feedback(createFeedback, "Las contraseñas no coinciden.", true); return; }
      const epoch = generation;
      create.disabled = true;
      feedback(createFeedback, "Creando cuenta…", false);
      try {
        const created = await signup(newName.value, newPassword.value);
        if (epoch !== generation || !createForm.isConnected) return;
        name.value = created.username;
        createForm.reset();
        feedback(createFeedback, "Cuenta @" + created.username + " creada. El administrador debe autorizar su acceso.", false);
        const setup = node("a", "Configurar la primera cuenta administradora", "audit-cloud-setup-link");
        setup.href = "supabase-setup.html?user=" + encodeURIComponent(created.userId) + "&username=" + encodeURIComponent(created.username);
        createFeedback.append(setup);
      } catch (error) { if (epoch === generation && createForm.isConnected) feedback(createFeedback, errorText(error), true); }
      finally { newPassword.value = repeat.value = ""; create.disabled = false; }
    });
    details.append(node("p", "Usuario de 3 a 32 caracteres. Contraseña de al menos 12 caracteres.", "audit-muted"), createForm, createFeedback);
    panel.append(details);
    bar.append(panel);
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

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00.000Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function panamaToday() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
      timeZone: "America/Panama", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date()).map(function (part) { return [part.type, part.value]; }));
    return parts.year + "-" + parts.month + "-" + parts.day;
  }

  function disposeDetail(view, restore) {
    clearBlobDownloads();
    if (window.TrazaSavedFile) window.TrazaSavedFile.clear();
    if (view && view.edit) { view.edit.controller.abort(); view.edit = null; }
    if (!view || !view.detail) return;
    const detail = view.detail;
    view.detail = null;
    if (detail.previewCleanup) detail.previewCleanup();
    detail.controller.abort();
    if (detail.renderTask) { try { detail.renderTask.cancel(); } catch (_) {} }
    if (detail.loadingTask) { try { Promise.resolve(detail.loadingTask.destroy()).catch(function () {}); } catch (_) {} }
    if (detail.pdf) { try { Promise.resolve(detail.pdf.destroy()).catch(function () {}); } catch (_) {} }
    for (const clear of detail.buffers) { try { clear.fill(0); } catch (_) {} }
    detail.buffers.clear();
    detail.panel.replaceChildren();
    detail.panel.remove();
    view.layout.classList.remove("has-detail");
    if (restore && detail.opener.isConnected) detail.opener.focus();
  }

  function disposeArchive() {
    if (!archiveView) return;
    if (window.TrazaSavedFile) window.TrazaSavedFile.clear();
    disposeDetail(archiveView, false);
    for (const clear of archiveView.buffers) { try { clear.fill(0); } catch (_) {} }
    archiveView.buffers.clear();
    archiveView.controller.abort();
    archiveView.disposed = true;
    archiveView = null;
  }

  function assertView(view, load) {
    assertAccount(view.epoch);
    if (view.disposed || archiveView !== view || view.pageEpoch !== pageGeneration ||
        view.page.hidden || view.page.closest("[hidden]") || (load !== undefined && load !== view.load)) {
      throw new Error("La vista cambió.");
    }
  }

  function unitsTextFor(record) {
    if (!record.unitCheck || record.unitCheck.state === "checking") return "Verificando unidades…";
    if (record.unitCheck.state !== "verified") return "Unidades no verificadas";
    return record.total_units.toLocaleString("es-PA", { maximumFractionDigits: 2 });
  }

  function updateDetailUnits(view, record) {
    const detail = view.detail;
    if (!detail || detail.record !== record) return;
    detail.units.textContent = unitsTextFor(record);
    detail.units.dataset.unitState = record.unitCheck.state;
    detail.products.textContent = record.row_count.toLocaleString("es-PA");
    detail.unitsNote.textContent = record.unitCheck.state === "unverified" ? record.unitCheck.message :
      record.unitCheck.changed ? "Unidades corregidas desde el PDF original. Usa Editar Excel para descargar el Excel actualizado; el Excel original se conserva." : "";
    detail.unitsNote.hidden = !detail.unitsNote.textContent;
  }

  async function verifyRecordUnits(record, view, key, controller, guard) {
    const cached = verifiedUnitSummaries.get(record.id);
    if (cached && cached.metadata === record.unitRevision) {
      guard();
      return cached.summary;
    }
    let clear;
    try {
      guard();
      if (!window.TrazaConverter || typeof window.TrazaConverter.analyzeUnits !== "function") {
        throw new Error("No se pudo cargar la comprobación de unidades. Actualiza la página e inténtalo de nuevo.");
      }
      clear = await getDocument(record, "pdf", key, guard, controller.signal);
      guard();
      view.buffers.add(clear);
      const summary = await window.TrazaConverter.analyzeUnits({ data: clear, signal: controller.signal, assertCurrent: guard, expectedNumber: record.salida_numero });
      guard();
      if (!summary || !summary.complete || summary.missingUnits !== 0 || !Number.isFinite(summary.totalUnits) || summary.totalUnits < 0 || !Number.isInteger(summary.rowCount) || summary.rowCount <= 0) {
        throw new Error("El PDF contiene productos sin unidades legibles. Revisa el documento original antes de usar su total.");
      }
      const verified = { totalUnits: summary.totalUnits, rowCount: summary.rowCount };
      // Only numerical summaries and encrypted revision markers live in this
      // session cache. PDF bytes, products and descriptions are never retained.
      verifiedUnitSummaries.set(record.id, { metadata: record.unitRevision, summary: verified });
      if (verifiedUnitSummaries.size > 200) verifiedUnitSummaries.delete(verifiedUnitSummaries.keys().next().value);
      return verified;
    } finally {
      if (clear) { clear.fill(0); view.buffers.delete(clear); }
    }
  }

  function documentButton(record, kind, label, result, view, detail) {
    const download = button(label, true);
    download.classList.add("audit-button-small");
    download.addEventListener("click", async function () {
      const epoch = generation;
      const key = master;
      const name = kind === "pdf" ? record.pdf_name : record.excel_name;
      const selected = detail || view.detail;
      const load = view.load;
      const guard = function () { assertView(view, load); if (view.detail !== selected) throw new Error("La vista cambió."); };
      let destination;
      let clear;
      // Excel uses one browser download, including its download list and any
      // configured open-after-download behavior. PDFs retain the folder picker.
      // No network, decryption or async session check precedes that picker.
      const selection = kind === "excel" ? null : picker(name, kind);
      if (window.TrazaSavedFile) window.TrazaSavedFile.clear();
      download.disabled = true;
      result.replaceChildren();
      if (!selection) feedback(result, "Se usará la configuración de descargas del navegador.", false);
      try {
        destination = selection ? await selection : null;
        guard();
        if (epoch !== generation || !status().authenticated) throw new Error("Inicia sesión nuevamente para abrir los documentos.");
        clear = await getDocument(record, kind, key, guard, selected ? selected.controller.signal : view.loadController.signal);
        guard();
        view.buffers.add(clear);
        if (selected) selected.buffers.add(clear);
        const mime = kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        const message = await writeDownload(clear, destination, name, mime, guard);
        guard();
        feedback(result, message, false);
        if ((destination || kind === "excel") && window.TrazaSavedFile) {
          const saved = { name: destination ? destination.name || name : name, mime, guard, message };
          // A folder save can offer a browser copy. The Excel download is
          // already that copy, so keep only its visible confirmation.
          if (destination) saved.data = clear;
          window.TrazaSavedFile.show(saved);
        }
      } catch (error) {
        if (epoch === generation && archiveView === view && load === view.load && view.detail === selected) {
          if (error && error.name === "AbortError") feedback(result, "Guardado cancelado. No se recuperó el documento.", false);
          else feedback(result, errorText(error), true);
        }
      } finally {
        if (clear) clear.fill(0);
        if (clear) view.buffers.delete(clear);
        if (clear && selected) selected.buffers.delete(clear);
        download.disabled = false;
      }
    });
    return download;
  }

  function editButton(record, result, view, detail) {
    const edit = button("Editar Excel", true);
    edit.classList.add("audit-button-small");
    edit.setAttribute("aria-label", "Editar Excel de salida " + record.salida_numero);
    edit.addEventListener("click", async function () {
      const epoch = generation;
      const key = master;
      const selected = detail || view.detail;
      const load = view.load;
      if (view.edit) view.edit.controller.abort();
      const attempt = { controller: new AbortController() };
      view.edit = attempt;
      const parentSignal = selected ? selected.controller.signal : view.loadController.signal;
      const abort = function () { attempt.controller.abort(); };
      parentSignal.addEventListener("abort", abort, { once: true });
      const guard = function () {
        assertView(view, load);
        if (view.edit !== attempt || attempt.controller.signal.aborted || view.detail !== selected || !key || key !== master ||
            (selected && selected.controller.signal.aborted)) throw new Error("La vista cambió.");
      };
      let clear;
      edit.disabled = true;
      if (window.TrazaSavedFile) window.TrazaSavedFile.clear();
      feedback(result, "Abriendo el PDF guardado para editar las columnas del Excel…", false);
      try {
        guard();
        if (!window.TrazaConverter || typeof window.TrazaConverter.openArchived !== "function") {
          throw new Error("No se pudo cargar el editor. Actualiza la página e inténtalo nuevamente.");
        }
        clear = await getDocument(record, "pdf", key, guard, attempt.controller.signal);
        guard();
        view.buffers.add(clear);
        if (selected) selected.buffers.add(clear);
        const file = new File([clear], record.pdf_name, { type: "application/pdf" });
        const authentication = status();
        guard();
        // The converter takes the source and then navigates. The archive view
        // intentionally becomes invalid at that point, so do not guard again.
        await window.TrazaConverter.openArchived({ file, record, authentication });
      } catch (error) {
        if (epoch === generation && archiveView === view && load === view.load && view.detail === selected && view.edit === attempt) {
          feedback(result, errorText(error), true);
        }
      } finally {
        parentSignal.removeEventListener("abort", abort);
        if (view.edit === attempt) view.edit = null;
        if (clear) clear.fill(0);
        if (clear) view.buffers.delete(clear);
        if (clear && selected) selected.buffers.delete(clear);
        edit.disabled = false;
      }
    });
    return edit;
  }

  function createPdfPreview(detail, record, guard) {
    const preview = node("div", undefined, "traza-detail-preview");
    const toolbar = node("div", undefined, "traza-preview-toolbar");
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Controles de la vista previa del PDF");
    const reduce = button("−", true);
    reduce.setAttribute("aria-label", "Reducir vista previa");
    const enlarge = button("+", true);
    enlarge.setAttribute("aria-label", "Ampliar vista previa");
    const zoomText = node("span", "100%", "traza-preview-zoom");
    const fit = button("Ajustar a ancho", true);
    const large = button("Ver PDF ampliado", true);
    large.setAttribute("aria-haspopup", "dialog");
    toolbar.append(reduce, zoomText, enlarge, fit, large);
    const previewStatus = node("p", "Cargando la primera página del PDF…", "traza-preview-status");
    previewStatus.setAttribute("role", "status");
    const scroll = node("div", undefined, "traza-preview-scroll");
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Primera página del PDF; desplázate para leer la vista ampliada");
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-busy", "true");
    preview.append(toolbar, previewStatus, scroll);
    let page = null;
    let zoom = 1;
    let revision = 0;
    let timer = null;
    let requestedSize = "";
    let active = true;
    let largeDialog = null;
    let canvas = null;
    const controls = [reduce, enlarge, fit, large];
    for (const control of controls) control.disabled = true;

    function current(sequence) {
      guard();
      if (!active || sequence !== revision) throw new Error("La vista previa cambió.");
    }

    function updateControls() {
      reduce.disabled = !page || zoom <= 0.5;
      enlarge.disabled = !page || zoom >= 3;
      fit.disabled = !page;
      large.disabled = !page || Boolean(largeDialog);
      zoomText.textContent = Math.round(zoom * 100) + "%";
    }

    function geometry() {
      const raw = page.getViewport({ scale: 1 });
      const cssWidth = Math.max(1, scroll.clientWidth) * zoom;
      const cssHeight = cssWidth * raw.height / raw.width;
      const density = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3,
        8192 / Math.max(cssWidth, cssHeight), Math.sqrt(16000000 / (cssWidth * cssHeight)));
      return { cssWidth, cssHeight, viewport: page.getViewport({ scale: cssWidth / raw.width * density }) };
    }

    async function render(sequence) {
      let raster;
      let task;
      let installed = false;
      try {
        current(sequence);
        const size = geometry();
        raster = node("canvas");
        raster.setAttribute("aria-label", "Vista previa de la primera página del PDF");
        raster.dataset.testid = "pdf-preview";
        raster.width = Math.max(1, Math.floor(size.viewport.width));
        raster.height = Math.max(1, Math.floor(size.viewport.height));
        raster.style.width = size.cssWidth + "px";
        raster.style.height = size.cssHeight + "px";
        task = page.render({ canvasContext: raster.getContext("2d"), viewport: size.viewport });
        detail.renderTask = task;
        await task.promise;
        current(sequence);
        const old = canvas;
        canvas = raster;
        scroll.replaceChildren(canvas);
        installed = true;
        if (old) { old.width = old.height = 0; }
        previewStatus.textContent = "Página 1 de " + detail.pdf.numPages;
        previewStatus.setAttribute("role", "status");
        scroll.setAttribute("aria-busy", "false");
      } catch (error) {
        if (active && sequence === revision && error.name !== "RenderingCancelledException") {
          try {
            guard();
            previewStatus.textContent = errorText(error);
            previewStatus.setAttribute("role", "alert");
            scroll.setAttribute("aria-busy", "false");
          } catch (_) {}
        }
      } finally {
        if (detail.renderTask === task) detail.renderTask = null;
        if (raster && !installed) raster.width = raster.height = 0;
      }
    }

    function requestRender(force) {
      if (!active || !page) return;
      try { guard(); } catch (_) { return; }
      const size = scroll.clientWidth + ":" + zoom + ":" + (window.devicePixelRatio || 1);
      if (!force && size === requestedSize) return;
      requestedSize = size;
      const sequence = ++revision;
      clearTimeout(timer);
      if (detail.renderTask) { try { detail.renderTask.cancel(); } catch (_) {} }
      scroll.setAttribute("aria-busy", "true");
      previewStatus.textContent = "Preparando vista previa…";
      timer = setTimeout(function () { timer = null; render(sequence); }, 60);
    }

    function changeZoom(value) {
      zoom = Math.max(0.5, Math.min(3, value));
      updateControls();
      requestRender(true);
    }
    reduce.addEventListener("click", function () { changeZoom(zoom - 0.25); }, { signal: detail.controller.signal });
    enlarge.addEventListener("click", function () { changeZoom(zoom + 0.25); }, { signal: detail.controller.signal });
    fit.addEventListener("click", function () { scroll.scrollTo(0, 0); changeZoom(1); }, { signal: detail.controller.signal });
    large.addEventListener("click", function () {
      guard();
      if (!page || largeDialog) return;
      const modal = createDialog("Vista ampliada · Salida " + record.salida_numero, large);
      largeDialog = modal.dialog;
      modal.dialog.classList.add("traza-pdf-dialog");
      const heading = modal.dialog.querySelector("h2");
      heading.id = "traza-pdf-preview-title";
      modal.dialog.setAttribute("aria-labelledby", heading.id);
      modal.content.append(preview);
      updateControls();
      modal.dialog.addEventListener("close", function () {
        largeDialog = null;
        if (!active) return;
        try {
          guard();
          // Restore before the shared dialog's close handler returns focus.
          detail.panel.append(preview);
          updateControls();
          requestRender(true);
        } catch (_) {}
      }, { once: true, capture: true });
      requestRender(true);
    }, { signal: detail.controller.signal });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(function () { requestRender(false); }) : null;
    if (observer) observer.observe(scroll);
    window.addEventListener("resize", function () { requestRender(false); }, { signal: detail.controller.signal });
    detail.previewCleanup = function () {
      active = false;
      revision++;
      clearTimeout(timer);
      if (observer) observer.disconnect();
      if (detail.renderTask) { try { detail.renderTask.cancel(); } catch (_) {} }
      if (canvas) { canvas.width = canvas.height = 0; canvas = null; }
      page = null;
      if (largeDialog && largeDialog.open) largeDialog.close();
      largeDialog = null;
    };
    return {
      element: preview,
      setPage: function (value) { page = value; updateControls(); requestRender(true); },
      fail: function (message) {
        previewStatus.textContent = message;
        previewStatus.setAttribute("role", "alert");
        scroll.setAttribute("aria-busy", "false");
        for (const control of controls) control.disabled = true;
      }
    };
  }

  function openDetail(view, record, officialName, opener) {
    assertView(view);
    disposeDetail(view, false);
    const panel = node("aside", undefined, "traza-detail audit-panel");
    panel.id = "traza-document-detail";
    panel.setAttribute("aria-labelledby", "traza-document-title");
    const detail = { panel, opener, record, controller: new AbortController(), buffers: new Set(), loadingTask: null, renderTask: null, pdf: null };
    view.detail = detail;
    const guard = function () { assertView(view); if (view.detail !== detail || detail.controller.signal.aborted) throw new Error("La vista cambió."); };
    const header = node("div", undefined, "traza-detail-header");
    const title = node("h3", "Salida " + record.salida_numero);
    title.id = "traza-document-title";
    const close = button("Cerrar detalle", true);
    close.addEventListener("click", function () { disposeDetail(view, true); });
    header.append(title, close);
    panel.append(header);
    const when = formatWhen(record.created_at);
    const facts = node("dl", undefined, "traza-detail-facts");
    for (const pair of [["Responsable", officialName ? "@" + officialName : "Responsable no disponible"], ["Fecha y hora · Panamá", when.date + " " + when.time], ["Productos", record.row_count.toLocaleString("es-PA")], ["Unidades", unitsTextFor(record)]]) {
      const value = node("dd", pair[1]);
      if (pair[0] === "Productos") detail.products = value;
      if (pair[0] === "Unidades") detail.units = value;
      facts.append(node("dt", pair[0]), value);
    }
    panel.append(facts);
    detail.unitsNote = node("p", "", "audit-muted");
    panel.append(detail.unitsNote);
    updateDetailUnits(view, record);
    const result = node("div");
    const edit = node("div", undefined, "audit-actions");
    edit.append(editButton(record, result, view, detail));
    panel.append(edit, node("p", "Elige las columnas y guarda otra versión del Excel con el PDF ya archivado. Los documentos originales se conservan.", "audit-muted"));
    for (const kind of ["pdf", "excel"]) {
      const file = node("div", undefined, "traza-document-name");
      file.append(node("span", kind === "pdf" ? "PDF original" : "Libro de Excel", "audit-muted"), node("strong", kind === "pdf" ? record.pdf_name : record.excel_name, "traza-file-name"), documentButton(record, kind, kind === "pdf" ? "Guardar PDF" : "Guardar Excel", result, view, detail));
      panel.append(file);
    }
    const preview = createPdfPreview(detail, record, guard);
    panel.append(result, preview.element);
    view.layout.append(panel);
    view.layout.classList.add("has-detail");
    close.focus({ preventScroll: true });
    const epoch = generation;
    const key = master;
    (async function () {
      let clear;
      try {
        clear = await getDocument(record, "pdf", key, guard, detail.controller.signal);
        guard();
        detail.buffers.add(clear);
        if (!window.pdfjsLib) throw new Error("No se pudo cargar el visor local de PDF.");
        if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
        detail.loadingTask = window.pdfjsLib.getDocument({ data: clear.slice(), isEvalSupported: false });
        detail.pdf = await detail.loadingTask.promise;
        guard();
        const page = await detail.pdf.getPage(1);
        guard();
        preview.setPage(page);
      } catch (error) {
        if (epoch === generation && archiveView === view && view.detail === detail) {
          preview.fail(errorText(error));
        }
      } finally {
        if (clear) { clear.fill(0); detail.buffers.delete(clear); }
        if (view.detail !== detail && detail.pdf) { try { await detail.pdf.destroy(); } catch (_) {} }
      }
    })();
  }

  function renderAuditPage() {
    const page = document.getElementById("audit-page");
    if (!page) return;
    disposeArchive();
    const pageEpoch = ++pageGeneration;
    page.replaceChildren();
    if (!status().authenticated || page.hidden || page.closest("[hidden]")) return;
    const view = { page, pageEpoch, epoch: generation, load: 0, disposed: false, controller: new AbortController(), detail: null, buffers: new Set() };
    archiveView = view;
    const panel = node("section", undefined, "audit-panel traza-archive-panel");
    const header = node("div", undefined, "traza-archive-header");
    const heading = node("div");
    heading.append(node("h2", "Archivo de salidas"), node("p", "Consulta las salidas compartidas. Sus unidades se comprueban automáticamente con el PDF original.", "audit-muted"));
    const newOutput = button("Nueva salida");
    newOutput.addEventListener("click", function () { if (window.TrazaUI) window.TrazaUI.navigate("converter"); else location.href = "index.html#nueva-salida"; });
    header.append(heading, newOutput);
    panel.append(header);
    const form = node("form", undefined, "audit-form audit-search");
    const search = field(form, "Número exacto de salida", "search", "search", { required: false, maxLength: 60, placeholder: "Ejemplo: 0029307", autocomplete: "off" });
    const from = field(form, "Desde", "from", "date", { required: false, autocomplete: "off" });
    const to = field(form, "Hasta", "to", "date", { required: false, autocomplete: "off" });
    const authorWrapper = node("div", undefined, "audit-field");
    const authorLabel = node("label", "Responsable");
    const author = node("select");
    author.id = "audit-cloud-author";
    authorLabel.htmlFor = author.id;
    const allAuthors = node("option", "Todos los responsables");
    allAuthors.value = "";
    author.append(allAuthors);
    authorWrapper.append(authorLabel, author);
    search.value = archiveFilters.query;
    from.value = archiveFilters.from;
    to.value = archiveFilters.to;
    const submit = button("Buscar");
    submit.type = "submit";
    const clear = button("Limpiar", true);
    const refresh = button("Actualizar", true);
    form.append(authorWrapper, submit, clear, refresh);
    const quick = node("div", undefined, "traza-quick-filters");
    quick.setAttribute("aria-label", "Accesos rápidos por fecha");
    const result = node("div");
    result.setAttribute("aria-live", "polite");
    const summary = node("div", undefined, "traza-archive-summary");
    const totalText = node("span", "", "traza-total-count");
    const unitsText = node("span", "", "traza-units-count");
    summary.append(totalText, unitsText);
    const layout = node("div", undefined, "traza-archive-layout");
    view.layout = layout;
    const recordsArea = node("div", undefined, "traza-records");
    layout.append(recordsArea);
    panel.append(form, quick, result, summary, layout);
    page.append(panel);
    let authorNames = new Map();
    let authorsLoaded = false;
    let pageController = null;

    function applyFilters() {
      const value = search.value.trim();
      if (value && !/^\d{1,60}$/.test(value)) { feedback(result, "Ingresa solo el número exacto de la salida, incluidos sus ceros iniciales.", true); return false; }
      if ((from.value && !validDate(from.value)) || (to.value && !validDate(to.value))) { feedback(result, "Selecciona fechas reales y completas.", true); return false; }
      if (from.value && to.value && from.value > to.value) { feedback(result, "La fecha «Desde» no puede ser posterior a «Hasta».", true); return false; }
      if (author.value && !UUID.test(author.value)) { feedback(result, "Selecciona un responsable válido.", true); return false; }
      Object.assign(archiveFilters, { query: value, from: from.value, to: to.value, author: author.value, page: 1 });
      loadRecords();
      return true;
    }

    async function loadRecords() {
      if (window.TrazaSavedFile) window.TrazaSavedFile.clear();
      disposeDetail(view, false);
      for (const clear of view.buffers) { try { clear.fill(0); } catch (_) {} }
      view.buffers.clear();
      if (pageController) pageController.abort();
      pageController = new AbortController();
      view.loadController = pageController;
      const controller = pageController;
      const stop = function () { controller.abort(); };
      view.controller.signal.addEventListener("abort", stop, { once: true });
      const sequence = ++view.load;
      const key = master;
      const guard = function () { assertView(view, sequence); if (controller.signal.aborted) throw new Error("La vista cambió."); };
      result.replaceChildren();
      recordsArea.replaceChildren(node("p", "Cargando el archivo…", "audit-state"));
      recordsArea.setAttribute("aria-busy", "true");
      totalText.textContent = unitsText.textContent = "";
      submit.disabled = clear.disabled = refresh.disabled = true;
      try {
        let path = "/rest/v1/mega_audit_records?workspace_id=eq." + CONFIG.workspace + "&select=*&order=created_at.desc,id.desc&limit=" + PAGE_SIZE + "&offset=" + ((archiveFilters.page - 1) * PAGE_SIZE);
        if (archiveFilters.query) {
          const tag = await key.blindIndex(archiveFilters.query);
          guard();
          path += "&salida_tag=eq." + tag;
        }
        if (archiveFilters.author) path += "&created_by=eq." + archiveFilters.author;
        if (archiveFilters.from) path += "&created_at=gte." + encodeURIComponent(archiveFilters.from + "T00:00:00-05:00");
        if (archiveFilters.to) {
          const end = new Date(archiveFilters.to + "T00:00:00-05:00");
          end.setUTCDate(end.getUTCDate() + 1);
          path += "&created_at=lt." + encodeURIComponent(end.toISOString());
        }
        const responses = await Promise.all([
          request(path, { headers: { Prefer: "count=exact" }, raw: true, signal: controller.signal }),
          request("/rest/v1/rpc/mega_audit_authors", { method: "POST", body: { p_workspace_id: CONFIG.workspace }, signal: controller.signal })
        ]);
        guard();
        const authors = responses[1];
        if (!Array.isArray(authors)) throw new Error("No se pudo verificar quién generó cada salida.");
        authorNames = new Map(authors.filter(function (entry) { return entry && UUID.test(entry.user_id) && typeof entry.username === "string"; }).map(function (entry) { return [entry.user_id, entry.username]; }));
        const desiredAuthor = authorsLoaded ? author.value : archiveFilters.author;
        author.replaceChildren(allAuthors);
        for (const [id, name] of authorNames) { const option = node("option", "@" + name); option.value = id; author.append(option); }
        author.value = desiredAuthor;
        authorsLoaded = true;
        const rows = await responses[0].json();
        guard();
        if (!Array.isArray(rows)) throw new Error("El archivo recibido no es válido.");
        const outcomes = await Promise.allSettled(rows.map(async function (entry) {
          const decoded = await decryptedRecord(entry, key);
          guard();
          decoded.unitRevision = entry.encrypted_metadata;
          decoded.unitCheck = { state: "checking", originalUnits: decoded.total_units, originalRowCount: decoded.row_count, changed: false };
          return decoded;
        }));
        guard();
        const verified = outcomes.filter(function (outcome) { return outcome.status === "fulfilled"; }).map(function (outcome) { return outcome.value; });
        const damaged = rows.length - verified.length;
        const count = /\/(\d+)$/.exec(responses[0].headers.get("Content-Range") || "");
        const total = count ? Number(count[1]) : null;
        totalText.textContent = total === null ? rows.length + " salidas en esta página" : total + (total === 1 ? " salida encontrada" : " salidas encontradas");
        function updatePageUnits() {
          guard();
          const checking = verified.filter(function (record) { return record.unitCheck.state === "checking"; }).length;
          const confirmed = verified.filter(function (record) { return record.unitCheck.state === "verified"; });
          const incomplete = damaged || checking || confirmed.length !== verified.length;
          const totalUnits = confirmed.reduce(function (sum, record) { return sum + record.total_units; }, 0);
          unitsText.textContent = (incomplete ? "Unidades verificadas en esta página: " : "Unidades en esta página: ") + totalUnits.toLocaleString("es-PA", { maximumFractionDigits: 2 }) +
            (checking ? " · Verificando " + checking + (checking === 1 ? " salida…" : " salidas…") : "");
          unitsText.dataset.unitState = checking ? "checking" : incomplete ? "unverified" : "verified";
        }
        updatePageUnits();
        const unitCells = [];
        recordsArea.replaceChildren();
        if (!rows.length) {
          const filtered = archiveFilters.query || archiveFilters.from || archiveFilters.to || archiveFilters.author;
          recordsArea.append(node("p", filtered ? "No hay salidas que coincidan con los filtros." : "El archivo está vacío. Crea una nueva salida para comenzar.", "audit-empty"));
        } else {
          const wrap = node("div", undefined, "audit-table-wrap");
          const table = node("table", undefined, "audit-table");
          table.setAttribute("aria-label", "Archivo de salidas");
          const head = node("thead");
          const headings = node("tr");
          const titles = ["Salida", "Responsable", "Fecha y hora", "Unidades", "Documentos", "Acciones"];
          for (const title of titles) { const th = node("th", title); th.scope = "col"; headings.append(th); }
          head.append(headings);
          const body = node("tbody");
          for (let index = 0; index < outcomes.length; index++) {
            const outcome = outcomes[index];
            const official = rows[index] || {};
            const officialName = authorNames.get(official.created_by);
            const when = formatWhen(official.created_at);
            const row = node("tr", undefined, outcome.status === "fulfilled" ? "" : "audit-cloud-unreadable");
            const cells = titles.map(function (title) { const td = node("td"); td.dataset.label = title; return td; });
            cells[1].textContent = officialName ? "@" + officialName : "Responsable no disponible";
            cells[2].append(node("span", when.date), node("span", when.time, "audit-muted"));
            if (outcome.status !== "fulfilled") {
              cells[0].append(node("strong", "Salida no verificable"), node("span", String(official.id || "Identificador no disponible"), "audit-muted"));
              cells[3].textContent = "No disponibles";
              cells[3].dataset.unitState = "unverified";
              const docs = node("div", undefined, "audit-documents");
              for (const label of ["Guardar PDF", "Guardar Excel"]) { const disabled = button(label, true); disabled.disabled = true; docs.append(disabled); }
              cells[4].append(docs);
              cells[5].textContent = "No se pudo descifrar";
            } else {
              const record = outcome.value;
              cells[0].append(node("strong", "Salida " + record.salida_numero));
              cells[3].textContent = unitsTextFor(record);
              cells[3].dataset.unitState = "checking";
              unitCells.push({ record, cell: cells[3] });
              const docs = node("div", undefined, "audit-documents");
              docs.append(documentButton(record, "pdf", "Guardar PDF", result, view), documentButton(record, "excel", "Guardar Excel", result, view));
              cells[4].append(docs);
              const open = button("Detalle", true);
              open.setAttribute("aria-label", "Abrir detalle de salida " + record.salida_numero);
              open.addEventListener("click", function () { openDetail(view, record, officialName, open); });
              cells[5].append(open, editButton(record, result, view));
            }
            row.append.apply(row, cells);
            body.append(row);
          }
          table.append(head, body);
          wrap.append(table);
          recordsArea.append(wrap);
          if (damaged) feedback(result, damaged + (damaged === 1 ? " salida no pudo descifrarse." : " salidas no pudieron descifrarse.") + " Sus filas permanecen visibles; los documentos y unidades no verificables están desactivados.", true);
        }
        const pagination = node("div", undefined, "audit-pagination");
        const pages = total === null ? "" : " de " + Math.max(1, Math.ceil(total / PAGE_SIZE));
        pagination.append(node("span", "Página " + archiveFilters.page + pages, "audit-muted"));
        const actions = node("div", undefined, "audit-actions");
        const previous = button("Anterior", true);
        const next = button("Siguiente", true);
        previous.disabled = archiveFilters.page <= 1;
        next.disabled = total === null ? rows.length < PAGE_SIZE : archiveFilters.page * PAGE_SIZE >= total;
        previous.addEventListener("click", function () { archiveFilters.page--; loadRecords(); });
        next.addEventListener("click", function () { archiveFilters.page++; loadRecords(); });
        actions.append(previous, next);
        pagination.append(actions);
        recordsArea.append(pagination);
        // Filters stay usable while the PDFs are checked. A new load aborts
        // this queue and its parser tasks before a late response can update UI.
        submit.disabled = clear.disabled = refresh.disabled = false;
        let nextUnit = 0;
        async function verifyNext() {
          while (nextUnit < unitCells.length) {
            guard();
            const item = unitCells[nextUnit++];
            const record = item.record;
            try {
              const summary = await verifyRecordUnits(record, view, key, controller, guard);
              guard();
              record.unitCheck.changed = summary.totalUnits !== record.unitCheck.originalUnits || summary.rowCount !== record.unitCheck.originalRowCount;
              record.total_units = summary.totalUnits;
              record.row_count = summary.rowCount;
              record.unitCheck.state = "verified";
            } catch (error) {
              guard();
              record.unitCheck.state = "unverified";
              record.unitCheck.message = "No se pudieron verificar las unidades. " + errorText(error) + " Usa Actualizar para intentarlo de nuevo.";
            }
            guard();
            item.cell.replaceChildren(node("span", unitsTextFor(record)));
            item.cell.dataset.unitState = record.unitCheck.state;
            if (record.unitCheck.state === "unverified") {
              item.cell.append(node("span", record.unitCheck.message, "audit-muted"));
            } else if (record.unitCheck.changed) {
              item.cell.append(node("span", "Corregidas desde el PDF", "audit-muted"));
            }
            updateDetailUnits(view, record);
            updatePageUnits();
          }
        }
        await Promise.all([verifyNext(), verifyNext()]);
        guard();
      } catch (error) {
        if (archiveView !== view || view.disposed || sequence !== view.load || view.epoch !== generation) return;
        recordsArea.replaceChildren(node("p", "No se pudo cargar el archivo. Usa Actualizar para intentarlo nuevamente.", "audit-state"));
        feedback(result, errorText(error), true);
      } finally {
        view.controller.signal.removeEventListener("abort", stop);
        if (archiveView === view && sequence === view.load) {
          submit.disabled = clear.disabled = refresh.disabled = false;
          recordsArea.setAttribute("aria-busy", "false");
        }
      }
    }
    form.addEventListener("submit", function (event) { event.preventDefault(); applyFilters(); });
    clear.addEventListener("click", function () { search.value = from.value = to.value = author.value = ""; applyFilters(); });
    refresh.addEventListener("click", function () { verifiedUnitSummaries.clear(); loadRecords(); });
    for (const label of ["Todo", "Hoy", "Esta semana", "Este mes"]) {
      const shortcut = button(label, true);
      shortcut.addEventListener("click", function () {
        if (label === "Todo") from.value = to.value = "";
        else {
          const today = panamaToday();
          to.value = today;
          const date = new Date(today + "T00:00:00Z");
          if (label === "Esta semana") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
          if (label === "Este mes") date.setUTCDate(1);
          from.value = date.toISOString().slice(0, 10);
        }
        applyFilters();
      });
      quick.append(shortcut);
    }
    loadRecords();
  }

  async function openUsersDialog(opener) {
    const epoch = generation;
    let modal;
    try {
      assertAccount(epoch, true);
      modal = createDialog("Usuarios y permisos", opener);
      modal.content.append(node("p", "Comprobando permisos…", "audit-state"));
      await requireAdmin(epoch);
      if (!modal.dialog.open) return;
      renderUserManagement(modal.content, modal.dialog, epoch);
    } catch (error) { if (modal && modal.dialog.open && epoch === generation) feedback(modal.content, errorText(error), true); }
  }

  async function openSecurityDialog(opener) {
    const epoch = generation;
    let modal;
    try {
      assertAccount(epoch, true);
      modal = createDialog("Seguridad", opener);
      modal.content.append(node("p", "Comprobando permisos…", "audit-state"));
      await requireAdmin(epoch);
      if (!modal.dialog.open) return;
      const explanation = node("p", "Guarda una copia privada de la clave de recuperación. Permite recuperar el archivo completo; consérvala en un lugar seguro y no la compartas.", "audit-muted");
      const download = button("Guardar clave de recuperación");
      const result = node("div");
      modal.content.replaceChildren(explanation, download, result);
      download.addEventListener("click", async function () {
        const selection = picker("MegaControl — Clave privada de recuperación.txt", "text");
        let clear;
        const wipe = function () { if (clear) clear.fill(0); };
        modal.dialog.addEventListener("close", wipe, { once: true });
        const guard = function () { assertAccount(epoch, true); if (!modal.dialog.open || !recoveryKey) throw new Error("La vista cambió."); };
        download.disabled = true;
        try {
          const handle = selection ? await selection : null;
          guard();
          await requireAdmin(epoch);
          guard();
          clear = new TextEncoder().encode("MegaControl — CLAVE PRIVADA DE RECUPERACIÓN\nNo la compartas ni la subas a GitHub o Supabase. Permite descifrar todo el archivo.\n\nAuditoría: " + CONFIG.workspace + "\n\n" + recoveryKey + "\n");
          const message = await writeDownload(clear, handle, "MegaControl — Clave privada de recuperación.txt", "text/plain;charset=utf-8", guard);
          guard();
          feedback(result, message, false);
        } catch (error) {
          if (epoch === generation && modal.dialog.open) feedback(result, error.name === "AbortError" ? "Guardado cancelado." : errorText(error), error.name !== "AbortError");
        } finally { wipe(); modal.dialog.removeEventListener("close", wipe); download.disabled = false; }
      });
    } catch (error) { if (modal && modal.dialog.open && epoch === generation) feedback(modal.content, errorText(error), true); }
  }

  function renderUserManagement(parent, dialog, userGeneration) {
    parent.replaceChildren(node("p", "Crea una cuenta para cada compañero y selecciona sus permisos.", "audit-muted"));
    const form = node("form", undefined, "audit-form audit-cloud-form");
    const name = field(form, "Usuario", "user-username", "text", { minLength: 3, autocomplete: "off" });
    const password = field(form, "Contraseña inicial o actual", "user-password", "password", { minLength: 12, autocomplete: "new-password" });
    const repeat = field(form, "Repite la contraseña", "user-repeat", "password", { minLength: 12, autocomplete: "new-password" });
    const roleWrapper = node("div", undefined, "audit-field");
    const roleLabel = node("label", "Permisos");
    const role = node("select");
    role.id = "audit-cloud-user-role";
    roleLabel.htmlFor = role.id;
    for (const pair of [["user", "Usuario"], ["admin", "Administrador"]]) { const option = node("option", pair[1]); option.value = pair[0]; role.append(option); }
    roleWrapper.append(roleLabel, role);
    const submit = button("Crear usuario");
    submit.type = "submit";
    form.append(roleWrapper, submit);
    passwordToggle(form, [password, repeat]);
    const result = node("div");
    const usersArea = node("div");
    parent.append(form, result, usersArea);
    const guard = function () { assertAccount(userGeneration, true); if (!dialog.open) throw new Error("La vista cambió."); };
    async function loadUsers() {
      usersArea.replaceChildren(node("p", "Cargando usuarios…", "audit-state"));
      try {
        guard();
        const users = await rpc("mega_audit_list_members", { p_workspace_id: CONFIG.workspace });
        guard();
        if (!Array.isArray(users)) throw new Error("La lista de usuarios no es válida.");
        const table = node("table", undefined, "audit-table");
        const head = node("thead");
        const headings = node("tr");
        for (const label of ["Usuario", "Permisos", "Creado · Panamá"]) { const cell = node("th", label); cell.scope = "col"; headings.append(cell); }
        head.append(headings);
        const body = node("tbody");
        for (const user of users) {
          const row = node("tr");
          const when = formatWhen(user.created_at);
          for (const pair of [["Usuario", "@" + user.username], ["Permisos", user.role === "admin" ? "Administrador" : "Usuario"], ["Creado", when.date + " " + when.time]]) { const cell = node("td", pair[1]); cell.dataset.label = pair[0]; row.append(cell); }
          body.append(row);
        }
        table.append(head, body);
        usersArea.replaceChildren(table);
      } catch (error) { if (userGeneration === generation && dialog.open) { usersArea.replaceChildren(); feedback(result, errorText(error), true); } }
    }
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (password.value !== repeat.value) { feedback(result, "Las contraseñas no coinciden. Revisa ambas con «Mostrar contraseña».", true); return; }
      submit.disabled = true;
      feedback(result, "Creando usuario…", false);
      try {
        guard();
        await createMember(name.value, password.value, role.value, guard);
        guard();
        form.reset();
        feedback(result, "Usuario creado. Ya puede iniciar sesión.", false);
        await loadUsers();
        guard();
      } catch (error) { if (userGeneration === generation && dialog.open) feedback(result, errorText(error), true); }
      finally { password.value = repeat.value = ""; submit.disabled = false; }
    });
    loadUsers();
  }

  function initialise() {
    try { validateConfiguration(); renderAccountBar(); renderAuditPage(); }
    catch (error) { const bar = document.getElementById("audit-bar"); if (bar) feedback(bar, errorText(error), true); }
  }

  // The mobile view reuses this session and parser without exposing tokens or keys.
  async function mobileSnapshot(signal) {
    const epoch = generation;
    assertAccount(epoch);
    if (!status().authenticated) throw new Error("Inicia sesión para consultar productos.");
    const result = [];
    for (let offset = 0; ; offset += 500) {
      const rows = await request("/rest/v1/mega_audit_records?workspace_id=eq." + CONFIG.workspace + "&select=id,created_at,encrypted_metadata&order=created_at.desc,id.desc&limit=500&offset=" + offset, { signal });
      assertAccount(epoch);
      if (!Array.isArray(rows) || rows.some(row => !UUID.test(row.id) || typeof row.encrypted_metadata !== "string")) throw new Error("El historial recibido no es válido.");
      result.push(...rows);
      if (rows.length < 500) return result;
    }
  }

  function getMobileCatalog() {
    if (!status().authenticated) throw new Error("Inicia sesión para consultar productos.");
    if (mobileCatalog) return mobileCatalog;
    if (!window.MobileCatalog) throw new Error("Actualiza la página para cargar el índice de productos.");
    const key = master, epoch = generation;
    const guard = function () { assertAccount(epoch); if (!status().authenticated || master !== key) throw new Error("La sesión cambió."); };
    mobileCatalog = window.MobileCatalog.create({
      cache: window.MobileCatalog.cache(CONFIG.workspace + "|" + key.fingerprint),
      snapshot: mobileSnapshot,
      document: mobileProducts,
      async seal(value) {
        guard();
        const data = new TextEncoder().encode(JSON.stringify(value));
        try { const ciphertext = await key.encrypt(data, "mobile-catalog-v1"); guard(); return base64(ciphertext); }
        finally { data.fill(0); }
      },
      async unseal(value) {
        guard();
        const data = await key.decrypt(unbase64(value), "mobile-catalog-v1");
        try { guard(); return JSON.parse(new TextDecoder().decode(data)); }
        finally { data.fill(0); }
      },
      async verifyAccess(signal) {
        guard();
        const rows = await request(ownQuery("mega_audit_members", "role"), { signal });
        guard();
        if (!Array.isArray(rows) || rows.length !== 1 || !["admin", "user"].includes(rows[0].role)) {
          clearSession(); throw new Error("Tu cuenta ya no tiene acceso al historial.");
        }
      }
    });
    return mobileCatalog;
  }

  async function mobileProducts(id, signal) {
    if (!UUID.test(String(id))) throw new Error("Documento inválido.");
    const epoch = generation;
    const key = master;
    const guard = function () {
      assertAccount(epoch);
      if (!status().authenticated || master !== key || (signal && signal.aborted)) throw new Error("Consulta cancelada.");
    };
    guard();
    const rows = await request("/rest/v1/mega_audit_records?workspace_id=eq." + CONFIG.workspace + "&id=eq." + id + "&select=*&limit=2", { signal });
    guard();
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("No tienes acceso a este documento.");
    const meta = await decryptedRecord(rows[0], key);
    guard();
    let data;
    try {
      data = await getDocument(rows[0], "pdf", key, guard, signal);
      const result = await window.TrazaConverter.analyzeUnits({ data, expectedNumber: meta.salida_numero, assertCurrent: guard, signal, includeProducts: true });
      guard();
      return { products: result.products, salida: meta.salida_numero, date: rows[0].created_at };
    } finally { if (data) data.fill(0); }
  }

  window.AuditCloud = Object.freeze({ ready, status, record, confirmArchivedRecord, newIdempotencyKey,
    mobile: Object.freeze({ login, logout: clearSession, prepare: (progress, signal) => getMobileCatalog().prepare(progress, signal), lookup: (code, signal) => getMobileCatalog().lookup(code, signal), hasUpdates: signal => getMobileCatalog().hasUpdates(signal) }) });
  window.addEventListener("audit:recorded", function () { if (document.getElementById("audit-page")) renderAuditPage(); });
  window.addEventListener("traza-ui:navigated", function () {
    for (const dialog of openDialogs) dialog.close();
    renderAuditPage();
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialise, { once: true });
  else initialise();
})();
