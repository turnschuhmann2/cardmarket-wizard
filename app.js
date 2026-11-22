// Full-page Cardmarket Better Wizard web app.
// Coordinates the Cardmarket tab bridge, 8-hour offer cache, Web Worker optimizer,
// scoped per-game/per-list price limits, multi-country shipping, and cart checkout.
(() => {
  'use strict';

  const {
    collect, collectBySellers, collectSellerTokens, createRunner, browserSite, BlockedError, RetryableError, RefusedError, CartRejectError, TokenExpiredError, CACHE_MAX_AGE_MS,
  } = globalThis.CardmarketCollector;
  const {
    parseShippingTable, parcelShipping, scopeKey, filterByLimits, previewLimitLeftOut, matchesScope, summarizeBasketBySource,
    basketItemSignature, applyBasketRemovals,
  } = globalThis.CardmarketWizard;
  const {
    collectBasketEntries, collectLeftOutEntries, groupExportEntries,
    formatArchidektExport, formatPlainExport, safeExportFilename,
    createBasketSnapshot, readBasketSnapshot, basketFingerprint,
  } = globalThis.CardmarketExport;
  const {
    buildTokenCatalog, parseTokenListText, matchTokenDecks, optimizeTokens,
    mergeTokensIntoBasket, formatProxyListText,
  } = globalThis.CardmarketTokens;
  const {
    createTracer, summarizeRun, formatPerfMarkdown, sanitizeEventsForStorage, fmtMs,
  } = globalThis.CardmarketTelemetry;

  const COUNTRIES = [
    [1, 'Austria'], [2, 'Belgium'], [3, 'Bulgaria'], [35, 'Croatia'], [5, 'Cyprus'], [6, 'Czech Republic'],
    [8, 'Denmark'], [9, 'Estonia'], [11, 'Finland'], [12, 'France'], [7, 'Germany'], [14, 'Greece'],
    [15, 'Hungary'], [37, 'Iceland'], [16, 'Ireland'], [17, 'Italy'], [36, 'Japan'], [21, 'Latvia'],
    [18, 'Liechtenstein'], [19, 'Lithuania'], [20, 'Luxembourg'], [22, 'Malta'], [23, 'Netherlands'],
    [24, 'Norway'], [25, 'Poland'], [26, 'Portugal'], [27, 'Romania'], [29, 'Singapore'], [31, 'Slovakia'],
    [30, 'Slovenia'], [10, 'Spain'], [28, 'Sweden'], [4, 'Switzerland'], [13, 'United Kingdom'],
  ];
  const COUNTRY_ID_BY_NAME = Object.fromEntries(COUNTRIES.map(([id, name]) => [name, id]));
  const COUNTRY_NAME_BY_ID = Object.fromEntries(COUNTRIES);
  const NEIGHBOURS = [7, 1, 23, 2, 12, 4, 6, 25, 8, 20];
  const NON_EUROPE_IDS = [36, 29]; // Japan, Singapore
  const NON_EU_CUSTOMS_IDS = [13, 4, 24, 37, 18]; // UK, Switzerland, Norway, Iceland, Liechtenstein
  const EU_IDS = COUNTRIES.filter(([id]) => !NON_EUROPE_IDS.includes(id) && !NON_EU_CUSTOMS_IDS.includes(id)).map(([id]) => id);
  const THOROUGH = { splitBySellerType: true, groupSkipFactor: 3, minSellers: 80, sellerBatch: 20, sellerLimit: 200, maxSellerPages: 15, improvementCents: 20 };
  const DEFAULT_INTERVAL_MS = 400;
  const VALID_INTERVALS = [400, 600, 1000, 2000];
  const SETTINGS_VERSION = 2;
  const LIMIT_CANDIDATES = [50, 100, 200, 300, 500, 1000, 2000];
  const TRACKED_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
  const CART_MEMORY_MS = 12 * 60 * 60 * 1000;
  const KEPT_RUNS = 15;
  const KEPT_PERF_RUNS = 25;

  const $ = id => document.getElementById(id);
  const euros = v => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${(v / 100).toFixed(2).replace('.', ',')} €`);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const fmtAge = ts => {
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hrs < 48) return rem ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  };

  function toast(message, kind = 'default', actions = []) {
    const el = document.createElement('div');
    el.className = `toast ${kind === 'error' ? 'toast-error' : kind === 'success' ? 'toast-success' : ''}`;
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;
    el.appendChild(msg);
    let timer = null;
    const close = () => { clearTimeout(timer); el.remove(); };
    if (Array.isArray(actions) && actions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'toast-actions';
      for (const act of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `toast-btn${act.primary ? ' toast-btn-primary' : ''}`;
        btn.textContent = act.label;
        btn.addEventListener('click', () => {
          act.onClick?.(btn, close);
          if (!act.keepOpen) close();
        });
        wrap.appendChild(btn);
      }
      el.appendChild(wrap);
    }
    $('toastHost').appendChild(el);
    timer = setTimeout(close, actions.length ? 8500 : 3600);
  }

  // ---- Bridge Fetch (routes requests through an authenticated Cardmarket tab) ----
  async function bridgeFetch(url, init = {}) {
    const t0 = Date.now();
    const fullUrl = url.startsWith('http') ? url : `https://www.cardmarket.com${url}`;
    const payload = { type: 'cm-fetch', url: fullUrl, method: init.method || 'GET' };
    if (init.body instanceof FormData) payload.formEntries = [...init.body.entries()];
    const res = await chrome.runtime.sendMessage(payload);
    const appRoundTripMs = Date.now() - t0;
    if (!res || res.error) {
      if (res?.networkError) throw new TypeError(res.error || 'Network error');
      throw new Error(res?.error || 'Could not reach a Cardmarket tab. Make sure you are signed in to cardmarket.com.');
    }
    const headersMap = new Map(Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      redirected: res.redirected,
      headers: { get: name => headersMap.get(String(name).toLowerCase()) ?? null },
      text: async () => res.text,
      _timing: {
        ...(res.timing || {}),
        ...(res.bridgeTiming || {}),
        appRoundTripMs,
      },
    };
  }

  async function bridgeToken() {
    const res = await chrome.runtime.sendMessage({ type: 'cm-token' });
    return res?.token || null;
  }

  // ---- Web Worker Client ----
  // Two workers: the main optimiser (long seller searches) and a dedicated one for price-limit
  // estimates, so opening the estimator never shares a thread with a 15 s basket search.
  // Each worker keeps the last collection it was sent, so repeat jobs skip re-cloning it.
  const collectionIds = new WeakMap();
  let nextCollectionId = 1;
  const collectionIdOf = col => {
    if (!collectionIds.has(col)) collectionIds.set(col, nextCollectionId++);
    return collectionIds.get(col);
  };
  let nextWorkerId = 1;
  function createWorkerClient(label) {
    const worker = new Worker('optimizer-worker.js');
    const jobs = new Map();
    let sentCollectionId = 0;
    const failAll = message => {
      sentCollectionId = 0;
      const err = new Error(message);
      for (const [id, job] of jobs) {
        jobs.delete(id);
        job.reject(err);
      }
    };
    worker.onmessage = event => {
      const msg = event.data;
      const job = jobs.get(msg?.id);
      if (!job) return;
      if (msg.event === 'error') {
        jobs.delete(msg.id);
        if (msg.code === 'collection-missing') sentCollectionId = 0;
        job.reject(new Error(msg.error));
        return;
      }
      if (msg.event === 'done') {
        jobs.delete(msg.id);
        job.resolve(msg);
        return;
      }
      job.onEvent?.(msg);
    };
    worker.onerror = event => failAll(event?.message || `${label} worker crashed.`);
    worker.onmessageerror = () => failAll(`${label} worker returned an unreadable message.`);
    function post(payload, onEvent) {
      const id = nextWorkerId++;
      const message = { id, ...payload };
      if (payload.collection && typeof payload.collection === 'object') {
        const colId = collectionIdOf(payload.collection);
        message.collectionId = colId;
        if (colId === sentCollectionId) delete message.collection;
        else sentCollectionId = colId;
      }
      return new Promise((resolve, reject) => {
        jobs.set(id, { resolve, reject, onEvent });
        worker.postMessage(message);
      });
    }
    return {
      async run(payload, onEvent) {
        try {
          return await post(payload, onEvent);
        } catch (error) {
          // Worker lost its cached collection (e.g. restarted): resend it once in full.
          if (!/collection-missing/.test(error.message) || !payload.collection) throw error;
          sentCollectionId = 0;
          return post(payload, onEvent);
        }
      },
    };
  }
  const optimiserWorker = createWorkerClient('Optimiser');
  function runWorker(payload, onEvent) {
    return optimiserWorker.run(payload, onEvent);
  }
  // Price-limit candidates are independent searches, so they run in parallel on a small pool
  // (created on first use; each worker holds its own copy of the collection).
  const LIMIT_POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  let limitsPool = null;
  const limitsWorkers = () => {
    if (!limitsPool) limitsPool = Array.from({ length: LIMIT_POOL_SIZE }, (_, i) => createWorkerClient(`Price-limit ${i + 1}`));
    return limitsPool;
  };

  // ---- App State ----
  const state = {
    knownLists: [],          // [{ game, listId, name, count, path }]
    selectedLists: [],       // ['Magic:123', 'YuGiOh:456']
    extraProducts: [],       // [{ id, idProduct, name, game, category, productPath, url, amount, enabled }]
    regionMode: 'de',        // 'de' | 'eu' | 'custom'
    customCountries: [...NEIGHBOURS],
    shipTo: 7,
    method: 'sellers',
    interval: DEFAULT_INTERVAL_MS,
    trackedSellers: {},      // { name: timestamp }
    collection: null,        // Current loaded/fetched collection
    basket: null,            // Current optimized basket
    overlap: [],
    cuts: [],
    leftOut: [],
    countsByScope: {},
    activeLimits: [],        // [{ type, game?, listId?, label, cents }]
    manualCuts: [],          // [key]
    limitScope: { type: 'all', label: 'All cards' },
    limitsOpen: false,
    limitEstimateJobId: 0,
    limitOptions: [],
    limitPartialOptions: [],
    limitBaselineCents: null,
    selectedLimitChoice: null,
    limitInfoModalState: null,
    optimiseJobId: 0,
    optimising: false,
    fetching: false,
    fetchingTokens: false,
    carting: false,
    checkingCart: false,
    controller: null,
    runLog: [],
    currentTables: null,
    savedRuns: [],
    tokensText: '',
    tokenDeckOptions: {},
    tokenSettings: { maxPriceCents: 20, minCondition: 5, language: null, foil: 'N' },
    tokenCatalog: null,
    tokenCatalogLoading: null,
    tokenMatchPlan: null,
    sellerTokenOffers: {},
    tokenResult: null,
    includeTokensInBasket: true,
    removedItems: [],        // [{ id, batchId, seller, sig, item }]
    removedNextId: 1,
    removedNextBatchId: 1,
    removedListOpen: false,
    restoredSnapshot: null,  // { createdAt, orderedAt, source, exact } while showing a saved basket snapshot
    perfHistory: [],         // [{ id, action, ok, startedAt, finishedAt, wallMs, meta, summary, events }]
    selectedPerfRunId: null,
  };

  function activeBasket() {
    if (!state.basket) return null;
    let b = state.basket;
    if (state.includeTokensInBasket && state.tokenResult?.assignments?.length) {
      b = mergeTokensIntoBasket(b, state.tokenResult, {
        tables: state.currentTables,
        trackedOnly: Object.keys(state.trackedSellers),
        parcelShippingFn: parcelShipping,
      });
    }
    if (state.removedItems.length) {
      b = applyBasketRemovals(b, state.removedItems, {
        tables: state.currentTables,
        trackedOnly: Object.keys(state.trackedSellers),
      });
    }
    return b;
  }

  let activeTracer = null;
  const record = event => {
    const now = Date.now();
    const entry = { t: new Date(now).toISOString(), ...event };
    state.runLog.push(entry);
    if (activeTracer) {
      activeTracer.events.push({ relMs: now - activeTracer.startedAt, ...entry });
    }
  };

  async function persistPerfRun(tracer, { ok = true, extra = {}, collection = null } = {}) {
    const finished = tracer.finish({ ok, ...extra });
    const summary = summarizeRun(finished.events, {
      action: finished.action,
      meta: finished.meta,
      startedAt: finished.startedAt,
      finishedAt: finished.finishedAt,
      wallMs: finished.wallMs,
      collection,
    });
    const entry = {
      id: finished.runId,
      action: finished.action,
      ok,
      startedAt: finished.startedAt,
      finishedAt: finished.finishedAt,
      wallMs: finished.wallMs,
      meta: finished.meta,
      summary,
      events: sanitizeEventsForStorage(finished.events, 600),
    };
    state.perfHistory = [entry, ...state.perfHistory.filter(r => r.id !== entry.id)].slice(0, KEPT_PERF_RUNS);
    state.selectedPerfRunId = entry.id;
    try {
      await chrome.storage.local.set({ bwPerfHistory: state.perfHistory });
    } catch {
      // Fall back to keeping summaries without raw events if storage write fails.
      const compact = state.perfHistory.map(r => ({ ...r, events: [] }));
      chrome.storage.local.set({ bwPerfHistory: compact }).catch(() => {});
    }
    try {
      console.info(
        `[BW Perf] ${entry.action} ${ok ? 'OK' : 'ERR'} in ${fmtMs(entry.wallMs)} · HTTP ${summary.http.total} (${summary.http.effectiveReqPerSec} req/s) · retries ${summary.runner.retries}`,
        summary,
      );
    } catch {
      // Ignore console errors in restricted contexts.
    }
    renderPerfTab();
    return entry;
  }

  function beginActionTrace(action, meta = {}, { reuseActive = false } = {}) {
    if (reuseActive && activeTracer) {
      return {
        tracer: activeTracer,
        owned: false,
        span: (name, m, fn) => activeTracer.span(name, m, fn),
        recordSpan: (name, ms, data) => activeTracer.recordSpan(name, ms, data),
        mark: (type, data) => activeTracer.mark(type, data),
        finish: async () => null,
      };
    }
    const prev = activeTracer;
    const tracer = createTracer({
      action,
      meta,
      onEvent: ev => state.runLog.push(ev),
    });
    activeTracer = tracer;
    let finished = false;
    return {
      tracer,
      owned: true,
      span: (name, m, fn) => tracer.span(name, m, fn),
      recordSpan: (name, ms, data) => tracer.recordSpan(name, ms, data),
      mark: (type, data) => tracer.mark(type, data),
      finish: async (opts = {}) => {
        if (finished) return null;
        finished = true;
        if (activeTracer === tracer) activeTracer = prev;
        return persistPerfRun(tracer, opts);
      },
    };
  }

  function traceSpan(name, metaOrFn, maybeFn) {
    if (activeTracer) return activeTracer.span(name, metaOrFn, maybeFn);
    const fn = typeof metaOrFn === 'function' ? metaOrFn : maybeFn;
    return fn(() => {});
  }

  globalThis.__bwPerf = {
    latest: () => state.perfHistory[0] || null,
    history: () => state.perfHistory,
    events: () => state.runLog,
    liveSummary: () => summarizeRun(state.runLog, { collection: state.collection }),
    markdown: runId => {
      const target = runId
        ? state.perfHistory.find(r => r.id === runId)
        : state.perfHistory[0];
      return formatPerfMarkdown(target?.summary || summarizeRun(state.runLog, { collection: state.collection }));
    },
  };

  const knownPaths = new Map();
  const pathsStore = {
    get: id => knownPaths.get(id),
    set: (id, path) => {
      knownPaths.set(id, path);
      chrome.storage.local.set({ productPaths: Object.fromEntries(knownPaths) });
    },
  };

  const site = browserSite({
    fetchImpl: bridgeFetch,
    getToken: bridgeToken,
    baseOrigin: 'https://www.cardmarket.com',
    paths: pathsStore,
    onResponse: response => record({ type: 'http', ...response }),
  });

  // ---- Selection & Cache Signature ----
  function getSellerCountries() {
    if (state.regionMode === 'de') return [7];
    if (state.regionMode === 'eu') {
      // Explicit EU single-market filter (+ shipTo if shipping to a non-EU country like CH/UK/NO)
      // so non-EU / worldwide sellers (JP, SG, UK, CH, NO) never crowd out page-1 offers.
      return [...new Set([...EU_IDS, state.shipTo])].sort((a, b) => a - b);
    }
    return [...new Set(state.customCountries)].sort((a, b) => a - b);
  }

  function getSelectedListObjects() {
    const set = new Set(state.selectedLists);
    return state.knownLists.filter(l => set.has(`${l.game}:${l.listId}`));
  }

  function getEnabledProducts() {
    return state.extraProducts.filter(p => p.enabled !== false && (p.amount || 1) > 0);
  }

  function selectionSignature() {
    const listsPart = getSelectedListObjects().map(l => `${l.game}:${l.listId}`).sort().join(',');
    const prodsPart = getEnabledProducts().map(p => `${p.productPath}x${p.amount || 1}`).sort().join(',');
    const countries = getSellerCountries();
    const regionPart = state.regionMode === 'eu'
      ? `eu2:${state.shipTo}`
      : countries.length > 1 && countries.includes(state.shipTo)
        ? `${countries.join('.')}:d${state.shipTo}`
        : countries.join('.');
    return `${listsPart}|${prodsPart}|${regionPart}`;
  }

  // Signatures written before the EU shipping-aware cache format (eu -> eu2:<shipTo>, custom -> ...:d<shipTo>).
  function legacySelectionSignatures() {
    const listsPart = getSelectedListObjects().map(l => `${l.game}:${l.listId}`).sort().join(',');
    const prodsPart = getEnabledProducts().map(p => `${p.productPath}x${p.amount || 1}`).sort().join(',');
    const countries = getSellerCountries();
    const sigs = [];
    if (state.regionMode === 'eu') {
      sigs.push(`${listsPart}|${prodsPart}|eu`);
    } else if (countries.length > 1 && countries.includes(state.shipTo)) {
      sigs.push(`${listsPart}|${prodsPart}|${countries.join('.')}`);
    }
    return sigs;
  }

  function collectionKeyFor(sig) { return `bwCol:${sig}`; }
  function limitsKeyFor(sig) { return `bwLimits:${sig}`; }
  function cutsKeyFor(sig) { return `bwCuts:${sig}`; }

  // ---- Persistence ----
  async function saveSettings() {
    await chrome.storage.local.set({
      bwAppSettings: {
        settingsVersion: SETTINGS_VERSION,
        selectedLists: state.selectedLists,
        regionMode: state.regionMode,
        customCountries: state.customCountries,
        shipTo: state.shipTo,
        method: state.method,
        interval: state.interval,
      },
    });
  }

  async function saveProducts() {
    await chrome.storage.local.set({ extraProducts: state.extraProducts });
  }

  async function saveKnownLists() {
    await chrome.storage.local.set({ knownWantsLists: state.knownLists });
  }

  async function persistLimitsAndCuts() {
    const sig = state.collection?.selectionSig || selectionSignature();
    await chrome.storage.local.set({
      [limitsKeyFor(sig)]: state.activeLimits,
      [cutsKeyFor(sig)]: state.manualCuts,
    });
  }

  async function loadLimitsAndCutsFor(sig) {
    const data = await chrome.storage.local.get([limitsKeyFor(sig), cutsKeyFor(sig)]);
    state.activeLimits = Array.isArray(data[limitsKeyFor(sig)]) ? data[limitsKeyFor(sig)] : [];
    state.manualCuts = Array.isArray(data[cutsKeyFor(sig)]) ? data[cutsKeyFor(sig)] : [];
  }

  // ---- Cache Status Inspection (8h freshness policy) ----
  async function inspectSelectionCache() {
    const sig = selectionSignature();
    const hasSelection = getSelectedListObjects().length > 0 || getEnabledProducts().length > 0;
    if (!hasSelection) return { status: 'empty', sig, collection: null };

    let col = state.collection?.selectionSig === sig ? state.collection : null;
    if (!col) {
      const stored = await chrome.storage.local.get(collectionKeyFor(sig));
      col = stored[collectionKeyFor(sig)] || null;
    }
    if (!col || !Array.isArray(col.results) || !col.stats?.finishedAt) {
      const legacySigs = legacySelectionSignatures();
      if (legacySigs.length) {
        let legacyCol = legacySigs.includes(state.collection?.selectionSig) ? state.collection : null;
        if (!legacyCol) {
          const keys = legacySigs.map(collectionKeyFor);
          const stored = await chrome.storage.local.get(keys);
          for (const key of keys) {
            if (stored[key]) { legacyCol = stored[key]; break; }
          }
        }
        if (legacyCol && Array.isArray(legacyCol.results) && legacyCol.stats?.finishedAt) {
          const ageMs = Date.now() - legacyCol.stats.finishedAt;
          const incomplete = Boolean(legacyCol.blocked) || legacyCol.results.some(r => r.verdict === 'blocked');
          return { status: 'legacy', sig, legacySig: legacyCol.selectionSig || legacySigs[0], collection: legacyCol, ageMs, incomplete };
        }
      }
      return { status: 'missing', sig, collection: null };
    }
    const ageMs = Date.now() - col.stats.finishedAt;
    const incomplete = Boolean(col.blocked) || col.results.some(r => r.verdict === 'blocked');
    if (ageMs >= CACHE_MAX_AGE_MS) return { status: 'stale', sig, collection: col, ageMs, incomplete };
    if (incomplete) return { status: 'incomplete', sig, collection: col, ageMs, incomplete };
    return { status: 'fresh', sig, collection: col, ageMs, incomplete: false };
  }

  async function updateCachePill() {
    const pill = $('cachePill');
    const text = $('cachePillText');
    const info = await inspectSelectionCache();
    pill.className = 'cache-pill';
    pill.title = 'Offer cache status for your current selection';
    if (info.status === 'legacy') {
      pill.classList.add('cache-stale');
      const suffix = info.ageMs >= CACHE_MAX_AGE_MS ? ' · >8h' : ' · older EU format';
      text.textContent = `Legacy cache · ${fmtAge(info.collection.stats.finishedAt)}${suffix}`;
      pill.title = 'Cached before the EU shipping-aware update. Click Compute Basket to refetch or reuse the old cache.';
      return info;
    }
    if ((info.status === 'missing' || info.status === 'empty') && state.collection?.stats?.finishedAt) {
      const count = Array.isArray(state.collection.results) ? state.collection.results.length : 0;
      pill.classList.add('cache-stale');
      text.textContent = `Loaded run · ${fmtAge(state.collection.stats.finishedAt)} · ${count} items (selection differs)`;
      pill.title = 'Showing a loaded basket from an earlier run or different sidebar selection; no cache exists yet for the current selection.';
      return info;
    }
    if (info.status === 'empty') {
      pill.classList.add('cache-none');
      text.textContent = 'Select lists or products';
      return info;
    }
    if (info.status === 'missing') {
      pill.classList.add('cache-none');
      text.textContent = 'No cache for selection';
      return info;
    }
    const count = info.collection.results.length;
    if (info.status === 'fresh') {
      pill.classList.add('cache-fresh');
      text.textContent = `Cache fresh · ${fmtAge(info.collection.stats.finishedAt)} · ${count} items`;
    } else if (info.status === 'stale') {
      pill.classList.add('cache-stale');
      text.textContent = `Cache stale (${fmtAge(info.collection.stats.finishedAt)} · >8h)`;
    } else {
      pill.classList.add('cache-stale');
      text.textContent = `Partial cache · ${fmtAge(info.collection.stats.finishedAt)}`;
    }
    return info;
  }

  // ---- Shipping Tables (single or multi-country) ----
  async function loadShippingTablesFor(col) {
    const locations = new Set();
    const defaultCountry = COUNTRY_NAME_BY_ID[state.shipTo] || 'Germany';
    locations.add(defaultCountry);
    for (const r of col?.results || []) {
      for (const o of r.offers || []) {
        if (o.location) locations.add(o.location);
      }
    }
    const fromIds = [...locations].map(name => COUNTRY_ID_BY_NAME[name]).filter(Boolean);
    if (!fromIds.includes(state.shipTo)) fromIds.push(state.shipTo);
    const { tables, failed = [], error, timing: shipTiming } = await traceSpan(
      'shipping-tables',
      { fromCount: fromIds.length, to: state.shipTo },
      async setMeta => {
        const res = await chrome.runtime.sendMessage({
          type: 'shipping-multi',
          fromList: fromIds,
          to: state.shipTo,
        });
        if (res?.timing) setMeta(res.timing);
        return res;
      },
    );
    if (error) throw new Error(`Shipping tables: ${error}`);
    const byLocation = {};
    for (const [name, methods] of Object.entries(tables || {})) {
      if (Array.isArray(methods)) byLocation[name] = parseShippingTable(methods);
    }
    // An empty table keeps a failed country from silently being priced with the domestic one.
    for (const country of failed) byLocation[country] = [];
    const defaultTable = byLocation[defaultCountry];
    if (failed.includes(defaultCountry) || !defaultTable?.length) {
      throw new Error(`Shipping tables: no shipping rates available for ${defaultCountry}.`);
    }
    return { default: defaultTable, defaultLocation: defaultCountry, byLocation, failed };
  }

  // ---- Offer Query Cache (8h TTL for automatic reuse) ----
  async function offerCache(forceFresh = false) {
    const keepMs = 24 * 60 * 60 * 1000;
    const stored = await chrome.storage.local.get(null);
    const cache = new Map();
    const expired = [];
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith('q:')) continue;
      if (forceFresh || Date.now() - value.at > keepMs) expired.push(key);
      else cache.set(key.slice(2), value);
    }
    if (expired.length) await chrome.storage.local.remove(expired);
    return {
      get: key => (forceFresh ? undefined : cache.get(key)),
      set: (key, value) => { cache.set(key, value); chrome.storage.local.set({ [`q:${key}`]: value }); },
    };
  }

  const isActionListName = name =>
    /^(view(\s*\/\s*edit)?(\s+list)?|edit(\s+list)?|delete|remove|shopping wizard|wizard)$/i.test(String(name || '').trim());
  const isPlaceholderListName = name =>
    !name || isActionListName(name) || /^((magic|yugioh|yu-gi-oh!)\s+wants\s+#\d+|wants\s+list\s+\d+)$/i.test(String(name).trim());
  const fallbackListName = (game, listId) => `${game === 'YuGiOh' ? 'Yu-Gi-Oh!' : 'Magic'} Wants #${listId}`;

  async function removeList(key) {
    state.knownLists = state.knownLists.filter(l => `${l.game}:${l.listId}` !== key);
    state.selectedLists = state.selectedLists.filter(k => k !== key);
    await Promise.all([saveKnownLists(), saveSettings()]);
    renderLists();
    await updateCachePill();
  }

  async function clearAllLists() {
    if (!state.knownLists.length) return;
    state.knownLists = [];
    state.selectedLists = [];
    await Promise.all([saveKnownLists(), saveSettings()]);
    renderLists();
    await updateCachePill();
    toast('Cleared all Wants Lists.');
  }

  // ---- UI Rendering: Sidebar ----
  function renderLists() {
    const container = $('listsContainer');
    const clearBtn = $('btnClearLists');
    if (clearBtn) clearBtn.hidden = !state.knownLists.length;
    if (!state.knownLists.length) {
      container.innerHTML = '<div class="empty-mini">No Wants Lists added yet. Paste a URL above or click <strong>Open Better Wizard</strong> on a Cardmarket Wants List page.</div>';
      return;
    }
    const selected = new Set(state.selectedLists);
    const byGame = { Magic: [], YuGiOh: [] };
    for (const list of state.knownLists) {
      (byGame[list.game] ||= []).push(list);
    }
    let html = '';
    for (const [game, items] of Object.entries(byGame)) {
      if (!items.length) continue;
      const badgeCls = game === 'Magic' ? 'badge-mtg' : 'badge-ygo';
      const label = game === 'Magic' ? 'Magic: The Gathering' : 'Yu-Gi-Oh!';
      html += `<div class="game-group-title">${label}</div>`;
      for (const item of items) {
        const key = `${item.game}:${item.listId}`;
        const checked = selected.has(key);
        const displayName = isActionListName(item.name) ? fallbackListName(item.game, item.listId) : item.name;
        html += `
          <div class="list-item ${checked ? 'checked' : ''}">
            <label class="list-item-left">
              <input type="checkbox" data-list-key="${esc(key)}" ${checked ? 'checked' : ''}>
              <span class="list-item-name" title="${esc(displayName)}">${esc(displayName)}</span>
            </label>
            <span class="list-item-meta">
              ${item.count != null ? `<span class="badge ${badgeCls}">${item.count}</span>` : `<span class="badge ${badgeCls}">${game === 'Magic' ? 'MTG' : 'YGO'}</span>`}
              <a class="list-ext-link" href="https://www.cardmarket.com${esc(item.path || `/en/${item.game}/Wants/${item.listId}`)}" target="_blank" rel="noopener" title="Open on Cardmarket">↗</a>
              <button type="button" class="qty-btn list-del-btn" data-list-del="${esc(key)}" title="Remove list" aria-label="Remove ${esc(displayName)}">×</button>
            </span>
          </div>`;
      }
    }
    container.innerHTML = html;
    container.querySelectorAll('input[data-list-key]').forEach(box => {
      box.addEventListener('change', async () => {
        const key = box.dataset.listKey;
        if (box.checked) {
          if (!state.selectedLists.includes(key)) state.selectedLists.push(key);
        } else {
          state.selectedLists = state.selectedLists.filter(k => k !== key);
        }
        renderLists();
        await saveSettings();
        await updateCachePill();
      });
    });
    container.querySelectorAll('[data-list-del]').forEach(btn => {
      btn.addEventListener('click', () => removeList(btn.dataset.listDel));
    });
  }

  function renderProducts() {
    const container = $('productsList');
    if (!state.extraProducts.length) {
      container.innerHTML = '<div class="empty-mini">No extra products added yet.</div>';
      return;
    }
    container.innerHTML = state.extraProducts.map((p, idx) => {
      const checked = p.enabled !== false;
      return `
        <div class="product-item ${checked ? 'checked' : ''}">
          <input type="checkbox" data-prod-toggle="${idx}" ${checked ? 'checked' : ''}>
          <div class="product-info">
            <a class="product-name" href="${esc(p.url || `https://www.cardmarket.com${p.productPath}`)}" target="_blank" rel="noopener" title="${esc(p.name)}">${esc(p.name)}</a>
            <span class="badge badge-product">${esc(p.category || 'Product')}</span>
            <span class="badge ${p.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${p.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span>
          </div>
          <div class="product-controls">
            <button type="button" class="qty-btn" data-prod-dec="${idx}">−</button>
            <span class="qty-val">${p.amount || 1}</span>
            <button type="button" class="qty-btn" data-prod-inc="${idx}">+</button>
            <button type="button" class="qty-btn" data-prod-del="${idx}" title="Remove">×</button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-prod-toggle]').forEach(el => el.addEventListener('change', async () => {
      state.extraProducts[Number(el.dataset.prodToggle)].enabled = el.checked;
      await saveProducts();
      renderProducts();
      await updateCachePill();
    }));
    container.querySelectorAll('[data-prod-dec]').forEach(el => el.addEventListener('click', async () => {
      const p = state.extraProducts[Number(el.dataset.prodDec)];
      p.amount = Math.max(1, (p.amount || 1) - 1);
      await saveProducts();
      renderProducts();
      await updateCachePill();
    }));
    container.querySelectorAll('[data-prod-inc]').forEach(el => el.addEventListener('click', async () => {
      const p = state.extraProducts[Number(el.dataset.prodInc)];
      p.amount = (p.amount || 1) + 1;
      await saveProducts();
      renderProducts();
      await updateCachePill();
    }));
    container.querySelectorAll('[data-prod-del]').forEach(el => el.addEventListener('click', async () => {
      state.extraProducts.splice(Number(el.dataset.prodDel), 1);
      await saveProducts();
      renderProducts();
      await updateCachePill();
    }));
  }

  function renderRegionControls() {
    $('regionMode').querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.region === state.regionMode);
    });
    $('customCountriesBox').hidden = state.regionMode !== 'custom';
    const selected = new Set(state.customCountries);
    $('countryCheckboxes').innerHTML = COUNTRIES.map(([id, name]) => `
      <label>
        <input type="checkbox" data-country-id="${id}" ${selected.has(id) ? 'checked' : ''}>
        <span>${esc(name)}</span>
      </label>`).join('');
    $('countryCheckboxes').querySelectorAll('[data-country-id]').forEach(box => {
      box.addEventListener('change', async () => {
        const id = Number(box.dataset.countryId);
        if (box.checked) {
          if (!state.customCountries.includes(id)) state.customCountries.push(id);
        } else {
          state.customCountries = state.customCountries.filter(c => c !== id);
        }
        await saveSettings();
        await updateCachePill();
      });
    });
  }

  function renderSavedRuns() {
    const sel = $('savedRuns');
    sel.innerHTML = '<option value="">Saved runs…</option>' + state.savedRuns.map(r => {
      const label = `${new Date(r.at).toLocaleString()} · ${r.cards} items${r.totalCents ? ` · ${euros(r.totalCents)} (${r.sellers} sellers)` : ''}${r.orderedAt ? ' · ordered' : ''}`;
      return `<option value="${esc(r.id)}">${esc(label)}</option>`;
    }).join('');
  }

  // ---- Progress & Busy Controls ----
  function syncBusyUI() {
    const working = state.fetching || state.fetchingTokens || state.carting;
    const computeBtn = $('btnCompute');
    computeBtn.disabled = working;
    $('btnRefetch').disabled = working;
    $('btnOpenRun').disabled = working;
    $('importFile').disabled = working;
    $('btnBuy').disabled = working || state.optimising || !(activeBasket()?.parcels?.length);
    const checkCartBtn = $('btnCheckCart');
    if (checkCartBtn) checkCartBtn.disabled = working || state.checkingCart;
    const findTokensBtn = $('btnFindTokens');
    if (findTokensBtn) findTokensBtn.disabled = working || state.optimising || !state.basket;
    const reoptTokensBtn = $('btnReoptTokens');
    if (reoptTokensBtn) reoptTokensBtn.disabled = working || state.optimising || !state.basket;
    $('btnStop').hidden = !(working && state.controller);
    computeBtn.querySelector('.btn-spinner').hidden = !(working || state.optimising);
    $('btnComputeLabel').textContent = state.fetching ? 'Fetching offers…'
      : state.fetchingTokens ? 'Finding tokens…'
        : state.carting ? 'Adding to cart…'
          : state.optimising ? 'Optimising…' : 'Compute Basket';
  }

  // Recompute triggers must not overlap a fetch or cart run.
  function workInProgress() {
    if (!state.fetching && !state.fetchingTokens && !state.carting) return false;
    toast('Wait for the current fetch or cart run to finish first.', 'error');
    return true;
  }

  function showProgress(title, meta = '', percent = null, sub = '') {
    $('progressBanner').hidden = false;
    $('progressTitle').textContent = title;
    $('progressMeta').textContent = meta;
    if (percent !== null) $('progressFill').style.width = `${Math.max(4, Math.min(100, percent))}%`;
    $('progressSub').textContent = sub;
  }

  function hideProgress() {
    $('progressBanner').hidden = true;
  }

  // ---- Verification Pause Handling ----
  let activePause = null;
  function waitForUser(message, attempt) {
    // Concurrent callers share one prompt so they cannot overwrite each other's buttons.
    if (activePause) return activePause;
    const automatic = attempt === 1;
    const until = Date.now() + 10000;
    record({ type: automatic ? 'auto-wait' : 'asked-user', message, attempt });
    $('pauseBanner').hidden = false;
    activePause = new Promise((resolve, reject) => {
      let timer = null;
      const signal = state.controller?.signal;
      const abort = () => finish(false);
      const finish = proceed => {
        clearInterval(timer);
        signal?.removeEventListener('abort', abort);
        $('pauseBanner').hidden = true;
        $('btnContinue').onclick = null;
        $('btnPauseStop').onclick = null;
        if (proceed) resolve();
        else reject(new Error('Stopped'));
      };
      const tick = () => {
        const left = Math.max(0, Math.round((until - Date.now()) / 1000));
        $('pauseText').textContent = `${message} Retrying in ${left}s…`;
        if (left === 0) finish(true);
      };
      if (automatic) { timer = setInterval(tick, 1000); tick(); }
      else { $('pauseText').textContent = `${message} Complete any check on Cardmarket, then click Continue.`; }
      $('btnContinue').onclick = () => finish(true);
      $('btnPauseStop').onclick = () => { state.controller?.abort(); finish(false); };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    }).finally(() => { activePause = null; });
    return activePause;
  }

  // ---- Cache Alert Modal ----
  function askCacheModal({ title, body, allowOld = false }) {
    return new Promise(resolve => {
      $('cacheModalTitle').textContent = title;
      $('cacheModalBody').textContent = body;
      $('modalUseOld').hidden = !allowOld;
      $('cacheModal').hidden = false;
      const cleanup = choice => {
        $('cacheModal').hidden = true;
        $('modalCancel').onclick = null;
        $('modalUseOld').onclick = null;
        $('modalRefetch').onclick = null;
        resolve(choice);
      };
      $('modalCancel').onclick = () => cleanup('cancel');
      $('modalUseOld').onclick = () => cleanup('old');
      $('modalRefetch').onclick = () => cleanup('refetch');
    });
  }

  // ---- Scoped Price Limits UI ----
  function availableScopes() {
    const scopes = [{ type: 'all', label: 'All cards' }];
    const games = new Set();
    const lists = new Map();
    for (const r of state.collection?.results || []) {
      if (r.kind === 'product') continue;
      const g = r.game || 'Magic';
      games.add(g);
      if (r.listId != null) {
        const k = `${g}:${r.listId}`;
        if (!lists.has(k)) {
          lists.set(k, {
            type: 'list', game: g, listId: String(r.listId),
            label: `${g === 'YuGiOh' ? 'YGO' : 'MTG'} · ${r.listName || `List ${r.listId}`}`,
          });
        }
      }
    }
    if (games.size > 1) {
      for (const g of games) {
        scopes.push({ type: 'game', game: g, label: g === 'YuGiOh' ? 'Yu-Gi-Oh! only' : 'Magic only' });
      }
    }
    if (lists.size > 1 || (lists.size === 1 && games.size > 1)) {
      for (const item of lists.values()) scopes.push(item);
    }
    return scopes;
  }

  function renderActiveLimits() {
    const bar = $('activeLimitsBar');
    if (!state.activeLimits.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML = state.activeLimits.map((rule, idx) => {
      const k = scopeKey(rule);
      const count = state.countsByScope[k] || 0;
      const text = rule.cents === null
        ? `${rule.label}: No limit`
        : `${rule.label} ≤ ${euros(rule.cents)} (${count} left out)`;
      return `<span class="limit-pill">${esc(text)} <button type="button" data-rm-limit="${idx}" title="Remove limit">×</button></span>`;
    }).join('') + '<button type="button" id="btnClearAllLimits" class="btn btn-link btn-xs">Clear all limits</button>';

    bar.querySelectorAll('[data-rm-limit]').forEach(btn => btn.addEventListener('click', async () => {
      if (workInProgress()) return;
      state.activeLimits.splice(Number(btn.dataset.rmLimit), 1);
      await persistLimitsAndCuts();
      await computeBasketFromCollection();
    }));
    $('btnClearAllLimits')?.addEventListener('click', async () => {
      if (workInProgress()) return;
      state.activeLimits = [];
      await persistLimitsAndCuts();
      await computeBasketFromCollection();
    });
  }

  function renderScopePills() {
    const scopes = availableScopes();
    const currentKey = scopeKey(state.limitScope);
    if (!scopes.some(s => scopeKey(s) === currentKey)) state.limitScope = scopes[0];
    $('scopePills').innerHTML = scopes.map((s, idx) => `
      <button type="button" class="scope-pill ${scopeKey(s) === scopeKey(state.limitScope) ? 'active' : ''}" data-scope-idx="${idx}">
        ${esc(s.label)}
      </button>`).join('');
    $('scopePills').querySelectorAll('[data-scope-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.limitScope = scopes[Number(btn.dataset.scopeIdx)];
        renderScopePills();
        estimateLimitsForCurrentScope();
      });
    });
  }

  function closeLimitInfoModal() {
    const modal = $('limitInfoModal');
    if (modal) modal.hidden = true;
    state.limitInfoModalState = null;
  }

  function openLimitInfoModal(cents, { isCustom = false } = {}) {
    if (!state.collection || !(cents > 0)) return;
    const scope = state.limitScope;
    const preview = previewLimitLeftOut(
      state.collection.results || [],
      state.activeLimits,
      state.manualCuts,
      scope,
      cents,
    );
    const pool = state.limitOptions.length ? state.limitOptions : state.limitPartialOptions;
    const opt = pool.find(o => o.cents === cents) || null;

    $('limitInfoModalTitle').textContent = `Cards left out (> ${euros(cents)})`;
    const subParts = [
      scope.label,
      `${preview.totalCopies} card${preview.totalCopies === 1 ? '' : 's'}`,
      `Market total ${euros(preview.totalMarketCents)}`,
    ];
    if (opt && Number.isFinite(opt.savesCents)) {
      subParts.push(`Est. saves ${euros(opt.savesCents)}`);
    }
    $('limitInfoModalSub').textContent = subParts.join(' · ');

    const body = $('limitInfoModalBody');
    if (!preview.items.length) {
      body.innerHTML = `<div class="limit-info-empty">No cards in <strong>${esc(scope.label)}</strong> have a market price above <strong>${euros(cents)}</strong>.</div>`;
    } else {
      const showSource = new Set(preview.items.map(i => i.game)).size > 1 || preview.items.some(i => i.listName);
      const hasMultiQty = preview.items.some(i => i.amount > 1);
      const labelCols = 1 + (showSource ? 1 : 0) + (hasMultiQty ? 1 : 0);
      body.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Card</th>
              ${showSource ? '<th>Source</th>' : ''}
              ${hasMultiQty ? '<th class="num">Qty</th>' : ''}
              <th class="num">Market</th>
              <th class="num">Cheapest</th>
              ${hasMultiQty ? '<th class="num">Total</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${preview.items.map(item => `
              <tr>
                <td><strong>${esc(item.name)}</strong></td>
                ${showSource ? `<td><span class="badge ${item.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${item.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span>${item.listName ? ` <span style="font-size:12px;color:var(--text-muted)">${esc(item.listName)}</span>` : ''}</td>` : ''}
                ${hasMultiQty ? `<td class="num">${item.amount}&times;</td>` : ''}
                <td class="num">${hasMultiQty ? euros(item.targetCents) : `<strong>${euros(item.targetCents)}</strong>`}</td>
                <td class="num" style="color:var(--text-muted)">${euros(item.cheapestOfferCents)}</td>
                ${hasMultiQty ? `<td class="num"><strong>${euros(item.totalMarketCents)}</strong></td>` : ''}
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="${labelCols}">Total (${preview.totalCopies} card${preview.totalCopies === 1 ? '' : 's'})</td>
              ${hasMultiQty ? '<td></td><td></td>' : ''}
              <td class="num">${euros(preview.totalMarketCents)}</td>
              ${hasMultiQty ? '' : '<td></td>'}
            </tr>
          </tfoot>
        </table>`;
    }

    const selectBtn = $('limitInfoSelect');
    state.limitInfoModalState = { cents, isCustom };
    selectBtn.textContent = `Select ≤ ${euros(cents)}`;
    selectBtn.hidden = false;
    $('limitInfoModal').hidden = false;
  }

  function selectLimitFromModal() {
    const info = state.limitInfoModalState;
    if (!info) return;
    if (info.isCustom) {
      state.selectedLimitChoice = 'custom';
      const radio = document.querySelector('input[name="bwLimit"][value="custom"]');
      if (radio) radio.checked = true;
    } else {
      state.selectedLimitChoice = String(info.cents);
      const radio = document.querySelector(`input[name="bwLimit"][value="${info.cents}"]`);
      if (radio) radio.checked = true;
    }
    closeLimitInfoModal();
  }

  function renderLimitsSkeleton(rows = 5, partial = []) {
    const existingRows = partial.map(opt => `
      <tr>
        <td><input type="radio" name="bwLimit" value="${opt.cents}" ${state.selectedLimitChoice === String(opt.cents) ? 'checked' : ''}></td>
        <td>
          <span class="limit-cell">
            <strong>${euros(opt.cents)}</strong>
            <button type="button" class="btn-info-icon" data-limit-info="${opt.cents}" title="Show cards left out above ${euros(opt.cents)}" aria-label="Show cards left out above ${euros(opt.cents)}">i</button>
          </span>
        </td>
        <td class="num">${opt.cards}</td>
        <td class="num">${euros(opt.leftOutCents)}</td>
        <td class="num">${euros(opt.basketCents)}</td>
        <td class="num" style="color:var(--emerald);font-weight:700">${euros(opt.savesCents)}</td>
      </tr>`).join('');
    const skelCount = Math.max(1, rows - partial.length);
    const skels = Array.from({ length: skelCount }, () => `
      <tr>
        <td><span class="skeleton" style="width:14px"></span></td>
        <td><span class="skeleton" style="width:65px"></span></td>
        <td class="num"><span class="skeleton" style="width:32px"></span></td>
        <td class="num"><span class="skeleton" style="width:64px"></span></td>
        <td class="num"><span class="skeleton" style="width:64px"></span></td>
        <td class="num"><span class="skeleton" style="width:64px"></span></td>
      </tr>`).join('');
    $('limitsTableWrap').innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12.5px;color:var(--text-muted)">
        <span class="pulse-dot"></span>
        <span>Estimating full-basket impact for <strong>${esc(state.limitScope.label)}</strong> in background…</span>
      </div>
      <table class="data-table">
        <thead><tr><th></th><th>Limit</th><th class="num">Cards left out</th><th class="num">Market value</th><th class="num">Full basket</th><th class="num">Saves</th></tr></thead>
        <tbody>${existingRows}${skels}</tbody>
      </table>`;
  }

  function renderLimitsTable() {
    const scope = state.limitScope;
    const hasBroader = state.activeLimits.some(r =>
      (scope.type === 'list' && (r.type === 'game' || r.type === 'all')) ||
      (scope.type === 'game' && r.type === 'all')
    );
    const hasExplicit = state.selectedLimitChoice !== null && (
      state.selectedLimitChoice === 'custom' ||
      (state.selectedLimitChoice === 'none' && hasBroader) ||
      state.limitOptions.some(o => String(o.cents) === state.selectedLimitChoice)
    );
    const rows = state.limitOptions.map(opt => {
      const isChecked = hasExplicit ? state.selectedLimitChoice === String(opt.cents) : Boolean(opt.suggested);
      return `
      <tr>
        <td><input type="radio" name="bwLimit" value="${opt.cents}" ${isChecked ? 'checked' : ''}></td>
        <td>
          <span class="limit-cell">
            <strong>${euros(opt.cents)}</strong>
            <button type="button" class="btn-info-icon" data-limit-info="${opt.cents}" title="Show cards left out above ${euros(opt.cents)}" aria-label="Show cards left out above ${euros(opt.cents)}">i</button>
            ${opt.suggested ? '<span class="badge badge-indigo">suggested</span>' : ''}
          </span>
        </td>
        <td class="num">${opt.cards}</td>
        <td class="num">${euros(opt.leftOutCents)}</td>
        <td class="num">${euros(opt.basketCents)}</td>
        <td class="num" style="color:var(--emerald);font-weight:700">${euros(opt.savesCents)}</td>
      </tr>`;
    }).join('');

    const customChecked = hasExplicit ? state.selectedLimitChoice === 'custom' : !state.limitOptions.length;
    const noneChecked = hasExplicit && state.selectedLimitChoice === 'none';

    const emptyMsg = !state.limitOptions.length
      ? '<p class="card-hint">No preset limit leaves out a subset of cards in this scope — you can still enter a custom limit below.</p>'
      : '';

    $('limitsTableWrap').innerHTML = `
      ${emptyMsg}
      <table class="data-table">
        <thead>
          <tr><th></th><th>Limit (${esc(scope.label)})</th><th class="num">Cards left out</th><th class="num">Market value</th><th class="num">Full basket</th><th class="num">Saves</th></tr>
        </thead>
        <tbody>
          ${rows}
          <tr>
            <td><input type="radio" name="bwLimit" value="custom" ${customChecked ? 'checked' : ''}></td>
            <td colspan="5">
              <span class="limit-cell">
                Other: <input id="customLimitInput" class="input" style="width:90px;display:inline-block" placeholder="1,50"> €
                <button type="button" class="btn-info-icon" data-limit-info="custom" title="Show cards left out for this custom limit" aria-label="Show cards left out for custom limit">i</button>
              </span>
            </td>
          </tr>
          ${hasBroader ? `
          <tr>
            <td><input type="radio" name="bwLimit" value="none" ${noneChecked ? 'checked' : ''}></td>
            <td colspan="5"><strong>No limit for ${esc(scope.label)}</strong> <span class="card-hint">(overrides broader limit)</span></td>
          </tr>` : ''}
        </tbody>
      </table>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <button type="button" id="btnApplyLimit" class="btn btn-primary btn-sm">Apply limit &amp; recompute basket</button>
      </div>`;

    $('btnApplyLimit').addEventListener('click', applySelectedLimit);
  }

  // Finished estimates per (collection, tables, scope, rules, cuts): reopening the estimator or
  // flipping back to a scope pill is instant. New collections/tables get new ids, so stale entries never hit.
  const limitEstimateCache = new Map();
  async function estimateLimitsForCurrentScope() {
    if (!state.collection || !state.currentTables) return;
    const myJob = ++state.limitEstimateJobId;
    const trackedOnly = Object.keys(state.trackedSellers).sort();
    const tablesId = collectionIdOf(state.currentTables);
    const cacheKey = JSON.stringify([
      collectionIdOf(state.collection), tablesId, scopeKey(state.limitScope),
      state.activeLimits.map(r => [scopeKey(r), r.cents]), [...state.manualCuts].sort(), trackedOnly,
    ]);
    const cached = limitEstimateCache.get(cacheKey);
    if (cached) {
      state.limitPartialOptions = [];
      state.selectedLimitChoice = null;
      state.limitOptions = cached.options;
      state.limitBaselineCents = cached.baselineCents;
      renderLimitsTable();
      return;
    }
    state.limitOptions = [];
    const partial = [];
    state.limitPartialOptions = partial;
    state.selectedLimitChoice = null;
    renderLimitsSkeleton(5, partial);
    try {
      const tLim0 = Date.now();
      const pool = limitsWorkers();
      // Stop stale estimates first so they don't steal CPU from this one.
      pool.slice(1).forEach(client => client.run({ type: 'cancel-limits' }).catch(() => {}));
      const job = {
        type: 'suggest-limits',
        collection: state.collection,
        tables: state.currentTables,
        tablesId,
        trackedOnly,
        activeLimits: state.activeLimits,
        manualCuts: state.manualCuts,
        scope: state.limitScope,
        markSuggestion: false,
      };
      const onRow = ev => {
        if (myJob !== state.limitEstimateJobId || ev.event !== 'limit-row') return;
        partial.push(ev.option);
        partial.sort((a, b) => a.cents - b.cents);
        renderLimitsSkeleton(5, partial);
      };
      // One shared baseline, then the candidates split round-robin across the pool.
      const base = await pool[0].run({ ...job, candidates: [] });
      if (myJob !== state.limitEstimateJobId || base.cancelled) return;
      const tBase = Date.now();
      const shares = pool.map((_, i) => LIMIT_CANDIDATES.filter((__, c) => c % pool.length === i));
      const parts = await Promise.all(pool.map((client, i) => shares[i].length
        ? client.run({ ...job, baseline: base.baseline, candidates: shares[i] }, onRow)
        : { options: [] }));
      if (myJob !== state.limitEstimateJobId || parts.some(part => part.cancelled)) return;
      const options = parts.flatMap(part => part.options || []).sort((a, b) => a.cents - b.cents);
      const suggestion = options.find(o => o.cards <= base.totalScopedCopies * 0.1) || options.at(-1);
      if (suggestion) suggestion.suggested = true;
      record({
        type: 'worker-suggest-limits',
        scope: state.limitScope?.label || 'all',
        options: options.length,
        roundTripMs: Date.now() - tLim0,
        baseMs: tBase - tLim0,
        candidatesMs: Date.now() - tBase,
        totalMs: Date.now() - tLim0,
        evaluatedCount: options.length,
        workers: pool.length,
      });
      state.limitOptions = options;
      state.limitBaselineCents = base.baselineCents;
      if (limitEstimateCache.size > 50) limitEstimateCache.clear();
      limitEstimateCache.set(cacheKey, { options, baselineCents: base.baselineCents });
      renderLimitsTable();
    } catch (error) {
      if (myJob !== state.limitEstimateJobId) return;
      $('limitsTableWrap').innerHTML = `<p class="card-hint" style="color:var(--rose)">Could not estimate limits: ${esc(error.message)}</p>`;
    }
  }

  async function applySelectedLimit() {
    if (workInProgress()) return;
    const choice = document.querySelector('input[name="bwLimit"]:checked')?.value;
    let centsVal = null;
    if (choice === 'none') {
      centsVal = null;
    } else if (choice === 'custom') {
      const raw = $('customLimitInput')?.value.replace(',', '.');
      centsVal = Math.round(Number(raw) * 100);
      if (!(centsVal > 0)) { toast('Enter a valid price limit in €.', 'error'); return; }
    } else {
      centsVal = Number(choice);
      if (!(centsVal > 0)) { toast('Select a price limit first.', 'error'); return; }
    }
    const targetKey = scopeKey(state.limitScope);
    state.activeLimits = [
      ...state.activeLimits.filter(r => scopeKey(r) !== targetKey),
      { ...state.limitScope, cents: centsVal },
    ];
    await persistLimitsAndCuts();
    toast(`Applied ${centsVal === null ? 'no limit' : `≤ ${euros(centsVal)}`} to ${state.limitScope.label} — recomputing full basket…`);
    await computeBasketFromCollection();
  }

  // ---- UI Rendering: Main Basket & Tabs ----
  function renderKpis(optimising = false, note = '') {
    const b = activeBasket();
    if (!b) return;
    const tokenCount = b.parcels.reduce((s, p) => s + p.items.filter(i => i.kind === 'token').length, 0);
    const covered = Math.max(0, (b.curve.at(-1)?.cards || 0) - tokenCount);
    const totalWanted = covered + b.missing.length + (b.removedNonTokenCount || 0);
    const itemsCents = b.totalCents - b.shippingCents;
    const crossCount = b.parcels.filter(p => (p.games?.length || 0) > 1 || p.hasProducts || p.hasTokens).length;
    const tokenNote = tokenCount ? `Incl. +${tokenCount} token${tokenCount === 1 ? '' : 's'} (${euros(b.tokenStats?.totalAddedCents ?? 0)})` : '';
    const removedNote = b.removedCount ? `-${euros(b.savedByRemovalsCents)} (${b.removedCount} removed)` : '';
    const subParts = [note, removedNote, tokenNote].filter(Boolean);
    const subNote = optimising ? 'Searching for cheaper seller combos…' : (subParts.join(' · ') || 'Optimised total');

    $('kpiTotal').textContent = euros(b.totalCents);
    $('kpiTotalSub').className = `kpi-sub ${subParts.length ? 'good' : ''}`;
    $('kpiTotalSub').textContent = subNote;
    $('kpiSplit').textContent = `${euros(itemsCents)} + ${euros(b.shippingCents)}`;
    $('kpiSplitSub').textContent = `${b.totalCents ? Math.round((b.shippingCents / b.totalCents) * 100) : 0}% shipping`;
    $('kpiSellers').textContent = `${b.parcels.length}`;
    $('kpiSellersSub').textContent = !b.parcels.length
      ? 'All sellers removed'
      : crossCount ? `${crossCount} combined parcel${crossCount > 1 ? 's' : ''}` : 'Optimized seller count';
    $('kpiItems').textContent = tokenCount ? `${covered}/${totalWanted} +${tokenCount}T` : `${covered} / ${totalWanted}`;
    const itemNotes = [];
    if (b.missing.length) itemNotes.push(`${b.missing.length} unavailable`);
    if (b.removedCount) itemNotes.push(`${b.removedCount} removed`);
    $('kpiItemsSub').textContent = itemNotes.length ? itemNotes.join(' · ') : '100% covered';
    $('tabCountSellers').textContent = String(b.parcels.length);
  }

  function renderCutsAndLeftOut(cutsLoading = false) {
    const leftBar = $('leftOutBar');
    if (state.leftOut.length) {
      const totalCopies = state.leftOut.reduce((s, r) => s + (r.amount || 1), 0);
      const leftEntries = leftOutEntries();
      const plainGroups = groupExportEntries(leftEntries, 'plain');
      const archGroups = groupExportEntries(leftEntries, 'archidekt');
      const hasMagic = archGroups.length > 0;
      leftBar.hidden = false;
      leftBar.innerHTML = `
        <div><strong>Left out (${totalCopies} cards):</strong> ${state.leftOut.slice(0, 8).map(r => esc(r.name)).join(', ')}${state.leftOut.length > 8 ? ` + ${state.leftOut.length - 8} more` : ''}</div>
        <div class="toolbar-group">
          <button type="button" id="btnCopyLeftPlain" class="btn btn-secondary btn-xs">${plainGroups.length > 1 ? 'Export left-out list ▾' : 'Copy left-out list'}</button>
          ${hasMagic ? `<button type="button" id="btnCopyLeftArchidekt" class="btn btn-secondary btn-xs">${archGroups.length > 1 ? 'Export left-out for Archidekt ▾' : 'Copy left-out for Archidekt'}</button>` : ''}
          <button type="button" id="btnPutAllBack" class="btn btn-link btn-xs">Put all back</button>
        </div>`;
      $('btnCopyLeftPlain').addEventListener('click', () => handleExportEntries(leftOutEntries(), 'plain', 'left-out items'));
      $('btnCopyLeftArchidekt')?.addEventListener('click', () => handleExportEntries(leftOutEntries(), 'archidekt', 'left-out Magic cards'));
      $('btnPutAllBack').addEventListener('click', async () => {
        if (workInProgress()) return;
        state.manualCuts = [];
        state.activeLimits = [];
        await persistLimitsAndCuts();
        await computeBasketFromCollection();
      });
    } else {
      leftBar.hidden = true;
    }

    const body = $('cutsBody');
    if (cutsLoading) {
      body.innerHTML = `
        <div class="card-head"><h2>Cards worth buying elsewhere</h2><span class="badge badge-neutral">Analysing…</span></div>
        <div class="skeleton-row"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>
        <div class="skeleton-row"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>`;
      return;
    }
    if (!state.cuts.length) {
      body.innerHTML = `<div class="card-head" style="margin-bottom:0"><h2>Cards worth buying elsewhere</h2><span class="badge badge-combo">None — every card fits cleanly</span></div>`;
      return;
    }
    const best = state.cuts.at(-1);
    const totalExtra = state.cuts.reduce((s, c) => s + c.extraCents, 0);
    body.innerHTML = `
      <details open>
        <summary style="cursor:pointer;font-weight:700;font-size:14px;margin-bottom:6px">
          Cards worth buying elsewhere: leaving out ${state.cuts.length} saves ${euros(state.basket.totalCents - best.basketCents)} (${euros(totalExtra)} beyond market value)
        </summary>
        <p class="card-hint">These items force an extra seller or a dearer shipping tier. Tick any to exclude and recompute instantly from cache.</p>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th></th><th>Item</th><th class="num">Market</th><th class="num">Saves</th><th class="num">Beyond market</th><th class="num">Basket after</th></tr></thead>
            <tbody>
              ${state.cuts.map(c => `
                <tr>
                  <td><input type="checkbox" data-cut-key="${esc(c.key)}"></td>
                  <td>
                    <strong>${esc(c.name)}</strong>
                    ${c.game ? `<span class="badge ${c.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${c.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span>` : ''}
                  </td>
                  <td class="num">${euros(c.marketCents)}</td>
                  <td class="num" style="color:var(--emerald);font-weight:700">${euros(c.savedCents)}</td>
                  <td class="num">${euros(c.extraCents)}</td>
                  <td class="num">${euros(c.basketCents)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div style="margin-top:10px">
          <button type="button" id="btnLeaveOutTicked" class="btn btn-secondary btn-sm">Leave out ticked &amp; recompute</button>
        </div>
      </details>`;
    $('btnLeaveOutTicked').addEventListener('click', async () => {
      if (workInProgress()) return;
      const chosen = [...body.querySelectorAll('[data-cut-key]:checked')].map(b => b.dataset.cutKey);
      if (!chosen.length) return;
      state.manualCuts = [...new Set([...state.manualCuts, ...chosen])];
      await persistLimitsAndCuts();
      await computeBasketFromCollection();
    });
  }

  let lastBreakdown = null;

  function renderBreakdown() {
    const card = $('breakdownCard');
    const b = activeBasket();
    if (!b || !b.parcels?.length) {
      lastBreakdown = null;
      if (card) card.hidden = true;
      return;
    }
    const max = b.parcels.length;
    const n = Math.min(max, Math.max(1, Number($('buySellers').value) || max));
    const parcels = b.parcels.slice(0, n);
    const summary = summarizeBasketBySource(parcels, {
      tables: state.currentTables,
      trackedOnly: Object.keys(state.trackedSellers),
      missing: b.missing || [],
      leftOut: state.leftOut || [],
    });
    lastBreakdown = { summary, n, max };

    if (!summary.rows.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const scopeText = n < max ? `First ${n} of ${max} sellers` : `${max} seller${max === 1 ? '' : 's'}`;
    $('breakdownScopeBadge').textContent = scopeText;
    $('breakdownHint').textContent = summary.totals.hasSharedParcels
      ? 'Exact item totals per Wants List and product. Shared-seller shipping is split proportionally so all rows sum to the exact basket total.'
      : 'Exact item and shipping totals per Wants List and product.';

    const badgeFor = row => {
      if (row.kind === 'product') return '<span class="badge badge-product">Product</span>';
      if (row.kind === 'token') return '<span class="badge badge-token">Tokens</span>';
      return `<span class="badge ${row.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${row.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span>`;
    };

    const unitWord = row => (row.kind === 'product' ? (row.itemCount === 1 ? 'unit' : 'units')
      : row.kind === 'token' ? (row.itemCount === 1 ? 'token' : 'tokens')
        : (row.itemCount === 1 ? 'card' : 'cards'));

    const rowsHtml = summary.rows.map(row => {
      const notes = [];
      if (row.leftOutCount > 0) notes.push(`${row.leftOutCount} left out`);
      if (row.missingCount > 0) notes.push(`${row.missingCount} unavailable`);
      const shipNote = row.sharedSellerCount > 0
        ? `title="Includes proportional share from ${row.sharedSellerCount} combined seller parcel${row.sharedSellerCount === 1 ? '' : 's'}"`
        : '';
      return `
        <tr>
          <td>
            <div class="breakdown-source">
              ${badgeFor(row)}
              <strong>${esc(row.label)}</strong>
            </div>
            ${notes.length ? `<div class="breakdown-sub">${esc(notes.join(' · '))}</div>` : ''}
          </td>
          <td class="num">
            <strong>${row.itemCount}</strong> ${unitWord(row)}
            <div class="breakdown-sub">${row.sellerCount} seller${row.sellerCount === 1 ? '' : 's'}${row.sharedSellerCount ? ` (${row.sharedSellerCount} shared)` : ''}</div>
          </td>
          <td class="num">${euros(row.itemsCents)}</td>
          <td class="num" ${shipNote}>${row.unknownShipping ? '–' : euros(row.shippingCents)}${row.sharedSellerCount ? ' *' : ''}</td>
          <td class="num"><strong>${euros(row.totalCents)}</strong></td>
          <td class="num">
            <span class="share-cell">
              <span class="share-bar-wrap"><span class="share-bar" style="width:${row.sharePct}%"></span></span>
              <span style="min-width:30px;font-size:12px;color:var(--text-muted)">${row.sharePct}%</span>
            </span>
          </td>
        </tr>`;
    }).join('');

    const t = summary.totals;
    $('breakdownTableWrap').innerHTML = `
      <table class="data-table breakdown-table">
        <thead>
          <tr>
            <th>Wants List / Product</th>
            <th class="num">Items</th>
            <th class="num">Items Cost</th>
            <th class="num">${t.hasSharedParcels ? 'Est. Shipping' : 'Shipping'}</th>
            <th class="num">Total</th>
            <th class="num">Share</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr>
            <td>Total (${esc(scopeText)})</td>
            <td class="num">${t.itemCount} items</td>
            <td class="num">${euros(t.itemsCents)}</td>
            <td class="num">${euros(t.shippingCents)}</td>
            <td class="num">${euros(t.totalCents)}</td>
            <td class="num">100%</td>
          </tr>
        </tfoot>
      </table>`;
  }

  async function copyBreakdownSummary() {
    if (!lastBreakdown?.summary?.rows?.length) return;
    const { summary, n, max } = lastBreakdown;
    const scope = n < max ? `first ${n} of ${max} sellers` : `${max} sellers`;
    const lines = [
      `Cardmarket Better Wizard — Cost Breakdown (${scope})`,
      ...summary.rows.map(r =>
        `- ${r.label}: ${euros(r.totalCents)} (${euros(r.itemsCents)} items + ${euros(r.shippingCents)} shipping, ${r.itemCount} items)`
      ),
      `Total: ${euros(summary.totals.totalCents)} (${euros(summary.totals.itemsCents)} items + ${euros(summary.totals.shippingCents)} shipping)`,
    ];
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('Copied price breakdown summary.', 'success');
  }

  function updateBuySummary() {
    const b = activeBasket();
    if (!b) return;
    if (!b.parcels.length) {
      $('buySummary').textContent = '0 items · 0,00 € total';
      renderBreakdown();
      updateExportButtons();
      syncBusyUI();
      return;
    }
    const max = b.parcels.length;
    const n = Math.min(max, Math.max(1, Number($('buySellers').value) || max));
    const pt = b.curve[n - 1];
    $('buySummary').textContent = pt ? `${pt.cards} items · ${euros(pt.totalCents)} total` : '';
    renderBreakdown();
    updateExportButtons();
    syncBusyUI();
  }

  function updateSellerCollapseControls() {
    const cards = [...$('parcelsList').querySelectorAll('details.parcel-card')];
    const bar = $('sellersControls');
    if (!cards.length) {
      bar.hidden = true;
      return;
    }
    const openCount = cards.filter(c => c.open).length;
    bar.hidden = false;
    $('sellersExpandedInfo').textContent = `${openCount} of ${cards.length} seller${cards.length === 1 ? '' : 's'} expanded`;
    $('btnExpandAllSellers').disabled = openCount === cards.length;
    $('btnCollapseAllSellers').disabled = openCount === 0;
  }

  function setAllSellersExpanded(open) {
    $('parcelsList').querySelectorAll('details.parcel-card').forEach(card => {
      card.open = open;
    });
    updateSellerCollapseControls();
  }

  // ---- Manual Seller / Card Removal (in-place, no recompute) ----
  function removedRecordsToEntries(records) {
    return (records || []).map((rec, order) => ({
      name: rec.item.name,
      game: rec.item.game || 'Magic',
      kind: rec.item.kind || 'card',
      listId: rec.item.listId ?? null,
      listName: rec.item.listName ?? null,
      idProduct: rec.item.idProduct ?? null,
      foil: !!rec.item.foil,
      seller: rec.seller,
      order,
      quantity: 1,
    }));
  }

  async function copyRemovedRecords(records, format = 'plain', triggerBtn = null) {
    const list = records || [];
    if (!list.length) {
      toast('Nothing to copy.', 'error');
      return false;
    }
    const entries = removedRecordsToEntries(list);
    try {
      if (format === 'archidekt') {
        const archGroups = groupExportEntries(entries, 'archidekt');
        if (!archGroups.length) {
          toast('No Magic cards among removed items to copy for Archidekt.', 'error');
          return false;
        }
        const { text, count } = await buildExportText(entries, 'archidekt', {
          categoryBy: archGroups.length > 1 ? 'list' : 'none',
        });
        if (!count || !text) {
          toast('Nothing to copy.', 'error');
          return false;
        }
        await navigator.clipboard.writeText(text);
        const skipped = Math.max(0, list.length - count);
        toast(
          `Copied ${count} removed Magic card${count === 1 ? '' : 's'} for Archidekt${skipped ? ` (${skipped} non-Magic skipped)` : ''}.`,
          'success',
        );
      } else {
        const { text, count } = formatPlainExport(entries, { groupBy: 'auto' });
        if (!count || !text) {
          toast('Nothing to copy.', 'error');
          return false;
        }
        await navigator.clipboard.writeText(text);
        const label = count === 1 ? `"${list[0].item.name}"` : `${count} removed items`;
        toast(`Copied ${label} to clipboard.`, 'success');
      }
      if (triggerBtn) {
        const prev = triggerBtn.textContent;
        triggerBtn.textContent = 'Copied ✓';
        setTimeout(() => { if (triggerBtn.isConnected) triggerBtn.textContent = prev; }, 1600);
      }
      return true;
    } catch (error) {
      toast(`Copy failed: ${error.message}`, 'error');
      return false;
    }
  }

  function refreshAfterRemoval({ sellerDroppedAtIndex = -1 } = {}) {
    const b = activeBasket();
    if (b && sellerDroppedAtIndex >= 0) {
      const cur = Number($('buySellers').value) || 0;
      if (sellerDroppedAtIndex < cur && cur > 1) {
        $('buySellers').value = Math.max(1, cur - 1);
      }
    }
    renderKpis(false);
    renderParcelsAndTabs({ resetBuySellers: false, preserveOpenSellers: true });
  }

  function applyRestoreRemovals(keepPredicate, toastMessage) {
    if (state.optimising || state.fetching || state.fetchingTokens || state.carting) return;
    const before = activeBasket();
    const prevCount = before?.parcels?.length || 0;
    const wasAllSelected = prevCount === 0 || Number($('buySellers').value) >= prevCount;
    const next = state.removedItems.filter(keepPredicate);
    if (next.length === state.removedItems.length) return;
    state.removedItems = next;
    renderKpis(false);
    renderParcelsAndTabs({ resetBuySellers: wasAllSelected, preserveOpenSellers: true });
    if (toastMessage) toast(toastMessage, 'success');
  }

  function restoreRemovalBatch(batchId) {
    applyRestoreRemovals(r => r.batchId !== batchId, 'Restored removed item(s) to basket.');
  }

  function restoreRemovalById(id) {
    const target = state.removedItems.find(r => r.id === id);
    applyRestoreRemovals(r => r.id !== id, target ? `Restored "${target.item.name}" to ${target.seller}.` : null);
  }

  function restoreSellerRemovals(seller) {
    applyRestoreRemovals(r => r.seller !== seller, `Restored removed item(s) from ${seller}.`);
  }

  function undoLastRemoval() {
    if (!state.removedItems.length) return;
    const lastBatchId = state.removedItems[state.removedItems.length - 1].batchId;
    restoreRemovalBatch(lastBatchId);
  }

  function restoreAllRemovals() {
    applyRestoreRemovals(() => false, 'Restored all removed items.');
  }

  function removeParcelItem(parcelIndex, itemIndex) {
    if (state.optimising || state.fetching || state.fetchingTokens || state.carting) return;
    const before = activeBasket();
    const parcel = before?.parcels?.[parcelIndex];
    const item = parcel?.items?.[itemIndex];
    if (!parcel || !item) return;

    const batchId = state.removedNextBatchId++;
    const rec = {
      id: state.removedNextId++,
      batchId,
      seller: parcel.seller,
      sig: basketItemSignature(parcel.seller, item),
      item: { ...item },
    };
    state.removedItems.push(rec);
    const after = activeBasket();
    const delta = Number.isFinite(before.totalCents) && Number.isFinite(after?.totalCents)
      ? Math.max(0, before.totalCents - after.totalCents)
      : null;
    const sellerDropped = parcel.items.length === 1;
    refreshAfterRemoval({ sellerDroppedAtIndex: sellerDropped ? parcelIndex : -1 });

    const savedTxt = delta !== null && delta > 0 ? ` (-${euros(delta)})` : '';
    toast(
      `Removed "${item.name}" from ${parcel.seller}${savedTxt}.`,
      'default',
      [
        {
          label: 'Copy card',
          primary: true,
          keepOpen: true,
          onClick: btn => copyRemovedRecords([rec], 'plain', btn),
        },
        {
          label: 'Undo',
          onClick: () => restoreRemovalBatch(batchId),
        },
      ],
    );
  }

  function removeSellerParcel(parcelIndex) {
    if (state.optimising || state.fetching || state.fetchingTokens || state.carting) return;
    const before = activeBasket();
    const parcel = before?.parcels?.[parcelIndex];
    if (!parcel || !parcel.items.length) return;

    const batchId = state.removedNextBatchId++;
    const recs = parcel.items.map(item => ({
      id: state.removedNextId++,
      batchId,
      seller: parcel.seller,
      sig: basketItemSignature(parcel.seller, item),
      item: { ...item },
    }));
    state.removedItems.push(...recs);
    const after = activeBasket();
    const delta = Number.isFinite(before.totalCents) && Number.isFinite(after?.totalCents)
      ? Math.max(0, before.totalCents - after.totalCents)
      : null;
    refreshAfterRemoval({ sellerDroppedAtIndex: parcelIndex });

    const count = recs.length;
    const savedTxt = delta !== null && delta > 0 ? ` (-${euros(delta)})` : '';
    toast(
      `Removed ${count} item${count === 1 ? '' : 's'} from ${parcel.seller}${savedTxt}.`,
      'default',
      [
        {
          label: count === 1 ? 'Copy card' : `Copy ${count} items`,
          primary: true,
          keepOpen: true,
          onClick: btn => copyRemovedRecords(recs, 'plain', btn),
        },
        {
          label: 'Undo',
          onClick: () => restoreRemovalBatch(batchId),
        },
      ],
    );
  }

  function renderRemovedItemsBox() {
    const box = $('removedItemsBox');
    if (!box) return;
    if (!state.removedItems.length) {
      box.innerHTML = '';
      return;
    }

    const b = activeBasket();
    const totalCount = state.removedItems.length;
    const savedCents = b?.savedByRemovalsCents ?? 0;
    const entries = removedRecordsToEntries(state.removedItems);
    const hasMagic = groupExportEntries(entries, 'archidekt').length > 0;

    const bySeller = new Map();
    for (const rec of state.removedItems) {
      if (!bySeller.has(rec.seller)) bySeller.set(rec.seller, []);
      bySeller.get(rec.seller).push(rec);
    }
    const sellerGroups = [...bySeller.entries()];
    const previewNames = state.removedItems.slice(0, 5).map(r => r.item.name);
    const previewExtra = totalCount > 5 ? ` +${totalCount - 5} more` : '';

    const badgeFor = item => {
      if (item.kind === 'product') return '<span class="badge badge-product">Product</span>';
      if (item.kind === 'token') return '<span class="badge badge-token">Token</span>';
      return `<span class="badge ${item.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${item.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span>`;
    };

    box.innerHTML = `
      <div class="removed-box">
        <div class="removed-head">
          <div class="removed-title">
            <strong>Removed from basket (${totalCount} item${totalCount === 1 ? '' : 's'})</strong>
            ${savedCents > 0 ? `<span class="badge badge-combo">-${euros(savedCents)}</span>` : ''}
            <span style="font-size:12px;color:#92400e">No recompute — remaining sellers unchanged</span>
          </div>
          <div class="removed-actions">
            <button type="button" id="btnCopyRemovedPlain" class="btn btn-primary btn-xs">Copy removed</button>
            ${hasMagic ? '<button type="button" id="btnCopyRemovedArchidekt" class="btn btn-secondary btn-xs">Copy for Archidekt</button>' : ''}
            <button type="button" id="btnUndoRemoval" class="btn btn-secondary btn-xs">Undo</button>
            <button type="button" id="btnRestoreAllRemoved" class="btn btn-link btn-xs">Restore all</button>
          </div>
        </div>
        <details class="removed-details" id="removedItemsDetails" ${state.removedListOpen ? 'open' : ''}>
          <summary>${esc(previewNames.join(', '))}${esc(previewExtra)} — show individual copy / restore</summary>
          <div class="removed-groups">
            ${sellerGroups.map(([seller, recs], gIdx) => `
              <div class="removed-seller-group">
                <div class="removed-seller-head">
                  <div>
                    <span class="removed-seller-name">${esc(seller)}</span>
                    <span class="badge badge-neutral" style="margin-left:6px">${recs.length} item${recs.length === 1 ? '' : 's'}</span>
                  </div>
                  <div class="removed-item-actions">
                    <button type="button" class="btn btn-secondary btn-xs" data-copy-removed-seller="${gIdx}">Copy</button>
                    <button type="button" class="btn btn-link btn-xs" data-restore-removed-seller="${gIdx}">Restore</button>
                  </div>
                </div>
                <div class="removed-seller-items">
                  ${recs.map(rec => `
                    <div class="removed-item-row">
                      <div class="removed-item-info">
                        ${badgeFor(rec.item)}
                        <strong>${esc(rec.item.name)}</strong>
                        ${rec.item.foil ? '<span class="badge badge-indigo">Foil</span>' : ''}
                        ${rec.item.listName ? `<span style="font-size:11.5px;color:var(--text-muted)">${esc(rec.item.listName)}</span>` : ''}
                      </div>
                      <div class="removed-item-actions">
                        <span class="removed-item-price">${euros(rec.item.priceCents)}</span>
                        <button type="button" class="btn btn-ghost btn-xs" data-copy-removed-id="${rec.id}">Copy</button>
                        <button type="button" class="btn btn-link btn-xs" data-restore-removed-id="${rec.id}">Restore</button>
                      </div>
                    </div>`).join('')}
                </div>
              </div>`).join('')}
          </div>
        </details>
      </div>`;

    $('removedItemsDetails')?.addEventListener('toggle', e => {
      state.removedListOpen = e.currentTarget.open;
    });
    $('btnCopyRemovedPlain')?.addEventListener('click', e => copyRemovedRecords(state.removedItems, 'plain', e.currentTarget));
    $('btnCopyRemovedArchidekt')?.addEventListener('click', e => copyRemovedRecords(state.removedItems, 'archidekt', e.currentTarget));
    $('btnUndoRemoval')?.addEventListener('click', undoLastRemoval);
    $('btnRestoreAllRemoved')?.addEventListener('click', restoreAllRemovals);

    box.querySelectorAll('[data-copy-removed-seller]').forEach(btn => {
      const [, recs] = sellerGroups[Number(btn.dataset.copyRemovedSeller)] || [];
      btn.addEventListener('click', () => copyRemovedRecords(recs, 'plain', btn));
    });
    box.querySelectorAll('[data-restore-removed-seller]').forEach(btn => {
      const [seller] = sellerGroups[Number(btn.dataset.restoreRemovedSeller)] || [];
      btn.addEventListener('click', () => restoreSellerRemovals(seller));
    });
    box.querySelectorAll('[data-copy-removed-id]').forEach(btn => {
      const id = Number(btn.dataset.copyRemovedId);
      const rec = state.removedItems.find(r => r.id === id);
      btn.addEventListener('click', () => rec && copyRemovedRecords([rec], 'plain', btn));
    });
    box.querySelectorAll('[data-restore-removed-id]').forEach(btn => {
      const id = Number(btn.dataset.restoreRemovedId);
      btn.addEventListener('click', () => restoreRemovalById(id));
    });
  }

  function renderParcelsAndTabs({ resetBuySellers = true, preserveOpenSellers = false } = {}) {
    const b = activeBasket();
    if (!b) return;
    const openSellers = preserveOpenSellers
      ? new Set(
          [...$('parcelsList').querySelectorAll('details.parcel-card[open]')]
            .map(el => el.dataset.seller)
            .filter(Boolean)
        )
      : null;

    const maxSellers = Math.max(1, b.parcels.length);
    $('buySellers').min = b.parcels.length ? 1 : 0;
    $('buySellers').max = b.parcels.length ? maxSellers : 0;
    if (!b.parcels.length) {
      $('buySellers').value = 0;
    } else if (resetBuySellers || !Number($('buySellers').value)) {
      $('buySellers').value = b.parcels.length;
    } else {
      $('buySellers').value = Math.min(maxSellers, Math.max(1, Number($('buySellers').value)));
    }
    updateBuySummary();
    renderRemovedItemsBox();

    // Missing items
    const reasons = {
      'not collected': 'Not collected yet (run stopped early)',
      'not fully collected': 'Not fully collected (a page failed)',
      'no offer': 'No offers matched your filters',
    };
    $('missingBox').innerHTML = Object.entries(reasons).map(([r, label]) => {
      const items = b.missing.filter(m => m.reason === r);
      return items.length
        ? `<div class="alert-banner alert-warn" style="margin-bottom:12px"><div><strong>${label} (${items.length}):</strong> ${items.map(i => esc(i.name)).join(', ')}</div></div>`
        : '';
    }).join('');

    // Seller parcels
    if (!b.parcels.length) {
      $('parcelsList').innerHTML = '<div class="alert-banner alert-info"><div>All sellers were removed from this basket. Copy your removed cards or click <strong>Restore all</strong> above to bring them back.</div></div>';
    } else {
      $('parcelsList').innerHTML = b.parcels.map((p, idx) => {
        const badges = [];
        if (p.location) badges.push(`<span class="badge badge-neutral">${esc(p.location)}</span>`);
        const games = p.games || [];
        if (games.length > 1) badges.push('<span class="badge badge-combo">MTG + YGO combined</span>');
        else if (games[0]) badges.push(`<span class="badge ${games[0] === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${games[0] === 'YuGiOh' ? 'YGO' : 'MTG'}</span>`);
        if (p.hasProducts) badges.push('<span class="badge badge-product">+ Product</span>');
        if (p.hasTokens) badges.push(`<span class="badge badge-token">+${p.tokenCount} token${p.tokenCount === 1 ? '' : 's'}</span>`);
        const isOpen = openSellers ? openSellers.has(p.seller) : idx < 3;

        return `
          <details class="parcel-card" data-seller="${esc(p.seller)}" ${isOpen ? 'open' : ''}>
            <summary class="parcel-summary">
              <div class="parcel-left">
                <span class="parcel-chevron" aria-hidden="true">▸</span>
                <span class="parcel-rank">#${idx + 1}</span>
                <span class="parcel-seller">${esc(p.seller)}</span>
                ${badges.join('')}
                <span class="badge badge-neutral">${p.items.length} item${p.items.length === 1 ? '' : 's'}</span>
              </div>
              <div class="parcel-right">
                <span class="parcel-cost">${euros(p.itemsCents)}</span>
                <span class="parcel-ship">+ ${euros(p.shippingCents)} ${esc(p.method || '')}</span>
                <strong>${euros(p.itemsCents + p.shippingCents)}</strong>
                <button type="button" class="btn btn-ghost btn-xs parcel-remove-btn" data-remove-parcel="${idx}" title="Remove all ${p.items.length} item${p.items.length === 1 ? '' : 's'} from ${esc(p.seller)} (no recompute)">Remove seller</button>
              </div>
            </summary>
            <div class="parcel-items-wrap">
              <table class="data-table">
                <thead><tr><th>Item</th><th>Source</th><th class="num">Price</th><th class="num">Market</th><th class="col-action"></th></tr></thead>
                <tbody>
                  ${p.items.map((item, itemIdx) => `
                    <tr>
                      <td>
                        <strong>${esc(item.name)}</strong>
                        ${item.foil ? '<span class="badge badge-indigo">Foil</span>' : ''}
                        ${item.aboveMarket ? '<span class="badge badge-warn">above market</span>' : ''}
                        ${item.kind === 'token' && item.tokenCovers?.length ? `<span class="token-covers-sub">Covers: ${esc(item.tokenCovers.join(' + '))}</span>` : ''}
                      </td>
                      <td>
                        ${item.kind === 'product'
                          ? '<span class="badge badge-product">Product</span>'
                          : item.kind === 'token'
                            ? `<span class="badge badge-token">Token</span>${item.tokenCombo ? ' <span class="badge badge-token-combo">2-in-1</span>' : ''}`
                            : `<span class="badge ${item.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${item.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span>`}
                        ${item.listName ? `<span style="font-size:12px;color:var(--text-muted)">${esc(item.listName)}</span>` : ''}
                      </td>
                      <td class="num"><strong>${euros(item.priceCents)}</strong></td>
                      <td class="num" style="color:var(--text-muted)">${euros(item.targetCents)}</td>
                      <td class="col-action">
                        <button type="button" class="btn-icon-remove" data-remove-item-parcel="${idx}" data-remove-item-idx="${itemIdx}" title="Remove ${esc(item.name)} from ${esc(p.seller)} (no recompute)" aria-label="Remove ${esc(item.name)}">&times;</button>
                      </td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </details>`;
      }).join('');
    }
    $('parcelsList').querySelectorAll('details.parcel-card').forEach(card => {
      card.addEventListener('toggle', updateSellerCollapseControls);
    });
    $('parcelsList').querySelectorAll('[data-remove-parcel]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        removeSellerParcel(Number(btn.dataset.removeParcel));
      });
    });
    $('parcelsList').querySelectorAll('[data-remove-item-parcel]').forEach(btn => {
      btn.addEventListener('click', () => {
        removeParcelItem(Number(btn.dataset.removeItemParcel), Number(btn.dataset.removeItemIdx));
      });
    });
    updateSellerCollapseControls();

    // Coverage curve
    const totalCards = b.curve.at(-1)?.cards || 1;
    $('curveBody').innerHTML = b.curve.map((pt, idx) => {
      const pct = Math.round((pt.cards / totalCards) * 100);
      return `
        <tr class="clickable" data-pick-n="${pt.sellers}">
          <td><strong>${pt.sellers}</strong></td>
          <td>${pt.cards}</td>
          <td><span class="cov-bar-wrap"><span class="cov-bar" style="width:${pct}%"></span></span> <span style="font-size:12px;color:var(--text-muted)">${pct}%</span></td>
          <td class="num"><strong>${euros(pt.totalCents)}</strong></td>
          <td class="num">${euros(Math.round(pt.totalCents / pt.cards))}</td>
          <td>${esc(b.parcels[idx].seller)} ${b.parcels[idx].location ? `<span class="badge badge-neutral">${esc(b.parcels[idx].location)}</span>` : ''}</td>
          <td class="num"><button type="button" class="btn btn-subtle btn-xs">Select ${pt.sellers}</button></td>
        </tr>`;
    }).join('');
    $('curveBody').querySelectorAll('[data-pick-n]').forEach(row => {
      row.addEventListener('click', () => {
        $('buySellers').value = row.dataset.pickN;
        if (state.tokenResult && Object.keys(state.sellerTokenOffers).length) {
          reoptimiseTokensFromMemory({ resetBuySellers: false, silent: true });
        } else {
          updateBuySummary();
        }
        switchTab('sellers');
        toast(`Selected first ${row.dataset.pickN} sellers for cart.`);
      });
    });

    // Overlap tab
    $('overlapBody').innerHTML = (state.overlap || []).map(row => `
      <tr>
        <td><strong>${esc(row.seller)}</strong></td>
        <td>${esc(row.location || '–')}</td>
        <td>${(row.games || []).map(g => `<span class="badge ${g === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${g === 'YuGiOh' ? 'YGO' : 'MTG'}</span>`).join(' ') || '–'}</td>
        <td class="num"><strong>${row.cards}</strong></td>
        <td class="num">${row.atTarget}</td>
        <td class="num">${euros(row.cheapestCents)}</td>
      </tr>`).join('');

    // Fetch coverage tab
    renderCoverageTab();
  }

  const warningBanner = (title, items) => (Array.isArray(items) && items.length
    ? `<div class="alert-banner alert-warn" style="margin-bottom:12px"><div><strong>${esc(title)}</strong> ${items.map(esc).join('; ')}</div></div>`
    : '');

  function renderCoverageTab() {
    const col = state.collection;
    if (!col) return;
    $('btnDownload').hidden = false;
    const mins = ((col.stats.finishedAt - col.stats.startedAt) / 60000).toFixed(1);
    const counts = {};
    for (const r of col.results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    $('coverageMeta').innerHTML = `<p class="card-hint">
      Fetched <strong>${esc(new Date(col.stats.finishedAt).toLocaleString())}</strong> (${fmtAge(col.stats.finishedAt)}):
      ${Number(col.stats.requests) || 0} requests (${Number(col.stats.cachedQueries) || 0} cached) in ${mins} min ·
      ${Object.entries(counts).map(([k, v]) => `${v} ${esc(k)}`).join(', ')}.
      ${col.blocked ? `<strong style="color:var(--rose)">Stopped early: ${esc(col.blocked)}</strong>` : ''}
    </p>${warningBanner('Warnings:', col.warnings)}`;
    $('coverageTables').innerHTML = `
      <table class="data-table">
        <thead><tr><th>Item</th><th>Source</th><th>Status</th><th class="num">Target</th><th class="num">Offers</th></tr></thead>
        <tbody>
          ${col.results.map(r => `
            <tr>
              <td><strong>${esc(r.name)}</strong></td>
              <td>${r.kind === 'product' ? '<span class="badge badge-product">Product</span>' : `<span class="badge ${r.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${r.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span> ${esc(r.listName || '')}`}</td>
              <td>${esc(r.verdict)}${r.error ? `: ${esc(r.error)}` : ''}</td>
              <td class="num">${euros(r.targetCents)}</td>
              <td class="num">${r.offers.length}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ---- Core Action: Compute Basket from Collection (via Web Worker) ----
  async function computeBasketFromCollection({ reuseTrace = false } = {}) {
    const col = state.collection;
    if (!col) return;
    const myJob = ++state.optimiseJobId;
    const trace = beginActionTrace('compute-basket', {
      items: col.results?.length || 0,
      shipTo: state.shipTo,
      limits: state.activeLimits.length,
      manualCuts: state.manualCuts.length,
    }, { reuseActive: reuseTrace });
    let traceOk = true;
    let traceError = null;
    state.removedItems = [];
    state.removedListOpen = false;
    state.restoredSnapshot = null;
    state.tokenResult = null;
    renderTokenResults();
    state.optimising = true;
    syncBusyUI();
    $('emptyState').hidden = true;
    $('resultsArea').hidden = false;

    const notices = [];
    const collected = col.results.filter(r => !['blocked', 'incomplete'].includes(r.verdict)).length;
    if (collected < col.results.length) {
      notices.push(`<div class="alert-banner alert-warn">
        <div><strong>Incomplete fetch:</strong> only ${collected} of ${col.results.length} items were collected. Click <em>Refetch offers</em> to complete the rest.</div>
      </div>`);
    }
    notices.push(warningBanner('Warnings:', col.warnings));
    $('topNotice').innerHTML = notices.join('');

    try {
      showProgress('Loading shipping tables…', '', 12, 'Fetching per-country Cardmarket postal rates');
      const { failed: shippingFailed, ...tables } = await loadShippingTablesFor(col);
      if (myJob !== state.optimiseJobId) return;
      state.currentTables = tables;
      if (shippingFailed.length) {
        notices.push(warningBanner('Shipping rates could not be loaded for:', [`${shippingFailed.join(', ')}. Sellers from there may be missing or mispriced; recompute to retry.`]));
        $('topNotice').innerHTML = notices.join('');
      }

      const sig = col.selectionSig || selectionSignature();
      const route = `${state.shipTo}:${state.activeLimits.map(r => `${scopeKey(r)}=${r.cents}`).sort().join(',')}:${[...state.manualCuts].sort().join(',')}`;
      const bestKey = `bwBest:${sig}:${route}`;
      const { [bestKey]: previous } = await trace.span('storage.read-best', () => chrome.storage.local.get(bestKey));
      if (myJob !== state.optimiseJobId) return;

      showProgress('Optimising basket across sellers…', 'Running multi-strategy search in background worker', 25);

      const result = await trace.span('worker.optimise', async setMeta => {
        const res = await runWorker({
          type: 'optimise',
          collection: col,
          tables: state.currentTables,
          trackedOnly: Object.keys(state.trackedSellers),
          activeLimits: state.activeLimits,
          manualCuts: state.manualCuts,
          timeMs: 14000,
          previousPicks: previous?.picks || null,
        }, ev => {
          if (myJob !== state.optimiseJobId) return;
          if (ev.event === 'quick') {
            state.basket = ev.basket;
            state.overlap = ev.overlap || [];
            state.leftOut = ev.leftOut || [];
            state.countsByScope = ev.countsByScope || {};
            renderActiveLimits();
            renderScopePills();
            renderKpis(true);
            renderCutsAndLeftOut(true);
            renderParcelsAndTabs();
            showProgress('Searching for cheaper seller combinations…', `Quick basket ${euros(ev.basket.totalCents)}`, 38);
          } else if (ev.event === 'progress') {
            const pct = 38 + Math.round((ev.done / ev.of) * 58);
            showProgress(
              'Searching for cheaper seller combinations…',
              `Strategy ${ev.done} of ${ev.of} · best ${euros(ev.cents)}`,
              pct,
            );
          }
        });
        if (res?.timing) setMeta(res.timing);
        return res;
      });

      if (myJob !== state.optimiseJobId || result.cancelled) return;
      state.basket = result.basket;
      state.cuts = result.cuts || [];
      record({
        type: 'worker-optimise',
        ...(result.timing || {}),
        keptPrevious: Boolean(result.keptPrevious),
        quickCents: result.quickCents ?? null,
        finalCents: state.basket?.totalCents ?? null,
        parcels: state.basket?.parcels?.length ?? 0,
      });
      state.optimising = false;
      syncBusyUI();

      if (Number.isFinite(state.basket.totalCents)) {
        await trace.span('storage.write-best', () => chrome.storage.local.set({
          [bestKey]: { totalCents: state.basket.totalCents, picks: state.basket.picks },
        }));
        if (myJob !== state.optimiseJobId) return;
      }

      const savedVsQuick = result.quickCents - state.basket.totalCents;
      const note = result.keptPrevious
        ? 'Kept better verified basket'
        : savedVsQuick > 0
          ? `Search saved ${euros(savedVsQuick)} vs quick basket`
          : 'Optimal basket found';

      await trace.span('ui.render-basket', async () => {
        if (Object.keys(state.sellerTokenOffers).length && state.tokenCatalog && state.tokenMatchPlan) {
          reoptimiseTokensFromMemory({ useAllParcels: true, renderBasket: false, silent: true });
        } else {
          state.tokenResult = null;
          renderTokenResults();
        }
        renderKpis(false, note);
        renderCutsAndLeftOut(false);
        renderParcelsAndTabs({ resetBuySellers: true });
        renderActiveLimits();
      });
      if (state.limitsOpen) estimateLimitsForCurrentScope();
      hideProgress();
      await trace.span('storage.save-run-summary', () => saveRunSummary(col));
    } catch (error) {
      traceOk = false;
      traceError = error.message;
      if (myJob !== state.optimiseJobId) return;
      hideProgress();
      toast(`Optimisation failed: ${error.message}`, 'error');
    } finally {
      if (myJob === state.optimiseJobId) {
        state.optimising = false;
        syncBusyUI();
      }
      await trace.finish({
        ok: traceOk,
        extra: traceError ? { error: traceError } : { totalCents: state.basket?.totalCents ?? null, parcels: state.basket?.parcels?.length ?? 0 },
        collection: col,
      });
    }
  }

  // ---- Core Action: Fetch Offers from Cardmarket ----
  async function fetchAndCompute({ forceFresh = false } = {}) {
    const selectedLists = getSelectedListObjects();
    const enabledProducts = getEnabledProducts();
    if (!selectedLists.length && !enabledProducts.length) {
      toast('Select at least one Wants List or Extra Product first.', 'error');
      return;
    }

    if (state.fetching || state.fetchingTokens || state.carting) return;
    state.fetching = true;
    const controller = new AbortController();
    state.controller = controller;
    syncBusyUI();
    const release = () => {
      if (state.controller === controller) state.controller = null;
      state.fetching = false;
      syncBusyUI();
    };
    state.runLog = [];
    const sellerCountries = getSellerCountries();
    const sig = selectionSignature();
    const trace = beginActionTrace('fetch-and-compute', {
      forceFresh,
      method: state.method,
      regionMode: state.regionMode,
      shipTo: state.shipTo,
      intervalMs: state.interval,
      lists: selectedLists.length,
      products: enabledProducts.length,
      sellerCountriesCount: sellerCountries.length,
    });
    let fetchOk = true;
    let fetchError = null;
    let fetchedCol = null;
    record({ type: 'start', forceFresh, lists: selectedLists, products: enabledProducts.length, sellerCountries, shipTo: state.shipTo });

    try {
      const { collectionRetryAfter: holdUntil } = await chrome.storage.local.get('collectionRetryAfter');
      if (Date.now() < holdUntil) {
        throw new Error(`Cardmarket asked to wait until ${new Date(holdUntil).toLocaleTimeString()}.`);
      }

      let waitingText = '';
      let waitUntil = 0;
      const onDeferred = ({ until }) => chrome.storage.local.set({ collectionRetryAfter: until });
      const onWait = ({ until, retry }) => {
        waitUntil = until;
        waitingText = `Cardmarket asked to slow down — retry ${retry}/5 at ${new Date(until).toLocaleTimeString()}`;
        showProgress('Waiting for Cardmarket rate limit…', waitingText, null);
      };

      // 1. Read every selected Wants List & plan printings per game (paced through createRunner).
      const combinedEntries = [];
      let priceGuideCreatedAt = null;
      const warnings = [];
      const wantsRunner = createRunner(site, {
        concurrency: 1,
        intervalMs: state.interval,
        bucketIntervals: { cart: 2000, products: 3000 },
        signal: controller.signal,
        waitForUser,
        log: record,
        readRetryDelays: [5000, 10000, 20000, 40000, 80000],
        onDeferred,
        onWait,
      });
      try {
        await trace.span('wants.read-and-plan', { lists: selectedLists.length }, async () => {
          for (const [idx, list] of selectedLists.entries()) {
            showProgress(`Reading Wants List ${idx + 1}/${selectedLists.length}…`, list.name, 6 + Math.round((idx / Math.max(1, selectedLists.length)) * 8));
            const fetched = await trace.span('wants.fetch', { game: list.game, listId: list.listId }, () =>
              wantsRunner.call('wantsList', list.game, list.listId)
            );
            list.name = fetched.name || list.name;
            list.count = fetched.wants.length;
            const { plan, error } = await trace.span('catalog.plan', { game: list.game, wants: fetched.wants.length }, async setMeta => {
              const res = await chrome.runtime.sendMessage({ type: 'plan', game: list.game, wants: fetched.wants });
              if (res?.timing) setMeta(res.timing);
              return res;
            });
            if (error) throw new Error(error);
          priceGuideCreatedAt ||= plan.priceGuideCreatedAt;
          warnings.push(...(plan.warnings || []));
          for (const entry of plan.entries) {
            combinedEntries.push({
              ...entry,
              key: `${list.game}:${list.listId}:${entry.key}`,
              game: list.game,
              listId: list.listId,
              listName: list.name,
              kind: 'card',
            });
          }
          }
        });
      } finally {
        wantsRunner.finish();
      }
      await saveKnownLists();
      renderLists();

      // 2. Append enabled extra products (sleeves, deck boxes, etc.).
      for (const prod of enabledProducts) {
        combinedEntries.push({
          key: `product:${prod.productPath}`,
          kind: 'product',
          game: prod.game || 'Magic',
          category: prod.category || 'Product',
          name: prod.name,
          amount: prod.amount || 1,
          productPath: prod.productPath,
          url: prod.url,
          languages: [],
          minCondition: 7,
          printings: [],
          listId: null,
          listName: null,
        });
      }

      // 3. Preload shipping tables for evaluation during seller batching.
      let evalTables = await trace.span('shipping-tables.preload', () => loadShippingTablesFor({ results: [] }));
      const triedLocations = new Set(Object.keys(evalTables.byLocation));
      const trackedOnly = Object.keys(state.trackedSellers);
      const cache = await trace.span('cache.load-offer-cache', { forceFresh }, async setMeta => {
        const c = await offerCache(forceFresh);
        setMeta({ entries: c.size });
        return c;
      });

      const common = {
        sellerCountries,
        concurrency: 4,
        intervalMs: state.interval,
        bucketIntervals: { cart: 2000, products: 3000 },
        signal: controller.signal,
        cache,
        cacheMaxAgeMs: forceFresh ? 0 : CACHE_MAX_AGE_MS,
        waitForUser,
        log: record,
        readRetryDelays: [5000, 10000, 20000, 40000, 80000],
        onDeferred,
        onWait,
        onProgress: ({ phase, done, total, requests, retries, intervalMs }) => {
          if (Date.now() > waitUntil) waitingText = '';
          const pct = phase === 'sellers'
            ? 60 + Math.round((done / Math.max(1, total)) * 35)
            : 15 + Math.round((done / Math.max(1, total)) * 45);
          const title = phase === 'sellers'
            ? `Reading top sellers' overlap (${done}/${total})`
            : `Reading item pages (${done}/${total})`;
          const adapted = intervalMs && intervalMs > state.interval
            ? ` · auto-paced ${(intervalMs / 1000).toFixed(1)}s/req`
            : '';
          showProgress(title, `${requests} requests${retries ? ` · ${retries} retries` : ''}${adapted}`, pct, waitingText);
        },
      };

      const planObj = { entries: combinedEntries };
      const domesticCountry = state.shipTo;
      const domesticLocation = COUNTRY_NAME_BY_ID[state.shipTo] || 'Germany';
      const loadShippingTables = async locations => {
        const unseen = (locations || []).filter(loc => loc && COUNTRY_ID_BY_NAME[loc] && !triedLocations.has(loc));
        if (unseen.length) {
          try {
            const synthetic = { results: [{ offers: [...triedLocations, ...unseen].map(location => ({ location })) }] };
            evalTables = await loadShippingTablesFor(synthetic);
            for (const location of unseen) triedLocations.add(location);
          } catch (error) {
            record({ type: 'error', message: error.message });
          }
        }
        return evalTables;
      };

      const evaluate = async results => {
        // Sellers found since the last batch may ship from countries we have no table for yet.
        const unseen = new Set();
        for (const r of results) {
          for (const o of r.offers || []) {
            if (o.location && COUNTRY_ID_BY_NAME[o.location] && !triedLocations.has(o.location)) unseen.add(o.location);
          }
        }
        let tablesForBatch = evalTables;
        if (unseen.size) {
          try {
            evalTables = await loadShippingTablesFor({ results });
            tablesForBatch = evalTables;
            for (const location of unseen) triedLocations.add(location);
          } catch (error) {
            record({ type: 'error', message: error.message });
            // Price this batch's unseen locations as unavailable rather than domestic; later batches retry.
            tablesForBatch = { ...evalTables, byLocation: { ...evalTables.byLocation } };
            for (const location of unseen) tablesForBatch.byLocation[location] = [];
          }
        }
        const res = await runWorker({ type: 'quick-cost', results, tables: tablesForBatch, trackedOnly });
        record({ type: 'worker-quick-cost', totalCents: res.totalCents, ...(res.timing || {}) });
        return res.totalCents;
      };

      const result = await trace.span(`collect.${state.method}`, { items: combinedEntries.length }, () => (
        state.method === 'printings'
          ? collect(planObj, site, common)
          : collectBySellers(planObj, site, {
              ...common,
              lists: selectedLists,
              domesticCountry,
              domesticLocation,
              loadShippingTables,
              evaluate,
              ...(state.method === 'thorough' ? THOROUGH : {}),
            })
      ));

      result.profile = state.method;
      const col = Object.assign(result, {
        selectionSig: sig,
        lists: selectedLists.map(l => ({ game: l.game, listId: l.listId, name: l.name })),
        products: enabledProducts.map(p => ({ name: p.name, productPath: p.productPath, amount: p.amount || 1, category: p.category, game: p.game })),
        priceGuideCreatedAt,
        warnings,
      });
      fetchedCol = col;

      state.collection = col;
      await trace.span('storage.write-collection', () => chrome.storage.local.set({ [collectionKeyFor(sig)]: col }));
      await loadLimitsAndCutsFor(sig);
      await updateCachePill();
      release();
      await computeBasketFromCollection({ reuseTrace: true });
    } catch (error) {
      fetchOk = false;
      fetchError = error.message;
      hideProgress();
      release();
      record({ type: 'error', message: error.message });
      toast(`Fetch failed: ${error.message}`, 'error');
    } finally {
      await trace.finish({
        ok: fetchOk,
        extra: fetchError ? { error: fetchError } : { items: fetchedCol?.results?.length ?? 0 },
        collection: fetchedCol,
      });
    }
  }

  // ---- Primary Button: Compute Basket (enforces 8-hour cache rule!) ----
  async function handleComputeClick() {
    if (workInProgress()) return;
    const info = await inspectSelectionCache();
    if (info.status === 'empty') {
      toast('Select at least one Wants List or Extra Product first.', 'error');
      return;
    }
    if (info.status === 'fresh') {
      state.collection = info.collection;
      await loadLimitsAndCutsFor(info.sig);
      await computeBasketFromCollection();
      return;
    }

    // Cache is missing, legacy, incomplete, or >8 hours old -> show clear confirmation modal!
    const reasonText = info.status === 'legacy'
      ? `Your cached offers from ${fmtAge(info.collection.stats.finishedAt)} were fetched before the EU shipping-aware update${info.ageMs >= CACHE_MAX_AGE_MS ? ' (and are older than 8 hours)' : ''}. Refetching updates EU & domestic results, or you can compute from the old cache.`
      : info.status === 'stale'
        ? `Your cached offers for this selection are ${fmtAge(info.collection.stats.finishedAt)} (older than 8 hours). Computing will refetch all selected cards and products from Cardmarket so prices and stock are up to date.`
        : info.status === 'incomplete'
          ? `Your cached fetch for this selection stopped early (${fmtAge(info.collection.stats.finishedAt)}). Computing will refetch the remaining cards and products from Cardmarket.`
          : 'No offer cache exists yet for the selected lists, products, and seller region. Computing will fetch all selected cards and products from Cardmarket first.';

    const modalTitle = info.status === 'legacy'
      ? 'Offer cache uses the older EU format'
      : info.status === 'stale'
        ? 'Offer cache is older than 8 hours'
        : 'Offer cache needs to be fetched';

    const choice = await askCacheModal({
      title: modalTitle,
      body: reasonText,
      allowOld: Boolean(info.collection),
    });

    if (choice === 'cancel') return;
    if (choice === 'old' && info.collection) {
      state.collection = info.collection;
      await loadLimitsAndCutsFor(info.legacySig || info.sig);
      await updateCachePill();
      await computeBasketFromCollection();
      return;
    }
    await fetchAndCompute({ forceFresh: info.status === 'stale' || (info.status === 'legacy' && info.ageMs >= CACHE_MAX_AGE_MS) });
  }

  // ---- Add Wants List by URL (resolves real list title & count from Cardmarket) ----
  async function addManualList() {
    const input = $('manualListUrl');
    const btn = $('btnAddManualList');
    const raw = input.value.trim();
    const match = /\/(Magic|YuGiOh)\/Wants\/(\d+)/i.exec(raw);
    if (!match) {
      toast('Paste a valid Cardmarket Wants List URL.', 'error');
      return;
    }
    const game = match[1].toLowerCase() === 'yugioh' ? 'YuGiOh' : 'Magic';
    const listId = match[2];
    const fallback = fallbackListName(game, listId);

    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      let info = null;
      try {
        info = await site.wantsListInfo(game, listId);
      } catch {
        // Offline or not signed in yet — still add the list and refresh its name on fetch.
      }
      const resolved = info?.name && !isPlaceholderListName(info.name) ? info.name : null;
      await applyContextParams({
        game,
        listId,
        listName: resolved || fallback,
        count: info?.count ?? null,
      });
      input.value = '';
      toast(resolved ? `Added "${resolved}".` : `Added ${fallback} (name will refresh on fetch).`, 'success');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add';
    }
  }

  // ---- Add Extra Product by URL ----
  async function addProductFromUrl(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      toast('Paste a valid Cardmarket product URL.', 'error');
      return;
    }
    const match = /^\/[^/]+\/(Magic|YuGiOh)\/Products\/([^/]+)\/(.+)$/i.exec(parsed.pathname);
    if (!match || match[2].toLowerCase() === 'singles') {
      toast('Use a non-single Cardmarket product URL (e.g. Sleeves, Deck-Boxes, Boosters).', 'error');
      return;
    }
    const game = match[1].toLowerCase() === 'yugioh' ? 'YuGiOh' : 'Magic';
    const category = decodeURIComponent(match[2]).replace(/-/g, ' ');
    const fallbackName = decodeURIComponent(match[3]).replace(/-/g, ' ');
    const normaliseProdPath = path => String(path || '').replace(/^\/[^/]+\//, '/en/');
    const productPath = normaliseProdPath(parsed.pathname);
    const existing = state.extraProducts.find(p => normaliseProdPath(p.productPath) === productPath);
    if (existing) {
      existing.amount = (existing.amount || 1) + 1;
      existing.enabled = true;
      existing.productPath = productPath;
      existing.url = `https://www.cardmarket.com${productPath}`;
    } else {
      state.extraProducts.push({
        id: `prod:${productPath}`,
        name: fallbackName,
        game,
        category,
        productPath,
        url: `https://www.cardmarket.com${productPath}`,
        amount: 1,
        enabled: true,
        addedAt: Date.now(),
      });
    }
    await saveProducts();
    renderProducts();
    await updateCachePill();
    toast(`Added ${fallbackName} to Extra Products.`, 'success');
  }

  // ---- Saved Runs ----
  async function saveRunSummary(col) {
    const id = `bwRun:${col.stats.finishedAt}`;
    const summary = {
      id, at: col.stats.finishedAt,
      lists: col.lists || [],
      cards: col.results.length,
      totalCents: state.basket?.totalCents ?? null,
      sellers: state.basket?.parcels.length ?? null,
      orderedAt: state.savedRuns.find(r => r.id === id)?.orderedAt ?? null,
    };
    const next = [summary, ...state.savedRuns.filter(r => r.id !== id)].sort((a, b) => b.at - a.at).slice(0, KEPT_RUNS);
    const dropped = state.savedRuns.filter(r => !next.some(n => n.id === r.id)).map(r => r.id);
    state.savedRuns = next;
    await chrome.storage.local.set({ [id]: col, bwRuns: next });
    if (dropped.length) await chrome.storage.local.remove([...dropped, ...dropped.map(runId => runId.replace(/^bwRun:/, 'bwSnap:'))]);
    renderSavedRuns();
  }

  // autoCompute: false loads the offers only; the user re-optimises explicitly from the notice button.
  async function openSavedCollection(col, { snapshot = null, source = 'saved run', autoCompute = true } = {}) {
    if (workInProgress()) return;
    if (!Array.isArray(col?.results) || !col.stats?.finishedAt) {
      toast('Not a valid Better Wizard run file.', 'error');
      return;
    }
    if (snapshot) {
      await restoreBasketSnapshot(col, snapshot, { source });
      return;
    }
    state.collection = col;
    if (col.selectionSig) await loadLimitsAndCutsFor(col.selectionSig);
    else { state.activeLimits = []; state.manualCuts = []; }
    await updateCachePill();
    if (!autoCompute) {
      showLoadedOffersWithoutBasket(col, source);
      return;
    }
    await computeBasketFromCollection();
    toast(`Opened run from ${new Date(col.stats.finishedAt).toLocaleString()}.`, 'success');
  }

  // Shows loaded offers with no basket yet, so an import never silently re-optimises into a different basket.
  function showLoadedOffersWithoutBasket(col, source) {
    // Supersede any in-flight optimisation so it cannot render a basket for the previous collection.
    state.optimiseJobId += 1;
    state.optimising = false;
    state.basket = null;
    state.tokenResult = null;
    state.removedItems = [];
    state.removedListOpen = false;
    state.restoredSnapshot = null;
    state.leftOut = [];
    state.cuts = [];
    state.overlap = [];
    state.countsByScope = {};
    state.sellerTokenOffers = {};
    hideProgress();
    syncBusyUI();
    renderTokenResults();
    $('emptyState').hidden = true;
    $('resultsArea').hidden = true;
    $('btnDownload').hidden = false;
    const when = new Date(col.stats.finishedAt).toLocaleString();
    $('topNotice').innerHTML = `<div class="alert-banner alert-info" style="margin-bottom:12px">
      <div><strong>Loaded ${col.results.length} items with offers from ${esc(when)}</strong> (from ${esc(source)}).
      No usable saved basket was found (e.g. the file was exported before basket snapshots were added), so nothing was computed.
      Optimising now uses these saved offers (no Cardmarket requests) and may pick a different basket than the one you ordered.</div>
      <div style="margin-top:8px"><button type="button" id="btnComputeLoaded" class="btn btn-primary btn-sm">Compute basket from these offers</button></div>
    </div>`;
    $('btnComputeLoaded').addEventListener('click', () => {
      if (workInProgress() || state.collection !== col) return;
      computeBasketFromCollection();
    });
    toast(`Loaded offers from ${when}. Click "Compute basket from these offers" to optimise.`, 'success');
  }

  // ---- Basket snapshots (exact basket after removals; JSON export, cart add, restore) ----
  const snapshotKeyFor = col => `bwSnap:${col.stats.finishedAt}`;

  // Best-effort Scryfall lookup so exported snapshots carry set codes for later offline Archidekt exports.
  // `lookup: false` uses only already-known printings (no Scryfall calls, e.g. right after a cart add).
  async function snapshotPrintings(finalBasket, { lookup = true } = {}) {
    const known = () => {
      const out = {};
      for (const [id, hit] of scryfallPrintingCache) if (hit) out[id] = hit;
      return out;
    };
    if (!lookup) return known();
    try {
      return await resolvePrintings(collectBasketEntries(finalBasket.parcels));
    } catch (error) {
      record({ type: 'snapshot-printings-failed', message: error.message });
      return known();
    }
  }

  async function buildCurrentSnapshot({ orderedAt = null, lookupPrintings = true } = {}) {
    const finalBasket = activeBasket();
    if (!finalBasket || !state.collection) return null;
    const printings = await snapshotPrintings(finalBasket, { lookup: lookupPrintings });
    return createBasketSnapshot({
      basket: state.basket,
      finalBasket,
      tokenResult: state.tokenResult,
      includeTokensInBasket: state.includeTokensInBasket,
      removedItems: state.removedItems,
      tables: state.currentTables,
      leftOut: state.leftOut,
      cuts: state.cuts,
      overlap: state.overlap,
      countsByScope: state.countsByScope,
      buySellers: Number($('buySellers').value) || finalBasket.parcels.length,
      activeLimits: state.activeLimits,
      manualCuts: state.manualCuts,
      shipTo: state.shipTo,
      selectionSig: state.collection.selectionSig || null,
      collectionFinishedAt: state.collection.stats?.finishedAt ?? null,
      printings,
      orderedAt: orderedAt ?? state.restoredSnapshot?.orderedAt ?? null,
    });
  }

  // Remembers the basket that was just added to the cart so the saved run reopens exactly as ordered.
  async function saveOrderedSnapshot() {
    const col = state.collection;
    if (!col?.stats?.finishedAt) return;
    try {
      const snapshot = await buildCurrentSnapshot({ orderedAt: Date.now(), lookupPrintings: false });
      if (!snapshot) return;
      await chrome.storage.local.set({ [snapshotKeyFor(col)]: snapshot });
      const run = state.savedRuns.find(r => r.id === `bwRun:${col.stats.finishedAt}`);
      if (run) {
        run.orderedAt = snapshot.orderedAt;
        await chrome.storage.local.set({ bwRuns: state.savedRuns });
        renderSavedRuns();
      }
      if (state.restoredSnapshot) state.restoredSnapshot.orderedAt = snapshot.orderedAt;
    } catch (error) {
      record({ type: 'snapshot-save-failed', message: error.message });
    }
  }

  function renderSnapshotNotice() {
    const snap = state.restoredSnapshot;
    if (!snap) return;
    const when = new Date(snap.orderedAt || snap.createdAt).toLocaleString();
    const what = snap.orderedAt ? `basket added to cart on ${when}` : `basket saved on ${when}`;
    const exactNote = snap.exact
      ? 'Removals stay undoable.'
      : 'Shown as saved (removals and tokens are baked in and cannot be undone here).';
    $('topNotice').innerHTML = `<div class="alert-banner alert-info" style="margin-bottom:12px">
      <div><strong>Showing the exact ${esc(what)}</strong> (from ${esc(snap.source)}). ${esc(exactNote)}
      Exports and cart checks use this basket; changing limits, cuts or shipping, or clicking <em>Compute Basket</em>, re-optimises from the saved offers.</div>
    </div>`;
  }

  async function restoreBasketSnapshot(col, raw, { source = 'saved run' } = {}) {
    if (workInProgress()) return;
    const snap = readBasketSnapshot(raw);
    if (!snap) {
      toast('The saved basket could not be read; loaded the saved offers only.', 'error');
      await openSavedCollection(col, { snapshot: null, source, autoCompute: false });
      return;
    }
    // Supersede any in-flight optimisation so its result cannot overwrite the restored basket.
    state.optimiseJobId += 1;
    state.optimising = false;
    state.collection = col;
    state.activeLimits = snap.activeLimits;
    state.manualCuts = snap.manualCuts;
    state.currentTables = snap.tables;
    if (!state.currentTables) {
      try {
        const { failed, ...tables } = await loadShippingTablesFor(col);
        state.currentTables = tables;
      } catch (error) {
        record({ type: 'snapshot-tables-failed', message: error.message });
      }
    }
    state.leftOut = snap.leftOut;
    state.cuts = snap.cuts;
    state.overlap = snap.overlap;
    state.countsByScope = snap.countsByScope;
    // Token offers fetched for a different basket must not re-optimise the restored token picks.
    state.sellerTokenOffers = {};
    state.includeTokensInBasket = snap.includeTokensInBasket;
    $('chkIncludeTokens').checked = state.includeTokensInBasket;
    state.basket = snap.basket;
    state.tokenResult = snap.tokenResult;
    state.removedItems = snap.removedItems;
    state.removedListOpen = false;

    let exact = true;
    try {
      exact = basketFingerprint(activeBasket()) === basketFingerprint(snap.finalBasket);
    } catch {
      exact = false;
    }
    if (!exact) {
      state.basket = snap.finalBasket;
      state.tokenResult = null;
      state.removedItems = [];
    }
    state.removedNextId = state.removedItems.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
    state.removedNextBatchId = state.removedItems.reduce((m, r) => Math.max(m, Number(r.batchId) || 0), 0) + 1;
    for (const [id, hit] of Object.entries(snap.printings)) {
      if (hit && !scryfallPrintingCache.get(Number(id))) scryfallPrintingCache.set(Number(id), hit);
    }
    state.restoredSnapshot = { createdAt: snap.createdAt, orderedAt: snap.orderedAt, source, exact };

    $('emptyState').hidden = true;
    $('resultsArea').hidden = false;
    hideProgress();
    syncBusyUI();
    renderSnapshotNotice();
    renderTokenResults();
    renderActiveLimits();
    renderScopePills();
    renderKpis(false, snap.orderedAt ? 'Ordered basket' : 'Saved basket');
    renderCutsAndLeftOut(false);
    $('buySellers').value = snap.buySellers;
    renderParcelsAndTabs({ resetBuySellers: false });
    await updateCachePill();
    const when = new Date(snap.orderedAt || snap.createdAt).toLocaleString();
    toast(`Restored ${snap.orderedAt ? 'ordered' : 'saved'} basket from ${when}${exact ? '' : ' (as saved)'}.`, 'success');
  }

  // ---- Exports (Plain & Archidekt, combined or per Wants List) ----
  const scryfallPrintingCache = new Map();

  function basketEntries() {
    const b = activeBasket();
    if (!b || !b.parcels.length) return [];
    const n = Math.max(1, Number($('buySellers').value) || b.parcels.length);
    return collectBasketEntries(b.parcels.slice(0, n));
  }

  function leftOutEntries() {
    return collectLeftOutEntries(state.leftOut);
  }

  function updateExportButtons() {
    if (!state.basket) return;
    const entries = basketEntries();
    const archGroups = groupExportEntries(entries, 'archidekt');
    const plainGroups = groupExportEntries(entries, 'plain');
    $('btnCopyPlain').disabled = entries.length === 0;
    $('btnCopyArchidekt').hidden = archGroups.length === 0;
    $('btnCopyArchidekt').textContent = archGroups.length > 1 ? 'Export for Archidekt ▾' : 'Copy for Archidekt';
    $('btnCopyPlain').textContent = plainGroups.length > 1 ? 'Export list ▾' : 'Copy list';
  }

  async function resolvePrintings(entries) {
    const ids = [...new Set(
      (entries || [])
        .filter(e => (e.game || 'Magic') === 'Magic' && e.kind !== 'product' && e.kind !== 'token')
        .map(e => e.idProduct)
        .filter(Boolean)
    )];
    const missing = ids.filter(id => !scryfallPrintingCache.has(id));
    if (missing.length) {
      toast('Looking up Scryfall set codes…');
      const { found = {}, error } = await traceSpan('scryfall.printings', { missing: missing.length }, async setMeta => {
        const res = await chrome.runtime.sendMessage({ type: 'printings', ids: missing });
        if (res?.timing) setMeta(res.timing);
        return res;
      });
      if (error) throw new Error(error);
      for (const id of missing) scryfallPrintingCache.set(id, found[id] || null);
    }
    const result = {};
    for (const id of ids) {
      const hit = scryfallPrintingCache.get(id);
      if (hit) result[id] = hit;
    }
    return result;
  }

  function downloadTextFile(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function buildExportText(entries, format, { categoryBy = 'seller', groupBy = 'auto', preloadEntries = null } = {}) {
    if (format === 'plain') {
      return formatPlainExport(entries, { groupBy });
    }
    const magicOnly = (entries || []).filter(e => (e.game || 'Magic') === 'Magic' && e.kind !== 'product' && e.kind !== 'token');
    if (!magicOnly.length) return { text: '', count: 0 };
    const found = await resolvePrintings(preloadEntries || magicOnly);
    return formatArchidektExport(magicOnly, found, { categoryBy });
  }

  function closeExportModal() {
    $('exportModal').hidden = true;
  }

  function openExportModal(entries, format, label) {
    const groups = groupExportEntries(entries, format);
    if (!groups.length) {
      toast(format === 'archidekt' ? 'No Magic cards to export for Archidekt.' : 'Nothing to export.', 'error');
      return;
    }
    const isArchidekt = format === 'archidekt';
    const totalEligible = groups.reduce((s, g) => s + g.quantity, 0);
    const totalAll = entries.reduce((s, e) => s + (e.quantity || 1), 0);
    const skippedNonMagic = isArchidekt ? Math.max(0, totalAll - totalEligible) : 0;
    const hasSellers = groups.some(g => g.sellerCount > 0);

    $('exportModalTitle').textContent = isArchidekt ? 'Export for Archidekt' : 'Export list';
    $('exportModalSub').textContent = `${groups.length} lists · ${totalEligible} ${isArchidekt ? 'Magic cards' : 'items'} — copy or download each Wants List separately, or export everything combined.`;

    const notice = $('exportModalNotice');
    if (skippedNonMagic > 0) {
      notice.hidden = false;
      notice.textContent = `Archidekt supports Magic cards only — ${skippedNonMagic} non-Magic / product / token item${skippedNonMagic === 1 ? '' : 's'} omitted here (use Export list for those).`;
    } else {
      notice.hidden = true;
    }

    const catRow = $('exportCategoryRow');
    const catSelect = $('exportCategoryBy');
    if (isArchidekt) {
      catRow.hidden = false;
      const options = hasSellers
        ? [
            ['seller', 'Seller name — [Seller]'],
            ['list', 'Wants List name — [Wants List]'],
            ['none', 'No category tag'],
          ]
        : [
            ['list', 'Wants List name — [Wants List]'],
            ['none', 'No category tag'],
          ];
      catSelect.innerHTML = options.map(([v, txt]) => `<option value="${v}">${esc(txt)}</option>`).join('');
      catSelect.value = hasSellers ? 'seller' : 'list';
    } else {
      catRow.hidden = true;
    }

    const badgeFor = g => {
      if (g.kind === 'product') return '<span class="badge badge-product">Product</span>';
      if (g.kind === 'token') return '<span class="badge badge-token">Tokens</span>';
      return `<span class="badge ${g.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${g.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span>`;
    };

    const listEl = $('exportModalList');
    listEl.innerHTML = groups.map((g, idx) => `
      <div class="export-row">
        <div class="export-row-info">
          <div class="export-row-title">
            ${badgeFor(g)}
            <span class="export-row-name" title="${esc(g.label)}">${esc(g.label)}</span>
          </div>
          <div class="export-row-meta">
            ${g.quantity} ${g.kind === 'product' ? (g.quantity === 1 ? 'item' : 'items') : (g.quantity === 1 ? 'card' : 'cards')}${g.sellerCount ? ` · ${g.sellerCount} seller${g.sellerCount === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <div class="export-row-actions">
          <button type="button" class="btn btn-primary btn-xs" data-export-copy="${idx}">Copy</button>
          <button type="button" class="btn btn-secondary btn-xs" data-export-dl="${idx}" title="Download as .txt">.txt</button>
        </div>
      </div>`).join('');

    catSelect.onchange = () => {
      listEl.querySelectorAll('[data-export-copy]').forEach(btn => {
        btn.classList.remove('btn-copied');
        btn.classList.add('btn-primary');
        btn.textContent = 'Copy';
      });
    };

    const runAction = async (btn, targetEntries, targetName, isDownload, isCombined) => {
      const prevText = btn.textContent;
      btn.disabled = true;
      try {
        const categoryBy = isArchidekt ? catSelect.value : 'none';
        const { text, count } = await buildExportText(targetEntries, format, {
          categoryBy,
          groupBy: isCombined ? 'list' : 'none',
          preloadEntries: isArchidekt ? entries : null,
        });
        if (!count || !text) {
          toast('Nothing to export.', 'error');
          return;
        }
        const scopeDesc = isCombined ? `all ${groups.length} lists` : `"${targetName}"`;
        if (isDownload) {
          const suffix = isArchidekt ? 'archidekt' : 'list';
          downloadTextFile(text, safeExportFilename(isCombined ? `all-${label}` : targetName, suffix));
          toast(`Downloaded ${count} ${isArchidekt ? 'Magic cards' : 'items'} (${scopeDesc}).`, 'success');
        } else {
          await navigator.clipboard.writeText(text);
          if (!isCombined) {
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-copied');
            btn.textContent = 'Copied ✓';
          }
          toast(`Copied ${count} ${isArchidekt ? 'Magic cards' : 'items'} (${scopeDesc})${isArchidekt ? ' for Archidekt' : ''}.`, 'success');
        }
      } catch (error) {
        btn.textContent = prevText;
        toast(`Export failed: ${error.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    listEl.querySelectorAll('[data-export-copy]').forEach(btn => {
      const g = groups[Number(btn.dataset.exportCopy)];
      btn.addEventListener('click', () => runAction(btn, g.entries, g.label, false, false));
    });
    listEl.querySelectorAll('[data-export-dl]').forEach(btn => {
      const g = groups[Number(btn.dataset.exportDl)];
      btn.addEventListener('click', () => runAction(btn, g.entries, g.label, true, false));
    });

    const copyAllBtn = $('exportCopyAll');
    const dlAllBtn = $('exportDownloadAll');
    copyAllBtn.onclick = () => runAction(copyAllBtn, entries, label, false, true);
    dlAllBtn.onclick = () => runAction(dlAllBtn, entries, label, true, true);

    $('exportModal').hidden = false;
  }

  async function handleExportEntries(entries, format, label) {
    const groups = groupExportEntries(entries, format);
    if (!groups.length) {
      toast(format === 'archidekt' ? 'No Magic cards to export for Archidekt.' : 'Nothing to export.', 'error');
      return;
    }
    if (groups.length > 1) {
      openExportModal(entries, format, label);
      return;
    }
    try {
      const group = groups[0];
      const hasSellers = group.sellerCount > 0;
      const { text, count } = await buildExportText(group.entries, format, {
        categoryBy: hasSellers ? 'seller' : 'none',
        groupBy: 'none',
      });
      if (!count || !text) {
        toast('Nothing to export.', 'error');
        return;
      }
      await navigator.clipboard.writeText(text);
      const totalAll = entries.reduce((s, e) => s + (e.quantity || 1), 0);
      const skipped = format === 'archidekt' ? Math.max(0, totalAll - count) : 0;
      const listNote = group.listName ? ` ("${group.label}")` : '';
      const skipNote = skipped ? ` (${skipped} non-Magic skipped)` : '';
      toast(`Copied ${count} ${label}${listNote} (${format === 'plain' ? 'plain' : 'Archidekt'})${skipNote}.`, 'success');
    } catch (error) {
      toast(`Copy failed: ${error.message}`, 'error');
    }
  }

  // ---- Cart Checkout & Tracked-Only Learning ----
  async function alreadyAdded() {
    const key = `bwCart:${state.collection?.selectionSig || 'default'}`;
    const data = await chrome.storage.local.get(key);
    const added = data[key] || {};
    for (const [id, at] of Object.entries(added)) {
      if (Date.now() - at > CART_MEMORY_MS) delete added[id];
    }
    return { key, added };
  }

  async function rememberTracked(map) {
    state.trackedSellers = map;
    await chrome.storage.local.set({ trackedSellers: map });
    $('trackedSellers').value = Object.keys(map).sort().join(', ');
  }

  async function checkCart(existingRunner = null, { prefixHtml = '' } = {}) {
    if (!existingRunner) {
      if (workInProgress() || state.checkingCart) return;
      state.checkingCart = true;
      syncBusyUI();
    }
    const trace = beginActionTrace('check-cart', { nested: Boolean(existingRunner) }, { reuseActive: Boolean(existingRunner) });
    let cartOk = true;
    let cartErr = null;
    const out = $('cartCheckBox');
    out.innerHTML = `${prefixHtml}<div class="alert-banner alert-info" style="margin-bottom:12px"><span>Reading your Cardmarket shopping cart…</span></div>`;
    try {
      const runner = existingRunner || createRunner(site, { intervalMs: state.interval, log: record });
      const shipments = await trace.span('cart.read', () => runner.call('cartShipping'));
      const learned = [];
      const known = { ...state.trackedSellers };
      for (const s of shipments) {
        if (s.trackedOnly && !known[s.seller]) learned.push(s.seller);
        if (s.trackedOnly) known[s.seller] = Date.now();
      }
      if (learned.length) await rememberTracked(known);
      const predicted = new Map((activeBasket()?.parcels || []).map(p => [p.seller, p]));
      const diffs = shipments.filter(s => predicted.has(s.seller) && s.shippingCents !== predicted.get(s.seller).shippingCents);
      const sum = k => shipments.reduce((t, s) => t + (s[k] || 0), 0);
      out.innerHTML = `${prefixHtml}<div class="alert-banner alert-info" style="margin-bottom:12px">
        <div>
          <strong>Cart: ${shipments.length} sellers · articles ${euros(sum('itemsCents'))} · shipping ${euros(sum('shippingCents'))}${sum('trusteeCents') ? ` · trustee ${euros(sum('trusteeCents'))}` : ''}</strong><br>
          ${diffs.length
            ? `Shipping differs for: ${diffs.map(s => `${esc(s.seller)} ${euros(s.shippingCents)} vs ${euros(predicted.get(s.seller).shippingCents)}${s.trackedOnly ? ' (tracked only)' : ''}`).join('; ')}.`
            : 'Shipping matches prediction for every seller in this basket.'}
          ${learned.length ? `<br>Learned tracked-only sellers: <strong>${learned.map(esc).join(', ')}</strong>.` : ''}
        </div>
        ${learned.length ? '<button type="button" id="btnRebuildTracked" class="btn btn-primary btn-sm">Recompute basket</button>' : ''}
      </div>`;
      $('btnRebuildTracked')?.addEventListener('click', () => { if (!workInProgress()) computeBasketFromCollection(); });
    } catch (error) {
      cartOk = false;
      cartErr = error.message;
      out.innerHTML = `${prefixHtml}<div class="alert-banner alert-warn" style="margin-bottom:12px">Could not read cart: ${esc(error.message)}</div>`;
    } finally {
      if (!existingRunner) {
        state.checkingCart = false;
        syncBusyUI();
      }
      await trace.finish({ ok: cartOk, extra: cartErr ? { error: cartErr } : {} });
    }
  }

  async function addToCart() {
    const b = activeBasket();
    if (!b || !b.parcels.length || state.fetching || state.fetchingTokens || state.carting || state.optimising) return;
    state.carting = true;
    syncBusyUI();
    let controller = null;
    let runner = null;
    let trace = null;
    let cartAddOk = true;
    let cartAddErr = null;
    const failed = [];
    let done = 0;
    let totalItems = 0;
    const renderFailedBanner = () => (failed.length
      ? `<div class="alert-banner alert-warn" style="margin-bottom:12px"><div><strong>Could not add:</strong> ${failed.map(esc).join('; ')}</div></div>`
      : '');
    try {
      const n = Math.max(1, Number($('buySellers').value) || b.parcels.length);
      const parcels = b.parcels.slice(0, n);
      const { key: cartKey, added } = await alreadyAdded();
      let skipped = 0;
      const orders = parcels.map(parcel => {
        const items = new Map();
        for (const item of parcel.items) {
          if (added[item.idArticle]) { skipped += 1; continue; }
          const entry = items.get(item.idArticle) || { idArticle: item.idArticle, amount: 0, name: item.name, game: item.game || 'Magic' };
          entry.amount += 1;
          items.set(item.idArticle, entry);
        }
        return { seller: parcel.seller, items: [...items.values()] };
      }).filter(o => o.items.length);

      totalItems = orders.reduce((s, o) => s + o.items.reduce((m, i) => m + i.amount, 0), 0);
      if (!totalItems) { toast(`All ${skipped} items from these sellers were already added to your cart.`); return; }
      if (!confirm(`Add ${totalItems} items from ${orders.length} sellers to your Cardmarket cart?` + (skipped ? `\n(${skipped} already added earlier will be skipped.)` : ''))) return;

      trace = beginActionTrace('add-to-cart', { sellers: orders.length, items: totalItems, skipped });
      controller = new AbortController();
      state.controller = controller;
      syncBusyUI();
      runner = createRunner(site, {
        concurrency: 1,
        intervalMs: Math.max(state.interval, 1000),
        bucketIntervals: { cart: 2000 },
        signal: controller.signal,
        waitForUser,
        log: record,
        maxWaits: 2,
        maxRetries: 2,
        maxWaitMs: 120000,
        onWait: ({ until }) => {
          showProgress(
            'Waiting for Cardmarket rate limit…',
            `Retrying at ${new Date(until).toLocaleTimeString()} · ${done}/${totalItems} items`,
            Math.round((done / totalItems) * 100),
            'You can click Stop to cancel.',
          );
        },
      });
      const runCartPostWithTokenRetry = async (game, postFn) => {
        try {
          return await postFn();
        } catch (err) {
          if (!(err instanceof TokenExpiredError)) throw err;
          record({ type: 'cart-token-expired', game, message: err.message });
          await runner.call('refreshToken', game);
          return await postFn();
        }
      };
      const mark = async items => {
        for (const item of items) added[item.idArticle] = Date.now();
        done += items.reduce((s, i) => s + i.amount, 0);
        await chrome.storage.local.set({ [cartKey]: added });
      };

      // Refresh the CSRF token once from Cardmarket so an hours-old tab DOM token does not break checkout.
      const firstGame = orders[0]?.items[0]?.game || 'Magic';
      showProgress('Refreshing Cardmarket session…', `0/${totalItems} items`, 2);
      try {
        await trace.span('cart.refresh-token', { game: firstGame }, () => runner.call('refreshToken', firstGame));
      } catch (tokenErr) {
        if (tokenErr instanceof BlockedError || runner.blocked()) throw runner.blocked() || tokenErr;
        record({ type: 'token-refresh-fallback', message: tokenErr.message });
      }

      let consecutiveUnexpected = 0;
      for (const [idx, order] of orders.entries()) {
        showProgress(`Adding to Cardmarket cart (${idx + 1}/${orders.length})…`, `${order.seller} · ${done}/${totalItems} items`, Math.round((done / totalItems) * 100));
        // Group by game when adding per seller so each game endpoint gets its own articles cleanly.
        const byGame = new Map();
        for (const item of order.items) {
          if (!byGame.has(item.game)) byGame.set(item.game, []);
          byGame.get(item.game).push(item);
        }
        for (const [g, groupItems] of byGame) {
          try {
            await runCartPostWithTokenRetry(g, () => runner.call('addSellerToCart', groupItems, g));
            await mark(groupItems);
            consecutiveUnexpected = 0;
          } catch (error) {
            if (error instanceof BlockedError || runner.blocked()) throw runner.blocked() || error;
            if (error instanceof RetryableError && error.cause === 'rate') {
              throw new BlockedError(`Cardmarket rate-limited cart adds (${error.message}). Try again in a few minutes.`);
            }
            if (error instanceof RetryableError || error instanceof RefusedError || error instanceof TypeError) {
              // The outcome is unknown and the items may already be in the cart: retrying per item could duplicate them.
              failed.push(`${groupItems.map(item => item.name).join(', ')} (${order.seller}): ${error.message}. Check your Cardmarket cart before retrying`);
              continue;
            }
            if (!(error instanceof CartRejectError)) {
              // Non-XML / session / bridge / HTTP 4xx failure: do not storm per-item cart endpoints.
              failed.push(`${groupItems.map(item => item.name).join(', ')} (${order.seller}): ${error.message}`);
              consecutiveUnexpected += 1;
              if (done === 0 && consecutiveUnexpected >= 3) {
                throw new BlockedError(`Stopped after ${consecutiveUnexpected} consecutive cart errors: ${error.message}`);
              }
              continue;
            }
            consecutiveUnexpected = 0;
            for (const [itemIdx, item] of groupItems.entries()) {
              showProgress(
                `Adding to Cardmarket cart (${idx + 1}/${orders.length})…`,
                `${order.seller} · item ${itemIdx + 1}/${groupItems.length} · ${done}/${totalItems} items`,
                Math.round((done / totalItems) * 100),
                'Bulk add rejected; adding available items individually',
              );
              try {
                await runCartPostWithTokenRetry(g, () => runner.call('addToCart', item.idArticle, item.amount, g));
                await mark([item]);
              } catch (itemErr) {
                if (itemErr instanceof BlockedError || runner.blocked()) throw runner.blocked() || itemErr;
                if (itemErr instanceof RetryableError && itemErr.cause === 'rate') {
                  throw new BlockedError(`Cardmarket rate-limited cart adds (${itemErr.message}). Try again in a few minutes.`);
                }
                failed.push(`${item.name} (${order.seller}): ${itemErr.message}`);
                if (itemErr instanceof RefusedError) break;
              }
            }
          }
        }
      }
      hideProgress();
      toast(`Added ${done}/${totalItems} items to your Cardmarket cart.` + (failed.length ? ` ${failed.length} failed.` : ''), failed.length ? 'error' : 'success');
      const failedHtml = renderFailedBanner();
      if (done > 0) {
        await saveOrderedSnapshot();
        await checkCart(runner, { prefixHtml: failedHtml });
      } else if (failedHtml) {
        $('cartCheckBox').innerHTML = failedHtml;
      }
    } catch (error) {
      cartAddOk = false;
      cartAddErr = error.message;
      hideProgress();
      toast(`Stopped after ${done}/${totalItems}: ${error.message}`, 'error');
      if (done > 0) await saveOrderedSnapshot();
      const stopHtml = `<div class="alert-banner alert-warn" style="margin-bottom:12px"><div><strong>Cart add stopped (${done}/${totalItems} added):</strong> ${esc(error.message)}</div></div>`;
      $('cartCheckBox').innerHTML = stopHtml + renderFailedBanner();
    } finally {
      runner?.finish();
      if (controller && state.controller === controller) state.controller = null;
      state.carting = false;
      syncBusyUI();
      if (trace) {
        await trace.finish({
          ok: cartAddOk,
          extra: { added: done, totalItems, failed: failed.length, ...(cartAddErr ? { error: cartAddErr } : {}) },
        });
      }
    }
  }

  // ---- Deck-Scoped Magic Tokens ----
  const EXAMPLE_TOKENS = `# Deck 1 (e.g. Edgar Markov)
4x 1/1 Black Vampire
2x Treasure

# Deck 2 (e.g. Chatterfang)
4x 1/1 Green Squirrel
2x Food`;

  async function saveTokenState() {
    await chrome.storage.local.set({
      bwTokensState: {
        text: state.tokensText,
        deckOptions: state.tokenDeckOptions,
        settings: state.tokenSettings,
        includeTokensInBasket: state.includeTokensInBasket,
      },
    });
  }

  async function ensureTokenCatalog() {
    if (state.tokenCatalog) return state.tokenCatalog;
    if (!state.tokenCatalogLoading) {
      state.tokenCatalogLoading = traceSpan('tokens.catalog', async setMeta => {
        const res = await chrome.runtime.sendMessage({ type: 'token-catalog' });
        if (!res || res.error) throw new Error(res?.error || 'Failed to load Magic token catalogue');
        if (res.timing) setMeta(res.timing);
        state.tokenCatalog = buildTokenCatalog(res.tokens || []);
        return state.tokenCatalog;
      }).finally(() => { state.tokenCatalogLoading = null; });
    }
    return state.tokenCatalogLoading;
  }

  function selectedBasketParcels() {
    if (!state.basket?.parcels?.length) return [];
    const base = state.removedItems.length
      ? applyBasketRemovals(state.basket, state.removedItems, {
          tables: state.currentTables,
          trackedOnly: Object.keys(state.trackedSellers),
        })
      : state.basket;
    if (!base.parcels.length) return [];
    const max = base.parcels.length;
    const n = Math.min(max, Math.max(1, Number($('buySellers').value) || max));
    return base.parcels.slice(0, n);
  }

  function renderTokenDeckToggles(decks) {
    const box = $('tokenDeckToggles');
    if (!decks.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '<span class="scope-label">Within-deck 2-for-1 DFC combos:</span>' + decks.map(d => {
      const allowed = d.allowCombos !== false;
      return `
        <label class="token-deck-chip ${allowed ? '' : 'combos-off'}" title="Allow double-sided tokens (A // B) to cover two different tokens in this deck. Never combines across different decks.">
          <input type="checkbox" data-token-deck="${esc(d.deckName)}" ${allowed ? 'checked' : ''}>
          <span>${esc(d.deckName)}</span>
          <span style="font-size:11px;opacity:.75">${allowed ? '2-in-1 ON' : '2-in-1 OFF'}</span>
        </label>`;
    }).join('');

    box.querySelectorAll('[data-token-deck]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const name = cb.dataset.tokenDeck;
        state.tokenDeckOptions = { ...state.tokenDeckOptions, [name]: { allowCombos: cb.checked } };
        await saveTokenState();
        refreshTokenPreview();
        reoptimiseTokensFromMemory({ resetBuySellers: false, silent: true });
      });
    });
  }

  function renderTokenPreview() {
    const box = $('tokenPreviewBox');
    const decks = parseTokenListText(state.tokensText, state.tokenDeckOptions);
    renderTokenDeckToggles(decks);

    if (!decks.length) {
      state.tokenMatchPlan = null;
      $('tabCountTokens').textContent = '0';
      box.innerHTML = '';
      return;
    }

    const totalFaces = decks.reduce((s, d) => s + d.requests.reduce((r, x) => r + x.qty, 0), 0);
    if (!state.tokenResult) $('tabCountTokens').textContent = String(totalFaces);

    if (!state.tokenCatalog) {
      box.innerHTML = '<div class="empty-mini">Loading Cardmarket Magic token catalogue (13,000+ printings)…</div>';
      ensureTokenCatalog()
        .then(() => refreshTokenPreview())
        .catch(err => {
          box.innerHTML = `<div class="alert-banner alert-warn">Could not load token catalogue: ${esc(err.message)}</div>`;
        });
      return;
    }

    state.tokenMatchPlan = matchTokenDecks(decks, state.tokenCatalog, {
      maxPriceCents: state.tokenSettings.maxPriceCents,
      foil: state.tokenSettings.foil,
    });

    box.innerHTML = state.tokenMatchPlan.decks.map(deck => {
      const deckFaces = deck.requests.reduce((s, r) => s + r.qty, 0);
      const rows = deck.requests.map(req => {
        let statusBadge;
        if (req.matchCount === 0) {
          statusBadge = '<span class="badge badge-danger">No catalogue match</span>';
        } else if (req.likelyProxy) {
          statusBadge = `<span class="badge badge-warn">Likely proxy (guide ${euros(req.cheapestGuideCents)})</span>`;
        } else {
          statusBadge = `<span class="badge badge-combo">${req.matchCount} printing${req.matchCount === 1 ? '' : 's'}${req.doubleCount ? ` (${req.doubleCount} DFC)` : ''}</span>`;
        }
        return `
          <tr>
            <td><strong>${req.qty}×</strong> ${esc(req.label)}</td>
            <td>${statusBadge}${req.fuzzy ? ' <span class="badge badge-neutral">fuzzy</span>' : ''}</td>
            <td class="num">${req.cheapestGuideCents !== null ? euros(req.cheapestGuideCents) : '–'}</td>
            <td style="font-size:12px;color:var(--text-muted)">${esc((req.sampleNames || []).slice(0, 2).join(' · '))}</td>
          </tr>`;
      }).join('');

      const comboHtml = deck.allowCombos && deck.combos.length
        ? `<div class="token-combo-hint">
            <strong>Within-deck 2-for-1 DFC options (${deck.combos.length}):</strong>
            ${deck.combos.slice(0, 5).map(c => `${esc(c.name)}${c.cheapestGuideCents !== null ? ` (${euros(c.cheapestGuideCents)})` : ''}`).join(' · ')}${deck.combos.length > 5 ? ` + ${deck.combos.length - 5} more` : ''}
          </div>`
        : (!deck.allowCombos ? '<div class="token-combo-hint" style="background:#fff7ed;border-color:#fdba74;color:#9a3412">2-for-1 DFC combining disabled for this deck (each token gets its own card).</div>' : '');

      return `
        <div class="token-deck-card">
          <div class="token-deck-card-head">
            <span>${esc(deck.deckName)}</span>
            <span class="badge badge-neutral">${deckFaces} token face${deckFaces === 1 ? '' : 's'}</span>
          </div>
          <div class="token-deck-card-body">
            <div class="table-scroll">
              <table class="data-table">
                <thead><tr><th>Wanted token</th><th>Catalogue match</th><th class="num">Guide low</th><th>Sample Cardmarket printings</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            ${comboHtml}
          </div>
        </div>`;
    }).join('');
  }

  function refreshTokenPreview() {
    renderTokenPreview();
  }

  function renderTokenResults() {
    const area = $('tokenResultsArea');
    const reoptBtn = $('btnReoptTokens');
    const res = state.tokenResult;
    const hasSellerOffers = selectedBasketParcels().some(p => Array.isArray(state.sellerTokenOffers[p.seller]));
    if (reoptBtn) reoptBtn.hidden = !hasSellerOffers;

    if (!res) {
      area.hidden = true;
      const decks = parseTokenListText(state.tokensText, state.tokenDeckOptions);
      const totalFaces = decks.reduce((s, d) => s + d.requests.reduce((r, x) => r + x.qty, 0), 0);
      $('tabCountTokens').textContent = String(totalFaces);
      return;
    }

    area.hidden = false;
    const st = res.stats;
    $('tabCountTokens').textContent = String(st.physicalTokensBought);

    $('tokenSummaryBar').innerHTML = `
      <div>
        <strong>Covered ${st.coveredFaces}/${st.totalRequestedFaces} token faces</strong>
        with <strong>${st.physicalTokensBought} physical card${st.physicalTokensBought === 1 ? '' : 's'}</strong>${st.comboCardsUsed ? ` (${st.comboCardsUsed} two-for-one DFC${st.comboCardsUsed === 1 ? '' : 's'})` : ''} ·
        <strong>${euros(st.tokensCents)}</strong> tokens + <strong>${euros(st.shippingDeltaCents)}</strong> shipping Δ
        ${st.coveredFaces ? ` · avg <strong>${euros(st.avgPerFaceCents)}/face</strong>` : ''}
      </div>
      <div>
        ${st.proxyFaces > 0
          ? `<span class="badge badge-warn">${st.proxyFaces} face${st.proxyFaces === 1 ? '' : 's'} to proxy</span>`
          : '<span class="badge badge-combo">100% covered!</span>'}
      </div>`;

    // Matched tokens table
    const matchedBox = $('tokenMatchedBox');
    if (res.assignments.length) {
      matchedBox.innerHTML = `
        <div class="token-section-head">
          <h3>Matched Tokens (${res.assignments.length} cards at ${res.bySeller.size} existing seller${res.bySeller.size === 1 ? '' : 's'})</h3>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr><th>Seller</th><th>Deck</th><th>Token Card</th><th>Covers</th><th class="num">Price</th><th class="num">Ship Δ</th><th class="num">Eff./face</th></tr>
            </thead>
            <tbody>
              ${res.assignments.map(a => `
                <tr>
                  <td><strong>${esc(a.seller)}</strong></td>
                  <td><span class="badge badge-neutral">${esc(a.deckName)}</span></td>
                  <td>
                    <strong>${esc(a.name)}</strong>
                    ${a.isCombo ? ' <span class="badge badge-token-combo">2-in-1</span>' : ''}
                    ${a.foil ? ' <span class="badge badge-indigo">Foil</span>' : ''}
                  </td>
                  <td>${esc(a.coveredLabels.join(' + '))}</td>
                  <td class="num">${euros(a.priceCents)}</td>
                  <td class="num">${a.shippingDeltaCents ? `+${euros(a.shippingDeltaCents)}` : '0,00 €'}</td>
                  <td class="num"><strong>${euros(a.effectivePerFaceCents)}</strong></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } else {
      matchedBox.innerHTML = '<div class="empty-mini">No tokens matched within your price cap and filters at your current basket sellers.</div>';
    }

    // Proxy / Skip list
    const proxyBox = $('tokenProxyBox');
    if (res.proxyList.length) {
      proxyBox.innerHTML = `
        <div class="token-section-head">
          <h3>Proxy / Skip List (${res.stats.proxyFaces} faces)</h3>
          <button type="button" id="btnCopyProxyTokens" class="btn btn-secondary btn-xs">Copy proxy list</button>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Deck</th><th>Token</th><th class="num">Qty</th><th>Reason</th></tr></thead>
            <tbody>
              ${res.proxyList.map(p => `
                <tr>
                  <td><span class="badge badge-neutral">${esc(p.deckName)}</span></td>
                  <td><strong>${esc(p.label)}</strong></td>
                  <td class="num">${p.remainingQty}${p.remainingQty < p.requestedQty ? ` / ${p.requestedQty}` : ''}</td>
                  <td style="color:var(--text-muted)">${esc(p.reason)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
      $('btnCopyProxyTokens')?.addEventListener('click', async () => {
        const text = formatProxyListText(res.proxyList);
        if (!text) return;
        await navigator.clipboard.writeText(text);
        toast(`Copied ${res.stats.proxyFaces} tokens to proxy.`, 'success');
      });
    } else {
      proxyBox.innerHTML = '';
    }
  }

  function reoptimiseTokensFromMemory({ resetBuySellers = false, silent = false, useAllParcels = false, renderBasket = true } = {}) {
    const hadTokens = Boolean(state.tokenResult);
    state.removedItems = state.removedItems.filter(r => r.item?.kind !== 'token');
    const targetParcels = useAllParcels ? (state.basket?.parcels || []) : selectedBasketParcels();
    if (!targetParcels.length || !state.tokenCatalog || !state.tokenMatchPlan || !state.currentTables) {
      state.tokenResult = null;
      renderTokenResults();
      if (hadTokens && renderBasket) {
        renderKpis(false);
        renderParcelsAndTabs({ resetBuySellers });
      }
      return;
    }
    const hasOffers = targetParcels.some(p => Array.isArray(state.sellerTokenOffers[p.seller]));
    if (!hasOffers) {
      state.tokenResult = null;
      renderTokenResults();
      if (hadTokens && renderBasket) {
        renderKpis(false);
        renderParcelsAndTabs({ resetBuySellers });
      }
      return;
    }
    state.tokenResult = optimizeTokens(
      state.tokenMatchPlan,
      targetParcels,
      state.sellerTokenOffers,
      state.tokenCatalog,
      {
        tables: state.currentTables,
        trackedOnly: Object.keys(state.trackedSellers),
        maxPriceCents: state.tokenSettings.maxPriceCents,
        targetPriceCents: Math.min(10, state.tokenSettings.maxPriceCents),
        minCondition: state.tokenSettings.minCondition,
        language: state.tokenSettings.language,
        foil: state.tokenSettings.foil,
        parcelShippingFn: parcelShipping,
      }
    );
    renderTokenResults();
    if (renderBasket) {
      renderKpis(false);
      renderParcelsAndTabs({ resetBuySellers });
    }
    if (!silent) {
      const st = state.tokenResult.stats;
      toast(`Re-optimised tokens: ${st.coveredFaces}/${st.totalRequestedFaces} faces (${euros(st.totalAddedCents)}).`, 'success');
    }
  }

  async function findTokensAtBasketSellers() {
    if (workInProgress()) return;
    const targetParcels = selectedBasketParcels();
    if (!targetParcels.length) {
      toast('Compute a basket first so tokens can ride along on your existing sellers.', 'error');
      return;
    }

    const decks = parseTokenListText(state.tokensText, state.tokenDeckOptions);
    if (!decks.length) {
      toast('Paste at least one token in the text box first.', 'error');
      return;
    }

    state.fetchingTokens = true;
    const controller = new AbortController();
    state.controller = controller;
    syncBusyUI();
    const trace = beginActionTrace('find-tokens', { sellers: targetParcels.length, decks: decks.length });
    let tokOk = true;
    let tokErr = null;

    try {
      const { collectionRetryAfter: holdUntil } = await chrome.storage.local.get('collectionRetryAfter');
      if (Date.now() < holdUntil) {
        throw new Error(`Cardmarket asked to wait until ${new Date(holdUntil).toLocaleTimeString()}.`);
      }

      showProgress('Loading Magic token catalogue…', '', 10);
      const catalog = await ensureTokenCatalog();
      state.tokenMatchPlan = await trace.span('tokens.match', () => matchTokenDecks(decks, catalog, {
        maxPriceCents: state.tokenSettings.maxPriceCents,
        foil: state.tokenSettings.foil,
      }));
      renderTokenPreview();

      if (!state.tokenMatchPlan.wantedProductIds.size) {
        hideProgress();
        toast('None of the pasted tokens matched a Cardmarket Magic token printing.', 'error');
        return;
      }

      const sellers = targetParcels.map(p => p.seller);
      const cache = await offerCache(false);
      let waitingText = '';
      let waitUntil = 0;

      const result = await trace.span('tokens.collect-sellers', { sellers: sellers.length }, () => collectSellerTokens(sellers, state.tokenMatchPlan, site, {
        maxPriceCents: state.tokenSettings.maxPriceCents,
        tokenIds: new Set(catalog.byId.keys()),
        cache,
        cacheMaxAgeMs: CACHE_MAX_AGE_MS,
        concurrency: 4,
        intervalMs: state.interval,
        bucketIntervals: { cart: 2000, products: 3000 },
        signal: controller.signal,
        waitForUser,
        log: record,
        readRetryDelays: [5000, 10000, 20000, 40000, 80000],
        onDeferred: ({ until }) => chrome.storage.local.set({ collectionRetryAfter: until }),
        onWait: ({ until, retry }) => {
          waitUntil = until;
          waitingText = `Cardmarket asked to slow down — retry ${retry}/5 at ${new Date(until).toLocaleTimeString()}`;
          showProgress('Waiting for Cardmarket rate limit…', waitingText, null);
        },
        onProgress: ({ done, total, seller, requests, retries, fromCache }) => {
          if (Date.now() > waitUntil) waitingText = '';
          const pct = 15 + Math.round((done / Math.max(1, total)) * 80);
          showProgress(
            `Checking basket sellers for cheap tokens (${done}/${total})`,
            `${seller}${fromCache ? ' (cached)' : ''} · ${requests} requests${retries ? ` · ${retries} retries` : ''}`,
            pct,
            waitingText,
          );
        },
      }));

      state.sellerTokenOffers = { ...state.sellerTokenOffers, ...result.offersBySeller };
      hideProgress();
      await trace.span('tokens.optimise', () => reoptimiseTokensFromMemory({ resetBuySellers: false, silent: true }));

      const st = state.tokenResult?.stats;
      if (result.blocked) {
        toast(`Stopped early: ${result.blocked}`, 'error');
      } else if (st && st.physicalTokensBought > 0) {
        toast(`Matched ${st.coveredFaces}/${st.totalRequestedFaces} token faces (${st.physicalTokensBought} cards, +${euros(st.totalAddedCents)}).`, 'success');
      } else {
        toast(`Checked ${sellers.length} basket sellers — no matching tokens within ${euros(state.tokenSettings.maxPriceCents)}.`);
      }
    } catch (error) {
      tokOk = false;
      tokErr = error.message;
      hideProgress();
      record({ type: 'tokens-error', message: error.message });
      toast(`Token lookup failed: ${error.message}`, 'error');
    } finally {
      if (state.controller === controller) state.controller = null;
      state.fetchingTokens = false;
      syncBusyUI();
      await trace.finish({ ok: tokOk, extra: tokErr ? { error: tokErr } : {} });
    }
  }

  // ---- Perf & Logs Tab ----
  function activePerfEntry() {
    if (state.perfHistory.length) {
      return state.perfHistory.find(r => r.id === state.selectedPerfRunId) || state.perfHistory[0];
    }
    if (state.runLog.length) {
      const summary = summarizeRun(state.runLog, { collection: state.collection });
      return { id: 'live', action: summary.action, ok: true, startedAt: summary.startedAt, wallMs: summary.wallMs, summary, events: state.runLog };
    }
    return null;
  }

  function renderPerfTab() {
    const badge = $('tabCountPerf');
    if (badge) badge.textContent = String(state.perfHistory.length);
    const select = $('perfRunSelect');
    const host = $('perfContent');
    if (!select || !host) return;

    if (state.perfHistory.length) {
      if (!state.perfHistory.some(r => r.id === state.selectedPerfRunId)) {
        state.selectedPerfRunId = state.perfHistory[0].id;
      }
      select.innerHTML = state.perfHistory.map(r => {
        const when = r.startedAt ? fmtAge(r.startedAt) : '';
        const reqs = r.summary?.http?.total ?? 0;
        const label = `${r.action}${r.ok === false ? ' [ERR]' : ''} · ${fmtMs(r.wallMs)} · ${reqs} HTTP${when ? ` · ${when}` : ''}`;
        return `<option value="${esc(r.id)}" ${r.id === state.selectedPerfRunId ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('');
      select.disabled = false;
    } else {
      select.innerHTML = '<option value="">No recorded actions yet</option>';
      select.disabled = true;
    }

    const entry = activePerfEntry();
    if (!entry || !entry.summary) {
      host.innerHTML = '<div class="empty-mini">Run Compute Basket, Refetch offers, Check cart, Add to cart, or Find tokens to record detailed timings here.</div>';
      return;
    }

    const s = entry.summary;
    const h = s.http;
    const r = s.runner;
    const parts = [];

    // KPI strip
    parts.push(`<div class="perf-kpis">
      <div class="perf-kpi">
        <span class="perf-kpi-label">Wall Time</span>
        <span class="perf-kpi-value">${esc(fmtMs(s.wallMs))}</span>
        <span class="perf-kpi-sub">${esc(s.action)} · ${s.startedAt ? esc(new Date(s.startedAt).toLocaleTimeString()) : '–'}</span>
      </div>
      <div class="perf-kpi">
        <span class="perf-kpi-label">HTTP Requests</span>
        <span class="perf-kpi-value">${h.total}</span>
        <span class="perf-kpi-sub">${h.effectiveReqPerSec} req/s · ${(h.bytes / 1024).toFixed(0)} KB · ${r.cachedQueries} cached</span>
      </div>
      <div class="perf-kpi">
        <span class="perf-kpi-label">HTTP Latency (p50 / p95)</span>
        <span class="perf-kpi-value">${h.total ? `${h.totalMs.p50Ms} / ${h.totalMs.p95Ms} ms` : '–'}</span>
        <span class="perf-kpi-sub">${h.headersMs.count ? `TTFB p50 ${h.headersMs.p50Ms} ms · body ${h.bodyMs.p50Ms} ms` : 'No network fetches'}</span>
      </div>
      <div class="perf-kpi">
        <span class="perf-kpi-label">Pacer Wait vs Exec</span>
        <span class="perf-kpi-value">${r.calls ? `${esc(fmtMs(r.paceWaitMs))} / ${esc(fmtMs(r.execMs))}` : '–'}</span>
        <span class="perf-kpi-sub">Retries ${r.retries} · 429s ${h.rateLimits} · Challenges ${h.challenges}</span>
      </div>
      <div class="perf-kpi">
        <span class="perf-kpi-label">Bridge IPC Overhead</span>
        <span class="perf-kpi-value">${h.bridgeOverheadMs.count ? `${h.bridgeOverheadMs.p50Ms} / ${h.bridgeOverheadMs.p95Ms} ms` : '–'}</span>
        <span class="perf-kpi-sub">Tab cache hits ${h.tabCacheHits} · misses ${h.tabCacheMisses}</span>
      </div>
    </div>`);

    // Hints
    if (s.hints?.length) {
      parts.push(`<div class="perf-hints">${s.hints.map(hint => `
        <div class="perf-hint perf-hint-${esc(hint.severity)}">
          <strong>${esc(hint.title)}</strong>
          <div>${esc(hint.detail)}</div>
        </div>`).join('')}</div>`);
    }

    // Collection phases
    if (s.phases?.length) {
      parts.push(`<div class="perf-section">
        <h4>Collection Phases</h4>
        <table class="perf-table">
          <thead><tr><th>Phase</th><th class="num">Duration</th><th class="num">Share</th><th class="num">Requests</th><th class="num">Cached</th></tr></thead>
          <tbody>${s.phases.map(p => `<tr>
            <td><strong>${esc(p.phase)}</strong></td>
            <td class="num">${esc(fmtMs(p.ms))}</td>
            <td class="num"><span class="perf-bar"><span style="width:${Math.min(100, Math.round(p.pctOfWall))}%"></span></span> ${p.pctOfWall}%</td>
            <td class="num">${p.requests ?? '–'}</td>
            <td class="num">${p.cachedQueries ?? '–'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`);
    }

    // Action Spans
    if (s.spansList?.length) {
      parts.push(`<div class="perf-section">
        <h4>Action Spans</h4>
        <table class="perf-table">
          <thead><tr><th>Span</th><th class="num">Count</th><th class="num">Total</th><th class="num">p50</th><th class="num">p95</th><th class="num">Max</th><th class="num">Share</th></tr></thead>
          <tbody>${s.spansList.map(sp => `<tr>
            <td><code>${esc(sp.name)}</code>${sp.errors ? ` <span class="badge badge-warn">${sp.errors} err</span>` : ''}</td>
            <td class="num">${sp.count}</td>
            <td class="num">${esc(fmtMs(sp.totalMs))}</td>
            <td class="num">${esc(fmtMs(sp.p50Ms))}</td>
            <td class="num">${esc(fmtMs(sp.p95Ms))}</td>
            <td class="num">${esc(fmtMs(sp.maxMs))}</td>
            <td class="num"><span class="perf-bar"><span style="width:${Math.min(100, Math.round(sp.pctOfWall))}%"></span></span> ${sp.pctOfWall}%</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`);
    }

    // HTTP by bucket
    const bucketEntries = Object.entries(h.byBucket || {}).sort((a, b) => b[1].totalMs.totalMs - a[1].totalMs.totalMs);
    if (bucketEntries.length) {
      parts.push(`<div class="perf-section">
        <h4>HTTP by Endpoint Bucket</h4>
        <table class="perf-table">
          <thead><tr><th>Bucket</th><th class="num">Reqs</th><th class="num">Errs</th><th class="num">Total p50/p95</th><th class="num">TTFB p50</th><th class="num">Body p50</th><th class="num">Bridge p50</th><th class="num">Size</th></tr></thead>
          <tbody>${bucketEntries.map(([name, bk]) => `<tr>
            <td><code>${esc(name)}</code></td>
            <td class="num">${bk.count}</td>
            <td class="num">${bk.errors}</td>
            <td class="num">${bk.totalMs.p50Ms} / ${bk.totalMs.p95Ms} ms</td>
            <td class="num">${bk.headersMs.count ? `${bk.headersMs.p50Ms} ms` : '–'}</td>
            <td class="num">${bk.bodyMs.count ? `${bk.bodyMs.p50Ms} ms` : '–'}</td>
            <td class="num">${bk.bridgeOverheadMs.count ? `${bk.bridgeOverheadMs.p50Ms} ms` : '–'}</td>
            <td class="num">${(bk.bytes / 1024).toFixed(0)} KB</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`);
    }

    // Phase 2 Seller Batches
    if (s.phase2?.sellersAsked > 0) {
      const p2 = s.phase2;
      const batchRows = (p2.batches || []).map((b, i) => `<tr>
        <td>Batch ${i + 1}</td>
        <td class="num">${b.asked ?? '–'}</td>
        <td class="num">${b.pages ?? '–'}</td>
        <td class="num">${b.sellersMs != null ? esc(fmtMs(b.sellersMs)) : '–'}</td>
        <td class="num">${b.evalMs != null ? esc(fmtMs(b.evalMs)) : '–'}</td>
        <td class="num">${b.basketCents != null ? esc(euros(b.basketCents)) : '–'}</td>
        <td class="num">${b.savedCents != null ? esc(euros(b.savedCents)) : '–'}</td>
      </tr>`).join('');
      parts.push(`<div class="perf-section">
        <h4>Phase 2 Seller Expansion</h4>
        <p class="card-hint">Asked ${p2.sellersAsked} sellers (${p2.complete} complete, ${p2.partial} partial, ${p2.errors} errors) · ${p2.totalPages} pages (avg ${p2.avgPagesPerSeller}/seller) · ${p2.ceilingStops} ceiling stops · ${p2.crossGameSkips} cross-game skips · Seller p50 ${esc(fmtMs(p2.sellerMs.p50Ms))} / max ${esc(fmtMs(p2.sellerMs.maxMs))}.</p>
        ${batchRows ? `<table class="perf-table">
          <thead><tr><th>Batch</th><th class="num">Asked</th><th class="num">Pages</th><th class="num">Sellers</th><th class="num">Eval</th><th class="num">Basket</th><th class="num">Saved</th></tr></thead>
          <tbody>${batchRows}</tbody>
        </table>` : ''}
      </div>`);
    }

    // Optimizer Worker
    if (s.optimizer?.length) {
      parts.push(`<div class="perf-section">
        <h4>Optimizer Worker Runs</h4>
        <table class="perf-table">
          <thead><tr><th>Kind</th><th class="num">Total</th><th class="num">Filter</th><th class="num">Quick</th><th class="num">Search</th><th class="num">Cuts</th><th>Details</th></tr></thead>
          <tbody>${s.optimizer.map(op => `<tr>
            <td><code>${esc(op.kind)}</code></td>
            <td class="num">${op.totalMs != null ? esc(fmtMs(op.totalMs)) : '–'}</td>
            <td class="num">${op.filterMs != null ? esc(fmtMs(op.filterMs)) : '–'}</td>
            <td class="num">${op.quickMs != null ? esc(fmtMs(op.quickMs)) : '–'}</td>
            <td class="num">${op.searchMs != null ? esc(fmtMs(op.searchMs)) : '–'}</td>
            <td class="num">${op.cutsMs != null ? esc(fmtMs(op.cutsMs)) : '–'}</td>
            <td>${op.strategies?.length ? esc(op.strategies.map(st => `${st.name} ${st.ms}ms`).join(', ')) : (op.scope ? esc(op.scope) : '–')}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`);
    }

    // Slowest HTTP requests
    if (h.slowest?.length) {
      parts.push(`<div class="perf-section">
        <h4>Slowest HTTP Requests</h4>
        <table class="perf-table">
          <thead><tr><th>Bucket</th><th>Status</th><th class="num">Total</th><th class="num">TTFB</th><th class="num">Bridge</th><th>URL</th></tr></thead>
          <tbody>${h.slowest.map(req => `<tr>
            <td><code>${esc(req.bucket)}</code></td>
            <td>${esc(String(req.status ?? 'err'))}</td>
            <td class="num">${esc(fmtMs(req.ms))}</td>
            <td class="num">${req.headersMs != null ? `${req.headersMs} ms` : '–'}</td>
            <td class="num">${req.bridgeOverheadMs != null ? `${req.bridgeOverheadMs} ms` : '–'}</td>
            <td class="perf-url">${esc(req.url)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`);
    }

    const md = formatPerfMarkdown(s);
    parts.push(`<details class="perf-md-wrap"><summary>Markdown report (copy &amp; paste into an issue or chat for optimization)</summary><pre class="perf-md-pre">${esc(md)}</pre></details>`);
    host.innerHTML = parts.join('');
  }

  // ---- Tabs ----
  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'tokens' && !state.tokenCatalog) {
      ensureTokenCatalog().then(() => refreshTokenPreview()).catch(() => {});
    } else if (name === 'perf') {
      renderPerfTab();
    }
  }

  // ---- Handle incoming context (from Wants List or Product page button) ----
  async function applyContextParams(params) {
    let changed = false;
    if (params.game && params.listId) {
      const listId = String(params.listId);
      const key = `${params.game}:${listId}`;
      const incomingName = typeof params.listName === 'string' ? params.listName.trim() : '';
      const incomingCount = params.count !== undefined && params.count !== null && params.count !== ''
        ? Number(params.count)
        : null;
      const existing = state.knownLists.find(l => `${l.game}:${l.listId}` === key);
      if (!existing) {
        state.knownLists.push({
          game: params.game,
          listId,
          name: incomingName && !isActionListName(incomingName) ? incomingName : fallbackListName(params.game, listId),
          count: Number.isFinite(incomingCount) ? incomingCount : null,
          path: `/en/${params.game}/Wants/${listId}`,
        });
        await saveKnownLists();
      } else {
        let updated = false;
        if (incomingName && !isPlaceholderListName(incomingName) && existing.name !== incomingName) {
          existing.name = incomingName;
          updated = true;
        }
        if (Number.isFinite(incomingCount) && existing.count !== incomingCount) {
          existing.count = incomingCount;
          updated = true;
        }
        if (updated) await saveKnownLists();
      }
      if (!state.selectedLists.includes(key)) {
        state.selectedLists.push(key);
        await saveSettings();
      }
      changed = true;
    }
    if (params.addedProduct) {
      const { extraProducts = [] } = await chrome.storage.local.get('extraProducts');
      state.extraProducts = extraProducts;
      changed = true;
      toast('Extra product added — ready to include in your next basket!', 'success');
    }
    if (changed) {
      renderLists();
      renderProducts();
      await updateCachePill();
    }
  }

  // ---- Init ----
  async function init() {
    // Populate Ship-To dropdown
    $('shipTo').innerHTML = COUNTRIES.map(([id, name]) =>
      `<option value="${id}" ${id === 7 ? 'selected' : ''}>${esc(name)}</option>`
    ).join('');

    // Load persisted state
    const data = await chrome.storage.local.get([
      'bwAppSettings', 'knownWantsLists', 'extraProducts', 'trackedSellers', 'bwRuns', 'productPaths', 'bwTokensState', 'bwPerfHistory',
    ]);
    for (const [id, path] of Object.entries(data.productPaths || {})) knownPaths.set(Number(id), path);
    state.knownLists = (data.knownWantsLists || []).map(l => (
      isActionListName(l.name) ? { ...l, name: fallbackListName(l.game, l.listId) } : l
    ));
    if (state.knownLists.some((l, i) => l !== (data.knownWantsLists || [])[i])) {
      await saveKnownLists();
    }
    state.extraProducts = data.extraProducts || [];
    state.savedRuns = data.bwRuns || [];
    state.perfHistory = Array.isArray(data.bwPerfHistory) ? data.bwPerfHistory : [];
    state.selectedPerfRunId = state.perfHistory[0]?.id || null;
    state.trackedSellers = Object.fromEntries(
      Object.entries(data.trackedSellers || {}).filter(([, at]) => Date.now() - at < TRACKED_MEMORY_MS)
    );
    const s = data.bwAppSettings || {};
    state.selectedLists = s.selectedLists || [];
    state.regionMode = s.regionMode || 'de';
    state.customCountries = Array.isArray(s.customCountries) ? s.customCountries : [...NEIGHBOURS];
    state.shipTo = s.shipTo || 7;
    state.method = s.method || 'sellers';
    const savedInterval = Number(s.interval);
    if (!s.settingsVersion) {
      // Upgrade legacy default (1000 ms) and removed 500 ms preset to the new adaptive default,
      // while preserving an explicit Very careful (2000 ms) choice.
      state.interval = savedInterval === 2000 ? 2000 : DEFAULT_INTERVAL_MS;
      if (data.bwAppSettings) await saveSettings();
    } else {
      state.interval = VALID_INTERVALS.includes(savedInterval) ? savedInterval : DEFAULT_INTERVAL_MS;
    }

    $('shipTo').value = state.shipTo;
    $('method').value = state.method;
    $('interval').value = state.interval;
    $('trackedSellers').value = Object.keys(state.trackedSellers).sort().join(', ');

    const ts = data.bwTokensState || {};
    state.tokensText = typeof ts.text === 'string' ? ts.text : '';
    state.tokenDeckOptions = ts.deckOptions && typeof ts.deckOptions === 'object' ? ts.deckOptions : {};
    if (ts.settings && typeof ts.settings === 'object') {
      state.tokenSettings = { ...state.tokenSettings, ...ts.settings };
    }
    state.includeTokensInBasket = ts.includeTokensInBasket !== false;
    $('tokensInput').value = state.tokensText;
    $('tokenMaxPrice').value = (state.tokenSettings.maxPriceCents / 100).toFixed(2);
    $('tokenMinCond').value = String(state.tokenSettings.minCondition ?? 5);
    $('tokenLanguage').value = state.tokenSettings.language != null ? String(state.tokenSettings.language) : '';
    $('tokenFoil').value = state.tokenSettings.foil || 'N';
    $('chkIncludeTokens').checked = state.includeTokensInBasket;

    renderLists();
    renderProducts();
    renderRegionControls();
    renderSavedRuns();
    refreshTokenPreview();
    renderPerfTab();

    // Handle URL query params (when launched from Cardmarket Wants List or Product page)
    const urlParams = Object.fromEntries(new URLSearchParams(location.search).entries());
    await applyContextParams(urlParams);

    // Listen for live updates when user clicks "Open Better Wizard" or "+ Add" from Cardmarket tabs
    chrome.runtime.onMessage.addListener(msg => {
      if (msg?.type === 'app-context') applyContextParams(msg.params || {});
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.extraProducts) {
        state.extraProducts = changes.extraProducts.newValue || [];
        renderProducts();
        updateCachePill();
      }
    });

    // ---- Event Listeners ----
    $('btnCompute').addEventListener('click', handleComputeClick);
    $('btnRefetch').addEventListener('click', () => fetchAndCompute({ forceFresh: true }));
    $('btnStop').addEventListener('click', () => state.controller?.abort());
    $('btnClearLists').addEventListener('click', clearAllLists);
    $('btnAddManualList').addEventListener('click', addManualList);
    $('manualListUrl').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addManualList(); }
    });

    const handleAddProduct = async () => {
      const val = $('productUrlInput').value;
      if (!val.trim()) return;
      await addProductFromUrl(val);
      $('productUrlInput').value = '';
    };
    $('btnAddProduct').addEventListener('click', handleAddProduct);
    $('productUrlInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); handleAddProduct(); }
    });

    $('regionMode').querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.regionMode = btn.dataset.region;
        renderRegionControls();
        await saveSettings();
        await updateCachePill();
      });
    });

    $('customCountriesBox').querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const preset = btn.dataset.preset;
        state.customCountries = preset === 'neighbours' ? [...NEIGHBOURS] : preset === 'eu' ? [...EU_IDS] : [];
        renderRegionControls();
        await saveSettings();
        await updateCachePill();
      });
    });

    $('shipTo').addEventListener('change', async () => {
      if (workInProgress()) { $('shipTo').value = state.shipTo; return; }
      state.shipTo = Number($('shipTo').value);
      await saveSettings();
      await updateCachePill();
      if (state.collection) await computeBasketFromCollection();
    });
    $('method').addEventListener('change', async () => { state.method = $('method').value; await saveSettings(); });
    $('interval').addEventListener('change', async () => { state.interval = Number($('interval').value); await saveSettings(); });
    $('trackedSellers').addEventListener('change', async () => {
      if (workInProgress()) { $('trackedSellers').value = Object.keys(state.trackedSellers).sort().join(', '); return; }
      const names = $('trackedSellers').value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const next = Object.fromEntries(names.map(n => [n, state.trackedSellers[n] || Date.now()]));
      await rememberTracked(next);
      if (state.collection) await computeBasketFromCollection();
    });

    $('btnToggleLimits').addEventListener('click', () => {
      state.limitsOpen = !state.limitsOpen;
      $('limitsEditor').hidden = !state.limitsOpen;
      $('btnToggleLimits').textContent = state.limitsOpen ? 'Hide estimator' : 'Estimate limits';
      if (state.limitsOpen) {
        renderScopePills();
        estimateLimitsForCurrentScope();
      }
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('buySellers').addEventListener('input', updateBuySummary);
    $('buySellers').addEventListener('change', () => {
      if (state.tokenResult && Object.keys(state.sellerTokenOffers).length) {
        reoptimiseTokensFromMemory({ resetBuySellers: false, silent: true });
      }
    });

    // ---- Tokens Tab Event Listeners ----
    let tokenInputTimer = null;
    $('tokensInput').addEventListener('input', () => {
      state.tokensText = $('tokensInput').value;
      clearTimeout(tokenInputTimer);
      tokenInputTimer = setTimeout(() => {
        saveTokenState();
        refreshTokenPreview();
        reoptimiseTokensFromMemory({ resetBuySellers: false, silent: true });
      }, 180);
    });
    $('btnAddTokenDeck').addEventListener('click', () => {
      const existing = parseTokenListText($('tokensInput').value, state.tokenDeckOptions);
      const nextNum = existing.length + 1;
      const prefix = $('tokensInput').value.trim() ? '\n\n' : '';
      $('tokensInput').value += `${prefix}# Deck ${nextNum}\n`;
      state.tokensText = $('tokensInput').value;
      $('tokensInput').focus();
      saveTokenState();
      refreshTokenPreview();
    });
    $('btnExampleTokens').addEventListener('click', () => {
      $('tokensInput').value = EXAMPLE_TOKENS;
      state.tokensText = EXAMPLE_TOKENS;
      saveTokenState();
      refreshTokenPreview();
      reoptimiseTokensFromMemory({ resetBuySellers: false, silent: true });
    });
    $('btnClearTokens').addEventListener('click', () => {
      $('tokensInput').value = '';
      state.tokensText = '';
      state.tokenResult = null;
      saveTokenState();
      refreshTokenPreview();
      renderTokenResults();
      renderKpis(false);
      renderParcelsAndTabs({ resetBuySellers: false });
    });

    const onTokenSettingChange = async () => {
      const eur = Number(String($('tokenMaxPrice').value || '0.20').replace(',', '.'));
      state.tokenSettings = {
        maxPriceCents: Number.isFinite(eur) && eur > 0 ? Math.max(1, Math.round(eur * 100)) : 20,
        minCondition: Number($('tokenMinCond').value) || 5,
        language: $('tokenLanguage').value ? Number($('tokenLanguage').value) : null,
        foil: $('tokenFoil').value || 'N',
      };
      await saveTokenState();
      refreshTokenPreview();
      reoptimiseTokensFromMemory({ resetBuySellers: false, silent: true });
    };
    $('tokenMaxPrice').addEventListener('change', onTokenSettingChange);
    $('tokenMinCond').addEventListener('change', onTokenSettingChange);
    $('tokenLanguage').addEventListener('change', onTokenSettingChange);
    $('tokenFoil').addEventListener('change', onTokenSettingChange);
    $('chkIncludeTokens').addEventListener('change', async () => {
      state.includeTokensInBasket = $('chkIncludeTokens').checked;
      await saveTokenState();
      renderKpis(false);
      renderParcelsAndTabs({ resetBuySellers: false });
    });
    $('btnFindTokens').addEventListener('click', findTokensAtBasketSellers);
    $('btnReoptTokens').addEventListener('click', () => reoptimiseTokensFromMemory({ resetBuySellers: false, silent: false }));
    $('btnExpandAllSellers').addEventListener('click', () => setAllSellersExpanded(true));
    $('btnCollapseAllSellers').addEventListener('click', () => setAllSellersExpanded(false));
    $('btnCopyBreakdown').addEventListener('click', copyBreakdownSummary);
    $('btnBuy').addEventListener('click', addToCart);
    $('btnCheckCart').addEventListener('click', () => checkCart());
    $('btnCopyPlain').addEventListener('click', () => handleExportEntries(basketEntries(), 'plain', 'basket items'));
    $('btnCopyArchidekt').addEventListener('click', () => handleExportEntries(basketEntries(), 'archidekt', 'Magic cards'));
    $('limitsTableWrap').addEventListener('click', e => {
      const infoBtn = e.target.closest('[data-limit-info]');
      if (!infoBtn) return;
      e.preventDefault();
      e.stopPropagation();
      const raw = infoBtn.dataset.limitInfo;
      if (raw === 'custom') {
        const inputVal = $('customLimitInput')?.value.replace(',', '.');
        const centsVal = Math.round(Number(inputVal) * 100);
        if (!(centsVal > 0)) {
          toast('Enter a valid price limit in € to preview left-out cards.', 'error');
          $('customLimitInput')?.focus();
          return;
        }
        openLimitInfoModal(centsVal, { isCustom: true });
        return;
      }
      const centsVal = Number(raw);
      if (centsVal > 0) openLimitInfoModal(centsVal);
    });
    $('limitsTableWrap').addEventListener('change', e => {
      if (e.target.matches('input[name="bwLimit"]')) {
        state.selectedLimitChoice = e.target.value;
      }
    });
    $('limitInfoModalClose').addEventListener('click', closeLimitInfoModal);
    $('limitInfoModalCloseX').addEventListener('click', closeLimitInfoModal);
    $('limitInfoSelect').addEventListener('click', selectLimitFromModal);
    $('limitInfoModal').addEventListener('click', e => { if (e.target === $('limitInfoModal')) closeLimitInfoModal(); });
    $('exportModalClose').addEventListener('click', closeExportModal);
    $('exportModalCloseX').addEventListener('click', closeExportModal);
    $('exportModal').addEventListener('click', e => { if (e.target === $('exportModal')) closeExportModal(); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('limitInfoModal').hidden) closeLimitInfoModal();
      else if (!$('exportModal').hidden) closeExportModal();
    });
    $('btnForgetCart').addEventListener('click', async () => {
      const { key } = await alreadyAdded();
      await chrome.storage.local.remove(key);
      toast('Cleared added-to-cart memory for this selection.');
    });

    $('btnOpenRun').addEventListener('click', async () => {
      const id = $('savedRuns').value;
      if (!id) return;
      const data = await chrome.storage.local.get(id);
      const col = data[id];
      const snapKey = col?.stats?.finishedAt ? snapshotKeyFor(col) : null;
      const snap = snapKey ? (await chrome.storage.local.get(snapKey))[snapKey] : null;
      const useSnap = snap && confirm(
        `This run has a basket you added to your cart on ${new Date(snap.orderedAt || snap.createdAt).toLocaleString()}.\n\n` +
        'OK: show that exact basket.\nCancel: re-optimise from the saved offers.',
      );
      await openSavedCollection(col, { snapshot: useSnap ? snap : null, source: 'saved run' });
    });

    $('importFile').addEventListener('change', async () => {
      const file = $('importFile').files[0];
      $('importFile').value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const col = parsed.collection || parsed;
        const snapshot = parsed.basketSnapshot && readBasketSnapshot(parsed.basketSnapshot) ? parsed.basketSnapshot : null;
        if (parsed.basketSnapshot && !snapshot) toast('This file has a basket from an unsupported version; loaded the saved offers only.', 'error');
        await openSavedCollection(col, { snapshot, source: `file ${file.name}`, autoCompute: false });
      } catch (error) {
        toast(`Import failed: ${error.message}`, 'error');
      }
    });

    $('btnDownload').addEventListener('click', async () => {
      if (!state.collection) return;
      if (state.optimising) { toast('Wait for the basket optimisation to finish before exporting.', 'error'); return; }
      const latestPerf = state.perfHistory[0]?.summary || summarizeRun(state.runLog, { collection: state.collection });
      let basketSnapshot = null;
      try {
        basketSnapshot = await buildCurrentSnapshot();
      } catch (error) {
        toast(`Basket not included in export: ${error.message}`, 'error');
      }
      const payload = {
        collection: state.collection,
        basketSnapshot,
        log: state.runLog,
        perf: latestPerf,
        perfHistory: state.perfHistory,
      };
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
      link.download = `cardmarket-better-wizard-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });

    $('btnOpenPerf')?.addEventListener('click', () => {
      $('emptyState').hidden = true;
      $('resultsArea').hidden = false;
      switchTab('perf');
    });

    $('perfRunSelect')?.addEventListener('change', e => {
      state.selectedPerfRunId = e.target.value || null;
      renderPerfTab();
    });

    $('btnCopyPerfMd')?.addEventListener('click', async () => {
      const entry = activePerfEntry();
      if (!entry?.summary) { toast('No performance report to copy yet.', 'error'); return; }
      try {
        await navigator.clipboard.writeText(formatPerfMarkdown(entry.summary));
        toast('Copied Markdown performance report to clipboard.', 'success');
      } catch (err) {
        toast(`Could not copy report: ${err.message}`, 'error');
      }
    });

    $('btnDownloadPerf')?.addEventListener('click', () => {
      const payload = {
        exportedAt: new Date().toISOString(),
        runs: state.perfHistory,
        liveLog: state.runLog,
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `cardmarket-wizard-perf-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    $('btnClearPerf')?.addEventListener('click', async () => {
      state.perfHistory = [];
      state.selectedPerfRunId = null;
      await chrome.storage.local.remove('bwPerfHistory');
      renderPerfTab();
      toast('Cleared saved performance history.');
    });

    const cacheInfo = await updateCachePill();
    if (cacheInfo.status === 'fresh' && cacheInfo.collection) {
      state.collection = cacheInfo.collection;
      await loadLimitsAndCutsFor(cacheInfo.sig);
      await computeBasketFromCollection();
    }
  }

  init();
})();
