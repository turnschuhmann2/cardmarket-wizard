// Full-page Cardmarket Better Wizard web app.
// Coordinates the Cardmarket tab bridge, 8-hour offer cache, Web Worker optimizer,
// scoped per-game/per-list price limits, multi-country shipping, and cart checkout.
(() => {
  'use strict';

  const {
    collect, collectBySellers, createRunner, browserSite, BlockedError, RetryableError, RefusedError, CACHE_MAX_AGE_MS,
  } = globalThis.CardmarketCollector;
  const {
    parseShippingTable, scopeKey, filterByLimits, matchesScope,
  } = globalThis.CardmarketWizard;
  const {
    collectBasketEntries, collectLeftOutEntries, groupExportEntries,
    formatArchidektExport, formatPlainExport, safeExportFilename,
  } = globalThis.CardmarketExport;

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
  const EU_IDS = COUNTRIES.filter(([id]) => ![36, 29].includes(id)).map(([id]) => id);
  const THOROUGH = { splitBySellerType: true, groupSkipFactor: 3, minSellers: 80, sellerBatch: 20, sellerLimit: 200, improvementCents: 20 };
  const LIMIT_CANDIDATES = [50, 100, 200, 300, 500, 1000, 2000];
  const TRACKED_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
  const CART_MEMORY_MS = 12 * 60 * 60 * 1000;
  const KEPT_RUNS = 15;

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

  function toast(message, kind = 'default') {
    const el = document.createElement('div');
    el.className = `toast ${kind === 'error' ? 'toast-error' : kind === 'success' ? 'toast-success' : ''}`;
    el.textContent = message;
    $('toastHost').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  // ---- Bridge Fetch (routes requests through an authenticated Cardmarket tab) ----
  async function bridgeFetch(url, init = {}) {
    const fullUrl = url.startsWith('http') ? url : `https://www.cardmarket.com${url}`;
    const payload = { type: 'cm-fetch', url: fullUrl, method: init.method || 'GET' };
    if (init.body instanceof FormData) payload.formEntries = [...init.body.entries()];
    const res = await chrome.runtime.sendMessage(payload);
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
    };
  }

  async function bridgeToken() {
    const res = await chrome.runtime.sendMessage({ type: 'cm-token' });
    return res?.token || null;
  }

  // ---- Web Worker Client ----
  const worker = new Worker('optimizer-worker.js');
  let nextWorkerId = 1;
  const workerJobs = new Map();
  worker.onmessage = event => {
    const msg = event.data;
    const job = workerJobs.get(msg?.id);
    if (!job) return;
    if (msg.event === 'error') {
      workerJobs.delete(msg.id);
      job.reject(new Error(msg.error));
      return;
    }
    if (msg.event === 'done') {
      workerJobs.delete(msg.id);
      job.resolve(msg);
      return;
    }
    job.onEvent?.(msg);
  };
  function runWorker(payload, onEvent) {
    const id = nextWorkerId++;
    return new Promise((resolve, reject) => {
      workerJobs.set(id, { resolve, reject, onEvent });
      worker.postMessage({ id, ...payload });
    });
  }

  // ---- App State ----
  const state = {
    knownLists: [],          // [{ game, listId, name, count, path }]
    selectedLists: [],       // ['Magic:123', 'YuGiOh:456']
    extraProducts: [],       // [{ id, idProduct, name, game, category, productPath, url, amount, enabled }]
    regionMode: 'de',        // 'de' | 'eu' | 'custom'
    customCountries: [...NEIGHBOURS],
    shipTo: 7,
    method: 'sellers',
    interval: 1000,
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
    limitBaselineCents: null,
    optimiseJobId: 0,
    optimising: false,
    fetching: false,
    carting: false,
    controller: null,
    runLog: [],
    currentTables: null,
    savedRuns: [],
  };

  const record = event => state.runLog.push({ t: new Date().toISOString(), ...event });

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
    if (state.regionMode === 'eu') return [];
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
    const regionPart = state.regionMode === 'eu' ? 'eu' : getSellerCountries().join('.');
    return `${listsPart}|${prodsPart}|${regionPart}`;
  }

  function collectionKeyFor(sig) { return `bwCol:${sig}`; }
  function limitsKeyFor(sig) { return `bwLimits:${sig}`; }
  function cutsKeyFor(sig) { return `bwCuts:${sig}`; }

  // ---- Persistence ----
  async function saveSettings() {
    await chrome.storage.local.set({
      bwAppSettings: {
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
    const { tables, failed = [], error } = await chrome.runtime.sendMessage({
      type: 'shipping-multi',
      fromList: fromIds,
      to: state.shipTo,
    });
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
    return { default: defaultTable, byLocation, failed };
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
      const label = `${new Date(r.at).toLocaleString()} · ${r.cards} items${r.totalCents ? ` · ${euros(r.totalCents)} (${r.sellers} sellers)` : ''}`;
      return `<option value="${esc(r.id)}">${esc(label)}</option>`;
    }).join('');
  }

  // ---- Progress & Busy Controls ----
  function syncBusyUI() {
    const working = state.fetching || state.carting;
    const computeBtn = $('btnCompute');
    computeBtn.disabled = working;
    $('btnRefetch').disabled = working;
    $('btnOpenRun').disabled = working;
    $('importFile').disabled = working;
    $('btnBuy').disabled = working || state.optimising;
    $('btnStop').hidden = !(working && state.controller);
    computeBtn.querySelector('.btn-spinner').hidden = !(working || state.optimising);
    $('btnComputeLabel').textContent = state.fetching ? 'Fetching offers…'
      : state.carting ? 'Adding to cart…'
        : state.optimising ? 'Optimising…' : 'Compute Basket';
  }

  // Recompute triggers must not overlap a fetch or cart run.
  function workInProgress() {
    if (!state.fetching && !state.carting) return false;
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

  function renderLimitsSkeleton(rows = 5, partial = []) {
    const existingRows = partial.map(opt => `
      <tr>
        <td><input type="radio" name="bwLimit" value="${opt.cents}"></td>
        <td><strong>${euros(opt.cents)}</strong></td>
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
    const rows = state.limitOptions.map(opt => `
      <tr>
        <td><input type="radio" name="bwLimit" value="${opt.cents}" ${opt.suggested ? 'checked' : ''}></td>
        <td><strong>${euros(opt.cents)}</strong> ${opt.suggested ? '<span class="badge badge-indigo">suggested</span>' : ''}</td>
        <td class="num">${opt.cards}</td>
        <td class="num">${euros(opt.leftOutCents)}</td>
        <td class="num">${euros(opt.basketCents)}</td>
        <td class="num" style="color:var(--emerald);font-weight:700">${euros(opt.savesCents)}</td>
      </tr>`).join('');

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
            <td><input type="radio" name="bwLimit" value="custom" ${!state.limitOptions.length ? 'checked' : ''}></td>
            <td colspan="5">
              Other: <input id="customLimitInput" class="input" style="width:90px;display:inline-block" placeholder="1,50"> €
            </td>
          </tr>
          ${hasBroader ? `
          <tr>
            <td><input type="radio" name="bwLimit" value="none"></td>
            <td colspan="5"><strong>No limit for ${esc(scope.label)}</strong> <span class="card-hint">(overrides broader limit)</span></td>
          </tr>` : ''}
        </tbody>
      </table>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <button type="button" id="btnApplyLimit" class="btn btn-primary btn-sm">Apply limit &amp; recompute basket</button>
      </div>`;

    $('btnApplyLimit').addEventListener('click', applySelectedLimit);
  }

  async function estimateLimitsForCurrentScope() {
    if (!state.collection || !state.currentTables) return;
    const myJob = ++state.limitEstimateJobId;
    state.limitOptions = [];
    const partial = [];
    renderLimitsSkeleton(5, partial);
    try {
      const res = await runWorker({
        type: 'suggest-limits',
        collection: state.collection,
        tables: state.currentTables,
        trackedOnly: Object.keys(state.trackedSellers),
        activeLimits: state.activeLimits,
        manualCuts: state.manualCuts,
        scope: state.limitScope,
        candidates: LIMIT_CANDIDATES,
      }, ev => {
        if (myJob !== state.limitEstimateJobId) return;
        if (ev.event === 'limit-row') {
          partial.push(ev.option);
          renderLimitsSkeleton(5, partial);
        }
      });
      if (myJob !== state.limitEstimateJobId || res.cancelled) return;
      state.limitOptions = res.options || [];
      state.limitBaselineCents = res.baselineCents;
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
    const b = state.basket;
    if (!b) return;
    const covered = b.curve.at(-1)?.cards || 0;
    const totalWanted = covered + b.missing.length;
    const itemsCents = b.totalCents - b.shippingCents;
    const crossCount = b.parcels.filter(p => (p.games?.length || 0) > 1 || p.hasProducts).length;

    $('kpiTotal').textContent = euros(b.totalCents);
    $('kpiTotalSub').className = `kpi-sub ${note ? 'good' : ''}`;
    $('kpiTotalSub').textContent = optimising ? 'Searching for cheaper seller combos…' : note || 'Optimised total';
    $('kpiSplit').textContent = `${euros(itemsCents)} + ${euros(b.shippingCents)}`;
    $('kpiSplitSub').textContent = `${b.totalCents ? Math.round((b.shippingCents / b.totalCents) * 100) : 0}% shipping`;
    $('kpiSellers').textContent = `${b.parcels.length}`;
    $('kpiSellersSub').textContent = crossCount ? `${crossCount} combined multi-game/product parcel${crossCount > 1 ? 's' : ''}` : 'Optimized seller count';
    $('kpiItems').textContent = `${covered} / ${totalWanted}`;
    $('kpiItemsSub').textContent = b.missing.length ? `${b.missing.length} unavailable` : '100% covered';
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

  function updateBuySummary() {
    if (!state.basket) return;
    const max = Math.max(1, state.basket.parcels.length);
    const n = Math.min(max, Math.max(1, Number($('buySellers').value) || max));
    const pt = state.basket.curve[n - 1];
    $('buySummary').textContent = pt ? `${pt.cards} items · ${euros(pt.totalCents)} total` : '';
    updateExportButtons();
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

  function renderParcelsAndTabs() {
    const b = state.basket;
    if (!b) return;
    $('buySellers').max = Math.max(1, b.parcels.length);
    $('buySellers').value = b.parcels.length;
    updateBuySummary();

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
    $('parcelsList').innerHTML = b.parcels.map((p, idx) => {
      const badges = [];
      if (p.location) badges.push(`<span class="badge badge-neutral">${esc(p.location)}</span>`);
      const games = p.games || [];
      if (games.length > 1) badges.push('<span class="badge badge-combo">MTG + YGO combined</span>');
      else if (games[0]) badges.push(`<span class="badge ${games[0] === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${games[0] === 'YuGiOh' ? 'YGO' : 'MTG'}</span>`);
      if (p.hasProducts) badges.push('<span class="badge badge-product">+ Product</span>');

      return `
        <details class="parcel-card" ${idx < 3 ? 'open' : ''}>
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
            </div>
          </summary>
          <div class="parcel-items-wrap">
            <table class="data-table">
              <thead><tr><th>Item</th><th>Source</th><th class="num">Price</th><th class="num">Market</th></tr></thead>
              <tbody>
                ${p.items.map(item => `
                  <tr>
                    <td>
                      <strong>${esc(item.name)}</strong>
                      ${item.foil ? '<span class="badge badge-indigo">Foil</span>' : ''}
                      ${item.aboveMarket ? '<span class="badge badge-warn">above market</span>' : ''}
                    </td>
                    <td>
                      ${item.kind === 'product'
                        ? '<span class="badge badge-product">Product</span>'
                        : `<span class="badge ${item.game === 'YuGiOh' ? 'badge-ygo' : 'badge-mtg'}">${item.game === 'YuGiOh' ? 'YGO' : 'MTG'}</span>`}
                      ${item.listName ? `<span style="font-size:12px;color:var(--text-muted)">${esc(item.listName)}</span>` : ''}
                    </td>
                    <td class="num"><strong>${euros(item.priceCents)}</strong></td>
                    <td class="num" style="color:var(--text-muted)">${euros(item.targetCents)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>`;
    }).join('');
    $('parcelsList').querySelectorAll('details.parcel-card').forEach(card => {
      card.addEventListener('toggle', updateSellerCollapseControls);
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
        updateBuySummary();
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
  async function computeBasketFromCollection() {
    const col = state.collection;
    if (!col) return;
    const myJob = ++state.optimiseJobId;
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
      const { [bestKey]: previous } = await chrome.storage.local.get(bestKey);
      if (myJob !== state.optimiseJobId) return;

      showProgress('Optimising basket across sellers…', 'Running multi-strategy search in background worker', 25);

      const result = await runWorker({
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

      if (myJob !== state.optimiseJobId || result.cancelled) return;
      state.basket = result.basket;
      state.cuts = result.cuts || [];
      state.optimising = false;
      syncBusyUI();

      if (Number.isFinite(state.basket.totalCents)) {
        await chrome.storage.local.set({
          [bestKey]: { totalCents: state.basket.totalCents, picks: state.basket.picks },
        });
        if (myJob !== state.optimiseJobId) return;
      }

      const savedVsQuick = result.quickCents - state.basket.totalCents;
      const note = result.keptPrevious
        ? 'Kept better verified basket'
        : savedVsQuick > 0
          ? `Search saved ${euros(savedVsQuick)} vs quick basket`
          : 'Optimal basket found';

      renderKpis(false, note);
      renderCutsAndLeftOut(false);
      renderParcelsAndTabs();
      renderActiveLimits();
      if (state.limitsOpen) estimateLimitsForCurrentScope();
      hideProgress();
      await saveRunSummary(col);
    } catch (error) {
      if (myJob !== state.optimiseJobId) return;
      hideProgress();
      toast(`Optimisation failed: ${error.message}`, 'error');
    } finally {
      if (myJob === state.optimiseJobId) {
        state.optimising = false;
        syncBusyUI();
      }
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

    if (state.fetching || state.carting) return;
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
    record({ type: 'start', forceFresh, lists: selectedLists, products: enabledProducts.length, sellerCountries, shipTo: state.shipTo });

    try {
      const { collectionRetryAfter: holdUntil } = await chrome.storage.local.get('collectionRetryAfter');
      if (Date.now() < holdUntil) {
        throw new Error(`Cardmarket asked to wait until ${new Date(holdUntil).toLocaleTimeString()}.`);
      }

      // 1. Read every selected Wants List & plan printings per game.
      const combinedEntries = [];
      let priceGuideCreatedAt = null;
      const warnings = [];
      for (const [idx, list] of selectedLists.entries()) {
        showProgress(`Reading Wants List ${idx + 1}/${selectedLists.length}…`, list.name, 6 + Math.round((idx / Math.max(1, selectedLists.length)) * 8));
        const fetched = await site.wantsList(list.game, list.listId);
        list.name = fetched.name || list.name;
        list.count = fetched.wants.length;
        const { plan, error } = await chrome.runtime.sendMessage({ type: 'plan', game: list.game, wants: fetched.wants });
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
      let evalTables = await loadShippingTablesFor({ results: [] });
      const triedLocations = new Set(Object.keys(evalTables.byLocation));
      const trackedOnly = Object.keys(state.trackedSellers);
      const cache = await offerCache(forceFresh);

      let waitingText = '';
      let waitUntil = 0;
      const common = {
        sellerCountries,
        intervalMs: state.interval,
        signal: controller.signal,
        cache,
        cacheMaxAgeMs: forceFresh ? 0 : CACHE_MAX_AGE_MS,
        waitForUser,
        log: record,
        readRetryDelays: [5000, 10000, 20000, 40000, 80000],
        onDeferred: ({ until }) => chrome.storage.local.set({ collectionRetryAfter: until }),
        onWait: ({ until, retry }) => {
          waitUntil = until;
          waitingText = `Cardmarket asked to slow down — retry ${retry}/5 at ${new Date(until).toLocaleTimeString()}`;
          showProgress('Waiting for Cardmarket rate limit…', waitingText, null);
        },
        onProgress: ({ phase, done, total, requests, retries }) => {
          if (Date.now() > waitUntil) waitingText = '';
          const pct = phase === 'sellers'
            ? 60 + Math.round((done / Math.max(1, total)) * 35)
            : 15 + Math.round((done / Math.max(1, total)) * 45);
          const title = phase === 'sellers'
            ? `Reading top sellers' overlap (${done}/${total})`
            : `Reading item pages (${done}/${total})`;
          showProgress(title, `${requests} requests${retries ? ` · ${retries} retries` : ''}`, pct, waitingText);
        },
      };

      const planObj = { entries: combinedEntries };
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
        return res.totalCents;
      };

      const result = state.method === 'printings'
        ? await collect(planObj, site, common)
        : await collectBySellers(planObj, site, {
            ...common,
            lists: selectedLists,
            evaluate,
            ...(state.method === 'thorough' ? THOROUGH : {}),
          });

      result.profile = state.method;
      const col = Object.assign(result, {
        selectionSig: sig,
        lists: selectedLists.map(l => ({ game: l.game, listId: l.listId, name: l.name })),
        products: enabledProducts.map(p => ({ name: p.name, productPath: p.productPath, amount: p.amount || 1, category: p.category, game: p.game })),
        priceGuideCreatedAt,
        warnings,
      });

      state.collection = col;
      await chrome.storage.local.set({ [collectionKeyFor(sig)]: col });
      await loadLimitsAndCutsFor(sig);
      await updateCachePill();
      release();
      await computeBasketFromCollection();
    } catch (error) {
      hideProgress();
      release();
      record({ type: 'error', message: error.message });
      toast(`Fetch failed: ${error.message}`, 'error');
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

    // Cache is missing, incomplete, or >8 hours old -> show clear confirmation modal!
    const reasonText = info.status === 'stale'
      ? `Your cached offers for this selection are ${fmtAge(info.collection.stats.finishedAt)} (older than 8 hours). Computing will refetch all selected cards and products from Cardmarket so prices and stock are up to date.`
      : info.status === 'incomplete'
        ? `Your cached fetch for this selection stopped early (${fmtAge(info.collection.stats.finishedAt)}). Computing will refetch the remaining cards and products from Cardmarket.`
        : 'No offer cache exists yet for the selected lists, products, and seller region. Computing will fetch all selected cards and products from Cardmarket first.';

    const choice = await askCacheModal({
      title: info.status === 'stale' ? 'Offer cache is older than 8 hours' : 'Offer cache needs to be fetched',
      body: reasonText,
      allowOld: Boolean(info.collection),
    });

    if (choice === 'cancel') return;
    if (choice === 'old' && info.collection) {
      state.collection = info.collection;
      await loadLimitsAndCutsFor(info.sig);
      await computeBasketFromCollection();
      return;
    }
    await fetchAndCompute({ forceFresh: info.status === 'stale' });
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
    const productPath = parsed.pathname;
    const existing = state.extraProducts.find(p => p.productPath === productPath);
    if (existing) {
      existing.amount = (existing.amount || 1) + 1;
      existing.enabled = true;
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
    };
    const next = [summary, ...state.savedRuns.filter(r => r.id !== id)].sort((a, b) => b.at - a.at).slice(0, KEPT_RUNS);
    const dropped = state.savedRuns.filter(r => !next.some(n => n.id === r.id)).map(r => r.id);
    state.savedRuns = next;
    await chrome.storage.local.set({ [id]: col, bwRuns: next });
    if (dropped.length) await chrome.storage.local.remove(dropped);
    renderSavedRuns();
  }

  async function openSavedCollection(col) {
    if (workInProgress()) return;
    if (!Array.isArray(col?.results) || !col.stats?.finishedAt) {
      toast('Not a valid Better Wizard run file.', 'error');
      return;
    }
    state.collection = col;
    if (col.selectionSig) await loadLimitsAndCutsFor(col.selectionSig);
    else { state.activeLimits = []; state.manualCuts = []; }
    await updateCachePill();
    await computeBasketFromCollection();
    toast(`Opened run from ${new Date(col.stats.finishedAt).toLocaleString()}.`, 'success');
  }

  // ---- Exports (Plain & Archidekt, combined or per Wants List) ----
  const scryfallPrintingCache = new Map();

  function basketEntries() {
    if (!state.basket) return [];
    const n = Math.max(1, Number($('buySellers').value) || state.basket.parcels.length);
    return collectBasketEntries(state.basket.parcels.slice(0, n));
  }

  function leftOutEntries() {
    return collectLeftOutEntries(state.leftOut);
  }

  function updateExportButtons() {
    if (!state.basket) return;
    const entries = basketEntries();
    const archGroups = groupExportEntries(entries, 'archidekt');
    const plainGroups = groupExportEntries(entries, 'plain');
    $('btnCopyArchidekt').hidden = archGroups.length === 0;
    $('btnCopyArchidekt').textContent = archGroups.length > 1 ? 'Export for Archidekt ▾' : 'Copy for Archidekt';
    $('btnCopyPlain').textContent = plainGroups.length > 1 ? 'Export list ▾' : 'Copy list';
  }

  async function resolvePrintings(entries) {
    const ids = [...new Set(
      (entries || [])
        .filter(e => (e.game || 'Magic') === 'Magic' && e.kind !== 'product')
        .map(e => e.idProduct)
        .filter(Boolean)
    )];
    const missing = ids.filter(id => !scryfallPrintingCache.has(id));
    if (missing.length) {
      toast('Looking up Scryfall set codes…');
      const { found = {}, error } = await chrome.runtime.sendMessage({ type: 'printings', ids: missing });
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
    const magicOnly = (entries || []).filter(e => (e.game || 'Magic') === 'Magic' && e.kind !== 'product');
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
      notice.textContent = `Archidekt supports Magic cards only — ${skippedNonMagic} non-Magic / product item${skippedNonMagic === 1 ? '' : 's'} omitted here (use Export list for those).`;
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

  async function checkCart(existingRunner = null) {
    const out = $('cartCheckBox');
    out.innerHTML = '<div class="alert-banner alert-info" style="margin-bottom:12px"><span>Reading your Cardmarket shopping cart…</span></div>';
    try {
      const runner = existingRunner || createRunner(site, { intervalMs: state.interval, log: record });
      const shipments = await runner.call('cartShipping');
      const learned = [];
      const known = { ...state.trackedSellers };
      for (const s of shipments) {
        if (s.trackedOnly && !known[s.seller]) learned.push(s.seller);
        if (s.trackedOnly) known[s.seller] = Date.now();
      }
      if (learned.length) await rememberTracked(known);
      const predicted = new Map((state.basket?.parcels || []).map(p => [p.seller, p]));
      const diffs = shipments.filter(s => predicted.has(s.seller) && s.shippingCents !== predicted.get(s.seller).shippingCents);
      const sum = k => shipments.reduce((t, s) => t + (s[k] || 0), 0);
      out.innerHTML = `<div class="alert-banner alert-info" style="margin-bottom:12px">
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
      out.innerHTML = `<div class="alert-banner alert-warn" style="margin-bottom:12px">Could not read cart: ${esc(error.message)}</div>`;
    }
  }

  async function addToCart() {
    if (!state.basket || state.fetching || state.carting || state.optimising) return;
    const n = Math.max(1, Number($('buySellers').value) || state.basket.parcels.length);
    const parcels = state.basket.parcels.slice(0, n);
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

    const totalItems = orders.reduce((s, o) => s + o.items.reduce((m, i) => m + i.amount, 0), 0);
    if (!totalItems) { toast(`All ${skipped} items from these sellers were already added to your cart.`); return; }
    if (!confirm(`Add ${totalItems} items from ${orders.length} sellers to your Cardmarket cart?` + (skipped ? `\n(${skipped} already added earlier will be skipped.)` : ''))) return;

    state.carting = true;
    const controller = new AbortController();
    state.controller = controller;
    syncBusyUI();
    const runner = createRunner(site, { intervalMs: state.interval, signal: controller.signal, waitForUser, log: record });
    const failed = [];
    let done = 0;
    const mark = async items => {
      for (const item of items) added[item.idArticle] = Date.now();
      done += items.reduce((s, i) => s + i.amount, 0);
      await chrome.storage.local.set({ [cartKey]: added });
    };
    try {
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
            await runner.call('addSellerToCart', groupItems, g);
            await mark(groupItems);
          } catch (error) {
            if (error instanceof BlockedError) throw error;
            if (error instanceof RetryableError || error instanceof RefusedError || error instanceof TypeError) {
              // The outcome is unknown and the items may already be in the cart: retrying per item could duplicate them.
              failed.push(`${groupItems.map(item => item.name).join(', ')} (${order.seller}): ${error.message}. Check your Cardmarket cart before retrying`);
              continue;
            }
            for (const item of groupItems) {
              try {
                await runner.call('addToCart', item.idArticle, item.amount, g);
                await mark([item]);
              } catch (itemErr) {
                if (itemErr instanceof BlockedError) throw itemErr;
                failed.push(`${item.name} (${order.seller}): ${itemErr.message}`);
              }
            }
          }
        }
      }
      hideProgress();
      toast(`Added ${done}/${totalItems} items to your Cardmarket cart.` + (failed.length ? ` ${failed.length} failed.` : ''), failed.length ? 'error' : 'success');
      if (failed.length) {
        $('cartCheckBox').innerHTML = `<div class="alert-banner alert-warn" style="margin-bottom:12px"><div><strong>Could not add:</strong> ${failed.map(esc).join('; ')}</div></div>`;
      }
      await checkCart(runner);
    } catch (error) {
      hideProgress();
      toast(`Stopped after ${done}/${totalItems}: ${error.message}`, 'error');
    } finally {
      if (state.controller === controller) state.controller = null;
      state.carting = false;
      syncBusyUI();
    }
  }

  // ---- Tabs ----
  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
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
      'bwAppSettings', 'knownWantsLists', 'extraProducts', 'trackedSellers', 'bwRuns', 'productPaths',
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
    state.trackedSellers = Object.fromEntries(
      Object.entries(data.trackedSellers || {}).filter(([, at]) => Date.now() - at < TRACKED_MEMORY_MS)
    );
    const s = data.bwAppSettings || {};
    state.selectedLists = s.selectedLists || [];
    state.regionMode = s.regionMode || 'de';
    state.customCountries = Array.isArray(s.customCountries) ? s.customCountries : [...NEIGHBOURS];
    state.shipTo = s.shipTo || 7;
    state.method = s.method || 'sellers';
    state.interval = s.interval || 1000;

    $('shipTo').value = state.shipTo;
    $('method').value = state.method;
    $('interval').value = state.interval;
    $('trackedSellers').value = Object.keys(state.trackedSellers).sort().join(', ');

    renderLists();
    renderProducts();
    renderRegionControls();
    renderSavedRuns();

    // Handle URL query params (when launched from Cardmarket Wants List or Product page)
    const urlParams = Object.fromEntries(new URLSearchParams(location.search).entries());
    await applyContextParams(urlParams);

    const cacheInfo = await updateCachePill();
    if (cacheInfo.status === 'fresh' && cacheInfo.collection) {
      state.collection = cacheInfo.collection;
      await loadLimitsAndCutsFor(cacheInfo.sig);
      await computeBasketFromCollection();
    }

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
    $('btnExpandAllSellers').addEventListener('click', () => setAllSellersExpanded(true));
    $('btnCollapseAllSellers').addEventListener('click', () => setAllSellersExpanded(false));
    $('btnBuy').addEventListener('click', addToCart);
    $('btnCheckCart').addEventListener('click', () => checkCart());
    $('btnCopyPlain').addEventListener('click', () => handleExportEntries(basketEntries(), 'plain', 'basket items'));
    $('btnCopyArchidekt').addEventListener('click', () => handleExportEntries(basketEntries(), 'archidekt', 'Magic cards'));
    $('exportModalClose').addEventListener('click', closeExportModal);
    $('exportModalCloseX').addEventListener('click', closeExportModal);
    $('exportModal').addEventListener('click', e => { if (e.target === $('exportModal')) closeExportModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('exportModal').hidden) closeExportModal(); });
    $('btnForgetCart').addEventListener('click', async () => {
      const { key } = await alreadyAdded();
      await chrome.storage.local.remove(key);
      toast('Cleared added-to-cart memory for this selection.');
    });

    $('btnOpenRun').addEventListener('click', async () => {
      const id = $('savedRuns').value;
      if (!id) return;
      const data = await chrome.storage.local.get(id);
      await openSavedCollection(data[id]);
    });

    $('importFile').addEventListener('change', async () => {
      const file = $('importFile').files[0];
      $('importFile').value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        await openSavedCollection(parsed.collection || parsed);
      } catch (error) {
        toast(`Import failed: ${error.message}`, 'error');
      }
    });

    $('btnDownload').addEventListener('click', () => {
      if (!state.collection) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify({ collection: state.collection, log: state.runLog })], { type: 'application/json' }));
      link.download = `cardmarket-better-wizard-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`;
      link.click();
    });
  }

  init();
})();
