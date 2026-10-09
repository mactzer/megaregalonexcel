(function () {
  "use strict";
  if (window.TrazaUI) return;
  let currentSection = null;
  let viewGeneration = 0;
  let menuOpen = false;
  let menuReturnFocus = null;
  let helpReturnFocus = null;
  const mobile = window.matchMedia("(max-width: 839px)");
  function boot() {
    const main = document.getElementById("app-main");
    const converter = document.getElementById("converter-view");
    const archive = document.getElementById("audit-page");
    const bar = document.getElementById("audit-bar");
    const sidebar = document.getElementById("traza-sidebar");
    const topbar = document.getElementById("traza-topbar");
    const overlay = document.getElementById("traza-menu-overlay");
    const menuButton = document.getElementById("traza-menu-button");
    const menuClose = document.getElementById("traza-menu-close");
    const help = document.getElementById("traza-help-dialog");
    const skipLink = document.querySelector(".traza-skip-link");
    function hidden(element, value) {
      if (!element) return;
      element.hidden = value;
      element.inert = value;
    }
    function closeMenu(returnFocus) {
      if (!menuOpen) return;
      menuOpen = false;
      document.body.classList.remove("traza-menu-open");
      overlay.hidden = true;
      main.inert = false;
      topbar.inert = false;
      if (skipLink) skipLink.inert = false;
      sidebar.inert = mobile.matches;
      menuButton.setAttribute("aria-expanded", "false");
      if (returnFocus !== false && menuReturnFocus && menuReturnFocus.isConnected) menuReturnFocus.focus();
      menuReturnFocus = null;
    }
    function openMenu() {
      if (!mobile.matches || menuOpen) return;
      menuOpen = true;
      menuReturnFocus = document.activeElement;
      sidebar.inert = false;
      main.inert = true;
      topbar.inert = true;
      if (skipLink) skipLink.inert = true;
      overlay.hidden = false;
      menuButton.setAttribute("aria-expanded", "true");
      document.body.classList.add("traza-menu-open");
      const active = sidebar.querySelector('[aria-current="page"]');
      (active || menuClose).focus();
    }
    function navigate(section, options) {
      options = options || {};
      if (section !== "converter" && section !== "archive") return false;
      if (section === "converter" && !converter) {
        window.location.assign("index.html#nueva-salida");
        return false;
      }
      closeMenu(false);
      const changed = currentSection !== section;
      currentSection = section;
      if (changed) viewGeneration++;
      hidden(converter, section !== "converter");
      hidden(archive, section !== "archive");
      hidden(bar, section !== "archive");
      main.classList.toggle("audit-mode", section === "archive");
      const name = section === "archive" ? "Archivo de salidas" : "Nueva salida";
      document.getElementById("traza-section-name").textContent = name;
      for (const link of document.querySelectorAll("[data-traza-section]")) {
        const active = link.dataset.trazaSection === section;
        if (active) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
      const hash = section === "archive" ? "#archivo" : "#nueva-salida";
      if (location.hash !== hash) {
        if (options.replace) history.replaceState(null, "", hash);
        else history.pushState(null, "", hash);
      }
      if (changed) window.dispatchEvent(new CustomEvent("traza-ui:navigated", { detail: { section, generation: viewGeneration } }));
      if (options.focus && main) main.focus({ preventScroll: true });
      return true;
    }
    window.TrazaUI = Object.freeze({
      navigate,
      get currentSection() { return currentSection; },
      get generation() { return viewGeneration; },
      closeMenu
    });
    for (const link of document.querySelectorAll("[data-traza-section]")) {
      link.addEventListener("click", function (event) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
        if (link.dataset.trazaSection === "converter" && !converter) return;
        event.preventDefault();
        navigate(link.dataset.trazaSection, { focus: true });
      });
    }
    window.addEventListener("hashchange", function () {
      navigate(location.hash === "#archivo" ? "archive" : "converter", { replace: true });
    });
    window.addEventListener("popstate", function () {
      navigate(location.hash === "#archivo" ? "archive" : "converter", { replace: true });
    });
    window.addEventListener("traza:navigate", function (event) {
      navigate(typeof event.detail === "string" ? event.detail : event.detail && event.detail.section, { focus: true });
    });
    menuButton.addEventListener("click", openMenu);
    menuClose.addEventListener("click", function () { closeMenu(); });
    overlay.addEventListener("click", function () { closeMenu(); });
    document.addEventListener("keydown", function (event) {
      if (!menuOpen) return;
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(sidebar.querySelectorAll('a[href],button:not([disabled]),[tabindex="0"]')).filter(function (element) { return element.getClientRects().length > 0; });
      const first = items[0];
      const last = items[items.length - 1];
      if (!sidebar.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }, true);
    function updateViewport() { closeMenu(false); sidebar.inert = mobile.matches; }
    if (mobile.addEventListener) mobile.addEventListener("change", updateViewport);
    else mobile.addListener(updateViewport);
    updateViewport();
    if (help) {
      for (const trigger of document.querySelectorAll("[data-traza-help]")) trigger.addEventListener("click", function () {
        helpReturnFocus = mobile.matches ? menuButton : trigger;
        closeMenu(false);
        help.showModal();
      });
      help.querySelector("[data-dialog-close]").addEventListener("click", function () { help.close(); });
      help.addEventListener("close", function () { if (helpReturnFocus && helpReturnFocus.isConnected) helpReturnFocus.focus(); helpReturnFocus = null; });
      help.addEventListener("click", function (event) { if (event.target === help) { const r = help.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) help.close(); } });
    }
    const initial = document.body.dataset.trazaInitial === "archive" || location.hash === "#archivo" ? "archive" : "converter";
    navigate(initial, { replace: true });
    // Keep the intranet client's existing authentication and user actions. Move
    // their DOM into the shared shell rather than maintaining a second client.
    if (document.documentElement.dataset.auditRequired === "true" && bar && archive) {
      const profile = document.getElementById("app-profile");
      let adminDialog = null;
      let adminTrigger = null;
      let controller = null;
      let queued = false;
      function removeAdminDialog() {
        if (!adminDialog) return;
        if (adminDialog.open) adminDialog.close();
        adminDialog.remove();
        adminDialog = null;
      }
      async function adaptIntranet() {
        queued = false;
        if (!window.AuditClient || !profile) return;
        let account;
        try { account = await window.AuditClient.ready(); } catch (_) { return; }
        if (account.mode !== "intranet") return;
        const nativeAccount = bar.querySelector(".audit-account");
        const login = bar.querySelector("#audit-login-username");
        if (login || nativeAccount) {
          if (controller) controller.abort();
          controller = new AbortController();
          removeAdminDialog();
          profile.replaceChildren();
          adminTrigger = null;
          if (!account.authenticated) {
            const signIn = document.createElement("button");
            signIn.type = "button";
            signIn.className = "audit-button";
            signIn.textContent = "Iniciar sesión";
            signIn.addEventListener("click", function () { navigate("archive"); if (login) login.focus(); });
            profile.append(signIn);
            window.dispatchEvent(new CustomEvent("traza:session-cleared"));
          } else if (nativeAccount) {
            const trigger = document.createElement("button");
            trigger.type = "button";
            trigger.className = "traza-profile-trigger";
            trigger.setAttribute("aria-expanded", "false");
            trigger.setAttribute("aria-controls", "traza-intranet-profile-menu");
            const avatar = document.createElement("span");
            avatar.className = "traza-profile-avatar";
            avatar.textContent = account.user.username.slice(0, 2).toUpperCase();
            const name = document.createElement("span");
            name.className = "traza-profile-name";
            const identity = document.createElement("strong");
            identity.textContent = "@" + account.user.username;
            const role = document.createElement("span");
            role.className = "traza-profile-role";
            role.textContent = account.user.role === "admin" ? "Administrador" : "Usuario";
            name.append(identity, role);
            trigger.append(avatar, name);
            const menu = document.createElement("div");
            menu.id = "traza-intranet-profile-menu";
            menu.className = "traza-profile-menu";
            menu.hidden = true;
            if (account.user.role === "admin") {
              adminTrigger = document.createElement("button");
              adminTrigger.type = "button";
              adminTrigger.textContent = "Usuarios y permisos";
              adminTrigger.addEventListener("click", async function () {
                menu.hidden = true;
                trigger.setAttribute("aria-expanded", "false");
                // The server verifies every mutation; also recheck the role
                // before exposing the existing administration form.
                try {
                  const response = await fetch("/api/status", { credentials: "same-origin", cache: "no-store" });
                  const current = await response.json();
                  if (!response.ok || !current.authenticated || current.user.role !== "admin" || current.user.id !== account.user.id || !adminDialog || !trigger.isConnected || controller.signal.aborted) return;
                  adminDialog.showModal();
                  adminDialog.querySelector("details").open = true;
                } catch (_) {}
              });
              menu.append(adminTrigger);
            }
            const logout = Array.from(nativeAccount.querySelectorAll("button")).find(function (item) { return item.textContent === "Cerrar sesión"; });
            if (logout) menu.append(logout);
            nativeAccount.remove();
            trigger.addEventListener("click", function () {
              menu.hidden = !menu.hidden;
              trigger.setAttribute("aria-expanded", String(!menu.hidden));
              if (!menu.hidden) menu.querySelector("button").focus();
            });
            document.addEventListener("keydown", function (event) {
              if (event.key === "Escape" && !menu.hidden) { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.focus(); }
            }, { signal: controller.signal });
            document.addEventListener("click", function (event) {
              if (!profile.contains(event.target)) { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); }
            }, { signal: controller.signal });
            profile.append(trigger, menu);
          }
        }
        const nativeAdmin = archive.querySelector(".audit-admin");
        if (nativeAdmin && adminTrigger) {
          removeAdminDialog();
          adminDialog = document.createElement("dialog");
          adminDialog.className = "traza-dialog";
          adminDialog.setAttribute("aria-labelledby", "traza-intranet-admin-title");
          const header = document.createElement("div");
          header.className = "traza-dialog-header";
          const title = document.createElement("h2");
          title.id = "traza-intranet-admin-title";
          title.textContent = "Usuarios y permisos";
          const close = document.createElement("button");
          close.type = "button";
          close.textContent = "Cerrar";
          close.className = "audit-button audit-button-secondary";
          const dialog = adminDialog;
          close.addEventListener("click", function () { dialog.close(); });
          dialog.addEventListener("close", function () { const current = profile.querySelector("button"); if (current) current.focus(); });
          header.append(title, close);
          const summary = nativeAdmin.querySelector("summary");
          if (summary) summary.hidden = true;
          dialog.append(header, nativeAdmin);
          document.body.append(dialog);
        }
      }
      const observer = new MutationObserver(function () {
        if (!queued) { queued = true; queueMicrotask(adaptIntranet); }
      });
      observer.observe(bar, { childList: true, subtree: true });
      observer.observe(archive, { childList: true, subtree: true });
      adaptIntranet();
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
