/* Lampa. Tizen/MSX transport diagnostic v1. A standalone harmless test. */
(function () {
  'use strict';
  if (window.__pluginlampa_probe_ready) return;
  if (!window.Lampa) return;
  var registered = false;
  function init() {
    if (registered) return;
    registered = true;
    window.__pluginlampa_probe_ready = true;
    try {
      Lampa.Manifest.plugins = {
        type: 'video',
        name: 'PluginLampa CHECK',
        version: '0.0.1',
        description: 'Проверка загрузки расширений на Samsung Tizen',
        onContextMenu: function () {
          return { name: 'PluginLampa CHECK', description: 'Проверка исполнения JS' };
        },
        onContextLauch: function () {
          try { Lampa.Noty.show('PluginLampa CHECK: JavaScript работает!', {time: 6000}); }
          catch (_) {}
        }
      };
      if (Lampa.Noty && Lampa.Noty.show) {
        Lampa.Noty.show('PluginLampa CHECK: файл успешно запущен', {time: 6000});
      }
    } catch (err) {
      console.error('[PluginLampa CHECK] Failed:', err);
    }
  }
  if (window.appready) init();
  else if (Lampa.Listener && typeof Lampa.Listener.follow === 'function') {
    Lampa.Listener.follow('app', function (event) {
      if (event && event.type === 'ready') init();
    });
  }
})();
