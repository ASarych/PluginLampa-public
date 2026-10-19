// PluginLampa v0.6.3 · Archive + Rutube + Stremio + AniLiberty + KB.
(function () {
  if (typeof window !== "undefined" && window.__lampa_video_finder_v1) return;
/*
 * observations alternative (a): a bounded ring buffer of raw events whose
 * aggregates are computed on read. Conforms to kb/observations/CONTRACT.md.
 *
 * createStore(storage, opts) -> { append, recent, aggregate, exportAll, importAll, size }
 *
 * Append-only journal, whitelisted event fields, sanitized URLs (no tokens or
 * Stremio query params), one-JSON export/import, in-memory degradation when the
 * storage adapter is missing or broken. No external dependencies. Works both in
 * Node (module.exports) and in the browser (window.LampaVideoFinderKB).
 */
(function (root) {
  'use strict';

  var DEFAULT_KEY = 'video_finder_kb_observations_v1';
  var DEFAULT_MAX_EVENTS = 500;
  var DETAIL_MAX = 200;

  var CLASSES = [
    'FOUND', 'EMPTY', 'INCOMPATIBLE_FORMAT', 'API_ERROR', 'CORS_BLOCKED',
    'SERVER_DOWN', 'TIMEOUT', 'REGION_BLOCKED', 'AUTH_REQUIRED', 'UNCLASSIFIED'
  ];

  var CLASS_SET = {};
  for (var ci = 0; ci < CLASSES.length; ci += 1) CLASS_SET[CLASSES[ci]] = true;

  var TOKEN_SEGMENT = /^[A-Za-z0-9_-]+$/;
  var URL_IN_TEXT = /https?:\/\/[^\s]*/gi;

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function isPositiveInteger(value) {
    return isFiniteNumber(value) && value > 0 && Math.floor(value) === value;
  }

  function isKnownClass(value) {
    return typeof value === 'string' && hasOwn(CLASS_SET, value);
  }

  /* ----------------------------------------------------------- sanitizing */

  function parseUrl(raw) {
    if (typeof URL === 'function') {
      try {
        var parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return { origin: parsed.origin, pathname: parsed.pathname };
      } catch (ignore) {
        return null;
      }
    }
    var match = /^(https?):\/\/([^\/?#]+)([^?#]*)/i.exec(raw);
    if (!match) return null;
    var authority = match[2];
    var at = authority.lastIndexOf('@');
    if (at >= 0) authority = authority.slice(at + 1);
    if (authority.length === 0) return null;
    var pathname = match[3] && match[3].length > 0 ? match[3] : '/';
    return { origin: match[1].toLowerCase() + '://' + authority, pathname: pathname };
  }

  function sanitizePath(pathname) {
    var segments = pathname.split('/');
    for (var i = 0; i < segments.length; i += 1) {
      if (segments[i].length >= 20 && TOKEN_SEGMENT.test(segments[i])) segments[i] = '<token>';
    }
    return segments.join('/');
  }

  function sanitizeUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    var parsed = parseUrl(raw);
    if (!parsed) return null;
    return parsed.origin + sanitizePath(parsed.pathname);
  }

  function sanitizeDetail(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    var collapsed = text.replace(/[\r\n\t]+/g, ' ');
    var masked = collapsed.replace(URL_IN_TEXT, function (match) {
      var safe = sanitizeUrl(match);
      return safe === null ? '' : safe;
    });
    return masked.length > DETAIL_MAX ? masked.slice(0, DETAIL_MAX) : masked;
  }

  /* --------------------------------------------------------------- events */

  function buildEvent(input, nowFn) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('observation event must be an object');
    }
    if (typeof input.sourceId !== 'string' || input.sourceId.length === 0) {
      throw new Error('observation event requires a non-empty sourceId');
    }
    if (!isKnownClass(input.class)) {
      throw new Error('observation event has an unknown class');
    }
    var time;
    if (hasOwn(input, 'time') && input.time !== undefined) {
      if (!isFiniteNumber(input.time)) {
        throw new Error('observation event time must be a finite number');
      }
      time = input.time;
    } else {
      time = nowFn();
    }
    return {
      time: time,
      sourceId: input.sourceId,
      class: input.class,
      movieId: typeof input.movieId === 'string' ? input.movieId : null,
      method: typeof input.method === 'string' ? input.method : null,
      route: sanitizeUrl(input.route),
      detail: sanitizeDetail(input.detail)
    };
  }

  function copyEvent(event) {
    return {
      time: event.time,
      sourceId: event.sourceId,
      class: event.class,
      movieId: event.movieId,
      method: event.method,
      route: event.route,
      detail: event.detail
    };
  }

  function buildStored(input, nowFn, strict) {
    if (!strict) {
      try {
        return buildEvent(input, nowFn);
      } catch (ignore) {
        return null;
      }
    }
    return buildEvent(input, nowFn);
  }

  /* -------------------------------------------------------------- storage */

  function safeGet(storage, key) {
    if (!storage || typeof storage.get !== 'function') return undefined;
    try {
      return storage.get(key, undefined);
    } catch (ignore) {
      return undefined;
    }
  }

  function safeSet(storage, key, value) {
    if (!storage || typeof storage.set !== 'function') return;
    try {
      storage.set(key, value);
    } catch (ignore) {
      /* degradation: memory only */
    }
  }

  function decode(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
      if (raw.length === 0) return null;
      try {
        return JSON.parse(raw);
      } catch (ignore) {
        return null;
      }
    }
    return typeof raw === 'object' ? raw : null;
  }

  function loadEvents(storage, key, maxEvents, nowFn) {
    var data = decode(safeGet(storage, key));
    if (!data || !Array.isArray(data.events)) return [];
    var restored = [];
    for (var i = 0; i < data.events.length; i += 1) {
      var event = buildStored(data.events[i], nowFn, false);
      if (event) restored.push(event);
    }
    return restored.length > maxEvents ? restored.slice(restored.length - maxEvents) : restored;
  }

  /* ------------------------------------------------------------ selection */

  function readFilter(opts) {
    var filter = { limit: null };
    if (isFiniteNumber(opts) && opts >= 0) {
      filter.limit = Math.floor(opts);
      return filter;
    }
    if (opts && typeof opts === 'object') {
      if (typeof opts.sourceId === 'string') filter.sourceId = opts.sourceId;
      if (typeof opts.movieId === 'string') filter.movieId = opts.movieId;
      if (typeof opts.class === 'string') filter.class = opts.class;
      if (isFiniteNumber(opts.since)) filter.since = opts.since;
      if (isFiniteNumber(opts.limit) && opts.limit >= 0) filter.limit = Math.floor(opts.limit);
    }
    return filter;
  }

  function matches(event, filter) {
    if (hasOwn(filter, 'sourceId') && event.sourceId !== filter.sourceId) return false;
    if (hasOwn(filter, 'movieId') && event.movieId !== filter.movieId) return false;
    if (hasOwn(filter, 'class') && event.class !== filter.class) return false;
    if (hasOwn(filter, 'since') && !(event.time >= filter.since)) return false;
    return true;
  }

  /* --------------------------------------------------------------- create */

  function createStore(storage, opts) {
    var options = opts && typeof opts === 'object' ? opts : {};
    var key = typeof options.key === 'string' && options.key.length > 0 ? options.key : DEFAULT_KEY;
    var maxEvents = isPositiveInteger(options.maxEvents) ? options.maxEvents : DEFAULT_MAX_EVENTS;
    var nowFn = typeof options.now === 'function' ? options.now : function () { return Date.now(); };

    var events = loadEvents(storage, key, maxEvents, nowFn);

    function persist() {
      safeSet(storage, key, JSON.stringify({ version: 1, events: events }));
    }

    function append(input) {
      var event = buildEvent(input, nowFn);
      events.push(event);
      if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
      persist();
    }

    function recent(opts2) {
      var filter = readFilter(opts2);
      var selected = [];
      for (var i = 0; i < events.length; i += 1) {
        if (matches(events[i], filter)) selected.push(copyEvent(events[i]));
      }
      if (filter.limit !== null && selected.length > filter.limit) {
        selected = selected.slice(selected.length - filter.limit);
      }
      return selected;
    }

    function aggregate(opts2) {
      var since = opts2 && typeof opts2 === 'object' && isFiniteNumber(opts2.since) ? opts2.since : null;
      var total = 0;
      var sources = Object.create(null);
      for (var i = 0; i < events.length; i += 1) {
        var event = events[i];
        if (since !== null && !(event.time >= since)) continue;
        total += 1;
        var source = sources[event.sourceId];
        if (!source) {
          source = { total: 0, byClass: Object.create(null), lastOk: null, lastFail: null, lastTime: null };
          sources[event.sourceId] = source;
        }
        source.total += 1;
        source.byClass[event.class] = (source.byClass[event.class] || 0) + 1;
        if (event.class === 'FOUND') {
          if (source.lastOk === null || event.time >= source.lastOk) source.lastOk = event.time;
        } else if (source.lastFail === null || event.time >= source.lastFail) {
          source.lastFail = event.time;
        }
        if (source.lastTime === null || event.time >= source.lastTime) source.lastTime = event.time;
      }
      return { total: total, sources: sources };
    }

    function exportAll() {
      var out = [];
      for (var i = 0; i < events.length; i += 1) out.push(copyEvent(events[i]));
      return JSON.stringify({ version: 1, events: out });
    }

    function importAll(json) {
      var data;
      if (typeof json === 'string') {
        try {
          data = JSON.parse(json);
        } catch (ignore) {
          throw new Error('importAll: invalid JSON');
        }
      } else if (json && typeof json === 'object') {
        data = json;
      } else {
        throw new Error('importAll: expected a JSON string or object');
      }
      if (!data || data.version !== 1 || !Array.isArray(data.events)) {
        throw new Error('importAll: expected { version: 1, events: [] }');
      }
      var next = [];
      for (var i = 0; i < data.events.length; i += 1) {
        next.push(buildStored(data.events[i], nowFn, true));
      }
      if (next.length > maxEvents) next = next.slice(next.length - maxEvents);
      events = next;
      persist();
    }

    function size() {
      return events.length;
    }

    return {
      append: append,
      recent: recent,
      aggregate: aggregate,
      exportAll: exportAll,
      importAll: importAll,
      size: size
    };
  }

  var api = { createStore: createStore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.observations = api;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));

/*
 * outcomes alternative (a): a rules table over HTTP status, error name/code
 * and exception text. Conforms to kb/outcomes/CONTRACT.md.
 *
 * classify(err, ctx) -> { class, retryable, detail }
 *
 * Pure, never throws, no external dependencies. Works both in Node
 * (module.exports) and in the browser (window.LampaVideoFinderKB).
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------- kind table */

  var KIND_RULES = {
    found: 'FOUND',
    empty: 'EMPTY',
    not_found: 'EMPTY',
    no_results: 'EMPTY',
    incompatible_format: 'INCOMPATIBLE_FORMAT',
    format: 'INCOMPATIBLE_FORMAT',
    parse_error: 'INCOMPATIBLE_FORMAT',
    bad_format: 'INCOMPATIBLE_FORMAT',
    schema_mismatch: 'INCOMPATIBLE_FORMAT',
    api_error: 'API_ERROR',
    api: 'API_ERROR',
    http_error: 'API_ERROR',
    upstream_error: 'API_ERROR',
    rate_limited: 'API_ERROR',
    cors: 'CORS_BLOCKED',
    cors_blocked: 'CORS_BLOCKED',
    blocked: 'CORS_BLOCKED',
    server_down: 'SERVER_DOWN',
    server_error: 'SERVER_DOWN',
    unavailable: 'SERVER_DOWN',
    connection_refused: 'SERVER_DOWN',
    network: 'SERVER_DOWN',
    timeout: 'TIMEOUT',
    timed_out: 'TIMEOUT',
    region_blocked: 'REGION_BLOCKED',
    geo_blocked: 'REGION_BLOCKED',
    region: 'REGION_BLOCKED',
    not_available: 'REGION_BLOCKED',
    auth_required: 'AUTH_REQUIRED',
    unauthorized: 'AUTH_REQUIRED',
    forbidden: 'AUTH_REQUIRED',
    auth: 'AUTH_REQUIRED',
    login_required: 'AUTH_REQUIRED',
    token_invalid: 'AUTH_REQUIRED',
    unclassified: 'UNCLASSIFIED',
    unknown: 'UNCLASSIFIED'
  };

  /* -------------------------------------------------------------- err codes */

  var TIMEOUT_CODES = { ETIMEDOUT: true, ESOCKETTIMEDOUT: true, ETIMEOUT: true };
  var NETWORK_CODES = {
    ECONNREFUSED: true, ECONNRESET: true, EHOSTUNREACH: true,
    ENETUNREACH: true, ENOTFOUND: true, EAI_AGAIN: true
  };
  var TIMEOUT_NAMES = { AbortError: true, TimeoutError: true };

  /* ------------------------------------------------------------- text table */

  var CORS_PATTERNS = ['cors', 'cross-origin'];
  var REGION_PATTERNS = ['region', 'geo', 'country', 'not available in your'];
  var AUTH_PATTERNS = ['unauthori', 'forbidden', 'auth', 'api key', 'invalid token', 'login'];
  var FORMAT_PATTERNS = ['parse', 'format', 'unexpected token', 'invalid json', 'schema'];
  var TIMEOUT_PATTERNS = ['timed out', 'timeout'];
  var NETWORK_PATTERNS = [
    'enotfound', 'econnrefused', 'econnreset', 'network', 'failed to fetch',
    'fetch failed', 'socket hang up', 'offline', 'unreachable'
  ];
  var API_PATTERNS = ['api error', 'bad request'];

  var TEXT_RULES = [
    { cls: 'CORS_BLOCKED', patterns: CORS_PATTERNS },
    { cls: 'REGION_BLOCKED', patterns: REGION_PATTERNS },
    { cls: 'AUTH_REQUIRED', patterns: AUTH_PATTERNS },
    { cls: 'INCOMPATIBLE_FORMAT', patterns: FORMAT_PATTERNS },
    { cls: 'TIMEOUT', patterns: TIMEOUT_PATTERNS },
    { cls: 'SERVER_DOWN', patterns: NETWORK_PATTERNS },
    { cls: 'API_ERROR', patterns: API_PATTERNS }
  ];

  /* ---------------------------------------------------------------- helpers */

  function hasOwn(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  function read(obj, key) {
    if (obj === null || obj === undefined) return undefined;
    try { return obj[key]; } catch (ignore) { return undefined; }
  }

  function result(cls, detail) {
    return {
      class: cls,
      retryable: cls !== 'FOUND' && cls !== 'EMPTY',
      detail: typeof detail === 'string' && detail.length > 0 ? detail : cls.toLowerCase()
    };
  }

  function textOf(err) {
    if (typeof err === 'string') return err;
    if (err !== null && typeof err === 'object') {
      var message = read(err, 'message');
      if (typeof message === 'string') return message;
    }
    return '';
  }

  function normalizeToken(value) {
    if (typeof value !== 'string') return null;
    var token = value.trim().toLowerCase();
    return token.length > 0 ? token : null;
  }

  function normalizeCode(value) {
    if (typeof value !== 'string') return null;
    var code = value.trim().toUpperCase();
    return code.length > 0 ? code : null;
  }

  function kindClass(value) {
    var token = normalizeToken(value);
    if (token && hasOwn(KIND_RULES, token)) return KIND_RULES[token];
    return null;
  }

  function matchesAny(text, patterns) {
    if (typeof text !== 'string' || text.length === 0) return false;
    var lower = text.toLowerCase();
    for (var i = 0; i < patterns.length; i += 1) {
      if (lower.indexOf(patterns[i]) !== -1) return true;
    }
    return false;
  }

  function textClass(text) {
    for (var i = 0; i < TEXT_RULES.length; i += 1) {
      if (matchesAny(text, TEXT_RULES[i].patterns)) return TEXT_RULES[i].cls;
    }
    return null;
  }

  function isPositiveInteger(value) {
    return typeof value === 'number' && isFinite(value) && value > 0 && Math.floor(value) === value;
  }

  function statusClass(status, text) {
    if (status === 401) return 'AUTH_REQUIRED';
    if (status === 403) {
      if (matchesAny(text, REGION_PATTERNS)) return 'REGION_BLOCKED';
      if (matchesAny(text, CORS_PATTERNS)) return 'CORS_BLOCKED';
      return 'AUTH_REQUIRED';
    }
    if (status === 408) return 'TIMEOUT';
    if (status === 429) return 'API_ERROR';
    if (status === 451) return 'REGION_BLOCKED';
    if (status >= 400 && status <= 499) return 'API_ERROR';
    if (status >= 500 && status <= 599) return 'SERVER_DOWN';
    return null;
  }

  function pickStatus(err, ctx) {
    var errCandidates = [
      read(err, 'status'),
      read(err, 'statusCode'),
      read(read(err, 'response'), 'status'),
      read(err, 'httpStatus')
    ];
    for (var i = 0; i < errCandidates.length; i += 1) {
      if (isPositiveInteger(errCandidates[i])) return errCandidates[i];
    }
    var ctxCandidates = [read(ctx, 'httpStatus'), read(ctx, 'status')];
    for (var j = 0; j < ctxCandidates.length; j += 1) {
      if (isPositiveInteger(ctxCandidates[j])) return ctxCandidates[j];
    }
    return undefined;
  }

  /* -------------------------------------------------------- classification */

  function classifyFromErr(err, ctx) {
    var text = textOf(err);

    var byKind = kindClass(read(err, 'kind'));
    if (byKind) return result(byKind, 'typed marker');

    var status = pickStatus(err, ctx);
    if (status !== undefined) {
      var byStatus = statusClass(status, text);
      if (byStatus) return result(byStatus, 'http status ' + status);
    }

    var code = normalizeCode(read(err, 'code'));
    if (code && hasOwn(TIMEOUT_CODES, code)) return result('TIMEOUT', 'error code ' + code);
    if (code && hasOwn(NETWORK_CODES, code)) return result('SERVER_DOWN', 'error code ' + code);

    var name = read(err, 'name');
    if (typeof name === 'string' && hasOwn(TIMEOUT_NAMES, name)) return result('TIMEOUT', 'error name ' + name);

    var byText = textClass(text);
    if (byText) return result(byText, 'message pattern');

    return result('UNCLASSIFIED', 'unrecognised exception');
  }

  function classifyFromCtx(ctx) {
    var outcome = read(ctx, 'outcome');
    var found = read(ctx, 'found');
    var count = read(ctx, 'resultCount');
    var items = read(ctx, 'items');
    var results = read(ctx, 'results');

    if (outcome === 'found' || found === true ||
        (typeof count === 'number' && isFinite(count) && count > 0) ||
        (Array.isArray(items) && items.length > 0) ||
        (Array.isArray(results) && results.length > 0)) {
      return result('FOUND', 'ctx signals: found');
    }
    if (outcome === 'empty' || read(ctx, 'empty') === true ||
        (typeof count === 'number' && count === 0)) {
      return result('EMPTY', 'ctx signals: empty');
    }
    return result('UNCLASSIFIED', 'ctx signals: unrecognised');
  }

  function classify(err, ctx) {
    try {
      if (err === null || err === undefined) return classifyFromCtx(ctx);
      return classifyFromErr(err, ctx);
    } catch (ignore) {
      return result('UNCLASSIFIED', 'classification failure');
    }
  }

  var api = { classify: classify };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.outcomes = api;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));

/*
 * profile alternative (b): a class-weighted score with exponential decay,
 * computed only from the observation journal. Conforms to kb/profile/CONTRACT.md.
 *
 * profile(store, sourceId, now) -> { score, state, lastOk, bestMethod }
 *
 * The score is the share of positive (FOUND) weight among all weighted
 * meaningful observations, where each observation's weight decays with age
 * (half-life). EMPTY is a successful request without finds: it is treated as
 * neutral and excluded from the score, so it can never worsen a profile.
 * Every failure class weighs strictly more than EMPTY and weights differ by
 * class, so a persistent failure counts more than a transient one.
 *
 * Pure, deterministic for an injected `now`, no external dependencies.
 * Works both in Node (module.exports) and in the browser
 * (window.LampaVideoFinderKB).
 */
(function (root) {
  'use strict';

  var DAY_MS = 24 * 60 * 60 * 1000;
  var HALF_LIFE_MS = 7 * DAY_MS;
  var RECENT_LIMIT = 500;

  var FOUND = 'FOUND';
  var EMPTY = 'EMPTY';

  /* Failure severity weights. All are strictly greater than EMPTY (weight 0). */
  var FAILURE_WEIGHT = {
    TIMEOUT: 1,
    API_ERROR: 1,
    UNCLASSIFIED: 1.5,
    SERVER_DOWN: 2,
    AUTH_REQUIRED: 2.5,
    REGION_BLOCKED: 3,
    CORS_BLOCKED: 3,
    INCOMPATIBLE_FORMAT: 3
  };

  var NEUTRAL = { score: 0, state: 'unknown', lastOk: null, bestMethod: null };

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function classOf(obs) {
    if (obs && typeof obs.class === 'string') return obs.class;
    if (obs && typeof obs.outcome === 'string') return obs.outcome;
    return '';
  }

  function atOf(obs) {
    if (obs && isFiniteNumber(obs.at)) return obs.at;
    if (obs && isFiniteNumber(obs.ts)) return obs.ts;
    return null;
  }

  function methodOf(obs) {
    return obs && typeof obs.method === 'string' ? obs.method : '';
  }

  function readJournal(store, sourceId) {
    if (!store || typeof store.recent !== 'function') return [];
    var list;
    try {
      list = store.recent(sourceId, RECENT_LIMIT);
    } catch (err) {
      return [];
    }
    return Array.isArray(list) ? list : [];
  }

  function decayFactor(now, at) {
    var age = now - at;
    if (age <= 0) return 1;
    return Math.pow(0.5, age / HALF_LIFE_MS);
  }

  function profile(store, sourceId, now) {
    var clock = isFiniteNumber(now) ? now : 0;
    var journal = readJournal(store, sourceId);

    var positive = 0;
    var negative = 0;
    var foundCount = 0;
    var failureCount = 0;
    var lastOk = null;
    var methods = {};

    for (var i = 0; i < journal.length; i++) {
      var obs = journal[i];
      if (!obs || typeof obs !== 'object') continue;
      var at = atOf(obs);
      if (at === null || at > clock) continue;

      var weight = decayFactor(clock, at);
      var cls = classOf(obs);

      if (cls === FOUND) {
        foundCount++;
        positive += weight;
        if (lastOk === null || at > lastOk) lastOk = at;
        var name = methodOf(obs);
        if (name) {
          var entry = methods[name];
          if (!entry) {
            entry = { count: 0, lastAt: -Infinity };
            methods[name] = entry;
          }
          entry.count++;
          if (at > entry.lastAt) entry.lastAt = at;
        }
      } else if (cls === EMPTY) {
        continue;
      } else {
        failureCount++;
        var severity = Object.prototype.hasOwnProperty.call(FAILURE_WEIGHT, cls)
          ? FAILURE_WEIGHT[cls]
          : FAILURE_WEIGHT.UNCLASSIFIED;
        negative += severity * weight;
      }
    }

    if (foundCount === 0 && failureCount === 0) {
      return { score: 0, state: 'unknown', lastOk: null, bestMethod: null };
    }

    var total = positive + negative;
    var score = total > 0 ? positive / total : 0;
    if (!(score >= 0)) score = 0;
    if (!(score <= 1)) score = 1;

    var state;
    if (foundCount > 0 && failureCount > 0) state = 'degraded';
    else if (foundCount > 0) state = 'ok';
    else state = 'down';

    var bestMethod = null;
    if (foundCount > 0) {
      var bestName = null;
      var bestEntry = null;
      for (var key in methods) {
        if (!Object.prototype.hasOwnProperty.call(methods, key)) continue;
        var cand = methods[key];
        if (bestEntry === null
          || cand.count > bestEntry.count
          || (cand.count === bestEntry.count && cand.lastAt > bestEntry.lastAt)
          || (cand.count === bestEntry.count && cand.lastAt === bestEntry.lastAt && key < bestName)) {
          bestName = key;
          bestEntry = cand;
        }
      }
      if (bestName !== null) bestMethod = bestName;
    }

    return { score: score, state: state, lastOk: lastOk, bestMethod: bestMethod };
  }

  var api = { profile: profile };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.profile = api;
  }
})(typeof window !== 'undefined' && window ? window
  : (typeof self !== 'undefined' && self ? self : null));

(function (root) {
  'use strict';

  var LADDER = [0, 0, 60000, 300000, 1800000];
  var QUARANTINE_MS = 86400000;
  var ACTION_NONE = 'none';
  var ACTION_PAUSE = 'pause';
  var ACTION_QUARANTINE = 'quarantine';

  var RULES = {
    FOUND: { pauseMs: 0, action: ACTION_NONE },
    EMPTY: { pauseMs: 0, action: ACTION_NONE }
  };

  var QUARANTINE_CLASSES = {
    CORS_BLOCKED: true,
    INCOMPATIBLE_FORMAT: true
  };

  function normalizeStreak(profile) {
    if (profile === null || typeof profile !== 'object') return 0;
    var streak = profile.streak;
    if (typeof streak !== 'number' || !isFinite(streak)) return 0;
    var floored = Math.floor(streak);
    return floored > 0 ? floored : 0;
  }

  function ladderDecision(streak) {
    var pauseMs = LADDER[Math.min(streak, LADDER.length - 1)];
    return { pauseMs: pauseMs, action: pauseMs > 0 ? ACTION_PAUSE : ACTION_NONE };
  }

  function decide(profile, outcomeClass, hasAlternative) {
    var kind = typeof outcomeClass === 'string' ? outcomeClass : '';

    if (Object.prototype.hasOwnProperty.call(RULES, kind)) {
      var rule = RULES[kind];
      return { pauseMs: rule.pauseMs, action: rule.action };
    }

    if (!hasAlternative && Object.prototype.hasOwnProperty.call(QUARANTINE_CLASSES, kind)) {
      return { pauseMs: QUARANTINE_MS, action: ACTION_QUARANTINE };
    }

    return ladderDecision(normalizeStreak(profile));
  }

  var api = { decide: decide, LADDER: LADDER, QUARANTINE_MS: QUARANTINE_MS };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.policy = api;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));

/*
 * registry alternative (b): a priority list of implementations per source.
 * Conforms to kb/registry/CONTRACT.md.
 *
 * createRegistry() -> { register(impl), choose(sourceId, profileFn) -> impl | null }
 *
 * The registration order of each source is its priority list: the first
 * registered implementation is the primary one, the next ones are fallbacks.
 * choose() reduces the preference reported by profileFn(impl, sourceId) to a
 * single implementation: the maximum wins, ties go to the earlier registration.
 *
 * Switching on failures and the daily retry of a rejected implementation are
 * expressed by the caller through profileFn; the registry keeps no history:
 * - a healthy implementation reports a positive constant (equal constants keep
 *   the priority order through the stable tie-break);
 * - a failed implementation that must not be retried yet reports -Infinity,
 *   so the choice switches to the next implementation in the list;
 * - when the daily retry is due (about 24 h after the failure, the quarantine
 *   convention: 86400000 ms), profileFn reports the healthy constant again and
 *   the rejected implementation is probed once more;
 * - while every implementation is rejected, the top of the priority list is
 *   returned, so the daily probe always has a candidate.
 *
 * Pure, deterministic, no external dependencies. Works both in Node
 * (module.exports) and in the browser (window.LampaVideoFinderKB.registry).
 */
(function (root) {
  'use strict';

  /* -------------------------------------------------------------- preference */

  // A number counts as is; an object counts as its numeric `score` field;
  // everything else (NaN, Infinity, undefined, a missing score) ranks last.
  function normalizePreference(raw) {
    var value = raw;
    if (value !== null && typeof value === 'object') value = value.score;
    if (typeof value === 'number' && isFinite(value)) return value;
    return -Infinity;
  }

  function findIndexById(order, id) {
    for (var i = 0; i < order.length; i++) {
      if (order[i].id === id) return i;
    }
    return -1;
  }

  /* ---------------------------------------------------------------- factory */

  function createRegistry() {
    var order = []; // registration order = priority order

    function register(impl) {
      if (typeof impl !== 'object' || impl === null) {
        throw new TypeError('registry: impl must be an object');
      }
      if (typeof impl.id !== 'string' || impl.id === '') {
        throw new TypeError('registry: impl.id must be a non-empty string');
      }
      if (typeof impl.sourceId !== 'string' || impl.sourceId === '') {
        throw new TypeError('registry: impl.sourceId must be a non-empty string');
      }
      var index = findIndexById(order, impl.id);
      if (index === -1) order.push(impl);
      else order[index] = impl; // duplicate id: replace in place, order kept
    }

    function choose(sourceId, profileFn) {
      var best = null;
      var bestScore = -Infinity;
      for (var i = 0; i < order.length; i++) {
        var impl = order[i];
        if (impl.sourceId !== sourceId) continue;
        if (typeof profileFn !== 'function') return impl; // the top priority
        var score = normalizePreference(profileFn(impl, sourceId));
        if (best === null || score > bestScore) {
          bestScore = score;
          best = impl;
        }
      }
      return best;
    }

    return { register: register, choose: choose };
  }

  /* --------------------------------------------------------------- exports */

  if (typeof module === 'object' && module.exports) module.exports = createRegistry;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.registry = createRegistry;
  }
})(typeof window !== 'undefined' ? window
  : typeof self !== 'undefined' ? self
  : typeof globalThis !== 'undefined' ? globalThis
  : undefined);

(function (root) {
  'use strict';

  var DEFAULT_KEY = 'video_finder_routes.v1';
  var ROUTE_KEYS = ['sourceId', 'page', 'method', 'checkedAt', 'persistence'];
  var PERSISTENCE = ['persistent', 'ephemeral'];

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function requireMovieId(movieId) {
    if (!isNonEmptyString(movieId)) {
      throw new TypeError('movieId must be a non-empty string');
    }
  }

  function normalizeRoute(route, now) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new TypeError('route must be an object');
    }

    var keys = Object.keys(route);
    for (var i = 0; i < keys.length; i++) {
      if (ROUTE_KEYS.indexOf(keys[i]) === -1) {
        throw new TypeError('unknown route key: ' + keys[i]);
      }
    }

    if (!isNonEmptyString(route.sourceId)) {
      throw new TypeError('sourceId must be a non-empty string');
    }
    if (!isNonEmptyString(route.page)) {
      throw new TypeError('page must be a non-empty string');
    }
    if (!isNonEmptyString(route.method)) {
      throw new TypeError('method must be a non-empty string');
    }
    if (PERSISTENCE.indexOf(route.persistence) === -1) {
      throw new TypeError('persistence must be one of ' + PERSISTENCE.join('/'));
    }

    var checkedAt = route.checkedAt;
    if (checkedAt === undefined || checkedAt === null) {
      checkedAt = now();
    }
    if (typeof checkedAt !== 'number' || !isFinite(checkedAt)) {
      throw new TypeError('checkedAt must be a finite number');
    }

    return {
      sourceId: route.sourceId,
      page: route.page,
      method: route.method,
      checkedAt: checkedAt,
      persistence: route.persistence
    };
  }

  function copyRoute(route) {
    return {
      sourceId: route.sourceId,
      page: route.page,
      method: route.method,
      checkedAt: route.checkedAt,
      persistence: route.persistence
    };
  }

  function freshData() {
    return { version: 1, index: {}, movies: {} };
  }

  function createRoutes(storage, opts) {
    var options = opts || {};
    var key = isNonEmptyString(options.key) ? options.key : DEFAULT_KEY;
    var now = typeof options.now === 'function'
      ? options.now
      : (typeof options.now === 'number' ? function () { return options.now; } : Date.now);

    function load() {
      var raw = storage.get(key, null);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return freshData();
      var data = freshData();
      if (raw.index && typeof raw.index === 'object' && !Array.isArray(raw.index)) {
        data.index = raw.index;
      }
      if (raw.movies && typeof raw.movies === 'object' && !Array.isArray(raw.movies)) {
        data.movies = raw.movies;
      }
      return data;
    }

    function save(data) {
      storage.set(key, data);
    }

    function indexAdd(data, sourceId, movieId) {
      var list = data.index[sourceId];
      if (!Array.isArray(list)) list = [];
      if (list.indexOf(movieId) === -1) list.push(movieId);
      data.index[sourceId] = list;
    }

    function indexRemoveMovie(data, movieId) {
      var sources = Object.keys(data.index);
      for (var i = 0; i < sources.length; i++) {
        var sourceId = sources[i];
        var list = data.index[sourceId];
        if (!Array.isArray(list)) continue;
        var at = list.indexOf(movieId);
        if (at === -1) continue;
        list.splice(at, 1);
        if (list.length === 0) delete data.index[sourceId];
        else data.index[sourceId] = list;
      }
    }

    function remember(movieId, route) {
      requireMovieId(movieId);
      var normalized = normalizeRoute(route, now);
      var data = load();

      var list = data.movies[movieId];
      if (!Array.isArray(list)) list = [];
      var replaced = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].sourceId === normalized.sourceId) {
          list[i] = copyRoute(normalized);
          replaced = true;
          break;
        }
      }
      if (!replaced) list.push(copyRoute(normalized));
      data.movies[movieId] = list;

      indexAdd(data, normalized.sourceId, movieId);
      save(data);
      return copyRoute(normalized);
    }

    function routesFor(movieId) {
      requireMovieId(movieId);
      var data = load();
      var list = data.movies[movieId];
      if (!Array.isArray(list)) return [];
      var copy = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i]) copy.push(copyRoute(list[i]));
      }
      copy.sort(function (a, b) { return b.checkedAt - a.checkedAt; });
      return copy;
    }

    function forget(movieId) {
      requireMovieId(movieId);
      var data = load();
      if (!Object.prototype.hasOwnProperty.call(data.movies, movieId)) return false;
      delete data.movies[movieId];
      indexRemoveMovie(data, movieId);
      save(data);
      return true;
    }

    return { remember: remember, routesFor: routesFor, forget: forget };
  }

  var api = { createRoutes: createRoutes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.routes = api;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));

(function () {
  'use strict';

  const SCHEMA_KEY = 'video_finder_kb_schema';
  const KB_PREFIX = 'video_finder_kb_';
  const CACHE_KEY = 'video_finder_cache_v2';
  const ADDONS_KEY = 'video_finder_stremio_addons_v1';

  function isStorage(obj) {
    return obj && typeof obj.get === 'function' && typeof obj.set === 'function';
  }

  function migrate(storage) {
    if (!isStorage(storage)) {
      throw new TypeError('storage must have get/set methods');
    }
    const existing = storage.get(SCHEMA_KEY, undefined);
    if (existing !== undefined && typeof existing === 'number') {
      return { schemaVersion: existing, created: false };
    }
    const version = 1;
    storage.set(SCHEMA_KEY, version);
    return { schemaVersion: version, created: true };
  }

  // The observation contract permits both JSON strings and plain objects.
  function parseDoc(raw) {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  function enforce(store, maxBytes) {
    if (typeof maxBytes !== 'number' || !isFinite(maxBytes) || maxBytes < 0) {
      throw new TypeError('maxBytes must be a finite non-negative number');
    }
    if (!store || typeof store.size !== 'function' ||
        typeof store.exportAll !== 'function' || typeof store.importAll !== 'function') {
      throw new TypeError('store must support size/exportAll/importAll');
    }
    if (store.size() <= maxBytes) {
      return { bytes: store.size(), maxBytes: maxBytes, removed: 0 };
    }
    const doc = parseDoc(store.exportAll());
    if (!doc || !Array.isArray(doc.events)) {
      throw new TypeError('observation export must contain events[]');
    }
    // Serialized size decreases as the oldest events are removed. Binary
    // search avoids one persistent storage write per evicted event on TVs.
    const events = doc.events.slice();
    let low = 0;
    let high = events.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      store.importAll(Object.assign({}, doc, { events: events.slice(mid) }));
      if (store.size() <= maxBytes) high = mid;
      else low = mid + 1;
    }
    // Reapply the minimum fitting suffix, even when all events must go.
    store.importAll(Object.assign({}, doc, { events: events.slice(low) }));
    return { bytes: store.size(), maxBytes: maxBytes, removed: low };
  }

  function exportAll(storage, store) {
    const schemaVersion = (isStorage(storage)) ? (storage.get(SCHEMA_KEY, 0)) : 0;
    return {
      schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : 0,
      observations: store && typeof store.exportAll === 'function' ? store.exportAll() : { events: [] }
    };
  }

  function importAll(storage, store, doc) {
    if (typeof doc === 'string') {
      doc = JSON.parse(doc);
    }
    if (!doc || typeof doc !== 'object') {
      throw new TypeError('doc must be an object or JSON string');
    }
    if (isStorage(storage)) {
      if (doc.schemaVersion !== undefined && typeof doc.schemaVersion === 'number' && doc.schemaVersion >= 0) {
        storage.set(SCHEMA_KEY, doc.schemaVersion);
      }
    }
    if (store && typeof store.importAll === 'function') {
      store.importAll(doc.observations || doc);
    }
    return doc;
  }

  // Re-export correct enforce
  const api = {
    migrate: migrate,
    enforce: enforce,
    exportAll: exportAll,
    importAll: importAll
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.LampaVideoFinderKB = window.LampaVideoFinderKB || {};
    window.LampaVideoFinderKB.budget = api;
  }
})();

(function (root) {
  'use strict';

  var DESCRIPTOR = {
    sourceId: 'archive',
    family: 'public-catalog',
    formats: ['mp4'],
    requirements: ['https']
  };

  function describe() {
    return {
      sourceId: DESCRIPTOR.sourceId,
      family: DESCRIPTOR.family,
      formats: DESCRIPTOR.formats.slice(),
      requirements: DESCRIPTOR.requirements.slice()
    };
  }

  var api = { describe: describe };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.descriptors = root.LampaVideoFinderKB.descriptors || {};
    root.LampaVideoFinderKB.descriptors[api.describe().sourceId] = api;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));

(function (root) {
  'use strict';
  var api = {
    describe: function () {
      return {
        sourceId: 'rutube',
        family: 'video-service',
        formats: ['hls', 'mp4'],
        requirements: ['https', 'rutube-api']
      };
    }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.descriptors = root.LampaVideoFinderKB.descriptors || {};
    root.LampaVideoFinderKB.descriptors.rutube = api;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));

(function (root) {
  'use strict';
  function describe() {
    return Object.freeze({
      sourceId: 'stremio',
      family: 'addon-protocol',
      formats: ['mp4', 'hls', 'http'],
      requirements: ['https', 'addon-manifest', 'movie-series']
    });
  }
  var api = { describe: describe };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LampaVideoFinderKB = root.LampaVideoFinderKB || {};
    root.LampaVideoFinderKB.descriptors = root.LampaVideoFinderKB.descriptors || {};
    root.LampaVideoFinderKB.descriptors[api.describe().sourceId] = api;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));

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

// PluginLampa v0.6.2 · Archive + Rutube + Stremio + Knowledge Base.
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
  var L = window.Lampa;
  if (!L || !L.Manifest || !L.Listener || !L.Storage || !L.Noty || !L.Select || !L.Player) {
    console.warn('[PluginLampa] Lampa is not ready; no plugin hooks installed');
    return;
  }
  window.__lampa_video_finder_v1 = true;
  var providers = [];
  var actions = [];
  var resultsNavigationGeneration = 0;
  var activeNativePage = null;
  var movieLookupRevision = 0;
  var movieLookupTimer = null;
  function displayMenu(config) {
    if (activeNativePage && activeNativePage.isAlive()) {
      activeNativePage.showMenu(config);
      return;
    }
    L.Select.show(config);
  }
  function closeMenu() {
    if (!activeNativePage) L.Select.close();
  }
  function exitResults() {
    if (activeNativePage && activeNativePage.isAlive() &&
        L.Activity && typeof L.Activity.backward === 'function') {
      L.Activity.backward();
    } else L.Controller.toggle('content');
  }
  function attachNativePage(page) { activeNativePage = page; }
  function detachNativePage(page) {
    if (activeNativePage === page) {
      activeNativePage = null;
      ++movieLookupRevision;
      if (movieLookupTimer !== null) clearTimeout(movieLookupTimer);
      movieLookupTimer = null;
      ++resultsNavigationGeneration;
      ++streamNavigationGeneration;
    }
  }
  function openNativePage(card) {
    if (activeNativePage) return false;
    var page = window.LampaVideoFinderNativePage;
    return !!(page && typeof page.open === 'function' && page.open(card));
  }
  var CACHE_KEY = 'video_finder_cache_v3';
  var MAX_STARTUP_CACHE_CHARS = 4 * 1024 * 1024;
  var MAX_MOVIES = 120;
  var MAX_RESULTS = 25;
  // A single Select.show with hundreds of items may strain older TV WebViews.
  var RESULTS_PAGE_SIZE = 30;
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
      imdb_id: String(card.imdb_id || (card.external_ids && card.external_ids.imdb_id) || ''),
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
      if (!Array.isArray(documents)) throw new Error('Archive: неверный формат ответа поиска');
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
      var files = payload && payload.files;
      if (!Array.isArray(files)) throw new Error('Archive: неверный формат файлов метаданных');
      // Extremely large metadata records should not freeze TV menu rendering.
      return files.slice(0, 1000).filter(function (file) {
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
      // Reading a huge/corrupt cache can stall Tizen before Lampa renders.
      // Skip decoding oversized strings but preserve the stored value for recovery.
      if (typeof raw === 'string' && raw.length > MAX_STARTUP_CACHE_CHARS) {
        console.warn('[VideoFinder] Legacy cache too large for startup; keeping stored data unchanged');
        return empty;
      }
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
    stats.lastOutcome = '';
    stats.policyAction = 'none';
    saveCache();
  }

  function recordProviderFailure(provider, error) {
    var stats = providerHealth(provider);
    stats.failures += 1;
    stats.streak += 1;
    stats.lastFail = Date.now();
    // KB M2: drive backoff from the classified outcome, never label a failure EMPTY.
    // Preserve the legacy ladder if KB is unavailable on an older installation.
    var pauseMs = COOLDOWNS_MS[Math.min(stats.streak, COOLDOWNS_MS.length - 1)];
    var kb = knowledgeBase();
    if (kb && kb.api.policy && typeof kb.api.policy.decide === 'function') {
      try {
        var classification = kb.api.outcomes.classify(error).class;
        var alternatives = providers.some(function (other) {
          return other.id !== provider.id && other.sourceId &&
            other.sourceId === provider.sourceId;
        });
        var decision = kb.api.policy.decide({streak:stats.streak},classification,alternatives);
        if (decision && typeof decision.pauseMs === 'number' && isFinite(decision.pauseMs)) {
          pauseMs = Math.max(0,decision.pauseMs);
          stats.lastOutcome = classification;
          stats.policyAction = decision.action;
        }
      } catch (err) { console.warn('[PluginLampa KB] policy:',err); }
    }
    stats.cooldownUntil = pauseMs ? Date.now() + pauseMs : 0;
    saveCache();
  }

  function providerStatuses() {
    return providers.map(function (provider) {
      var h = providerHealth(provider);
      return {
        id: provider.id, name: provider.name, discovery: !!provider.discovery,
        successes: h.successes, empty: h.empty, failures: h.failures,
        streak: h.streak, cooldownUntil: h.cooldownUntil,
        lastOutcome: h.lastOutcome || '', policyAction: h.policyAction || 'none',
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
    var match = String(url || '').match(/^https?:\/\/([^\/:?#\s]+)(?::[0-9]+)?(?:[\/?#]|$)/i);
    return match ? match[1].toLowerCase() : '';
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

  // A source may opt into stream caching, but that does not make a signed
  // URL permanent. Query strings/fragments can carry authorization or expiry
  // tokens and must never enter local persistent playback data.
  function persistableStreamUrl(url) {
    if (typeof url !== 'string' || url.length > 2048 || /[\s\\?#]/.test(url)) return false;
    if (typeof URL === 'function') {
      try {
        var parsed = new URL(url);
        return /^https?:$/.test(parsed.protocol) && !!parsed.hostname &&
          !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
      } catch (err) { return false; }
    }
    // Fallback for Tizen WebViews without URL(): reject userinfo and malformed ports.
    var match = url.match(/^https?:\/\/([a-z0-9][a-z0-9.-]*|\[[a-f0-9:]+\])(?::([0-9]{1,5}))?\/[^\s?#\\]*$/i);
    return !!match && (!match[2] || Number(match[2]) <= 65535);
  }

  function cachedStreams(movie, provider, item) {
    if (!provider.persistStreams || item.id == null) return null;
    var record = getMovieEntry(movie, false);
    var entry = record && record.providers[provider.id];
    var stream = entry && entry.streams && entry.streams[String(item.id)];
    if (!stream || !Array.isArray(stream.items) || !stream.items.length) return null;
    // Previously persisted entries may contain query-bearing expired tokens.
    if (!stream.items.every(function (entry) { return entry && persistableStreamUrl(entry.url); })) return null;
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
        return stream && persistableStreamUrl(stream.url);
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

  function showProviders(returnToResults) {
    var status = providerStatuses();
    displayMenu({
      title: 'Подключённые источники · ' + status.length,
      items: status.map(function (p) {
        var label = p.available ? 'доступен' : 'пауза до ' + new Date(p.cooldownUntil).toLocaleTimeString();
        return { title: p.name, subtitle: label + ' · найдено: ' + p.successes +
          ' · пусто: ' + p.empty + ' · ошибок: ' + p.failures +
          (p.discovery ? ' · поисковик' : ' · каталог') +
          (p.lastOutcome ? ' · KB: ' + p.lastOutcome + '/' + p.policyAction : '') };
      }),
      onSelect: function () { notify('Обновить все источники можно из меню результатов'); },
      onBack: function () {
        if (returnToResults) returnToResults();
        else exitResults();
      }
    });
  }

  function showSources(returnToResults) {
    var sources = sourceList();
    if (!sources.length) { notify('Пока нет сохранённых сайтов'); return; }
    displayMenu({
      title: 'Найденные сайты · ' + sources.length,
      items: sources.map(function (source) {
        return { title: source.host, subtitle: 'Через ' + source.providers.join(', ') + ' · находок: ' + source.matches };
      }),
      onSelect: function () { notify('Это каталог обнаруженных сайтов, не отдельные плагины'); },
      onBack: function () {
        if (returnToResults) returnToResults();
        else exitResults();
      }
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

  function safePlaybackUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 8192 ||
        raw !== raw.trim() || /[\s\\<>]/.test(raw)) return '';
    // Parse the authority ourselves as well: older Tizen has no URL(), and
    // different browser versions may normalize malformed backslashes/userinfo.
    var match = raw.match(/^https?:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
    if (!match || match[1].indexOf('@') !== -1) return '';
    var host = match[1].match(/^([a-z0-9][a-z0-9.-]*|\[[a-f0-9:]+\])(?::([0-9]{1,5}))?$/i);
    if (!host || (host[2] && Number(host[2]) > 65535)) return '';
    if (typeof URL !== 'function') return raw;
    try {
      var url = new URL(raw);
      if (!/^https?:$/.test(url.protocol) || !url.hostname ||
          url.username || url.password) return '';
      return url.href;
    } catch (err) { return ''; }
  }

  function chooseStream(item, video, movie, provider) {
    var stream = safePlaybackUrl(video && video.url);
    if (!stream) {
      notify('Источник вернул неправильный URL', true);
      return;
    }
    try {
      closeMenu();
      L.Player.play({
        url: stream,
        title: movie.title + ' — ' + (video.title || item.title || provider.name),
        movie: movie.card
      });
    } catch (err) {
      console.error('[VideoFinder] Playback failed', err);
      notify('Не удалось запустить воспроизведение', true);
    }
  }

  function showStreamOptions(streams, item, provider, movie, returnToResults, saved, generation) {
    function current() { return generation === streamNavigationGeneration; }
    function back() {
      if (!current()) return;
      if (returnToResults) returnToResults();
      else exitResults();
    }
    var grouped = [];
    streams.forEach(function (video) {
      if (!video || !video.episodeNumber) return;
      var key = String(video.episodeNumber);
      var existing = grouped.filter(function (e) { return e.key === key; })[0];
      if (!existing) {
        existing = {key: key, title: video.episodeTitle || ('Серия ' + key), streams: []};
        grouped.push(existing);
      }
      existing.streams.push(video);
    });

    // Multiple episodes are a navigation level, not a giant flat list
    // of up to 150 HLS variants. Other providers retain their old flow.
    if (grouped.length > 1 && grouped.reduce(function (sum, g) {
      return sum + g.streams.length;
    }, 0) === streams.length) {
      function episodeMenu() {
        if (!current()) return;
        displayMenu({
          title: 'Серии · ' + item.title,
          items: grouped.map(function (group) {
            return {title: group.title, subtitle: group.streams.length + ' вариантов качества',
              _episode: group};
          }),
          onSelect: function (picked) {
            if (!current() || !picked) return;
            var group = picked._episode;
            if (!group) return;
            displayMenu({
              title: group.title + ' · качество',
              items: group.streams,
              onSelect: function (stream) {
                if (current()) chooseStream(item, stream, movie, provider);
              },
              onBack: episodeMenu
            });
          },
          onBack: back
        });
      }
      episodeMenu();
      return;
    }
    displayMenu({
      title: 'Видео · ' + item.title + (saved ? ' · из памяти' : ''),
      items: streams,
      onSelect: function (stream) {
        if (current()) chooseStream(item, stream, movie, provider);
      },
      onBack: back
    });
  }

  var streamNavigationGeneration = 0;
  function openStreams(item, provider, movie, returnToResults) {
    var generation = ++streamNavigationGeneration;
    notify('Получаю список видео...');
    function cancel() {
      if (generation !== streamNavigationGeneration) return;
      ++streamNavigationGeneration;
      if (returnToResults) returnToResults();
    }
    displayMenu({
      title: 'Получаю видео · ' + (item.title || provider.name),
      items: [{title: 'Назад', subtitle: 'Отменить ожидание потока'}],
      onSelect: cancel,
      onBack: cancel
    });
    var saved = cachedStreams(movie, provider, item);
    withTimeout(function () {
      return saved || provider.resolve(item, movie);
    }, providerTimeout(provider), 'resolve ' + provider.id).then(function (streams) {
      if (generation !== streamNavigationGeneration) return;
      if (!Array.isArray(streams) || !streams.length) {
        notify('Для выбранной записи нет доступных MP4/HLS-потоков', true);
        if (returnToResults) returnToResults();
        return;
      }
      if (!saved) {
        recordProviderSuccess(provider, streams.length);
        rememberStreams(movie, provider, item, streams);
      }
      showStreamOptions(streams, item, provider, movie, returnToResults, saved, generation);
    }).catch(function (err) {
      if (generation !== streamNavigationGeneration) return;
      recordProviderFailure(provider, err);
      console.error('[VideoFinder] Resolve failed:', provider.id, err);
      notify('Не удалось получить поток. Возможны CORS/сетевая ошибка.', true);
      if (returnToResults) returnToResults();
    });
  }

  // Lazy optional knowledge base; legacy cache remains the source of playback data.
  var knowledge = null;
  function knowledgeBase() {
    if (knowledge) return knowledge;
    var k = window.LampaVideoFinderKB;
    if (!k || !k.observations || !k.outcomes || !k.routes || !k.profile || !k.registry || !k.budget) return null;
    try {
      k.budget.migrate(L.Storage);
      knowledge = {
        api:k, observations:k.observations.createStore(L.Storage,{maxEvents:250}),
        routes:k.routes.createRoutes(L.Storage), registry:k.registry()
      };
      providers.forEach(function(p){knowledge.registry.register({id:p.id,sourceId:p.id});});
    } catch(e) {console.warn('[PluginLampa KB] init:',e); return null;}
    return knowledge;
  }
  // Lampa.Storage can be small on older Smart TVs. Budget uses UTF-8 bytes,
  // while observation store.size() deliberately counts events.
  function kbBytes(kb) {
    var text = kb.observations.exportAll();
    try {
      return encodeURIComponent(text).replace(/%[0-9A-F]{2}/gi, 'X').length;
    } catch (err) { return text.length * 3; }
  }
  function capKB(kb) {
    var store = {
      append: function(e) {kb.observations.append(e);},
      exportAll: function() {return JSON.parse(kb.observations.exportAll());},
      importAll: function(doc) {kb.observations.importAll(doc);},
      size: function() {return kbBytes(kb);}
    };
    kb.api.budget.enforce(store, 65536);
  }

  function knowledgeRecord(provider,movie,err,items) {
    var kb=knowledgeBase();
    if(!kb)return;
    try {
      var count=Array.isArray(items)?items.length:0;
      var kind=err?kb.api.outcomes.classify(err).class:(count?'FOUND':'EMPTY');
      kb.observations.append({
        sourceId:provider.id,class:kind,movieId:movieKey(movie),
        method:'search',detail:'count='+count
      });
      capKB(kb);
      if(kind==='FOUND'&&items[0]&&typeof items[0].sourceUrl==='string') {
        var url=items[0].sourceUrl;
        if((/^https:\/\/archive\.org\/details\/[A-Za-z0-9_.%-]+\/?$/.test(url) ||
            /^https:\/\/rutube\.ru\/video\/[A-Za-z0-9_-]+\/?$/.test(url)) &&
           url.indexOf('?')<0&&url.indexOf('#')<0) {
          kb.routes.remember(movieKey(movie),{
            sourceId:provider.id,page:url,method:'search',
            checkedAt:Date.now(),persistence:'persistent'
          });
        }
      }
    } catch(e) { console.warn('[PluginLampa KB] observation:',e); }
  }
  function knowledgeStatus() {
    var kb=knowledgeBase();
    if(!kb)return {enabled:false,events:0,sources:[]};
    var compatible={
      recent:function(id,limit) {
        return kb.observations.recent({sourceId:id,limit:limit}).map(function(o) {
          return {at:o.time,class:o.class,method:o.method};
        });
      }
    };
    return {enabled:true,events:kb.observations.size(),bytes:kbBytes(kb),
      sources:providers.map(function(p) {
        return {id:p.id,profile:kb.api.profile.profile(compatible,p.id,Date.now())};
      })
    };
  }

  // Registry selects one implementation per logical source. Separate source IDs
  // remain independent; no fallback to title-search or an unrelated catalog.
  function registrySelection(candidates, forced, movie) {
    var kb = knowledgeBase();
    if (!kb || !kb.api || typeof kb.api.registry !== 'function') return candidates;
    var registry = kb.api.registry();
    var ids = [];
    candidates.forEach(function (provider) {
      var sourceId = provider.sourceId || provider.id;
      registry.register({id:provider.id,sourceId:sourceId,provider:provider});
      if (ids.indexOf(sourceId) === -1) ids.push(sourceId);
    });
    var chosen = [];
    ids.forEach(function (sourceId) {
      var impl = registry.choose(sourceId,function (candidate) {
        // A fallback must support this card before it can replace the primary.
        try {
          if (candidate.provider.supports && !candidate.provider.supports(movie)) return -Infinity;
        } catch (err) { return -Infinity; }
        var h = providerHealth(candidate.provider);
        if (forced) return 1;
        return h.cooldownUntil > Date.now() ? -Infinity : 1;
      });
      if (impl && impl.provider) {
        var hasSupported = candidates.some(function (p) {
          if ((p.sourceId || p.id) !== sourceId) return false;
          try { return !p.supports || p.supports(movie); } catch (err) { return false; }
        });
        if (hasSupported) {
          var supported = !impl.provider.supports;
          try { if (!supported) supported = !!impl.provider.supports(movie); } catch (err) { supported = false; }
          if (supported) chosen.push(impl.provider);
        } else chosen.push(impl.provider); // Preserve unsupported-source diagnostics.
      }
    });
    return chosen;
  }

  function queryProvider(provider, movie, isCurrent) {
    return withTimeout(function () {
      if (!isCurrent()) return [];
      return provider.search(movie);
    }, providerTimeout(provider), 'search ' + provider.id).then(function (items) {
      // A previous card's completed requests must not update persisted cache,
      // KB observations, provider health or cooldowns for the current session.
      if (!isCurrent()) return { provider: provider, items: [], stale: true };
      if (!Array.isArray(items)) throw new Error('Expected an array of candidates');
      recordProviderSuccess(provider, items.length);
      knowledgeRecord(provider,movie,null,items);
      return { provider: provider, items: rememberCandidates(movie, provider, items), cached: false };
    }).catch(function (err) {
      if (!isCurrent()) return { provider: provider, items: [], stale: true };
      recordProviderFailure(provider, err);
      knowledgeRecord(provider,movie,err,null);
      console.error('[VideoFinder] Search failed:', provider.id, err);
      // Preserve the last good results; never cache errors as valid empty searches.
      return { provider: provider, items: cachedCandidates(movie, provider) || [],
        cached: true, error: String(err && err.message || err) };
    });
  }

  function openResults(movie, refresh, titleSearch) {
    // Any direct search supersedes an unresolved IMDb lookup.
    ++movieLookupRevision;
    if (movieLookupTimer !== null) clearTimeout(movieLookupTimer);
    movieLookupTimer = null;
    // Entering another results view invalidates a pending stream resolution.
    ++streamNavigationGeneration;
    var navigation = ++resultsNavigationGeneration;
    if (!movie.title) {
      notify('В карточке нет названия фильма', true);
      if (activeNativePage && activeNativePage.isAlive()) displayMenu({
        title: 'PluginLampa · Ошибка',
        items: [{title:'Нет названия фильма', subtitle:'Нажми Назад для возврата'}],
        onSelect: function () {}, onBack: exitResults
      });
      return;
    }
    var scope = titleSearch || 'all';
    var selectedProviders = registrySelection(providers.filter(function (p) {
      return scope === 'all' || (scope === 'titles' ? !!p.titleSearch : !p.titleSearch);
    }), refresh, movie);
    var diagnostics = [];
    var cachedGroups = refresh ? [] : selectedProviders.map(function (provider) {
      // Respect supports() even for saved results: a disabled source must not reappear.
      try {
        if (provider.supports && !provider.supports(movie)) return null;
      } catch (err) { return null; }
      var saved = cachedCandidates(movie, provider);
      return saved ? { provider: provider, items: saved, cached: true } : null;
    }).filter(Boolean);

    var cacheHit = cachedGroups.length > 0;
    var sourceProviders = selectedProviders.filter(function (provider) { return !provider.discovery; });
    var discoveryProviders = selectedProviders.filter(function (provider) { return provider.discovery; });
    var networkCount = 0;

    if (refresh) notify('Обновляю результаты: ' + movie.title);

    function searchGroup(group) {
      if (navigation !== resultsNavigationGeneration) return Promise.resolve([]);
      var active = group.filter(function (provider) {
        try {
          if (provider.supports && !provider.supports(movie)) {
            diagnostics.push({provider: provider, status: provider.unavailableReason ?
              provider.unavailableReason(movie) : 'неподдерживаемый тип или ID'});
            return false;
          }
        } catch (err) {
          console.warn('[VideoFinder] supports() failed:', provider.id, err);
          diagnostics.push({provider: provider, status: 'ошибка проверки ID'});
          return false;
        }
        // Manual refresh overrides both the negative cache and the cooldown.
        if (!refresh && cachedCandidates(movie, provider)) {
          diagnostics.push({provider: provider, status: 'результаты из памяти'});
          return false;
        }
        if (!refresh && recentMiss(movie, provider)) {
          diagnostics.push({provider: provider, status: 'недавний пустой ответ, нажми ↻'});
          return false;
        }
        if (!providerAvailable(provider, refresh)) {
          diagnostics.push({provider: provider, status: 'пауза после ошибок, нажми ↻'});
          return false;
        }
        return true;
      });
      networkCount += active.length;
      return Promise.all(active.map(function (provider) {
        return queryProvider(provider, movie, function () {
          return navigation === resultsNavigationGeneration;
        }).then(function (result) {
          if (result.stale || navigation !== resultsNavigationGeneration) return result;
          diagnostics.push({provider: provider, status: result.error ?
            'Ошибка: ' + result.error : result.items.length ?
            'найдено: ' + result.items.length : (provider.emptyReason ?
              provider.emptyReason() : 'ответ без подходящих прямых видео')});
          return result;
        });
      }));
    }

    // For an already found movie never ask search engines again. For a new
    // movie, ask specialized source adapters first, discovery engines last.
    var tasks = searchGroup(sourceProviders).then(function (primary) {
      var all = cachedGroups.concat(primary);
      if (navigation !== resultsNavigationGeneration) return all;
      if (!refresh && all.some(function (group) { return group.items.length; })) return all;
      return searchGroup(discoveryProviders).then(function (found) {
        return all.concat(found);
      });
    });

    tasks.then(function (groups) {
      // A newer card, refresh or mode selection owns the menu.
      if (navigation !== resultsNavigationGeneration) return;
      var results = [];
      groups.forEach(function (group) {
        group.items.forEach(function (item) {
          results.push({
            title: item.title || 'Видео',
            subtitle: (item.subtitle ? item.subtitle + ' · ' : '') + group.provider.name +
              (group.provider.titleSearch ? ' · совпадение по названию (проверь)' : '') +
              (group.cached ? ' · сохранено' : ''),
            _item: item,
            _provider: group.provider,
            _rank: Number(item.confidence) || 0
          });
        });
      });
      results.sort(function (a, b) { return b._rank - a._rank; });

      if (!results.length) {
        notify('0 результатов: открой «Диагностика источников» и проверь причины.', true);
      }
      var menuActions = actions.filter(function (action) {
        try { return !action.supports || action.supports(movie); }
        catch (err) { console.warn('[VideoFinder] action supports failed:', action.id, err); return false; }
      }).map(function (action) {
        return { title: action.title, subtitle: action.subtitle || '', _actionHandler: action };
      });
      var utilityEntries = [
        { title: 'Диагностика источников (' + selectedProviders.length + ')', _action: 'diagnostics',
          subtitle: networkCount + ' запросов · причины нулевых результатов' },
        { title: 'Режим: ' + (scope === 'all' ? 'Все источники' : scope === 'titles' ?
          'Только по названию' : 'Только точные Stremio'),
          subtitle: 'Сменить режим поиска', _action: 'titles' },
        { title: '↻ Обновить поиск', subtitle: 'Проверить все источники заново', _action: 'refresh' },
        { title: 'Подключённые источники (' + providers.length + ')',
          subtitle: 'Доступность и статистика', _action: 'providers' },
        { title: 'Найденные сайты (' + sourceList().length + ')',
          subtitle: 'Локально сохранённые сайты', _action: 'sources' }
      ];
      var resultPage = 0;
      var resultsPageRevision = 0;
      function showResultsMenu() {
        if (navigation !== resultsNavigationGeneration) return;
        var lastPage = Math.max(0, Math.ceil(results.length / RESULTS_PAGE_SIZE) - 1);
        resultPage = Math.max(0, Math.min(resultPage, lastPage));
        var pageToken = ++resultsPageRevision;
        var beginning = resultPage * RESULTS_PAGE_SIZE;
        var pageResults = results.slice(beginning, beginning + RESULTS_PAGE_SIZE);
        var pages = lastPage + 1;
        var paging = [];
        if (resultPage > 0) paging.push({
          title: '← Предыдущие результаты', _action: 'previous-page',
          subtitle: 'Страница ' + resultPage + ' из ' + pages
        });
        if (resultPage < lastPage) paging.push({
          title: 'Следующие результаты →', _action: 'next-page',
          subtitle: 'Страница ' + (resultPage + 2) + ' из ' + pages
        });
        // Never give the Tizen UI hundreds of rows at once. All candidates
        // remain accessible via pages without a new provider network call.
        var nativeResults = !!(activeNativePage && activeNativePage.isAlive());
        var entries = nativeResults
          ? results.concat(menuActions, utilityEntries)
          : pageResults.concat(paging, menuActions, utilityEntries);
        displayMenu({
        _nativeGroupedResults: nativeResults,
        title: 'Видео · ' + movie.title +
          (networkCount === 0 ? ' · из памяти' : '') +
          (pages > 1 ? ' · ' + (resultPage + 1) + '/' + pages : ''),
        items: entries,
        onSelect: function (selected) {
          if (navigation !== resultsNavigationGeneration ||
              pageToken !== resultsPageRevision || !selected) return;
          if (selected._action === 'next-page') {
            resultPage++;
            showResultsMenu();
            return;
          }
          if (selected._action === 'previous-page') {
            resultPage--;
            showResultsMenu();
            return;
          }
          if (selected._actionHandler) { selected._actionHandler.open(movie); return; }
          if (selected._action === 'refresh') { closeMenu(); openResults(movie, true, titleSearch); return; }
          if (selected._action === 'titles') {
            closeMenu();
            openResults(movie, false, scope === 'all' ? 'exact' : scope === 'exact' ? 'titles' : 'all');
            return;
          }
          if (selected._action === 'diagnostics') {
            displayMenu({
              title: 'Источники · ' + movie.title,
              items: diagnostics.length ? diagnostics.map(function (d) {
                return {title: d.provider.name, subtitle: d.status};
              }) : [{title: 'Подключённых источников нет'}],
              onSelect: function () {},
              onBack: showResultsMenu
            });
            return;
          }
          if (selected._action === 'sources') { showSources(showResultsMenu); return; }
          if (selected._action === 'providers') { showProviders(showResultsMenu); return; }
          closeMenu();
          openStreams(selected._item, selected._provider, movie, showResultsMenu);
        },
        onBack: function () {
          if (navigation !== resultsNavigationGeneration ||
              pageToken !== resultsPageRevision) return;
          if (resultPage > 0) {
            resultPage--;
            showResultsMenu();
          } else exitResults();
        }
      });
      }
      showResultsMenu();
      if (networkCount === 0 && cacheHit) notify('Показываю сохранённые результаты');
    }).catch(function (err) {
      if (navigation !== resultsNavigationGeneration) return;
      console.error('[VideoFinder] Unexpected search error', err);
      notify('Ошибка поиска видео', true);
      if (activeNativePage && activeNativePage.isAlive()) displayMenu({
        title: 'PluginLampa · Ошибка поиска',
        items: [{title:'Не удалось получить результаты', subtitle:'Вернись к карточке и попробуй снова'}],
        onSelect: function () {}, onBack: exitResults
      });
    });
  }

  // Additional adapters can be attached from another script after this one.
  window.LampaVideoFinder = {
    requestJson: httpJson,
    displayMenu: displayMenu,
    closeMenu: closeMenu,
    attachNativePage: attachNativePage,
    detachNativePage: detachNativePage,
    searchCard: function (card) { openCard(card); },
    nativePageActive: function () { return !!activeNativePage; },
    open: function (card) {
      if (!activeNativePage && openNativePage(card)) return;
      openResults(movieInfo(card));
    },
    // Extensions can reject late responses after another card takes focus.
    navigationGeneration: function () { return resultsNavigationGeneration; },
    registerProvider: registerProvider,
    unregisterProvider: unregisterProvider,
    registerAction: registerAction,
    listProviders: function () { return providers.map(function (p) { return p.id; }); },
    listKnownSources: sourceList,
    listProviderHealth: providerStatuses,
    knowledgeStatus: knowledgeStatus,
    knownRoutes:function(card){var kb=knowledgeBase();return kb?kb.routes.routesFor(movieKey(movieInfo(card))):[];},
    clearMovieCache: function (card) { forgetMovie(movieInfo(card)); },
    clearCache: function () { cache = { version: 2, movies: {}, sites: {}, health: {} }; saveCache(); },
    cacheStats: function () { return { movies: Object.keys(cache.movies).length, sites: sourceList().length }; }
  };

  registerProvider({
    id: 'archive',
    titleSearch: true,
    name: 'Internet Archive',
    siteUrl: 'https://archive.org',
    persistStreams: true,
    // Archive's catalog is a movie catalog, not a season/episode resolver.
    supports: function (movie) { return movie.media_type !== 'tv'; },
    search: searchArchive,
    resolve: resolveArchive
  });

  function init() {
    Lampa.Manifest.plugins = {
      type: 'video',
      name: 'Video Finder',
      version: '0.6.3',
      description: 'Поиск видео с локальным сохранением найденных источников',
      onContextMenu: function () {
        return { name: 'Найти видео (Video Finder)', description: 'Сначала сохранённое, затем поиск' };
      },
      onContextLauch: openCard
    };
    // The extra card button is optional. Some Lampa/plugin combinations do
    // not support this event; the context-menu manifest must still work.
    try {
      L.Listener.follow('full', function (event) {
        if (!event || event.type !== 'complite' || !event.body || !window.$) return;
        var container = event.body.find('.buttons--container');
        if (!container.length || container.find('.pluginlampa-watch').length) return;
        var button = $('<div class="full-start__button selector pluginlampa-watch"><span>PluginLampa</span></div>');
        button.on('hover:enter', function () {
          if (event.data && event.data.movie) openCard(event.data.movie);
        });
        container.append(button);
      });
    } catch (err) {
      console.warn('[PluginLampa] Optional full-card hook unavailable', err);
    }
    console.log('[VideoFinder] Installed v0.6.3. Providers:', window.LampaVideoFinder.listProviders());
  }

  function openCard(card) {
    card = card || {};
    if (!activeNativePage && openNativePage(card)) return;
    ++movieLookupRevision;
    if (movieLookupTimer !== null) clearTimeout(movieLookupTimer);
    movieLookupTimer = null;
    var revision = movieLookupRevision;
    var pageOwner = activeNativePage;
    function current() {
      return revision === movieLookupRevision && pageOwner === activeNativePage;
    }
    var movie = movieInfo(card);
    // An invalid card has nothing to enrich; show its native error immediately.
    if (!movie.title) {
      if (current()) openResults(movie);
      return;
    }
    if (movie.imdb_id || !L.Api || !L.Api.sources || !L.Api.sources.tmdb || !movie.tmdb_id ||
        typeof L.Api.sources.tmdb.external_imdb_id !== 'function') {
      if (current()) openResults(movie);
      return;
    }
    var completed = false;
    movieLookupTimer = setTimeout(function () {
      if (completed || !current()) return;
      completed = true;
      movieLookupTimer = null;
      openResults(movie);
    }, 6000);
    try {
      L.Api.sources.tmdb.external_imdb_id({
        type: movie.media_type, id: movie.tmdb_id
      }, function (id) {
        if (completed || !current()) return;
        completed = true;
        if (movieLookupTimer !== null) clearTimeout(movieLookupTimer);
        movieLookupTimer = null;
        card.imdb_id = id || '';
        openResults(movieInfo(card));
      });
    } catch (err) {
      if (!completed && current()) {
        completed = true;
        if (movieLookupTimer !== null) clearTimeout(movieLookupTimer);
        movieLookupTimer = null;
        openResults(movie);
      }
    }
  }

  var initialized = false;
  function safeInit() {
    if (initialized) return;
    initialized = true;
    try { init(); }
    catch (error) {
      initialized = false;
      console.error('[PluginLampa] Initialization failed', error);
      window.__lampa_video_finder_v1 = false;
    }
  }
  if (window.appready) safeInit();
  else {
    try {
      L.Listener.follow('app', function (event) {
        if (event && event.type === 'ready') safeInit();
      });
      // Ready might have fired between the first check and subscription.
      if (window.appready) safeInit();
    } catch (err) {
      // Do not crash the enclosing Media Station X web application because
      // another extension replaced or broke the Lampa event dispatcher.
      console.warn('[PluginLampa] Cannot subscribe to app readiness', err);
      window.__lampa_video_finder_v1 = false;
    }
  }
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
    text = String(text || '');
    if (!/^https?:\/\/[^\s\/?#]+(?:[^\s]*)?$/i.test(text)) return '';
    if (typeof URL !== 'function') return text;
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
    var names = [localized, original].filter(Boolean);
    if (!names.some(function (name) { return (' ' + title + ' ').indexOf(' ' + name + ' ') !== -1; })) return false;
    if (movie.year && title.indexOf(String(movie.year)) === -1) return false;
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
      if (!data || !Array.isArray(data.results)) {
        throw new Error('Rutube: неверный формат ответа поиска');
      }
      var list = data.results.slice(0, 200);
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
    titleSearch: true,
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
  var CATALOG_URL = 'https://raw.githubusercontent.com/Stremio/stremio-official-addons/master/index.json';
  var STORAGE_KEY = 'video_finder_stremio_addons_v1';
  // The stored addon list is untrusted and parsed synchronously on TV startup.
  var MAX_SAVED_CHARS = 512 * 1024;
  var MAX_MANIFEST_RESOURCES = 128;
  var MAX_PREFIXES = 128;
  var addons = [];

  function notify(text, error) {
    L.Noty.show(text, error ? { style: 'error', time: 5500 } : { time: 3500 });
  }
  // Older Tizen WebViews may have no global URL constructor.
  function validHttp(raw, httpsOnly) {
    try {
      var value = String(raw || '').trim();
      if (value.indexOf('stremio://') === 0) value = 'https://' + value.slice(10);
      if (typeof URL === 'function') {
        var nativeUrl = new URL(value);
        if ((httpsOnly && nativeUrl.protocol !== 'https:') ||
            (!httpsOnly && !/^https?:$/.test(nativeUrl.protocol)) ||
            nativeUrl.username || nativeUrl.password) return '';
        return nativeUrl.href;
      }
      // Only HTTP(S), with an ordinary host, optional port and safe path/query/fragment.
      // Reject userinfo, whitespace, backslashes and non-HTTP schemes.
      var found = value.match(/^(https?):\/\/([a-z0-9.-]+|\[[a-f0-9:]+\])(?::([0-9]{1,5}))?(\/[^?#\\\s]*)?(\?[^#\\\s]*)?(#[^\\\s]*)?$/i);
      if (!found || (httpsOnly && found[1].toLowerCase() !== 'https')) return '';
      if (found[3] && Number(found[3]) > 65535) return '';
      return found[1].toLowerCase() + '://' + found[2] +
        (found[3] ? ':' + found[3] : '') + (found[4] || '/') +
        (found[5] || '') + (found[6] || '');
    } catch (_) { return ''; }
  }
  function manifestUrl(value) {
    var url = validHttp(value, true);
    if (!url) throw Error('Требуется HTTPS-адрес расширения');
    if (typeof URL !== 'function') {
      if (/[?#]/.test(url)) throw Error('Адрес должен оканчиваться на /manifest.json без параметров');
      return /\/manifest\.json$/i.test(url) ? url :
        url.replace(/\/+$/, '') + '/manifest.json';
    }
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
      // Avoid parsing an unbounded JSON blob before the first Lampa screen.
      // Do not rewrite or delete the original value on failure.
      if (typeof raw === 'string' && raw.length > MAX_SAVED_CHARS) {
        console.warn('[VideoFinder] Stored Stremio addon list exceeds startup limit');
        return [];
      }
      var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(data) ? data.slice(0, 30) : [];
    } catch (_) { return []; }
  }
  function save(next) {
    if (!L.Storage || typeof L.Storage.set !== 'function') {
      throw Error('Stremio: хранилище недоступно');
    }
    L.Storage.set(STORAGE_KEY, JSON.stringify(next.map(function (a) {
      return { url: a.url, manifest: a.manifest };
    })));
  }
  function short(value) {
    return String(value || '').replace(/<[^>]+>/g, '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 160);
  }
  function normalizeManifest(manifest) {
    if (!manifest || !manifest.id || !manifest.name || !Array.isArray(manifest.types) ||
        !Array.isArray(manifest.resources)) throw Error('Неправильный manifest.json');
    if (manifest.behaviorHints && manifest.behaviorHints.configurationRequired) throw Error('Расширение требует настройки на своём сайте');
    var resources = manifest.resources.slice(0, MAX_MANIFEST_RESOURCES).filter(function (resource) {
      return resource === 'stream' || (resource && resource.name === 'stream');
    });
    if (!resources.length) throw Error('Расширение не предоставляет потоки stream');
    return {
      id: short(manifest.id), name: short(manifest.name),
      types: manifest.types.filter(function (v) { return v === 'movie' || v === 'series'; }),
      idPrefixes: Array.isArray(manifest.idPrefixes) ? manifest.idPrefixes.slice(0, MAX_PREFIXES).filter(function (p) {
        return typeof p === 'string' && p.length < 40;
      }) : null,
      resources: resources.map(function (r) {
        return typeof r === 'string' ? 'stream' : {
          name: 'stream',
          types: Array.isArray(r.types) ? r.types.filter(function (t) { return t === 'movie' || t === 'series'; }) : null,
          idPrefixes: Array.isArray(r.idPrefixes) ? r.idPrefixes.slice(0, MAX_PREFIXES).filter(function (p) {
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
  function playableStreams(data, addon) {
    // Stremio's protocol requires an array. A malformed API response is not
    // an EMPTY catalog response and must not create a negative cache entry.
    if (!data || !Array.isArray(data.streams)) {
      throw Error('Stremio: неверный формат списка потоков');
    }
    var received = data.streams;
    // Keep processing bounded on memory-constrained TV WebViews.
    var limit = Math.min(received.length, 500);
    var direct = [];
    var torrents = 0, external = 0, proxyHeaders = 0;
    for (var i = 0; i < limit; i++) {
      var stream = received[i];
      if (!stream || typeof stream !== 'object') continue;
      if (stream.infoHash) torrents++;
      if (stream.externalUrl || stream.ytId) external++;
      if (stream.behaviorHints && stream.behaviorHints.proxyHeaders) proxyHeaders++;
      if (playable(stream)) direct.push(stream);
    }
    if (addon) {
      addon.lastResponse = {
        received: received.length, direct: direct.length,
        torrents: torrents, external: external, proxyHeaders: proxyHeaders
      };
    }
    return direct;
  }
  function makeProvider(addon) {
    return {
      id: addon.providerId, name: 'Stremio · ' + addon.manifest.name,
      siteUrl: addon.url, persistStreams: false, timeoutMs: 12000,
      supports: function (movie) { return !!idFor(addon, movie); },
      emptyReason: function () {
        var stats = addon.lastResponse;
        if (!stats) return 'в ответе нет воспроизводимых прямых потоков';
        if (!stats.received) return 'сервер расширения ответил: 0 потоков';
        if (!stats.direct) return stats.received + ' потоков: ' + stats.torrents +
          ' торрент, ' + stats.external + ' внешних ссылок, ' + stats.proxyHeaders +
          ' с заголовками; прямых HTTP(S): 0';
        return 'прямые потоки обнаружены';
      },
      unavailableReason: function (movie) {
        if (movie.media_type === 'tv' && !episode(movie)) return 'нужно открыть конкретную серию';
        if (!movie.imdb_id && !movie.tmdb_id) return 'в карточке нет IMDb/TMDB ID';
        return 'расширение не поддерживает этот формат ID или тип видео';
      },
      search: function (movie) {
        var key = idFor(addon, movie);
        if (!key) return Promise.resolve([]);
        return request(endpoint(addon, key)).then(function (data) {
          return playableStreams(data, addon).slice(0, 25).map(function (stream, index) {
            var title = short(stream.name || stream.description || stream.title || 'Видео');
            return {
              id: key.type + ':' + key.id + ':' + index,
              signature: JSON.stringify([stream.name || '', stream.title || '', stream.description || '']), index: index, videoId: key.id, mediaType: key.type,
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
          var streams = playableStreams(data, addon);
          var matches = streams.filter(function (stream) {
            return JSON.stringify([stream.name || '', stream.title || '', stream.description || '']) === item.signature;
          });
          if (!matches.length) return [];
          // Multiple links may have exactly the same name/description. Do not
          // silently select item.index: addons can reorder streams between
          // search and resolve, and these links may have different content.
          // Let the user choose an explicit current URL in the existing menu.
          return matches.slice(0, 25).map(function (selected, index) {
            return {
              title: short(selected.name || item.title || 'Видео') +
                (matches.length > 1 ? ' · Вариант ' + (index + 1) : ''),
              subtitle: short(selected.description || selected.title || 'Stremio'),
              url: playable(selected)
            };
          });
        });
      }
    };
  }
  function addKnown(url, manifest, persist) {
    var normalized = manifestUrl(url);
    var info = normalizeManifest(manifest);
    var id = 'stremio:' + hash(normalized);
    var old = addons.find(function (a) { return a.url === normalized; });
    var addon = { url: normalized, manifest: info, providerId: id };
    var previous = addons.slice();
    var next = addons.filter(function (a) { return a.url !== normalized; }).concat([addon]);
    // Commit settings first. If quota/storage fails, do not alter any live
    // provider or claim that the addon was successfully installed.
    if (persist !== false) save(next);
    try {
      if (old) engine.unregisterProvider(old.providerId);
      engine.registerProvider(makeProvider(addon));
      addons = next;
    } catch (err) {
      engine.unregisterProvider(id);
      if (old) {
        try { engine.registerProvider(makeProvider(old)); }
        catch (restoreErr) { console.error('[VideoFinder] Stremio restore failed', restoreErr); }
      }
      if (persist !== false) {
        try { save(previous); }
        catch (storageErr) { console.warn('[VideoFinder] Stremio storage rollback failed', storageErr); }
      }
      throw err;
    }
    return { id: id, name: info.name, url: normalized };
  }
  function install(url) {
    var cleanUrl = manifestUrl(url);
    return request(cleanUrl).then(function (manifest) { return addKnown(cleanUrl, manifest); });
  }
  function remove(id) {
    var item = addons.find(function (a) { return a.providerId === id; });
    if (!item) return false;
    var next = addons.filter(function (a) { return a.providerId !== id; });
    try { save(next); }
    catch (err) {
      console.warn('[VideoFinder] Cannot persist Stremio removal', err);
      notify('Не удалось сохранить изменение Stremio: хранилище недоступно', true);
      return false;
    }
    engine.unregisterProvider(item.providerId);
    addons = next;
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
    engine.closeMenu();
    L.Input.edit({ title: 'HTTPS-ссылка Stremio addon /manifest.json', value: '', free: true, nosave: true },
      function (value) {
        if (!value) { manage(); return; }
        install(value).then(function (item) {
          notify('Добавлено: ' + item.name);
          manage();
        }).catch(function (err) {
          notify('Ошибка расширения: ' + err.message, true);
          manage();
        });
      });
  }
  function catalog() {
    notify('Загружаю список Stremio...');
    request(CATALOG_URL).then(function (data) {
      if (!Array.isArray(data)) throw Error('Неправильный список');
      var choices = data.filter(function (entry) {
        var m = entry.manifest;
        return m && /^https:\/\//.test(entry.transportUrl || '') &&
          (m.resources || []).some(function (r) { return r === 'stream' || (r && r.name === 'stream'); });
      }).map(function (entry) {
        return { title: short(entry.manifest.name), subtitle: short(entry.manifest.description), url: entry.transportUrl };
      });
      if (!choices.length) { notify('В списке нет источников видео'); return; }
      engine.displayMenu({title: 'Официальный список Stremio', items: choices,
        onSelect: function (choice) {
          install(choice.url).then(function (item) {
            notify('Добавлено: ' + item.name); manage();
          }).catch(function (err) { notify('Не удалось добавить: ' + err.message, true); });
        }, onBack: manage});
    }).catch(function () { notify('Не удалось загрузить список. Можно добавить ссылку вручную.', true); manage(); });
  }
  function manage() {
    var items = [{ title: 'Выбрать из списка Stremio', subtitle: 'Загрузить официальный список расширений', action: 'catalog' }, { title: '＋ Добавить расширение Stremio', subtitle: 'Адрес HTTPS /manifest.json', action: 'add' }];
    list().forEach(function (addon) {
      items.push({ title: addon.name, subtitle: addon.url + ' · нажмите для удаления', action: 'remove', addon: addon });
    });
    engine.displayMenu({ title: 'Stremio · расширения (' + addons.length + ')', items: items,
      onSelect: function (choice) {
        if (choice.action === 'catalog') return catalog();
        if (choice.action === 'add') return addViaInput();
        engine.displayMenu({ title: 'Удалить ' + choice.addon.name + '?',
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
  var episodeMenuGeneration = 0;
  function selectSeriesEpisode(movie) {
    var menuGeneration = ++episodeMenuGeneration;
    var cardGeneration = typeof engine.navigationGeneration === 'function' ?
      engine.navigationGeneration() : null;
    function current() {
      return menuGeneration === episodeMenuGeneration &&
        (cardGeneration === null || cardGeneration === engine.navigationGeneration());
    }
    var imdb = String(movie.imdb_id || '');
    if (!/^tt\d{5,12}$/.test(imdb)) {
      notify('Нет IMDb ID сериала: выбрать серии через Stremio невозможно', true);
      return;
    }
    notify('Получаю сезоны и серии из Cinemeta...');
    // The official Stremio metadata addon supplies actual episode numbers.
    // Do not guess a season/episode or treat an empty list as a stream failure.
    request('https://v3-cinemeta.strem.io/meta/series/' + imdb + '.json').then(function (body) {
      if (!current()) return;
      var raw = body && body.meta && body.meta.videos;
      if (!Array.isArray(raw)) throw Error('Cinemeta не вернула список серий');
      var seasons = Object.create(null), count = 0;
      raw.slice(0, 2500).forEach(function (entry) {
        if (!entry) return;
        var season = Number(entry.season), episode = Number(entry.episode);
        if (!Number.isInteger(season) || !Number.isInteger(episode) ||
            season < 1 || season > 100 || episode < 1 || episode > 1000) return;
        var key = String(season);
        if (!seasons[key]) seasons[key] = [];
        if (seasons[key].some(function (v) { return v.episode === episode; })) return;
        seasons[key].push({season: season, episode: episode, title: short(entry.title || entry.name || '')});
        count++;
      });
      if (!count) throw Error('В Cinemeta нет подходящих эпизодов');
      var groups = Object.keys(seasons).sort(function (a, b) { return Number(a) - Number(b); });
      function showSeasons() {
        if (!current()) return;
        engine.displayMenu({
          title: 'Stremio · сезоны · ' + movie.title,
          items: groups.map(function (season) {
            return {title: 'Сезон ' + season, subtitle: seasons[season].length + ' серий', _season: season};
          }),
          onSelect: function (selected) {
            if (!current() || !selected) return;
            var episodes = seasons[selected._season];
            if (!episodes) return;
            episodes.sort(function (a,b){ return a.episode - b.episode; });
            engine.displayMenu({
              title: 'Сезон ' + selected._season + ' · серии',
              items: episodes.map(function (ep) {
                return {title: 'Серия ' + ep.episode + (ep.title ? ' · ' + ep.title : ''), _episode: ep};
              }),
              onSelect: function (selectedEp) {
                if (!current() || !selectedEp) return;
                var ep = selectedEp._episode;
                if (!ep) return;
                var card = {}, source = movie.card || {};
                Object.keys(source).forEach(function (key) {card[key] = source[key];});
                card.media_type = 'tv';
                card.imdb_id = imdb;
                card.season_number = ep.season;
                card.episode_number = ep.episode;
                engine.open(card);
              },
              onBack: showSeasons
            });
          },
          onBack: function () {
            if (current()) engine.open(movie.card || {});
          }
        });
      }
      showSeasons();
    }).catch(function (err) {
      if (!current()) return;
      console.warn('[VideoFinder] Cinemeta episodes failed:', err);
      notify('Не удалось получить эпизоды Stremio: ' + (err.message || err), true);
    });
  }

  readSaved().forEach(function (addon) {
    try { addKnown(addon.url, addon.manifest, false); }
    catch (err) { console.warn('[VideoFinder] Ignore invalid saved Stremio addon'); }
  });
  window.LampaVideoFinderStremio = { install: install, remove: remove, list: list, manage: manage };
  engine.registerAction({ id: 'stremio-manage', title: '⚙ Stremio · расширения',
    subtitle: 'Добавить или удалить источник видео', open: manage });
  engine.registerAction({id: 'stremio-series',
    title: '📺 Stremio · выбрать серию',
    subtitle: 'Сезоны и реальные эпизоды из Cinemeta',
    supports: function (movie) {
      return movie.media_type === 'tv' && /^tt\d{5,12}$/.test(String(movie.imdb_id || '')) &&
        !episode(movie) && addons.some(function (a) {
          return a.manifest.types.indexOf('series') !== -1;
        });
    },
    open: selectSeriesEpisode
  });
})();

/*
 * PluginLampa / AniLiberty experimental HTTP provider.
 * Independently written against the documented AniLiberty API v1.
 * Opt-in, disabled by default: live endpoint/CORS and Samsung Tizen playback not yet verified.
 * No tokens, cookies, DRM bypass, headless browser, or external JS.
 */
(function () {
  'use strict';
  var engine = window.LampaVideoFinder;
  var L = window.Lampa;
  if (!engine || !L || !engine.registerProvider || !engine.registerAction) return;
  if (engine.listProviders().indexOf('aniliberty') !== -1) return;

  var BASE = 'https://anilibria.top/api/v1';
  var KEY = 'video_finder_aniliberty_enabled_v1';
  var MAX_RELEASES = 12;
  var MAX_EPISODES = 60;
  var MAX_STREAMS = 150;

  function enabled() {
    var value = L.Storage.get(KEY, false);
    return value === true || value === 'true' || value === 1;
  }
  function notify(msg, error) {
    L.Noty.show(msg, error ? {style: 'error', time: 6000} : {time: 4500});
  }
  function clean(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ').trim().replace(/\s+/g, ' ');
  }
  function sameTitle(a, b) {
    a = clean(a); b = clean(b);
    if (!a || !b) return false;
    return a === b || (a.length > 9 && b.indexOf(a + ' ') === 0) ||
      (b.length > 9 && a.indexOf(b + ' ') === 0);
  }
  function matching(movie, release) {
    if (!release || !release.name || !release.id) return false;
    var names = [release.name.main, release.name.english].filter(Boolean);
    var wanted = [movie.title, movie.original_title].filter(Boolean);
    if (!names.some(function (s) {
      return wanted.some(function (t) { return sameTitle(s, t); });
    })) return false;
    if (movie.year && release.year && Math.abs(Number(movie.year) - Number(release.year)) > 1) return false;
    return true;
  }
  function urlStream(value) {
    var text = String(value || '');
    // Restrict to absolute HTTPS URLs without embedded login/password or backslashes.
    return /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/[^\s\\<>]*$/i.test(text) &&
      text.indexOf('@') < 0 ? text : '';
  }
  function api(path) { return engine.requestJson(BASE + path); }
  function search(movie) {
    if (!enabled()) return Promise.resolve([]);
    var names = [movie.title, movie.original_title].filter(Boolean);
    if (names.length > 1 && clean(names[0]) === clean(names[1])) names.pop();
    if (!names.length) return Promise.resolve([]);
    return Promise.all(names.map(function (name) {
      return api('/app/search/releases?query=' + encodeURIComponent(name)).then(function (response) {
        if (!Array.isArray(response)) throw Error('AniLiberty: неверный формат ответа поиска');
        return {ok: true, rows: response.slice(0, 60)};
      }).catch(function (error) {
        console.warn('[AniLiberty] Search request failed', error);
        return {ok: false, rows: []};
      });
    })).then(function (groups) {
      if (!groups.some(function (g) { return g.ok; })) {
        throw Error('AniLiberty: API недоступен или запрос заблокирован');
      }
      var unique = Object.create(null);
      groups.forEach(function (group) {
        group.rows.forEach(function (release) {
          if (!matching(movie, release) || !/^\d{1,12}$/.test(String(release.id))) return;
          var id = String(release.id);
          if (unique[id]) return;
          unique[id] = {
            id: id,
            title: String(release.name.main || release.name.english),
            subtitle: 'AniLiberty · аниме' + (release.year ? ' · ' + release.year : ''),
            sourceUrl: 'https://anilibria.top/anime/releases/release/' + id,
            confidence: 85
          };
        });
      });
      return Object.keys(unique).slice(0, MAX_RELEASES).map(function (id) { return unique[id]; });
    });
  }
  function resolve(item) {
    if (!item || !/^\d{1,12}$/.test(String(item.id || ''))) {
      return Promise.reject(Error('AniLiberty: неверный ID релиза'));
    }
    return api('/anime/releases/' + encodeURIComponent(String(item.id))).then(function (release) {
      var episodes = release && release.episodes;
      if (!Array.isArray(episodes)) throw Error('AniLiberty: неверный формат списка серий');
      var streams = [];
      episodes.slice(0, MAX_EPISODES).forEach(function (episode) {
        if (!episode) return;
        var ordinal = String(episode.ordinal || episode.number || '');
        var caption = 'Серия ' + ordinal + (episode.name ? ' · ' + String(episode.name).slice(0, 75) : '');
        [['1080p',episode.hls_1080],['720p',episode.hls_720],['480p',episode.hls_480]]
          .forEach(function (quality) {
            var url = urlStream(quality[1]);
            if (url && streams.length < MAX_STREAMS) streams.push({
              title: caption + ' · ' + quality[0],
              subtitle: 'AniLiberty · HLS ' + quality[0],
              episodeNumber: ordinal,
              episodeTitle: caption,
              quality: quality[0],
              url: url
            });
          });
      });
      return streams;
    });
  }
  engine.registerProvider({
    id: 'aniliberty',
    name: 'AniLiberty (эксперимент)',
    siteUrl: 'https://anilibria.top',
    titleSearch: true,
    timeoutMs: 12000,
    persistStreams: false,
    supports: function (movie) { return enabled() && !!movie.title; },
    unavailableReason: function () { return 'Выключен. Включи через пункт ⚙ AniLiberty в меню результатов.'; },
    search: search,
    resolve: resolve
  });
  engine.registerAction({
    id: 'aniliberty-toggle',
    title: '⚙ AniLiberty · аниме (эксперимент)',
    subtitle: 'Включить/выключить отдельный API-источник, пока не проверенный на Tizen',
    open: function () {
      var on = !enabled();
      L.Storage.set(KEY, on);
      notify('AniLiberty ' + (on ? 'включён' : 'выключен') +
        '. Нажми ↻ Обновить поиск, чтобы применить изменение.');
    }
  });
})();

/*
 * Native Film Page — Lampa Activity + Component (single universal TV build).
 * Does not replace Lampa's globals or modify the other plugins' controllers.
 */
(function () {
  'use strict';
  var L = window.Lampa;
  var engine = window.LampaVideoFinder;
  if (!L || !engine || !L.Component || typeof L.Component.add !== 'function' ||
      !L.Activity || typeof L.Activity.push !== 'function' ||
      typeof L.Scroll !== 'function' || !L.Controller ||
      typeof window.$ !== 'function') return;

  var COMPONENT = 'pluginlampa_page';
  var MAX_ROWS = 28;
  var current = null;
  var jq = window.$;

  function Page(activityData) {
    var self = this;
    var scroll = new L.Scroll({ mask: true, over: true });
    var content = jq('<div class="pluginlampa-native-page" style="padding:1.5em 2em 4em"></div>');
    var heading = jq('<div style="font-size:1.6em;margin-bottom:1em"></div>');
    var rows = jq('<div class="pluginlampa-native-rows"></div>');
    var style = jq('<style>' +
      '.pluginlampa-native-page{padding:1.3em 2em 4em}' +
      '.pluginlampa-native-page .online{margin-bottom:.45em}' +
      '.pluginlampa-native-page .online__body{padding:.9em 1.1em}' +
      '.pluginlampa-native-page .pluginlampa-selected .online__body{' +
      'background:rgba(255,255,255,.22);outline:.17em solid #fff;' +
      'border-radius:.3em}' +
      '.pluginlampa-native-page .pluginlampa-section{' +
      'font-weight:bold;font-size:1.12em;opacity:.85;padding:.85em 0 .35em}' +
      '</style>');
    var selected = null;
    var visibleRows = [];
    var focusMemory = Object.create(null);
    var selectedIndex = 0;
    var menu = null;
    var chosenSource = null;
    var page = 0;
    var generation = 0;
    var alive = true;
    var started = false;
    var movie = activityData.movie || {};

    function isActive() {
      try {
        return alive && L.Activity.active &&
          L.Activity.active() && L.Activity.active().activity === self.activity;
      } catch (_) { return false; }
    }

    function setFocus() {
      if (!isActive() || !L.Controller.collectionSet ||
          !L.Controller.collectionFocus) return;
      L.Controller.collectionSet(scroll.render());
      L.Controller.collectionFocus(selected || false, scroll.render());
    }

    function moveFallback(delta) {
      if (!isActive() || !visibleRows.length) return;
      var index = 0;
      for (var i = 0; i < visibleRows.length; i++) {
        if (visibleRows[i].node === selected) { index = i; break; }
      }
      index = Math.max(0, Math.min(visibleRows.length - 1, index + delta));
      visibleRows[index].focus();
      setFocus();
    }

    function draw() {
      if (!alive || !menu) return;
      generation++;
      var token = generation;
      var list = Array.isArray(menu.items) ? menu.items : [];
      var maxPage = Math.max(0, Math.ceil(list.length / MAX_ROWS) - 1);
      page = Math.max(0, Math.min(page, maxPage));
      selectedIndex = Math.max(page * MAX_ROWS,
        Math.min(selectedIndex, Math.max(0, list.length - 1)));
      if (Math.floor(selectedIndex / MAX_ROWS) !== page) selectedIndex = page * MAX_ROWS;
      heading.text(menu.title || 'PluginLampa');
      rows.empty();
      visibleRows = [];
      selected = null;
      var firstRow = null;
      var restoredRow = null;
      var view = list.slice(page * MAX_ROWS, page * MAX_ROWS + MAX_ROWS);
      var lastSource = null;
      var actions = [];
      if (page > 0) actions.push({title:'← Предыдущие', _nativeBackPage:true});
      if (page < maxPage) actions.push({title:'Следующие →', _nativeNextPage:true});
      view.concat(actions).forEach(function (item, localIndex) {
        var sourceName = item && item._provider ? item._provider.name : null;
        if (sourceName && sourceName !== lastSource) {
          var section = jq('<div class="pluginlampa-section"></div>');
          section.text(sourceName);
          rows.append(section);
        }
        lastSource = sourceName;
        var row = jq('<div class="online selector pluginlampa-native-item"></div>');
        var body = jq('<div class="online__body"></div>');
        var title = jq('<div class="online__title"></div>');
        var subtitle = jq('<div class="online__quality"></div>');
        title.text(String(item && item.title != null ? item.title : 'Видео'));
        subtitle.text(String(item && item.subtitle != null ? item.subtitle : ''));
        body.append(title);
        body.append(subtitle);
        row.append(body);
        row.on('hover:enter', function () {
          if (!alive || token !== generation || !isActive()) return;
          // Some remote implementations send OK without a preceding focus event.
          if (!item._nativeNextPage && !item._nativeBackPage) {
            selectedIndex = page * MAX_ROWS + localIndex;
            focusMemory[menu.title || 'PluginLampa'] = selectedIndex;
          }
          if (item._nativeNextPage) {
            page++;
            selectedIndex = page * MAX_ROWS;
            draw();
          } else if (item._nativeBackPage) {
            page--;
            selectedIndex = page * MAX_ROWS;
            draw();
          } else if (menu && typeof menu.onSelect === 'function') {
            menu.onSelect(item);
          }
        });
        var focusRow = function () {
          if (!alive || token !== generation || !isActive()) return;
          if (selected && selected !== row[0]) jq(selected).removeClass('pluginlampa-selected');
          selected = row[0];
          row.addClass('pluginlampa-selected');
          if (menu && !item._nativeNextPage && !item._nativeBackPage) {
            selectedIndex = page * MAX_ROWS + localIndex;
            focusMemory[menu.title || 'PluginLampa'] = selectedIndex;
          }
          if (typeof scroll.update === 'function') scroll.update(row, true);
        };
        row.on('hover:focus', focusRow);
        visibleRows.push({node: row[0], focus: focusRow});
        if (!firstRow) firstRow = row[0];
        if (localIndex === selectedIndex - page * MAX_ROWS) restoredRow = row[0];
        rows.append(row);
      });
      selected = restoredRow || firstRow;
      if (selected) jq(selected).addClass('pluginlampa-selected');
      if (!list.length) {
        var empty = jq('<div style="opacity:.7;padding:1em"></div>');
        empty.text('Список пуст');
        rows.append(empty);
      }
      if (isActive()) {
        self.start();
      }
    }

    function sourceMenu(root, id) {
      var rowsForSource = root.items.filter(function (item) {
        return item && item._provider && item._provider.id === id;
      });
      var first = rowsForSource[0];
      var label = first && first._provider ? first._provider.name : id;
      return {
        title: 'PluginLampa · ' + label,
        items: rowsForSource,
        onSelect: function (item) {
          if (!alive || !isActive()) return;
          root.onSelect(item);
        },
        onBack: function () {
          chosenSource = null;
          self.showMenu(root);
        }
      };
    }

    function sourceChooser(root) {
      var providers = [];
      var counts = Object.create(null);
      var labels = Object.create(null);
      var commands = [];
      root.items.forEach(function (item) {
        if (item && item._provider && item._provider.id) {
          var id = item._provider.id;
          if (!counts[id]) {
            counts[id] = 0;
            providers.push(id);
            labels[id] = item._provider.name || id;
          }
          counts[id]++;
        } else commands.push(item);
      });
      var choices = providers.map(function (id) {
        return {
          title: labels[id], subtitle: counts[id] + ' результатов · открыть источник',
          _nativeSource: id
        };
      });
      // Show explicit empty state instead of an unexplained command-only screen.
      if (!choices.length) choices.push({
        title: 'Источники ничего не нашли',
        subtitle: 'Проверь диагностику или обнови поиск',
        _nativeEmpty: true
      });
      choices = choices.concat(commands);
      return {
        title: root.title + ' · Источники',
        items: choices,
        onSelect: function (item) {
          if (!alive || !isActive()) return;
          if (item._nativeEmpty) return;
          if (item._nativeSource) {
            chosenSource = item._nativeSource;
            renderMenu(sourceMenu(root, chosenSource));
          } else root.onSelect(item);
        },
        onBack: function () { L.Activity.backward(); }
      };
    }

    function renderMenu(next) {
      menu = next || {title:'PluginLampa',items:[]};
      selectedIndex = focusMemory[menu.title || 'PluginLampa'] || 0;
      page = Math.floor(selectedIndex / MAX_ROWS);
      draw();
    }

    this.isAlive = function () { return alive; };
    this.showMenu = function (next) {
      if (!alive) return;
      if (next && next._nativeGroupedResults) {
        if (chosenSource && !next.items.some(function (item) {
          return item && item._provider && item._provider.id === chosenSource;
        })) chosenSource = null;
        renderMenu(chosenSource ? sourceMenu(next, chosenSource) : sourceChooser(next));
      } else renderMenu(next);
    };

    this.create = function () {
      content.append(style);
      content.append(heading);
      content.append(rows);
      scroll.append(content);
      current = self;
      engine.attachNativePage(self);
      self.showMenu({title:'PluginLampa · Поиск',items:[
        {title:'Ищем источники...',subtitle:'Результаты появятся на этой странице'}
      ]});
      if (self.activity && typeof self.activity.loader === 'function') {
        self.activity.loader(true);
      }
      // The search may throw synchronously if an external plugin changes the
      // underlying Lampa APIs. The Activity must remain navigable/closeable.
      try { engine.searchCard(movie); }
      catch (err) {
        console.error('[PluginLampa] Native search startup failed', err);
        self.showMenu({title:'PluginLampa · Ошибка',items:[
          {title:'Не удалось открыть поиск',subtitle:'Нажми Назад для возврата'}
        ]});
      }
      return self.render();
    };

    this.render = function () { return scroll.render(); };

    this.start = function () {
      if (!isActive()) return;
      if (started) { setFocus(); return; }
      L.Controller.add('content', {
        toggle: function () { setFocus(); },
        left: function () {
          if (window.Navigator && typeof window.Navigator.canmove === 'function' &&
              typeof window.Navigator.move === 'function' && window.Navigator.canmove('left')) window.Navigator.move('left');
          else L.Controller.toggle('menu');
        },
        right: function () {
          if (window.Navigator && typeof window.Navigator.move === 'function') window.Navigator.move('right');
        },
        up: function () {
          if (window.Navigator && typeof window.Navigator.canmove === 'function' &&
              typeof window.Navigator.move === 'function' && window.Navigator.canmove('up')) window.Navigator.move('up');
          else moveFallback(-1);
        },
        down: function () {
          if (window.Navigator && typeof window.Navigator.move === 'function') window.Navigator.move('down');
          else moveFallback(1);
        },
        back: function () { self.back(); }
      });
      L.Controller.toggle('content');
      started = true;
      if (self.activity && typeof self.activity.loader === 'function') {
        self.activity.loader(false);
      }
    };

    this.back = function () {
      // A paused Activity must not consume Back destined for the top screen.
      if (!alive || !isActive()) return;
      if (menu && typeof menu.onBack === 'function') {
        menu.onBack();
      } else L.Activity.backward();
    };

    this.pause = function () { started = false; };
    this.stop = function () { started = false; };
    this.destroy = function () {
      if (!alive) return;
      alive = false;
      generation++;
      engine.detachNativePage(self);
      if (current === self) current = null;
      if (typeof scroll.destroy === 'function') scroll.destroy();
      content.remove();
      menu = null;
      visibleRows = [];
      selected = null;
    };
  }

  try {
    L.Component.add(COMPONENT, Page);
    window.LampaVideoFinderNativePage = {
      open: function (card) {
        if (current && current.isAlive()) return false;
        try {
          L.Activity.push({
            url: '', title: 'PluginLampa', component: COMPONENT,
            movie: card || {}, page: 1
          });
          return true;
        } catch (err) {
          console.warn('[PluginLampa] Native Activity push failed', err);
          return false;
        }
      },
      active: function () { return !!(current && current.isAlive()); }
    };
  } catch (err) {
    console.warn('[PluginLampa] Native page unavailable', err);
  }
})();

})();
