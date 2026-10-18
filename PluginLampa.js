/*
MIT License

Copyright (c) 2026 ASarych

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

// PluginLampa v0.5.0 · Archive + Rutube + Stremio integration.
/*
 * Lampa Video Finder — extensible search plugin (prototype)
 * Built-in example adapter: Internet Archive (public catalog search).
 * Version 0.5.0. Persistent results, provider health, retry cooldowns.
 * No credentials, proxies, telemetry or DRM bypass.
 * Requires Lampa with Manifest/Select/Player API and browser fetch.
 */
(function () {
  'use strict';

  if (window.__lampa_video_finder_v1) return;
  window.__lampa_video_finder_v1 = true;

  var L = window.Lampa;
  var providers = [];
  var actions = [];
  var busy = false;
  var CACHE_KEY = 'video_finder_cache_v2';
  var MAX_MOVIES = 120;
  var MAX_RESULTS = 25;
  var MAX_SITES = 150;
  var MISS_TTL_MS = 30 * 60 * 1000;
  var COOLDOWNS_MS = [0, 0, 60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];
  var cache = loadCache();

  function notify(message, error) {
    L.Noty.show(message, error ? { style: 'error', time: 6000 } : { time: 3500 });
  }

  function movieInfo(card) {
    card = card || {};
    var title = card.title || card.name || card.original_title || card.original_name || '';
    var original = card.original_title || card.original_name || title;
    var release = card.release_date || card.first_air_date || '';
    var year = /^\d{4}/.test(release) ? release.slice(0, 4) : (card.year || '');
    return {
      title: String(title),
      original_title: String(original),
      year: String(year),
      imdb_id: String(card.imdb_id || ''),
      tmdb_id: card.id || null,
      media_type: card.media_type || (card.first_air_date || card.number_of_seasons ? 'tv' : 'movie'),
      card: card
    };
  }

  // Prefer Lampa's request wrapper on TV/WebView; browser hosts can use fetch.
  function httpJson(url) {
    if (L && typeof L.Reguest === 'function') {
      return new Promise(function (resolve, reject) {
        try {
          var request = new L.Reguest();
          request.timeout(12000);
          request.silent(url, function (payload) {
            try { resolve(typeof payload === 'string' ? JSON.parse(payload) : payload); }
            catch (err) { reject(err); }
          }, function (xhr, reason) {
            reject(new Error('Сетевая ошибка Lampa: ' +
              (xhr && xhr.status != null ? xhr.status : String(reason || 'unknown'))));
          });
        } catch (err) { reject(err); }
      });
    }
    if (typeof fetch !== 'function') {
      return Promise.reject(new Error('Нет доступного сетевого API'));
    }
    return fetch(url, { method: 'GET' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function normalize(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ')
      .replace(/^\s+|\s+$/g, '');
  }

  function rankMatch(title, movie) {
    var a = normalize(title);
    var b = normalize(movie.original_title);
    var c = normalize(movie.title);
    if (!a) return 0;
    if (a === b || a === c) return 100;
    if ((b && a.indexOf(b) !== -1) || (c && a.indexOf(c) !== -1)) return 60;
    return 5;
  }

  function searchArchiveTitle(title, movie) {
    // Query public Archive catalog. Its metadata can contain unrelated or
    // incomplete entries, so results are candidates, not verified matches.
    var escaped = String(title).replace(/[\\"\r\n]/g, ' ').trim();
    if (!escaped) return Promise.resolve([]);
    var query = 'mediatype:movies AND title:"' + escaped + '"';
    var url = 'https://archive.org/advancedsearch.php?output=json&rows=15' +
      '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year' +
      '&q=' + encodeURIComponent(query);
    return httpJson(url).then(function (payload) {
      var documents = payload && payload.response && payload.response.docs;
      if (!Array.isArray(documents)) return [];
      return documents.filter(function (document) {
        if (!document || !document.identifier || !document.title) return false;
        if (movie.year && document.year && String(movie.year) !== String(document.year)) return false;
        return rankMatch(document.title, movie) >= 60;
      }).map(function (document) {
        return {
          id: String(document.identifier),
          sourceUrl: 'https://archive.org/details/' + encodeURIComponent(document.identifier),
          title: String(document.title),
          subtitle: (document.year ? String(document.year) + ' · ' : '') + 'Internet Archive',
          confidence: rankMatch(document.title, movie)
        };
      });
    });
  }

  function searchArchive(movie) {
    var names = [movie.original_title];
    if (normalize(movie.title) !== normalize(movie.original_title)) names.push(movie.title);
    return Promise.all(names.map(function (name) {
      // Keep partial results, but if every request fails don't erase cached hits.
      return searchArchiveTitle(name, movie).then(function (items) {
        return { ok: true, items: items };
      }).catch(function (err) {
        console.warn('[VideoFinder] Archive search request failed', err);
        return { ok: false, items: [] };
      });
    })).then(function (groups) {
      if (!groups.some(function (group) { return group.ok; })) {
        throw new Error('All Archive search requests failed');
      }
      var seen = Object.create(null);
      var found = [];
      groups.forEach(function (group) {
        group.items.forEach(function (item) {
          if (seen[item.id]) return;
          seen[item.id] = true;
          found.push(item);
        });
      });
      return found.sort(function (a, b) { return b.confidence - a.confidence; });
    });
  }

  function resolveArchive(item) {
    var url = 'https://archive.org/metadata/' + encodeURIComponent(item.id);
    return httpJson(url).then(function (payload) {
      var files = (payload && payload.files) || [];
      return files.filter(function (file) {
        return file && file.name && /\.mp4$/i.test(file.name) &&
          file.private !== 'true' && file.private !== true;
      }).map(function (file) {
        return {
          title: String(file.name),
          subtitle: (file.size ? Math.round(Number(file.size) / 1048576) + ' MB' : 'MP4'),
          url: 'https://archive.org/download/' + encodeURIComponent(item.id) + '/' +
            String(file.name).split('/').map(encodeURIComponent).join('/')
        };
      });
    });
  }

  // Store candidates, not the rendered Lampa UI objects (those contain functions).
  // Cache entries are local to the device and survive application restarts.
  function loadCache() {
    var empty = { version: 2, movies: {}, sites: {}, health: {} };
    try {
      if (!L.Storage || typeof L.Storage.get !== 'function') return empty;
      var raw = L.Storage.get(CACHE_KEY, '');
      if (!raw) return empty;
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || parsed.version !== 2 || !parsed.movies || !parsed.sites ||
          typeof parsed.movies !== 'object' || typeof parsed.sites !== 'object') return empty;
      // Backward-compatible extension of v0.2 data. Do not delete saved films.
      if (!parsed.health || typeof parsed.health !== 'object' || Array.isArray(parsed.health)) parsed.health = {};
      return parsed;
    } catch (err) {
      console.warn('[VideoFinder] Cache could not be loaded', err);
      return empty;
    }
  }

  function saveCache() {
    try {
      var movieKeys = Object.keys(cache.movies);
      if (movieKeys.length > MAX_MOVIES) {
        movieKeys.sort(function (a, b) {
          return (cache.movies[a].updated || 0) - (cache.movies[b].updated || 0);
        });
        movieKeys.slice(0, movieKeys.length - MAX_MOVIES).forEach(function (key) {
          delete cache.movies[key];
        });
      }
      var sites = Object.keys(cache.sites);
      if (sites.length > MAX_SITES) {
        sites.sort(function (a, b) {
          return (cache.sites[a].lastSeen || 0) - (cache.sites[b].lastSeen || 0);
        });
        sites.slice(0, sites.length - MAX_SITES).forEach(function (key) {
          delete cache.sites[key];
        });
      }
      if (L.Storage && typeof L.Storage.set === 'function') {
        L.Storage.set(CACHE_KEY, JSON.stringify(cache));
      }
    } catch (err) {
      console.warn('[VideoFinder] Cannot save search cache', err);
    }
  }

  function providerHealth(provider) {
    var id = provider.id;
    if (!Object.prototype.hasOwnProperty.call(cache.health, id)) {
      cache.health[id] = { successes: 0, empty: 0, failures: 0, streak: 0, cooldownUntil: 0, lastOk: 0, lastFail: 0 };
    }
    return cache.health[id];
  }

  function providerAvailable(provider, forced) {
    return forced || providerHealth(provider).cooldownUntil <= Date.now();
  }

  function recordProviderSuccess(provider, itemsCount) {
    var stats = providerHealth(provider);
    if (itemsCount > 0) stats.successes += 1;
    else stats.empty += 1;
    stats.streak = 0;
    stats.cooldownUntil = 0;
    stats.lastOk = Date.now();
    saveCache();
  }

  function recordProviderFailure(provider) {
    var stats = providerHealth(provider);
    stats.failures += 1;
    stats.streak += 1;
    stats.lastFail = Date.now();
    if (stats.streak >= 2) {
      var index = Math.min(stats.streak, COOLDOWNS_MS.length - 1);
      stats.cooldownUntil = Date.now() + COOLDOWNS_MS[index];
    }
    saveCache();
  }

  function providerStatuses() {
    return providers.map(function (provider) {
      var h = providerHealth(provider);
      return {
        id: provider.id, name: provider.name, discovery: !!provider.discovery,
        successes: h.successes, empty: h.empty, failures: h.failures,
        streak: h.streak, cooldownUntil: h.cooldownUntil,
        available: providerAvailable(provider, false)
      };
    });
  }

  function withTimeout(work, timeoutMs, label) {
    var timer;
    return Promise.race([
      Promise.resolve().then(work),
      new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(new Error('Timeout: ' + label)); }, timeoutMs);
      })
    ]).then(function (result) {
      clearTimeout(timer);
      return result;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function providerTimeout(provider) {
    return Math.max(50, Math.min(30000, Number(provider.timeoutMs) || 12000));
  }

  function movieKey(movie) {
    var kind = movie.media_type === 'tv' ? 'tv' : 'movie';
    var episodeSuffix = '';
    if (kind === 'tv') {
      var card = movie.card || {};
      var season = Number(card.season_number || card.season || 0);
      var episode = Number(card.episode_number || card.episode || 0);
      if (season > 0 && episode > 0) episodeSuffix = ':S' + season + ':E' + episode;
    }
    if (movie.tmdb_id != null && movie.tmdb_id !== '') return 'tmdb:' + kind + ':' + movie.tmdb_id + episodeSuffix;
    if (movie.imdb_id) return 'imdb:' + movie.imdb_id + episodeSuffix;
    return 'title:' + kind + ':' + normalize(movie.original_title || movie.title) + ':' + movie.year + episodeSuffix;
  }

  function getMovieEntry(movie, create) {
    var key = movieKey(movie);
    if (!Object.prototype.hasOwnProperty.call(cache.movies, key) && create) {
      cache.movies[key] = { updated: Date.now(), providers: {} };
    }
    return cache.movies[key] || null;
  }

  function cachedCandidates(movie, provider) {
    var record = getMovieEntry(movie, false);
    var entry = record && record.providers[provider.id];
    if (!entry || !Array.isArray(entry.items) || !entry.items.length) return null;
    return entry.items;
  }

  function recentMiss(movie, provider) {
    var record = getMovieEntry(movie, false);
    var entry = record && record.providers[provider.id];
    return !!(entry && Array.isArray(entry.items) && !entry.items.length &&
      Number(entry.negativeUntil || 0) > Date.now());
  }

  function domainOf(url) {
    try {
      var parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) ? parsed.hostname.toLowerCase() : '';
    } catch (_) { return ''; }
  }

  function recordSite(item, provider) {
    // A discovered hostname is informational: it is NOT a new executable adapter.
    var host = domainOf(item.sourceUrl || item.url || provider.siteUrl || '');
    if (!host) return;
    var now = Date.now();
    var existing = cache.sites[host] || {
      host: host, providers: [], firstSeen: now, matches: 0
    };
    if (existing.providers.indexOf(provider.id) === -1) existing.providers.push(provider.id);
    existing.lastSeen = now;
    existing.matches += 1;
    cache.sites[host] = existing;
  }

  function rememberCandidates(movie, provider, items) {
    var prepared = [];
    // A provider might return non-serializable values; skip only those values.
    items.slice(0, MAX_RESULTS).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      try {
        var clean = JSON.parse(JSON.stringify(item));
        if (!clean || Array.isArray(clean) || typeof clean !== 'object') return;
        prepared.push(clean);
        recordSite(clean, provider);
      } catch (err) { console.warn('[VideoFinder] Ignored non-serializable item', err); }
    });
    var record = getMovieEntry(movie, !!prepared.length);
    if (prepared.length) {
      // Reset resolved streams on explicit refresh; candidates may have changed.
      record.providers[provider.id] = { items: prepared, savedAt: Date.now() };
      record.updated = Date.now();
    } else {
      // A successful empty search is different from a network error.
      // Remember misses briefly, but never discard previously found candidates.
      record = getMovieEntry(movie, true);
      if (!record.providers[provider.id] || !record.providers[provider.id].items.length) {
        record.providers[provider.id] = {
          items: [], savedAt: Date.now(), negativeUntil: Date.now() + MISS_TTL_MS
        };
      }
      record.updated = Date.now();
    }
    saveCache();
    return prepared;
  }

  function cachedStreams(movie, provider, item) {
    if (!provider.persistStreams || item.id == null) return null;
    var record = getMovieEntry(movie, false);
    var entry = record && record.providers[provider.id];
    var stream = entry && entry.streams && entry.streams[String(item.id)];
    if (!stream || !Array.isArray(stream.items) || !stream.items.length) return null;
    // Stable static URLs only; never cache short-lived signed URLs from other adapters.
    if (Date.now() - stream.savedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return stream.items;
  }

  function rememberStreams(movie, provider, item, streams) {
    if (!provider.persistStreams || item.id == null) return;
    var record = getMovieEntry(movie, false);
    var entry = record && record.providers[provider.id];
    if (!entry) return;
    try {
      var clean = JSON.parse(JSON.stringify(streams.slice(0, 25)));
      clean = clean.filter(function (stream) {
        return stream && typeof stream.url === 'string' && domainOf(stream.url);
      });
      if (!clean.length) return;
      if (!entry.streams) entry.streams = {};
      entry.streams[String(item.id)] = { savedAt: Date.now(), items: clean };
      saveCache();
    } catch (err) { console.warn('[VideoFinder] Cannot cache streams', err); }
  }

  function forgetMovie(movie) {
    delete cache.movies[movieKey(movie)];
    saveCache();
  }

  function sourceList() {
    return Object.keys(cache.sites).map(function (key) {
      return cache.sites[key];
    }).sort(function (a, b) { return b.lastSeen - a.lastSeen; });
  }

  function showProviders() {
    var status = providerStatuses();
    L.Select.show({
      title: 'Подключённые источники · ' + status.length,
      items: status.map(function (p) {
        var label = p.available ? 'доступен' : 'пауза до ' + new Date(p.cooldownUntil).toLocaleTimeString();
        return { title: p.name, subtitle: label + ' · найдено: ' + p.successes +
          ' · пусто: ' + p.empty + ' · ошибок: ' + p.failures +
          (p.discovery ? ' · поисковик' : ' · каталог') };
      }),
      onSelect: function () { notify('Обновить все источники можно из меню результатов'); },
      onBack: function () { L.Controller.toggle('content'); }
    });
  }

  function showSources() {
    var sources = sourceList();
    if (!sources.length) { notify('Пока нет сохранённых сайтов'); return; }
    L.Select.show({
      title: 'Найденные сайты · ' + sources.length,
      items: sources.map(function (source) {
        return { title: source.host, subtitle: 'Через ' + source.providers.join(', ') + ' · находок: ' + source.matches };
      }),
      onSelect: function () { notify('Это каталог обнаруженных сайтов, не отдельные плагины'); },
      onBack: function () { L.Controller.toggle('content'); }
    });
  }

  function registerProvider(provider) {
    if (!provider || !provider.id || !provider.name ||
        typeof provider.search !== 'function' || typeof provider.resolve !== 'function') {
      throw new Error('A provider requires id, name, search(movie), resolve(item)');
    }
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].id === provider.id) throw new Error('Duplicate provider id: ' + provider.id);
    }
    if (provider.supports != null && typeof provider.supports !== 'function') {
      throw new Error('supports must be a function(movie)');
    }
    providers.push(provider);
  }

  function unregisterProvider(id) {
    providers = providers.filter(function (provider) { return provider.id !== id; });
  }

  function registerAction(action) {
    if (!action || !action.id || !action.title || typeof action.open !== 'function') {
      throw new Error('An action requires id, title, open(movie)');
    }
    for (var i = 0; i < actions.length; i++) {
      if (actions[i].id === action.id) throw new Error('Duplicate action: ' + action.id);
    }
    actions.push(action);
  }

  function chooseStream(item, video, movie, provider) {
    var stream = null;
    try { stream = new URL(video.url); } catch (_) { /* invalid URL */ }
    if (!stream || !/^https?:$/.test(stream.protocol)) {
      notify('Источник вернул неправильный URL', true);
      return;
    }
    try {
      L.Select.close();
      L.Player.play({
        url: stream.href,
        title: movie.title + ' — ' + (item.title || provider.name),
        movie: movie.card
      });
    } catch (err) {
      console.error('[VideoFinder] Playback failed', err);
      notify('Не удалось запустить воспроизведение', true);
    }
  }

  function openStreams(item, provider, movie) {
    notify('Получаю список видео...');
    var saved = cachedStreams(movie, provider, item);
    withTimeout(function () {
      return saved || provider.resolve(item, movie);
    }, providerTimeout(provider), 'resolve ' + provider.id).then(function (streams) {
      if (!Array.isArray(streams) || !streams.length) {
        notify('Для выбранной записи нет доступных MP4-потоков', true);
        return;
      }
      if (!saved) {
        recordProviderSuccess(provider, streams.length);
        rememberStreams(movie, provider, item, streams);
      }
      L.Select.show({
        title: 'Видео · ' + item.title + (saved ? ' · из памяти' : ''),
        items: streams,
        onSelect: function (stream) { chooseStream(item, stream, movie, provider); },
        onBack: function () { L.Controller.toggle('content'); }
      });
    }).catch(function (err) {
      recordProviderFailure(provider);
      console.error('[VideoFinder] Resolve failed:', provider.id, err);
      notify('Не удалось получить поток. Возможны CORS/сетевая ошибка.', true);
    });
  }

  function queryProvider(provider, movie) {
    return withTimeout(function () { return provider.search(movie); }, providerTimeout(provider),
      'search ' + provider.id).then(function (items) {
      if (!Array.isArray(items)) throw new Error('Expected an array of candidates');
      recordProviderSuccess(provider, items.length);
      return { provider: provider, items: rememberCandidates(movie, provider, items), cached: false };
    }).catch(function (err) {
      recordProviderFailure(provider);
      console.error('[VideoFinder] Search failed:', provider.id, err);
      // Preserve the last good results; never cache errors as valid empty searches.
      return { provider: provider, items: cachedCandidates(movie, provider) || [], cached: true };
    });
  }

  function openResults(movie, refresh) {
    if (!movie.title) {
      notify('В карточке нет названия фильма', true);
      return;
    }
    if (busy) return;
    busy = true;
    var cachedGroups = refresh ? [] : providers.map(function (provider) {
      var saved = cachedCandidates(movie, provider);
      return saved ? { provider: provider, items: saved, cached: true } : null;
    }).filter(Boolean);

    var cacheHit = cachedGroups.length > 0;
    var sourceProviders = providers.filter(function (provider) { return !provider.discovery; });
    var discoveryProviders = providers.filter(function (provider) { return provider.discovery; });
    var networkCount = 0;

    if (refresh) notify('Обновляю результаты: ' + movie.title);

    function searchGroup(group) {
      var active = group.filter(function (provider) {
        try {
          if (provider.supports && !provider.supports(movie)) return false;
        } catch (err) {
          console.warn('[VideoFinder] supports() failed:', provider.id, err);
          return false;
        }
        // Manual refresh overrides both the negative cache and the cooldown.
        return (refresh || !recentMiss(movie, provider)) && providerAvailable(provider, refresh);
      });
      networkCount += active.length;
      return Promise.all(active.map(function (provider) { return queryProvider(provider, movie); }));
    }

    // For an already found movie never ask search engines again. For a new
    // movie, ask specialized source adapters first, discovery engines last.
    var tasks = cacheHit ? Promise.resolve(cachedGroups) :
      searchGroup(sourceProviders).then(function (primary) {
        if (refresh) {
          return searchGroup(discoveryProviders).then(function (found) {
            return primary.concat(found);
          });
        }
        if (primary.some(function (group) { return group.items.length; })) return primary;
        return searchGroup(discoveryProviders).then(function (found) {
          return primary.concat(found);
        });
      });

    tasks.then(function (groups) {
      var results = [];
      groups.forEach(function (group) {
        group.items.forEach(function (item) {
          results.push({
            title: item.title || 'Видео',
            subtitle: (item.subtitle ? item.subtitle + ' · ' : '') + group.provider.name +
              (group.cached ? ' · сохранено' : ''),
            _item: item,
            _provider: group.provider,
            _rank: Number(item.confidence) || 0
          });
        });
      });
      results.sort(function (a, b) { return b._rank - a._rank; });

      if (!results.length) {
        notify('Видео не найдено. Можно обновить поиск вручную.', true);
      }
      var menuActions = actions.map(function (action) {
        return { title: action.title, subtitle: action.subtitle || '', _actionHandler: action };
      });
      var entries = results.concat(menuActions, [
        { title: '↻ Обновить поиск', subtitle: 'Проверить все источники заново', _action: 'refresh' },
        { title: 'Подключённые источники (' + providers.length + ')',
          subtitle: 'Доступность и статистика', _action: 'providers' },
        { title: 'Найденные сайты (' + sourceList().length + ')',
          subtitle: 'Локально сохранённые сайты', _action: 'sources' }
      ]);
      L.Select.show({
        title: 'Видео · ' + movie.title + (networkCount === 0 ? ' · из памяти' : ''),
        items: entries,
        onSelect: function (selected) {
          if (selected._actionHandler) { selected._actionHandler.open(movie); return; }
          if (selected._action === 'refresh') { L.Select.close(); openResults(movie, true); return; }
          if (selected._action === 'sources') { showSources(); return; }
          if (selected._action === 'providers') { showProviders(); return; }
          L.Select.close();
          openStreams(selected._item, selected._provider, movie);
        },
        onBack: function () { L.Controller.toggle('content'); }
      });
      if (networkCount === 0 && cacheHit) notify('Показываю сохранённые результаты');
    }).catch(function (err) {
      console.error('[VideoFinder] Unexpected search error', err);
      notify('Ошибка поиска видео', true);
    }).then(function () { busy = false; });
  }

  // Additional adapters can be attached from another script after this one.
  window.LampaVideoFinder = {
    requestJson: httpJson,
    registerProvider: registerProvider,
    unregisterProvider: unregisterProvider,
    registerAction: registerAction,
    listProviders: function () { return providers.map(function (p) { return p.id; }); },
    listKnownSources: sourceList,
    listProviderHealth: providerStatuses,
    clearMovieCache: function (card) { forgetMovie(movieInfo(card)); },
    clearCache: function () { cache = { version: 2, movies: {}, sites: {}, health: {} }; saveCache(); },
    cacheStats: function () { return { movies: Object.keys(cache.movies).length, sites: sourceList().length }; }
  };

  registerProvider({
    id: 'archive',
    name: 'Internet Archive',
    siteUrl: 'https://archive.org',
    persistStreams: true,
    // Archive's catalog is a movie catalog, not a season/episode resolver.
    supports: function (movie) { return movie.media_type !== 'tv'; },
    search: searchArchive,
    resolve: resolveArchive
  });

  function init() {
    L.Manifest.plugins = {
      type: 'video',
      name: 'Video Finder',
      version: '0.5.0',
      description: 'Поиск видео с локальным сохранением найденных источников',
      onContextMenu: function () {
        return { name: 'Найти видео (Video Finder)', description: 'Сначала сохранённое, затем поиск' };
      },
      onContextLauch: function (card) { openResults(movieInfo(card)); }
    };
    console.log('[VideoFinder] Installed. Providers:', window.LampaVideoFinder.listProviders());
  }

  if (window.appready) init();
  else L.Listener.follow('app', function (event) {
    if (event.type === 'ready') init();
  });
})();

/*
 * PluginLampa Rutube provider (independent JS implementation, 2026-10-18).
 * API inspiration: Lampac / Modules/OnlineRUS/RutubeMovie (AGPL-3.0).
 * No Lampac source text reused in this file. Requires compatible CORS.
 */
(function () {
  'use strict';
  var engine = window.LampaVideoFinder;
  if (!engine || typeof engine.registerProvider !== 'function') {
    console.warn('[VideoFinder] Load lampa-video-finder.js before providers/rutube.js');
    return;
  }
  if (engine.listProviders().indexOf('rutube') !== -1) return;

  function clean(text) {
    return String(text || '').toLowerCase()
      .replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ').trim();
  }
  function validStream(text) {
    try {
      var url = new URL(text);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  }
  function getJson(url) { return engine.requestJson(url); }

  function isMatch(candidate, movie) {
    var title = clean(candidate.title);
    var localized = clean(movie.title);
    var original = clean(movie.original_title);
    if (!title) return false;
    if ((localized && title.indexOf(localized) === -1) &&
        (original && title.indexOf(original) === -1)) return false;
    if (/\b(trailer|teaser|review|reaction|recap)\b|трейлер|тизер|обзор|реакция|анонс|сериал|серия/i.test(title)) return false;
    if (Number(candidate.duration || 0) < 3000) return false;
    if (candidate.is_deleted || candidate.is_hidden || candidate.is_locked ||
        candidate.is_paid || candidate.is_adult || candidate.is_livestream) return false;
    return !candidate.category || Number(candidate.category.id) === 4;
  }
  function searchOne(name, movie) {
    var query = [name, movie.year].filter(Boolean).join(' ');
    var url = 'https://rutube.ru/api/search/video/?content_type=video&duration=movie&query=' +
      encodeURIComponent(query);
    return getJson(url).then(function (data) {
      var list = Array.isArray(data.results) ? data.results : [];
      return list.filter(function (entry) { return entry && entry.id != null && isMatch(entry, movie); })
        .map(function (entry) {
          var hasYear = !movie.year || clean(entry.title).indexOf(String(movie.year)) !== -1;
          var href = validStream(entry.video_url || entry.url || '');
          return {
            id: String(entry.id),
            title: String(entry.title),
            subtitle: 'Rutube · ' + Math.round(Number(entry.duration) / 60) + ' мин',
            sourceUrl: href || 'https://rutube.ru/video/' + encodeURIComponent(String(entry.id)) + '/',
            confidence: hasYear ? 85 : 60
          };
        });
    });
  }
  function search(movie) {
    var names = [movie.title];
    if (clean(movie.original_title) !== clean(movie.title)) names.push(movie.original_title);
    return Promise.all(names.filter(Boolean).map(function (name) {
      return searchOne(name, movie).then(function (items) { return { ok: true, items: items }; })
        .catch(function (error) { console.warn('[Rutube] Search failed:', error); return { ok: false, items: [] }; });
    })).then(function (groups) {
      if (!groups.length || !groups.some(function (group) { return group.ok; })) {
        throw new Error('Rutube search unavailable');
      }
      var unique = Object.create(null);
      groups.forEach(function (group) {
        group.items.forEach(function (item) {
          if (!unique[item.id] || unique[item.id].confidence < item.confidence) unique[item.id] = item;
        });
      });
      return Object.keys(unique).map(function (id) { return unique[id]; });
    });
  }
  function resolve(item) {
    if (!item || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(item.id || ''))) {
      return Promise.reject(new Error('Invalid Rutube ID'));
    }
    var url = 'https://rutube.ru/api/play/options/' + encodeURIComponent(item.id) +
      '/?no_404=true&referer=&pver=v2&client=wdp';
    return getJson(url).then(function (data) {
      var balancer = data && data.video_balancer;
      var hls = balancer && validStream(balancer.m3u8);
      if (!hls) return [];
      // Short-lived signed streams are never saved in the host's local cache.
      return [{ title: item.title + ' · HLS', subtitle: 'm3u8', url: hls }];
    });
  }
  engine.registerProvider({
    id: 'rutube', name: 'Rutube', siteUrl: 'https://rutube.ru',
    timeoutMs: 12000, persistStreams: false,
    supports: function (movie) { return movie.media_type !== 'tv'; },
    search: search, resolve: resolve
  });
})();

/*
 * Stremio HTTP addon protocol adapter for PluginLampa.
 * Independent implementation based on the public protocol specification:
 * https://stremio.github.io/stremio-addon-sdk/protocol.html
 * No third-party addon or SDK source code included.
 */
(function () {
  'use strict';
  var engine = window.LampaVideoFinder;
  var L = window.Lampa;
  if (!engine || !L || !engine.registerProvider || !engine.registerAction) {
    console.warn('[VideoFinder] Load core v0.4 before stremio.js');
    return;
  }
  if (window.LampaVideoFinderStremio) return;
  var STORAGE_KEY = 'video_finder_stremio_addons_v1';
  var addons = [];

  function notify(text, error) {
    L.Noty.show(text, error ? { style: 'error', time: 5500 } : { time: 3500 });
  }
  function validHttp(raw, httpsOnly) {
    try {
      var value = String(raw || '').trim();
      if (value.indexOf('stremio://') === 0) value = 'https://' + value.slice(10);
      var url = new URL(value);
      if ((httpsOnly && url.protocol !== 'https:') ||
          (!httpsOnly && !/^https?:$/.test(url.protocol)) ||
          url.username || url.password) return '';
      return url.href;
    } catch (_) { return ''; }
  }
  function manifestUrl(value) {
    var url = validHttp(value, true);
    if (!url) throw Error('Требуется HTTPS-адрес расширения');
    var parsed = new URL(url);
    if (parsed.hash || parsed.search) throw Error('Адрес должен оканчиваться на /manifest.json без параметров');
    if (!/\/manifest\.json$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/manifest.json';
    }
    return parsed.href;
  }
  function readSaved() {
    try {
      var raw = L.Storage && L.Storage.get(STORAGE_KEY, '[]');
      var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(data) ? data.slice(0, 30) : [];
    } catch (_) { return []; }
  }
  function save() {
    if (L.Storage && L.Storage.set) {
      L.Storage.set(STORAGE_KEY, JSON.stringify(addons.map(function (a) {
        return { url: a.url, manifest: a.manifest };
      })));
    }
  }
  function short(value) {
    return String(value || '').replace(/<[^>]+>/g, '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 160);
  }
  function normalizeManifest(manifest) {
    if (!manifest || !manifest.id || !manifest.name || !Array.isArray(manifest.types) ||
        !Array.isArray(manifest.resources)) throw Error('Неправильный manifest.json');
    var resources = manifest.resources.filter(function (resource) {
      return resource === 'stream' || (resource && resource.name === 'stream');
    });
    if (!resources.length) throw Error('Расширение не предоставляет потоки stream');
    return {
      id: short(manifest.id), name: short(manifest.name),
      types: manifest.types.filter(function (v) { return v === 'movie' || v === 'series'; }),
      idPrefixes: Array.isArray(manifest.idPrefixes) ? manifest.idPrefixes.filter(function (p) {
        return typeof p === 'string' && p.length < 40;
      }) : null,
      resources: resources.map(function (r) {
        return typeof r === 'string' ? 'stream' : {
          name: 'stream',
          types: Array.isArray(r.types) ? r.types.filter(function (t) { return t === 'movie' || t === 'series'; }) : null,
          idPrefixes: Array.isArray(r.idPrefixes) ? r.idPrefixes.filter(function (p) {
            return typeof p === 'string' && p.length < 40;
          }) : null
        };
      })
    };
  }
  function hash(text) {
    var value = 2166136261;
    for (var i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(16);
  }
  function request(url) { return engine.requestJson(url); }

  function episode(movie) {
    var card = movie.card || {};
    var season = Number(card.season_number || card.season || 0);
    var number = Number(card.episode_number || card.episode || 0);
    if (!Number.isInteger(season) || !Number.isInteger(number) || season < 1 || number < 1) return null;
    return [season, number];
  }
  function idFor(addon, movie) {
    var type = movie.media_type === 'tv' ? 'series' : 'movie';
    var imdb = movie.imdb_id || (movie.card && movie.card.external_ids && movie.card.external_ids.imdb_id) || '';
    var options = [];
    if (/^tt\d{5,12}$/.test(String(imdb))) options.push(String(imdb));
    if (movie.tmdb_id != null && /^\d+$/.test(String(movie.tmdb_id))) options.push('tmdb:' + String(movie.tmdb_id));
    var resources = addon.manifest.resources;
    for (var i = 0; i < resources.length; i++) {
      var resource = resources[i];
      var types = resource.types || addon.manifest.types;
      if (types.indexOf(type) < 0) continue;
      var prefixes = resource.idPrefixes || addon.manifest.idPrefixes;
      for (var j = 0; j < options.length; j++) {
        var id = options[j];
        // Most addons without a prefix filter expect IMDb IDs. TMDB must be advertised explicitly.
        if ((!prefixes && id.indexOf('tt') === 0) ||
            (prefixes && prefixes.some(function (prefix) { return id.indexOf(prefix) === 0; }))) {
          if (type === 'series') {
            var ep = episode(movie);
            return ep ? { type: type, id: id + ':' + ep[0] + ':' + ep[1] } : null;
          }
          return { type: type, id: id };
        }
      }
    }
    return null;
  }
  function endpoint(addon, key) {
    return addon.url.slice(0, -'manifest.json'.length) + 'stream/' + key.type + '/' +
      encodeURIComponent(key.id) + '.json';
  }
  function playable(stream) {
    if (!stream || !stream.url || (stream.behaviorHints && stream.behaviorHints.proxyHeaders)) return '';
    return validHttp(stream.url, false);
  }
  function playableStreams(data) {
    return data && Array.isArray(data.streams) ? data.streams.filter(playable) : [];
  }
  function makeProvider(addon) {
    return {
      id: addon.providerId, name: 'Stremio · ' + addon.manifest.name,
      siteUrl: addon.url, persistStreams: false, timeoutMs: 12000,
      supports: function (movie) { return !!idFor(addon, movie); },
      search: function (movie) {
        var key = idFor(addon, movie);
        if (!key) return Promise.resolve([]);
        return request(endpoint(addon, key)).then(function (data) {
          return playableStreams(data).slice(0, 25).map(function (stream, index) {
            var title = short(stream.name || stream.description || stream.title || 'Видео');
            return {
              id: key.type + ':' + key.id + ':' + index,
              index: index, videoId: key.id, mediaType: key.type,
              title: title, subtitle: short(stream.description || stream.title || 'Stremio'),
              sourceUrl: addon.url, confidence: 90
            };
          });
        });
      },
      resolve: function (item) {
        if (!item || !/^(movie|series)$/.test(item.mediaType) || !item.videoId ||
            !Number.isInteger(item.index) || item.index < 0 || item.index > 24) {
          return Promise.reject(Error('Неправильная сохранённая запись'));
        }
        return request(endpoint(addon, { type: item.mediaType, id: item.videoId })).then(function (data) {
          var streams = playableStreams(data);
          var selected = streams[item.index];
          if (!selected) return [];
          return [{ title: short(selected.name || item.title || 'Видео'),
            subtitle: short(selected.description || selected.title || 'Stremio'), url: selected.url }];
        });
      }
    };
  }
  function addKnown(url, manifest) {
    var normalized = manifestUrl(url);
    var info = normalizeManifest(manifest);
    var id = 'stremio:' + hash(normalized);
    var old = addons.find(function (a) { return a.url === normalized; });
    if (old) {
      engine.unregisterProvider(old.providerId);
      addons.splice(addons.indexOf(old), 1);
    }
    var addon = { url: normalized, manifest: info, providerId: id };
    addons.push(addon);
    engine.registerProvider(makeProvider(addon));
    save();
    return { id: id, name: info.name, url: normalized };
  }
  function install(url) {
    var cleanUrl = manifestUrl(url);
    return request(cleanUrl).then(function (manifest) { return addKnown(cleanUrl, manifest); });
  }
  function remove(id) {
    var item = addons.find(function (a) { return a.providerId === id; });
    if (!item) return false;
    engine.unregisterProvider(item.providerId);
    addons.splice(addons.indexOf(item), 1);
    save();
    return true;
  }
  function list() {
    return addons.map(function (a) { return { id: a.providerId, name: a.manifest.name, url: a.url }; });
  }
  function addViaInput() {
    if (!L.Input || typeof L.Input.edit !== 'function') {
      notify('В этой версии Lampa нет поля ввода URL', true);
      return;
    }
    L.Select.close();
    L.Input.edit({ title: 'HTTPS-ссылка Stremio addon /manifest.json', value: '', free: true, nosave: true },
      function (value) {
        if (!value) return;
        install(value).then(function (item) {
          notify('Добавлено: ' + item.name);
          manage();
        }).catch(function (err) { notify('Ошибка расширения: ' + err.message, true); });
      });
  }
  function manage() {
    var items = [{ title: '＋ Добавить расширение Stremio', subtitle: 'Адрес HTTPS /manifest.json', action: 'add' }];
    list().forEach(function (addon) {
      items.push({ title: addon.name, subtitle: addon.url + ' · нажмите для удаления', action: 'remove', addon: addon });
    });
    L.Select.show({ title: 'Stremio · расширения (' + addons.length + ')', items: items,
      onSelect: function (choice) {
        if (choice.action === 'add') return addViaInput();
        L.Select.show({ title: 'Удалить ' + choice.addon.name + '?',
          items: [{ title: 'Нет, оставить', action: 'keep' },
            { title: 'Удалить расширение', action: 'confirm' }],
          onSelect: function (confirm) {
            if (confirm.action === 'confirm') {
              remove(choice.addon.id);
              notify('Расширение удалено');
            }
            manage();
          }, onBack: manage });
      }, onBack: function () { L.Controller.toggle('content'); }
    });
  }
  readSaved().forEach(function (addon) {
    try { addKnown(addon.url, addon.manifest); }
    catch (err) { console.warn('[VideoFinder] Ignore invalid saved Stremio addon'); }
  });
  window.LampaVideoFinderStremio = { install: install, remove: remove, list: list, manage: manage };
  engine.registerAction({ id: 'stremio-manage', title: '⚙ Stremio · расширения',
    subtitle: 'Добавить или удалить источник видео', open: manage });
})();
