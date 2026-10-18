// PluginLampa v0.6.2 · Archive + Rutube + Stremio + KB.
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
    const events = doc.events.slice();
    let removed = 0;
    while (events.length && store.size() > maxBytes) {
      events.shift();
      removed++;
      store.importAll(Object.assign({}, doc, { events: events }));
    }
    if (!removed && store.size() > maxBytes) store.importAll(Object.assign({}, doc, { events: [] }));
    return { bytes: store.size(), maxBytes: maxBytes, removed: removed };
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
  var busy = false;
  var CACHE_KEY = 'video_finder_cache_v3';
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
    var rawStream = String(video && video.url || '');
    try {
      if (typeof URL === 'function') stream = new URL(rawStream);
    } catch (_) { /* old Tizen may not expose URL */ }
    if (!stream && /^https?:\/\/[^\s\/?#]+(?:[^\s]*)?$/i.test(rawStream)) {
      stream = { href: rawStream, protocol: rawStream.slice(0, 6).toLowerCase() === 'https:' ? 'https:' : 'http:' };
    }
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

  function queryProvider(provider, movie) {
    return withTimeout(function () { return provider.search(movie); }, providerTimeout(provider),
      'search ' + provider.id).then(function (items) {
      if (!Array.isArray(items)) throw new Error('Expected an array of candidates');
      recordProviderSuccess(provider, items.length);
      knowledgeRecord(provider,movie,null,items);
      return { provider: provider, items: rememberCandidates(movie, provider, items), cached: false };
    }).catch(function (err) {
      recordProviderFailure(provider);
      knowledgeRecord(provider,movie,err,null);
      console.error('[VideoFinder] Search failed:', provider.id, err);
      // Preserve the last good results; never cache errors as valid empty searches.
      return { provider: provider, items: cachedCandidates(movie, provider) || [],
        cached: true, error: String(err && err.message || err) };
    });
  }

  function openResults(movie, refresh, titleSearch) {
    if (!movie.title) {
      notify('В карточке нет названия фильма', true);
      return;
    }
    if (busy) return;
    busy = true;
    var scope = titleSearch || 'all';
    var selectedProviders = providers.filter(function (p) {
      return scope === 'all' || (scope === 'titles' ? !!p.titleSearch : !p.titleSearch);
    });
    var diagnostics = [];
    var cachedGroups = refresh ? [] : selectedProviders.map(function (provider) {
      var saved = cachedCandidates(movie, provider);
      return saved ? { provider: provider, items: saved, cached: true } : null;
    }).filter(Boolean);

    var cacheHit = cachedGroups.length > 0;
    var sourceProviders = selectedProviders.filter(function (provider) { return !provider.discovery; });
    var discoveryProviders = selectedProviders.filter(function (provider) { return provider.discovery; });
    var networkCount = 0;

    if (refresh) notify('Обновляю результаты: ' + movie.title);

    function searchGroup(group) {
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
        return queryProvider(provider, movie).then(function (result) {
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
      if (!refresh && all.some(function (group) { return group.items.length; })) return all;
      return searchGroup(discoveryProviders).then(function (found) {
        return all.concat(found);
      });
    });

    tasks.then(function (groups) {
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
      var menuActions = actions.map(function (action) {
        return { title: action.title, subtitle: action.subtitle || '', _actionHandler: action };
      });
      var entries = results.concat(menuActions, [
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
      ]);
      L.Select.show({
        title: 'Видео · ' + movie.title + (networkCount === 0 ? ' · из памяти' : ''),
        items: entries,
        onSelect: function (selected) {
          if (selected._actionHandler) { selected._actionHandler.open(movie); return; }
          if (selected._action === 'refresh') { L.Select.close(); openResults(movie, true, titleSearch); return; }
          if (selected._action === 'titles') {
            L.Select.close();
            openResults(movie, false, scope === 'all' ? 'exact' : scope === 'exact' ? 'titles' : 'all');
            return;
          }
          if (selected._action === 'diagnostics') {
            L.Select.show({
              title: 'Источники · ' + movie.title,
              items: diagnostics.length ? diagnostics.map(function (d) {
                return {title: d.provider.name, subtitle: d.status};
              }) : [{title: 'Подключённых источников нет'}],
              onSelect: function () {},
              onBack: function () { L.Controller.toggle('content'); }
            });
            return;
          }
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
    open: function (card) { openResults(movieInfo(card)); },
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
      version: '0.6.2',
      description: 'Поиск видео с локальным сохранением найденных источников',
      onContextMenu: function () {
        return { name: 'Найти видео (Video Finder)', description: 'Сначала сохранённое, затем поиск' };
      },
      onContextLauch: openCard
    };
    L.Listener.follow('full', function (event) {
      if (event.type !== 'complite' || !event.body || !window.$) return;
      var container = event.body.find('.buttons--container');
      if (!container.length || container.find('.pluginlampa-watch').length) return;
      var button = $('<div class="full-start__button selector pluginlampa-watch"><span>PluginLampa</span></div>');
      button.on('hover:enter', function () { openCard(event.data.movie); });
      container.append(button);
    });
    console.log('[VideoFinder] Installed v0.6.2. Providers:', window.LampaVideoFinder.listProviders());
  }

  function openCard(card) {
    card = card || {};
    var movie = movieInfo(card);
    if (movie.imdb_id || !L.Api || !L.Api.sources || !L.Api.sources.tmdb || !movie.tmdb_id) {
      openResults(movie); return;
    }
    if (typeof L.Api.sources.tmdb.external_imdb_id !== 'function') {
      openResults(movie); return;
    }
    var completed = false;
    var timer = setTimeout(function () {
      if (!completed) { completed = true; openResults(movie); }
    }, 6000);
    try {
      L.Api.sources.tmdb.external_imdb_id({ type: movie.media_type, id: movie.tmdb_id }, function (id) {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        card.imdb_id = id || '';
        openResults(movieInfo(card));
      });
    } catch (err) {
      if (!completed) { completed = true; clearTimeout(timer); openResults(movie); }
    }
  }

  function safeInit() {
    try { init(); }
    catch (error) {
      console.error('[PluginLampa] Initialization failed', error);
      window.__lampa_video_finder_v1 = false;
    }
  }
  if (window.appready) safeInit();
  else L.Listener.follow('app', function (event) {
    if (event.type === 'ready') safeInit();
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
    if (manifest.behaviorHints && manifest.behaviorHints.configurationRequired) throw Error('Расширение требует настройки на своём сайте');
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
  function playableStreams(data, addon) {
    var received = data && Array.isArray(data.streams) ? data.streams : [];
    var direct = received.filter(playable);
    if (addon) {
      addon.lastResponse = {
        received: received.length,
        direct: direct.length,
        torrents: received.filter(function (s) { return s && s.infoHash; }).length,
        external: received.filter(function (s) { return s && (s.externalUrl || s.ytId); }).length,
        proxyHeaders: received.filter(function (s) { return s && s.behaviorHints && s.behaviorHints.proxyHeaders; }).length
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
          var matches = streams.filter(function (stream) { return JSON.stringify([stream.name || '', stream.title || '', stream.description || '']) === item.signature; });
          var selected = matches.length === 1 ? matches[0] : null;
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
      L.Select.show({title: 'Официальный список Stremio', items: choices,
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
    L.Select.show({ title: 'Stremio · расширения (' + addons.length + ')', items: items,
      onSelect: function (choice) {
        if (choice.action === 'catalog') return catalog();
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
