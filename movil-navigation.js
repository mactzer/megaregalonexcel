(function () {
  'use strict';
  const engine = document.getElementById('engine'), scanner = document.getElementById('mobile-scanner-view'), docs = document.getElementById('mobile-document-view');
  const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
  const hashes = { scanner: '#escaner', archive: '#archivo', converter: '#nueva-salida' };
  let section = 'scanner', owner, ready;
  function fromHash() { return location.hash === '#archivo' ? 'archive' : location.hash === '#nueva-salida' ? 'converter' : 'scanner'; }
  function present(next, options = {}) {
    if (!Object.hasOwn(hashes, next)) return false;
    const changed = section !== next; section = next;
    if (!embedded) {
      scanner.hidden = scanner.inert = next !== 'scanner'; docs.hidden = docs.inert = next === 'scanner';
      document.body.classList.toggle('mobile-documents-open', next !== 'scanner');
      if (location.hash !== hashes[next]) history[options.replace ? 'replaceState' : 'pushState'](null, '', hashes[next]);
    }
    for (const link of document.querySelectorAll('.bottom [data-mobile-section]')) {
      if (link.dataset.mobileSection === next) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    if (changed || options.notify) window.dispatchEvent(new CustomEvent('mobile-session:navigated', { detail: { section: next } }));
    return true;
  }
  function navigate(next, options) {
    if (!Object.hasOwn(hashes, next)) return false;
    if (embedded) { ready.then(w => w.TrazaUI.navigate(next, options)).catch(() => {}); return true; }
    present(next, options);
    ready.then(w => { if (section === next) w.TrazaUI.navigate(next, { replace: true }); }).catch(() => {});
    return true;
  }
  async function verify(w) {
    if (w.document.readyState === 'loading') await new Promise(resolve => w.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    if (!w.AuditCloud || !w.TrazaConverter || !w.TrazaUI) throw new Error('No se pudo cargar el acceso. Actualiza la página.');
    await w.AuditCloud.ready(); owner = w;
    w.addEventListener('traza-ui:navigated', event => { if (event.detail) present(event.detail.section); });
    if (embedded) present(w.TrazaUI.currentSection, { notify: true }); else w.TrazaUI.navigate(section, { replace: true });
    return w;
  }
  if (embedded) {
    docs.remove(); document.body.classList.add('mobile-embedded'); ready = Promise.resolve().then(() => verify(window.parent));
  } else ready = new Promise((resolve, reject) => {
    function loaded() {
      if (!engine.getAttribute('src') || engine.contentWindow.location.href === 'about:blank') return;
      engine.removeEventListener('load', loaded); verify(engine.contentWindow).then(resolve, reject);
    }
    engine.addEventListener('load', loaded);
  });
  window.MobileSession = Object.freeze({ ready, navigate, embedded, owns: w => !embedded && engine.contentWindow === w, get currentSection() { return section; } });
  for (const link of document.querySelectorAll('[data-mobile-section]')) link.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
    event.preventDefault(); navigate(link.dataset.mobileSection);
  });
  if (!embedded) {
    present(fromHash(), { replace: true });
    window.addEventListener('hashchange', () => navigate(fromHash(), { replace: true })); window.addEventListener('popstate', () => navigate(fromHash(), { replace: true }));
    engine.src = engine.dataset.src; // Never reload or move the owner when changing views.
  }
})();
