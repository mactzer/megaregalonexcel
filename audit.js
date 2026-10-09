(function () {
  "use strict";

  if (window.AuditCloud && document.documentElement.dataset.auditRequired !== "true") {
    window.AuditClient = window.AuditCloud;
    return;
  }

  if (document.documentElement.dataset.auditRequired !== "true" &&
      (document.documentElement.dataset.auditProvider === "supabase" || window.SUPABASE_AUDIT_CONFIG)) {
    const failed = function () { throw new Error("No se pudo cargar la auditoría de Supabase. Actualiza la página antes de descargar."); };
    window.AuditClient = Object.freeze({ ready: async function () { failed(); }, record: async function () { failed(); }, newIdempotencyKey: failed });
    const showFailure = function () {
      const bar = document.getElementById("audit-bar");
      if (bar) bar.textContent = "No se pudo cargar la auditoría de Supabase. Actualiza la página.";
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showFailure, { once: true });
    else showFailure();
    return;
  }

  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const PAGE_SIZE = 25;
  const API_ROOT = "/api";
  let currentStatus = null;
  let statusPromise = null;
  let pageGeneration = 0;
  let authenticationGeneration = 0;
  let loginInProgress = false;
  const archiveEdits = new Set();
  const unitVerifications = new Set();

  function status() {
    return {
      mode: currentStatus ? currentStatus.mode : "intranet",
      authenticated: Boolean(currentStatus && currentStatus.authenticated),
      user: currentStatus && currentStatus.user ? Object.assign({}, currentStatus.user) : null,
      generation: authenticationGeneration
    };
  }

  function cancelArchiveEdits() {
    for (const controller of archiveEdits) controller.abort();
    archiveEdits.clear();
  }

  function cancelUnitVerifications() {
    for (const controller of unitVerifications) controller.abort();
    unitVerifications.clear();
  }

  function clearSession() {
    authenticationGeneration++;
    cancelArchiveEdits();
    cancelUnitVerifications();
    currentStatus = { mode: "intranet", authenticated: false, user: null, csrf_token: null };
    window.dispatchEvent(new CustomEvent("traza:session-cleared"));
    renderAccountBar();
    renderAuditPage();
  }

  function setStatus(next) {
    if (currentStatus && currentStatus.authenticated && !next.authenticated) {
      clearSession();
      return;
    }
    const before = currentStatus && currentStatus.user && currentStatus.user.id;
    const after = next.user && next.user.id;
    if (Boolean(currentStatus && currentStatus.authenticated) !== Boolean(next.authenticated) || before !== after) {
      authenticationGeneration++;
      cancelArchiveEdits();
      cancelUnitVerifications();
    }
    currentStatus = next;
  }

  function assertAuthentication(snapshot) {
    const now = status();
    if (!snapshot.authenticated || !now.authenticated || snapshot.generation !== now.generation ||
        !snapshot.user || !now.user || String(snapshot.user.id) !== String(now.user.id)) {
      throw new Error("La sesión cambió. Inicia sesión nuevamente.");
    }
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function button(text, className) {
    const node = element("button", text, "audit-button" + (className ? " " + className : ""));
    node.type = "button";
    return node;
  }

  function field(form, labelText, name, type, options) {
    const wrapper = element("div", undefined, "audit-field" + (options && options.wide ? " audit-field-wide" : ""));
    const label = element("label", labelText);
    const input = element("input");
    input.name = name;
    input.id = "audit-" + name;
    input.type = type || "text";
    label.htmlFor = input.id;
    if (options) {
      for (const key of ["required", "minLength", "maxLength", "placeholder"]) {
        if (options[key] !== undefined) input[key] = options[key];
      }
      if (options.autoComplete !== undefined) input.setAttribute("autocomplete", options.autoComplete);
    }
    wrapper.append(label, input);
    form.append(wrapper);
    return input;
  }

  function message(text, isError) {
    const node = element("p", text, "audit-message " + (isError ? "audit-error" : "audit-success"));
    node.setAttribute("role", isError ? "alert" : "status");
    return node;
  }

  function showMessage(container, text, isError) {
    container.replaceChildren(message(text, isError));
  }

  function errorText(error) {
    return error && error.message ? error.message : "No se pudo completar la operación. Inténtalo de nuevo.";
  }

  async function request(path, options) {
    options = options || {};
    const epoch = authenticationGeneration;
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.method && options.method !== "GET" && currentStatus && currentStatus.csrf_token) {
      headers.set("X-CSRF-Token", currentStatus.csrf_token);
    }
    let response;
    try {
      response = await fetch(API_ROOT + path, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "same-origin",
        cache: "no-store",
        signal: options.signal
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error("No se pudo conectar con el equipo que guarda la auditoría. Comprueba que esté encendido y vuelve a intentarlo.");
    }
    if (response.status === 401 && options.sessionAware !== false && epoch === authenticationGeneration &&
        currentStatus && currentStatus.mode === "intranet") clearSession();
    let result;
    try { result = await response.json(); }
    catch (error) {
      throw new Error("El equipo de auditoría devolvió una respuesta inválida. Vuelve a intentarlo.");
    }
    if (!response.ok) {
      const serverError = typeof result.error === "string" ? result.error : result.message;
      throw new Error(serverError || (response.status === 401 ? "Tu sesión ha terminado. Inicia sesión nuevamente." : "No se pudo completar la operación."));
    }
    if (options.sessionAware !== false && epoch !== authenticationGeneration) {
      throw new Error("La sesión cambió. Inicia sesión nuevamente.");
    }
    return result;
  }

  async function loadStatus() {
    const requiresAudit = document.documentElement.dataset.auditRequired === "true";
    if (window.location.protocol === "file:") {
      if (requiresAudit) throw new Error("Abre la auditoría desde la dirección del equipo interno, con el servicio encendido.");
      return { mode: "static", authenticated: false };
    }
    let response;
    try {
      response = await fetch(API_ROOT + "/status", { credentials: "same-origin", cache: "no-store" });
    } catch (error) {
      throw new Error("No se pudo comprobar la conexión con la auditoría. Vuelve a intentarlo antes de descargar.");
    }
    if (response.status === 404) {
      if (requiresAudit || (currentStatus && currentStatus.mode === "intranet")) {
        throw new Error("El servicio interno de auditoría no está disponible. Vuelve a intentarlo antes de descargar.");
      }
      return { mode: "static", authenticated: false };
    }
    if (!response.ok) throw new Error("La auditoría no está disponible. Vuelve a intentarlo antes de descargar.");
    let result;
    try { result = await response.json(); }
    catch (error) { throw new Error("La respuesta de la auditoría no es válida. Vuelve a intentarlo."); }
    if (!result || result.mode !== "intranet" || typeof result.authenticated !== "boolean") {
      throw new Error("No se pudo identificar el servicio de auditoría de esta página.");
    }
    if (result.authenticated && (!result.user || !result.csrf_token)) {
      throw new Error("La sesión de auditoría no es válida. Actualiza la página.");
    }
    return result;
  }

  async function ready() {
    if (!statusPromise) {
      const epoch = authenticationGeneration;
      statusPromise = loadStatus().then(function (status) {
        if (epoch !== authenticationGeneration) throw new Error("La sesión cambió. Inicia sesión nuevamente.");
        setStatus(status);
        renderAccountBar();
        renderAuditPage();
        return status;
      }).catch(function (error) {
        if (epoch === authenticationGeneration) renderConnectionError(error);
        throw error;
      });
    }
    await statusPromise;
    return currentStatus;
  }

  function newIdempotencyKey() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== "function") {
      throw new Error("Este navegador no permite crear el identificador de auditoría. Usa una versión actual de Chrome o Edge.");
    }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, function (value) { return value.toString(16).padStart(2, "0"); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  async function confirmArchivedRecord(recordId, options) {
    await ready();
    const account = status();
    assertAuthentication(account);
    if (typeof recordId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) {
      throw new Error("No se pudo identificar la salida del archivo.");
    }
    const result = await request("/audits/" + encodeURIComponent(recordId), { signal: options && options.signal });
    assertAuthentication(account);
    if (!result || !result.record || result.record.id !== recordId || typeof result.record.salida_numero !== "string" ||
        typeof result.record.pdf_name !== "string" || typeof result.record.excel_name !== "string") {
      throw new Error("No se pudo confirmar la salida del archivo. Actualiza el historial.");
    }
    return result.record;
  }

  function asBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error("No se pudo preparar el Excel para guardarlo en la auditoría.");
  }

  function base64(bytes) {
    const chunks = [];
    for (let start = 0; start < bytes.length; start += 32768) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(start, start + 32768)));
    }
    return btoa(chunks.join(""));
  }

  async function record(options) {
    const beforeReady = status();
    const service = await ready();
    if (service.mode === "static") return null;
    if (beforeReady.authenticated) assertAuthentication(beforeReady);
    const account = status();
    if (!account.authenticated) {
      const input = document.getElementById("audit-login-username");
      if (input) input.focus();
      throw new Error("Inicia sesión en la auditoría antes de descargar el Excel.");
    }
    if (!options.pdfFile || typeof options.pdfFile.arrayBuffer !== "function") {
      throw new Error("El PDF original no está disponible. Vuelve a cargarlo antes de descargar.");
    }
    const excelBytes = asBytes(options.excelBytes);
    if (options.pdfFile.size > MAX_FILE_BYTES || excelBytes.byteLength > MAX_FILE_BYTES) {
      throw new Error("La auditoría permite un máximo de 25 MB por documento (PDF o Excel).");
    }
    const pdfBytes = new Uint8Array(await options.pdfFile.arrayBuffer());
    try {
      assertAuthentication(account);
      const result = await request("/audits", {
        method: "POST",
        headers: { "Idempotency-Key": options.idempotencyKey || newIdempotencyKey() },
        body: {
          salida_numero: String(options.salidaNumero),
          row_count: options.rowCount,
          total_units: options.totalUnits,
          pdf_name: options.pdfFile.name,
          pdf_base64: base64(pdfBytes),
          excel_base64: base64(excelBytes)
        }
      });
      assertAuthentication(account);
      const savedRecord = result && result.record;
      if (!savedRecord || savedRecord.id === undefined || String(savedRecord.salida_numero) !== String(options.salidaNumero)) {
        throw new Error("No se pudo confirmar el registro de esta salida. Intenta descargarla nuevamente.");
      }
      window.dispatchEvent(new CustomEvent("audit:recorded", { detail: savedRecord }));
      return savedRecord;
    } finally { pdfBytes.fill(0); }
  }

  function renderConnectionError(error) {
    const bar = document.getElementById("audit-bar");
    if (bar) {
      const panel = element("section", undefined, "audit-panel");
      panel.append(message(errorText(error), true));
      const retry = button("Comprobar conexión de nuevo", "audit-button-secondary");
      retry.addEventListener("click", function () {
        retry.disabled = true;
        statusPromise = null;
        ready().catch(function () {});
      });
      panel.append(retry);
      bar.replaceChildren(panel);
    }
    const page = document.getElementById("audit-page");
    if (page) page.replaceChildren();
  }

  function renderAccountBar() {
    const bar = document.getElementById("audit-bar");
    if (!bar || !currentStatus) return;
    if (currentStatus.mode === "intranet") {
      const privacyNote = document.querySelector(".privacy-note");
      if (privacyNote) {
        const dot = element("span", undefined, "privacy-dot");
        dot.setAttribute("aria-hidden", "true");
        privacyNote.replaceChildren(dot, document.createTextNode("Conversión local · historial en la red de la empresa"));
      }
    }
    const panel = element("section", undefined, "audit-panel");
    if (currentStatus.mode === "static") {
      const account = element("div", undefined, "audit-account");
      const text = element("div");
      text.append(element("strong", "Conversión local en tu navegador", "audit-account-name"));
      text.append(element("span", "Esta dirección no guarda un historial compartido.", "audit-muted"));
      account.append(text);
      if (!document.getElementById("audit-page")) {
        const link = element("a", "Auditoría compartida", "audit-button audit-button-secondary");
        link.href = "audit.html";
        account.append(link);
      }
      panel.append(account);
    } else if (currentStatus.authenticated) {
      const account = element("div", undefined, "audit-account");
      const text = element("div");
      text.append(element("strong", currentStatus.user.display_name + " · @" + currentStatus.user.username, "audit-account-name"));
      text.append(element("span", "Al descargar, el PDF y el Excel se guardan en el equipo interno para el historial compartido.", "audit-muted"));
      const actions = element("div", undefined, "audit-actions");
      if (!document.getElementById("audit-page")) {
        const history = element("a", "Historial compartido", "audit-button audit-button-secondary");
        history.href = "audit.html";
        actions.append(history);
      }
      const logout = button("Cerrar sesión", "audit-button-secondary");
      logout.addEventListener("click", async function () {
        logout.disabled = true;
        const csrfToken = currentStatus.csrf_token;
        clearSession();
        const controller = new AbortController();
        const timeout = window.setTimeout(function () { controller.abort(); }, 8000);
        try {
          await request("/logout", { method: "POST", body: {}, headers: { "X-CSRF-Token": csrfToken }, signal: controller.signal, sessionAware: false });
        } catch (error) {
          // Local documents and session have already been removed. A remote
          // revocation failure must never restore them.
        } finally { window.clearTimeout(timeout); }
      });
      actions.append(logout);
      account.append(text, actions);
      panel.append(account);
    } else {
      panel.append(element("h2", "Inicia sesión en la auditoría"));
      panel.append(element("p", "Usa tu cuenta para que cada salida quede registrada a tu nombre.", "audit-muted"));
      const form = element("form", undefined, "audit-form");
      const username = field(form, "Usuario", "login-username", "text", { required: true, maxLength: 64, autoComplete: "username" });
      const password = field(form, "Contraseña", "login-password", "password", { required: true, maxLength: 1024, autoComplete: "current-password" });
      const submit = button("Iniciar sesión");
      submit.type = "submit";
      form.append(submit);
      const feedback = element("div");
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (loginInProgress) return;
        loginInProgress = true;
        submit.disabled = true;
        feedback.replaceChildren();
        const epoch = authenticationGeneration;
        try {
          const result = await request("/login", { method: "POST", body: { username: username.value.trim(), password: password.value }, sessionAware: false });
          if (epoch !== authenticationGeneration || !form.isConnected) return;
          if (!result.user || !result.csrf_token) throw new Error("No se pudo iniciar una sesión válida.");
          password.value = "";
          setStatus({ mode: "intranet", authenticated: true, user: result.user, csrf_token: result.csrf_token });
          renderAccountBar();
          renderAuditPage();
        } catch (error) {
          showMessage(feedback, errorText(error), true);
          password.value = "";
          password.focus();
        } finally {
          loginInProgress = false;
          submit.disabled = false;
        }
      });
      panel.append(form, feedback);
      panel.append(element("p", "Si aún no tienes una cuenta, solicítala al administrador del historial.", "audit-muted"));
    }
    bar.replaceChildren(panel);
  }

  function formatWhen(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return { date: String(value || "—"), time: "" };
    const dateParts = new Intl.DateTimeFormat("es-PA", {
      timeZone: "America/Panama", day: "2-digit", month: "2-digit", year: "numeric"
    }).formatToParts(date);
    const parts = Object.fromEntries(dateParts.map(function (part) { return [part.type, part.value]; }));
    return {
      date: parts.day + "/" + parts.month + "/" + parts.year,
      time: new Intl.DateTimeFormat("es-PA", {
        timeZone: "America/Panama", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
      }).format(date)
    };
  }

  function documentLink(recordId, kind, label) {
    const link = element("a", label, "audit-button audit-button-secondary audit-button-small");
    link.href = API_ROOT + "/audits/" + encodeURIComponent(recordId) + "/" + kind;
    return link;
  }

  async function archivedPdf(record, controller, guard) {
    let response;
    try {
      response = await fetch(API_ROOT + "/audits/" + encodeURIComponent(record.id) + "/pdf", {
        credentials: "same-origin", cache: "no-store", signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error("No se pudo recuperar el PDF guardado. Comprueba la conexión y vuelve a intentarlo.");
    }
    guard();
    if (response.status === 401) {
      clearSession();
      throw new Error("Tu sesión ha terminado. Inicia sesión nuevamente.");
    }
    if (!response.ok) throw new Error("No se pudo recuperar el PDF guardado. Actualiza el archivo e inténtalo de nuevo.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      guard();
      if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error("El PDF guardado no es válido o supera el tamaño permitido.");
      return bytes;
    } catch (error) { bytes.fill(0); throw error; }
  }

  function renderAuditPage() {
    const page = document.getElementById("audit-page");
    if (!page || !currentStatus) return;
    cancelUnitVerifications();
    const generation = ++pageGeneration;
    page.replaceChildren();
    if (currentStatus.mode === "static") {
      const panel = element("section", undefined, "audit-panel");
      panel.append(element("h2", "El historial compartido necesita un equipo dentro de la empresa"));
      panel.append(element("p", "Esta página de GitHub Pages convierte documentos en el navegador. Para compartir una auditoría entre compañeros, abre la versión interna desde la dirección que te dé el administrador del historial."));
      panel.append(element("p", "En esa versión, los usuarios, las salidas, los PDF y los Excel se guardan en la computadora interna que la aloja. Todos consultan el mismo historial mientras ese equipo esté encendido y accesible en la red."));
      panel.append(element("p", "Puedes seguir convirtiendo archivos aquí; estas descargas no se registran en la auditoría interna.", "audit-muted"));
      const convert = element("a", "Volver al conversor", "audit-button");
      convert.href = "index.html";
      panel.append(convert);
      page.append(panel);
      return;
    }
    if (!currentStatus.authenticated) return;

    const panel = element("section", undefined, "audit-panel");
    panel.append(element("h2", "Buscar una salida"));
    panel.append(element("p", "Cada registro conserva el PDF original y el Excel generado. La fecha y la hora corresponden al momento en que el equipo interno guardó la salida.", "audit-muted"));
    const searchForm = element("form", undefined, "audit-form audit-search");
    const search = field(searchForm, "Número de salida", "search", "search", { wide: true, maxLength: 60, placeholder: "Ejemplo: 29307" });
    const submit = button("Buscar");
    submit.type = "submit";
    const clear = button("Ver todas", "audit-button-secondary");
    searchForm.append(submit, clear);
    const feedback = element("div");
    const recordsArea = element("div");
    panel.append(searchForm, feedback, recordsArea);
    page.append(panel);
    let query = "";
    let pageNumber = 1;
    let requestNumber = 0;

    async function loadRecords() {
      cancelArchiveEdits();
      cancelUnitVerifications();
      const currentRequest = ++requestNumber;
      feedback.replaceChildren();
      recordsArea.replaceChildren(element("p", "Cargando historial…", "audit-state"));
      submit.disabled = true;
      clear.disabled = true;
      try {
        const params = new URLSearchParams({ q: query, page: String(pageNumber) });
        const result = await request("/audits?" + params.toString());
        if (generation !== pageGeneration || currentRequest !== requestNumber) return;
        if (!Array.isArray(result.records) || !Number.isFinite(result.total)) throw new Error("El historial devolvió una respuesta inválida.");
        recordsArea.replaceChildren();
        if (!result.records.length) {
          recordsArea.append(element("p", query ? "No hay salidas que coincidan con ese número." : "Todavía no hay salidas registradas. Descarga un Excel en el conversor interno para crear el primer registro.", "audit-empty"));
        } else {
          const unitSummary = element("p", "Unidades verificadas en esta página: 0", "audit-muted");
          unitSummary.setAttribute("role", "status");
          recordsArea.append(unitSummary);
          const verificationRows = [];
          const wrap = element("div", undefined, "audit-table-wrap");
          const table = element("table", undefined, "audit-table");
          const caption = element("caption", "Historial de salidas");
          caption.hidden = true;
          const head = element("thead");
          const headRow = element("tr");
          for (const title of ["Salida", "Generada por", "Fecha y hora (Panamá)", "Productos / unidades", "Documentos"]) {
            const cell = element("th", title);
            cell.scope = "col";
            headRow.append(cell);
          }
          head.append(headRow);
          const body = element("tbody");
          for (const record of result.records) {
            const row = element("tr");
            const salida = element("td");
            salida.append(element("strong", "Salida " + record.salida_numero));
            const user = element("td", record.user_display_name || record.username);
            user.append(element("span", "@" + record.username, "audit-muted"));
            const when = formatWhen(record.created_at);
            const date = element("td", when.date, "audit-number");
            date.append(element("span", when.time, "audit-muted"));
            const amounts = element("td", "Verificando unidades…", "audit-number");
            amounts.dataset.unitState = "checking";
            verificationRows.push({ record, amounts });
            const docs = element("td");
            const links = element("div", undefined, "audit-documents");
            links.append(documentLink(record.id, "pdf", "PDF original"), documentLink(record.id, "excel", "Excel"));
            const edit = button("Editar Excel", "audit-button-secondary audit-button-small");
            edit.addEventListener("click", async function () {
              cancelArchiveEdits();
              const controller = new AbortController();
              archiveEdits.add(controller);
              const account = status();
              const viewGeneration = window.TrazaUI ? window.TrazaUI.generation : null;
              const selectedRequest = requestNumber;
              const guard = function () {
                assertAuthentication(account);
                if (controller.signal.aborted || generation !== pageGeneration || selectedRequest !== requestNumber ||
                    !edit.isConnected || (window.TrazaUI && (window.TrazaUI.currentSection !== "archive" || window.TrazaUI.generation !== viewGeneration))) {
                  throw new Error("La vista cambió. Abre de nuevo la salida que deseas editar.");
                }
              };
              let bytes;
              edit.disabled = true;
              feedback.replaceChildren(message("Recuperando el PDF de la salida…", false));
              try {
                guard();
                const confirmed = await confirmArchivedRecord(record.id, { signal: controller.signal });
                guard();
                bytes = await archivedPdf(confirmed, controller, guard);
                guard();
                if (!window.TrazaConverter || typeof window.TrazaConverter.openArchived !== "function") {
                  throw new Error("No se pudo abrir el editor. Actualiza la página e inténtalo de nuevo.");
                }
                const file = new File([bytes], confirmed.pdf_name, { type: "application/pdf" });
                await window.TrazaConverter.openArchived({ file, record: confirmed, authentication: account });
              } catch (error) {
                if (account.generation === authenticationGeneration && generation === pageGeneration && selectedRequest === requestNumber && edit.isConnected && !controller.signal.aborted) {
                  showMessage(feedback, errorText(error), true);
                }
              } finally {
                if (bytes) bytes.fill(0);
                archiveEdits.delete(controller);
                if (edit.isConnected) edit.disabled = false;
              }
            });
            links.append(edit);
            docs.append(links);
            row.append(salida, user, date, amounts, docs);
            body.append(row);
          }
          table.append(caption, head, body);
          wrap.append(table);
          recordsArea.append(wrap);
          verifyPageUnits(verificationRows, unitSummary, currentRequest);
        }
        const perPage = Number.isInteger(result.page_size) && result.page_size > 0 ? result.page_size : PAGE_SIZE;
        const totalPages = Math.max(1, Math.ceil(result.total / perPage));
        const pagination = element("div", undefined, "audit-pagination");
        pagination.append(element("span", result.total + (result.total === 1 ? " salida" : " salidas") + " · Página " + pageNumber + " de " + totalPages, "audit-muted"));
        const actions = element("div", undefined, "audit-actions");
        const prev = button("Anterior", "audit-button-secondary");
        const next = button("Siguiente", "audit-button-secondary");
        prev.disabled = pageNumber <= 1;
        next.disabled = pageNumber >= totalPages;
        prev.addEventListener("click", function () { pageNumber--; loadRecords(); });
        next.addEventListener("click", function () { pageNumber++; loadRecords(); });
        actions.append(prev, next);
        pagination.append(actions);
        recordsArea.append(pagination);
      } catch (error) {
        if (generation !== pageGeneration || currentRequest !== requestNumber) return;
        recordsArea.replaceChildren();
        showMessage(feedback, errorText(error), true);
      } finally {
        if (generation === pageGeneration && currentRequest === requestNumber) {
          submit.disabled = false;
          clear.disabled = false;
        }
      }
    }

    async function verifyPageUnits(rows, summary, selectedRequest) {
      if (window.TrazaUI && window.TrazaUI.currentSection !== "archive") return;
      const controller = new AbortController();
      unitVerifications.add(controller);
      const activeBuffers = new Set();
      const clearBuffers = function () {
        for (const bytes of activeBuffers) {
          if (bytes.byteLength) bytes.fill(0);
        }
        activeBuffers.clear();
      };
      controller.signal.addEventListener("abort", clearBuffers, { once: true });
      const account = status();
      const viewGeneration = window.TrazaUI ? window.TrazaUI.generation : null;
      let cursor = 0;
      let pending = rows.length;
      let unverified = 0;
      let verifiedUnits = 0;
      const guard = function () {
        assertAuthentication(account);
        if (controller.signal.aborted || generation !== pageGeneration || selectedRequest !== requestNumber ||
            !summary.isConnected || (window.TrazaUI && (window.TrazaUI.currentSection !== "archive" || window.TrazaUI.generation !== viewGeneration))) {
          throw new Error("La vista cambió. Abre de nuevo el archivo de salidas.");
        }
      };
      const updateSummary = function () {
        const amount = verifiedUnits.toLocaleString("es-PA", { maximumFractionDigits: 2 });
        summary.textContent = "Unidades verificadas en esta página: " + amount +
          (pending ? " · Verificando " + pending + (pending === 1 ? " salida…" : " salidas…") : "") +
          (unverified ? " · " + unverified + (unverified === 1 ? " salida sin verificar" : " salidas sin verificar") : "");
      };
      updateSummary();
      const worker = async function () {
        while (cursor < rows.length && !controller.signal.aborted) {
          const entry = rows[cursor++];
          let bytes;
          try {
            guard();
            bytes = await archivedPdf(entry.record, controller, guard);
            activeBuffers.add(bytes);
            guard();
            if (!window.TrazaConverter || typeof window.TrazaConverter.analyzeUnits !== "function") {
              throw new Error("No se pudo comprobar el PDF original. Actualiza la página e inténtalo de nuevo.");
            }
            const result = await window.TrazaConverter.analyzeUnits({
              data: bytes, signal: controller.signal, assertCurrent: guard, expectedNumber: String(entry.record.salida_numero)
            });
            guard();
            if (result && result.rowCount === 0) {
              throw new Error("No se detectaron productos en el PDF original. Si contiene una imagen, necesita texto legible para comprobar sus unidades.");
            }
            if (result && result.missingUnits > 0) {
              throw new Error("Hay productos sin unidades legibles en el PDF original. Esta salida no se incluye en la suma de unidades verificadas.");
            }
            if (!result || result.complete !== true || !Number.isInteger(result.rowCount) || result.rowCount < 1 ||
                !Number.isFinite(result.totalUnits) || result.totalUnits < 0 || result.missingUnits !== 0) {
              throw new Error("El PDF original no permite verificar todas las unidades de esta salida.");
            }
            entry.amounts.replaceChildren(element("span", result.rowCount + (result.rowCount === 1 ? " producto" : " productos")));
            entry.amounts.append(element("span", result.totalUnits.toLocaleString("es-PA", { maximumFractionDigits: 2 }) + " unidades", "audit-muted"));
            entry.amounts.dataset.unitState = "verified";
            verifiedUnits += result.totalUnits;
          } catch (error) {
            try { guard(); } catch (_) { return; }
            entry.amounts.replaceChildren(element("span", "Unidades no verificadas"), element("span", errorText(error), "audit-muted"));
            entry.amounts.dataset.unitState = "unverified";
            unverified++;
          } finally {
            if (bytes && bytes.byteLength) bytes.fill(0);
            activeBuffers.delete(bytes);
          }
          guard();
          pending--;
          updateSummary();
        }
      };
      try {
        await Promise.all([worker(), worker()]);
      } catch (_) {
        // Una vista invalidada no puede recuperar documentos ni actualizar sus conteos.
      } finally {
        controller.signal.removeEventListener("abort", clearBuffers);
        clearBuffers();
        unitVerifications.delete(controller);
      }
    }
    searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      query = search.value.trim();
      pageNumber = 1;
      loadRecords();
    });
    clear.addEventListener("click", function () {
      search.value = "";
      query = "";
      pageNumber = 1;
      loadRecords();
    });
    loadRecords();
    if (currentStatus.user.role === "admin") renderUserManagement(page, generation);
  }

  function renderUserManagement(page, generation) {
    const details = element("details", undefined, "audit-panel audit-admin");
    details.append(element("summary", "Administrar usuarios"));
    const body = element("div", undefined, "audit-admin-body");
    body.append(element("p", "Crea una cuenta por persona. Al desactivar una cuenta, sus registros anteriores se conservan.", "audit-muted"));
    const form = element("form", undefined, "audit-form");
    const displayName = field(form, "Nombre de la persona", "user-display-name", "text", { required: true, maxLength: 120, autoComplete: "off" });
    const username = field(form, "Usuario", "user-username", "text", { required: true, maxLength: 64, autoComplete: "off" });
    const password = field(form, "Contraseña inicial", "user-password", "password", { required: true, minLength: 10, maxLength: 1024, autoComplete: "new-password" });
    const roleWrapper = element("div", undefined, "audit-field");
    const roleLabel = element("label", "Permisos");
    const role = element("select");
    role.id = "audit-user-role";
    roleLabel.htmlFor = role.id;
    const regularOption = element("option", "Usuario");
    regularOption.value = "user";
    const adminOption = element("option", "Administrador");
    adminOption.value = "admin";
    role.append(regularOption, adminOption);
    roleWrapper.append(roleLabel, role);
    const submit = button("Crear usuario");
    submit.type = "submit";
    form.append(roleWrapper, submit);
    body.append(form, element("p", "La contraseña inicial debe tener al menos 10 caracteres. Entrega cada cuenta únicamente a su titular.", "audit-muted"));
    const feedback = element("div");
    const usersArea = element("div");
    body.append(feedback, usersArea);
    details.append(body);
    page.append(details);
    let loaded = false;

    async function loadUsers() {
      usersArea.replaceChildren(element("p", "Cargando usuarios…", "audit-state"));
      try {
        const result = await request("/users");
        if (generation !== pageGeneration) return;
        if (!Array.isArray(result.users)) throw new Error("La lista de usuarios devolvió una respuesta inválida.");
        const wrap = element("div", undefined, "audit-table-wrap");
        const table = element("table", undefined, "audit-table");
        const head = element("thead");
        const headers = element("tr");
        for (const title of ["Nombre", "Usuario", "Permisos", "Estado", "Acción"]) {
          const cell = element("th", title);
          cell.scope = "col";
          headers.append(cell);
        }
        head.append(headers);
        const rows = element("tbody");
        for (const user of result.users) {
          const row = element("tr");
          const action = element("td");
          const active = Boolean(user.active);
          const toggle = button(active ? "Desactivar" : "Activar", "audit-button-secondary audit-button-small");
          if (String(user.id) === String(currentStatus.user.id)) {
            toggle.disabled = true;
            toggle.title = "Tu propia cuenta debe permanecer activa.";
          }
          toggle.addEventListener("click", async function () {
            toggle.disabled = true;
            feedback.replaceChildren();
            try {
              await request("/users/" + encodeURIComponent(user.id), { method: "PATCH", body: { active: !active } });
              showMessage(feedback, active ? "Cuenta desactivada. Su historial se conserva." : "Cuenta activada.", false);
              await loadUsers();
            } catch (error) {
              if (generation !== pageGeneration) return;
              showMessage(feedback, errorText(error), true);
              toggle.disabled = false;
            }
          });
          action.append(toggle);
          row.append(element("td", user.display_name), element("td", user.username), element("td", user.role === "admin" ? "Administrador" : "Usuario"), element("td", active ? "Activa" : "Desactivada"), action);
          rows.append(row);
        }
        table.append(head, rows);
        wrap.append(table);
        usersArea.replaceChildren(wrap);
      } catch (error) {
        if (generation !== pageGeneration) return;
        usersArea.replaceChildren();
        showMessage(feedback, errorText(error), true);
      }
    }
    details.addEventListener("toggle", function () {
      if (details.open && !loaded) { loaded = true; loadUsers(); }
    });
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      submit.disabled = true;
      feedback.replaceChildren();
      try {
        await request("/users", { method: "POST", body: { username: username.value.trim(), display_name: displayName.value.trim(), password: password.value, role: role.value } });
        if (generation !== pageGeneration) return;
        form.reset();
        showMessage(feedback, "Usuario creado. Ya puede iniciar sesión con su cuenta.", false);
        loaded = true;
        await loadUsers();
      } catch (error) {
        if (generation !== pageGeneration) return;
        showMessage(feedback, errorText(error), true);
      } finally { submit.disabled = false; }
    });
  }

  function initialise() {
    const bar = document.getElementById("audit-bar");
    if (bar) bar.append(element("p", "Comprobando auditoría…", "audit-muted"));
    ready().catch(function () {});
  }

  window.addEventListener("traza-ui:navigated", function (event) {
    cancelArchiveEdits();
    cancelUnitVerifications();
    if (event.detail && event.detail.section === "archive" && currentStatus && currentStatus.authenticated) renderAuditPage();
  });
  window.AuditClient = Object.freeze({ ready, status, record, confirmArchivedRecord, newIdempotencyKey });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialise, { once: true });
  else initialise();
})();
