// Service worker: opens the full-page Better Wizard app, routes Cardmarket requests through a
// signed-in Cardmarket tab, caches Cardmarket catalogues/shipping tables, and resolves Scryfall ids.
importScripts('catalog.js');

const EXPORTS = 'https://downloads.s3.cardmarket.com/productCatalog';
const CATALOG_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const SHIPPING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const indexPromises = {};
let cachedBridgeTabId = null;
let bridgeTabPromise = null;
let printingsQueue = Promise.resolve();

// Cardmarket's game ids in the public export file names.
const GAME_IDS = { Magic: 1, YuGiOh: 3 };

// Cardmarket's country ids & names (from help.cardmarket.com/api/countries).
const COUNTRIES = [
  [1, 'Austria'], [2, 'Belgium'], [3, 'Bulgaria'], [35, 'Croatia'], [5, 'Cyprus'], [6, 'Czech Republic'],
  [8, 'Denmark'], [9, 'Estonia'], [11, 'Finland'], [12, 'France'], [7, 'Germany'], [14, 'Greece'],
  [15, 'Hungary'], [37, 'Iceland'], [16, 'Ireland'], [17, 'Italy'], [36, 'Japan'], [21, 'Latvia'],
  [18, 'Liechtenstein'], [19, 'Lithuania'], [20, 'Luxembourg'], [22, 'Malta'], [23, 'Netherlands'],
  [24, 'Norway'], [25, 'Poland'], [26, 'Portugal'], [27, 'Romania'], [29, 'Singapore'], [31, 'Slovakia'],
  [30, 'Slovenia'], [10, 'Spain'], [28, 'Sweden'], [4, 'Switzerland'], [13, 'United Kingdom'],
];
const COUNTRY_NAME_BY_ID = Object.fromEntries(COUNTRIES);

async function openOrFocusApp(params = {}) {
  const baseUrl = chrome.runtime.getURL('app.html');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const hasParams = Boolean(qs.toString());
  const targetUrl = hasParams ? `${baseUrl}?${qs}` : baseUrl;
  const existing = await chrome.tabs.query({ url: `${baseUrl}*` });
  if (existing.length) {
    const tab = existing[0];
    if (tab.discarded && hasParams) {
      await chrome.tabs.update(tab.id, { active: true, url: targetUrl });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return tab;
    }
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (hasParams) {
      await waitForTabComplete(tab.id);
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'app-context', params });
      } catch {
        await chrome.tabs.update(tab.id, { url: targetUrl }).catch(() => {});
      }
    }
    return tab;
  }
  return chrome.tabs.create({ url: targetUrl });
}

chrome.action.onClicked.addListener(() => {
  openOrFocusApp();
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === cachedBridgeTabId) cachedBridgeTabId = null;
});

async function pingTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'cm-ping' });
    return res?.ok ? res : null;
  } catch {
    return null;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current || current.status === 'complete') return;
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      chrome.tabs.onRemoved.removeListener(onRemove);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onUpdate = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const onRemove = id => {
      if (id === tabId) finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
    chrome.tabs.onRemoved.addListener(onRemove);
  });
}

async function discoverCardmarketTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.cardmarket.com/*' });
  // Prefer an already-responsive tab (especially one with a CSRF token).
  let fallback = null;
  for (const tab of tabs) {
    if (tab.discarded || tab.id == null) continue;
    const ping = await pingTab(tab.id);
    if (ping) {
      if (ping.hasToken) return tab.id;
      fallback ??= tab.id;
    }
  }
  if (fallback != null) return fallback;

  // No responsive Cardmarket tab found: open one in the background once.
  const created = await chrome.tabs.create({ url: 'https://www.cardmarket.com/en/Magic', active: false });
  await waitForTabComplete(created.id);
  // Give document_idle content script a brief beat to register.
  for (let i = 0; i < 10; i += 1) {
    if (await pingTab(created.id)) return created.id;
    await new Promise(r => setTimeout(r, 250));
  }
  return created.id;
}

async function getCardmarketTab() {
  if (!bridgeTabPromise) {
    bridgeTabPromise = discoverCardmarketTab()
      .then(tabId => {
        cachedBridgeTabId = tabId;
        return tabId;
      })
      .finally(() => { bridgeTabPromise = null; });
  }
  return bridgeTabPromise;
}

async function sendToBridgeTab(message, { useCache = true } = {}) {
  const t0 = Date.now();
  // Fast path for idempotent GET/token messages: reuse the last known responsive Cardmarket tab
  // directly instead of paying a tabs.query + cm-ping IPC roundtrip on every single request.
  if (useCache && cachedBridgeTabId != null) {
    const tabId = cachedBridgeTabId;
    try {
      const result = await chrome.tabs.sendMessage(tabId, message);
      if (result !== undefined) {
        if (result && typeof result === 'object') {
          result.bridgeTiming = {
            tabCacheHit: true,
            tabResolveMs: 0,
            ipcTotalMs: Date.now() - t0,
          };
        }
        return result;
      }
    } catch {
      // Tab navigated, reloaded, or closed: fall through to rediscover once.
    }
    if (cachedBridgeTabId === tabId) cachedBridgeTabId = null;
  }
  const tResolveStart = Date.now();
  const tabId = await getCardmarketTab();
  const tabResolveMs = Date.now() - tResolveStart;
  try {
    const result = await chrome.tabs.sendMessage(tabId, message);
    if (result === undefined && cachedBridgeTabId === tabId) cachedBridgeTabId = null;
    if (result && typeof result === 'object') {
      result.bridgeTiming = {
        tabCacheHit: false,
        tabResolveMs,
        ipcTotalMs: Date.now() - t0,
      };
    }
    return result;
  } catch (error) {
    if (cachedBridgeTabId === tabId) cachedBridgeTabId = null;
    throw error;
  }
}

async function loadIndex(game) {
  const t0 = Date.now();
  const id = GAME_IDS[game] || 1;
  const key = `catalogueIndex:${id}`;
  const { [key]: catalogueIndex } = await chrome.storage.local.get(key);
  if (catalogueIndex?.version === CardmarketCatalog.INDEX_VERSION && Date.now() - catalogueIndex.fetchedAt < CATALOG_MAX_AGE_MS) {
    return { index: catalogueIndex, cacheHit: true, loadMs: Date.now() - t0, downloadMs: 0, indexMs: 0 };
  }
  const tDl = Date.now();
  const [catalogue, priceGuide] = await Promise.all([
    fetch(`${EXPORTS}/productList/products_singles_${id}.json`).then(r => r.json()),
    fetch(`${EXPORTS}/priceGuide/price_guide_${id}.json`).then(r => r.json()),
  ]);
  const downloadMs = Date.now() - tDl;
  const tIdx = Date.now();
  const index = { ...CardmarketCatalog.indexCatalogue(catalogue, priceGuide), fetchedAt: Date.now() };
  const indexMs = Date.now() - tIdx;
  await chrome.storage.local.set({ [key]: index });
  await chrome.storage.local.remove('catalogueIndex');
  return { index, cacheHit: false, loadMs: Date.now() - t0, downloadMs, indexMs };
}

async function fetchShipping(from, to) {
  const fromId = Number(from);
  const toId = Number(to);
  if (!Number.isInteger(fromId) || fromId <= 0 || !Number.isInteger(toId) || toId <= 0) {
    throw new Error(`Invalid shipping country ids: ${from}->${to}`);
  }
  const key = `ship:${fromId}:${toId}`;
  const { [key]: cached } = await chrome.storage.local.get(key);
  if (cached && Date.now() - cached.at < SHIPPING_MAX_AGE_MS && Array.isArray(cached.methods)) {
    return { methods: cached.methods, cacheHit: true };
  }
  const response = await fetch(`https://help.cardmarket.com/api/shippingCosts?locale=en&fromCountry=${fromId}&toCountry=${toId}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for shipping ${fromId}->${toId}`);
  const methods = await response.json();
  if (!Array.isArray(methods)) throw new Error(`Unexpected shipping payload for ${fromId}->${toId}`);
  await chrome.storage.local.set({ [key]: { at: Date.now(), methods } });
  return { methods, cacheHit: false };
}

async function fetchShippingMulti(fromList, to) {
  const t0 = Date.now();
  const unique = [...new Set(fromList.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  const tables = {};
  const failed = [];
  let cachedCount = 0;
  let fetchedCount = 0;
  const queue = [...unique];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const from = queue.shift();
      const name = COUNTRY_NAME_BY_ID[from] || String(from);
      try {
        const res = await fetchShipping(from, to);
        tables[name] = res.methods;
        if (res.cacheHit) cachedCount += 1;
        else fetchedCount += 1;
      } catch (error) {
        // Report unsupported pairs rather than failing the whole European batch.
        failed.push(name);
      }
    }
  });
  await Promise.all(workers);
  return {
    tables,
    failed,
    timing: {
      totalMs: Date.now() - t0,
      cachedCount,
      fetchedCount,
      failedCount: failed.length,
    },
  };
}

function printings(ids) {
  const validIds = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  const task = printingsQueue.then(async () => {
    const t0 = Date.now();
    const { scryfallPrintings: known = {} } = await chrome.storage.local.get('scryfallPrintings');
    let dirty = false;
    let cachedCount = 0;
    let fetchedCount = 0;
    try {
      for (const id of validIds) {
        if (id in known) {
          cachedCount += 1;
          continue;
        }
        const response = await fetch(`https://api.scryfall.com/cards/cardmarket/${id}`, { headers: { Accept: 'application/json' } });
        if (response.ok) {
          const card = await response.json();
          known[id] = { name: card.name, set: card.set, number: card.collector_number };
          dirty = true;
          fetchedCount += 1;
        } else if (response.status === 404) {
          known[id] = null;
          dirty = true;
          fetchedCount += 1;
        } else {
          throw new Error(`Scryfall answered HTTP ${response.status}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      if (dirty) await chrome.storage.local.set({ scryfallPrintings: known });
    }
    return {
      found: Object.fromEntries(validIds.map(id => [id, known[id] ?? null])),
      timing: { totalMs: Date.now() - t0, cachedCount, fetchedCount },
    };
  });
  printingsQueue = task.catch(() => {});
  return task;
}

// Only the extension's own app page may drive the Cardmarket bridge tab.
function isAppSender(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  const appUrl = chrome.runtime.getURL('app.html');
  const url = sender?.url || '';
  return url === appUrl || url.startsWith(`${appUrl}?`) || url.startsWith(`${appUrl}#`);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'open-app') {
    openOrFocusApp(message.params || {}).then(() => reply({ ok: true }), error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'cm-fetch') {
    if (!isAppSender(sender)) {
      reply({ error: 'Unauthorised sender' });
      return false;
    }
    (async () => {
      try {
        const isGet = !message.method || message.method === 'GET';
        const result = await sendToBridgeTab(message, { useCache: isGet });
        reply(result);
      } catch (error) {
        reply({ error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === 'cm-token') {
    if (!isAppSender(sender)) {
      reply({ token: null });
      return false;
    }
    (async () => {
      try {
        const result = await sendToBridgeTab({ type: 'cm-token' }, { useCache: true });
        reply(result || { token: null });
      } catch {
        reply({ token: null });
      }
    })();
    return true;
  }

  if (message.type === 'shipping') {
    fetchShipping(message.from, message.to)
      .then(({ methods, cacheHit }) => reply({ methods, timing: { cacheHit } }), error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'shipping-multi') {
    fetchShippingMulti(message.fromList || [], message.to)
      .then(({ tables, failed, timing }) => reply({ tables, failed, timing }), error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'printings') {
    printings(message.ids).then(({ found, timing }) => reply({ found, timing }), error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'plan') {
    const t0 = Date.now();
    const game = message.game || 'Magic';
    indexPromises[game] = indexPromises[game] || loadIndex(game).finally(() => { delete indexPromises[game]; });
    indexPromises[game]
      .then(({ index, cacheHit, loadMs, downloadMs, indexMs }) => {
        const tPlan = Date.now();
        const plan = CardmarketCatalog.planEntries(message.wants, index);
        const planMs = Date.now() - tPlan;
        reply({
          plan,
          timing: {
            totalMs: Date.now() - t0,
            loadIndexMs: loadMs,
            downloadMs,
            indexMs,
            planMs,
            cacheHit,
          },
        });
      })
      .catch(error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'token-catalog') {
    const t0 = Date.now();
    const game = message.game || 'Magic';
    indexPromises[game] = indexPromises[game] || loadIndex(game).finally(() => { delete indexPromises[game]; });
    indexPromises[game]
      .then(({ index, cacheHit, loadMs, downloadMs, indexMs }) => reply({
        tokens: index.tokens || [],
        catalogueCreatedAt: index.catalogueCreatedAt,
        priceGuideCreatedAt: index.priceGuideCreatedAt,
        timing: {
          totalMs: Date.now() - t0,
          loadIndexMs: loadMs,
          downloadMs,
          indexMs,
          cacheHit,
        },
      }))
      .catch(error => reply({ error: String(error) }));
    return true;
  }

  return false;
});
