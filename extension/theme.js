// Se carga en el <head> de cada página, antes de pintar nada, para que el tema
// correcto esté aplicado desde el primer fotograma (sin parpadeo).
(function () {
  const THEMES = ['dark', 'claude-light', 'claude-dark'];
  const root = document.documentElement;

  function resolve(t) {
    if (THEMES.includes(t)) return t;
    // Sin preferencia guardada: sigue el modo claro/oscuro del sistema
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'claude-dark' : 'claude-light';
  }

  window.applyTheme = function (t) {
    const r = resolve(t);
    root.dataset.theme = r;
    try { localStorage.setItem('theme', r); } catch { /* sin caché */ }
  };

  let cached = null;
  try { cached = localStorage.getItem('theme'); } catch { /* sin caché */ }
  window.applyTheme(cached);

  // El tema guardado en la cuenta manda; así también se sincroniza entre dispositivos
  try {
    chrome.storage.sync.get('settings').then(({ settings }) => {
      if (settings && settings.theme) window.applyTheme(settings.theme);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      const s = area === 'sync' && changes.settings && changes.settings.newValue;
      if (s && s.theme) window.applyTheme(s.theme);
    });
  } catch { /* fuera del contexto de la extensión */ }
})();
