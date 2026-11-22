// Service worker: opens the full-page Better Wizard app, routes Cardmarket requests through a
// signed-in Cardmarket tab, caches Cardmarket catalogues/shipping tables, and resolves Scryfall ids.
importScripts('catalog.js');

const EXPORTS = 'https://downloads.s3.cardmarket.com/productCatalog';
const CATALOG_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const SHIPPING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const indexPromises = {};
let bridgeTabPromise = null;

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
  const targetUrl = qs.toString() ? `${baseUrl}?${qs}` : baseUrl;
  const existing = await chrome.tabs.query({ url: `${baseUrl}*` });
  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (Object.keys(params).length) {
      chrome.tabs.sendMessage(tab.id, { type: 'app-context', params }).catch(() => {});
    }
    return tab;
  }
  return chrome.tabs.create({ url: targetUrl });
}

chrome.action.onClicked.addListener(() => {
  openOrFocusApp();
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
  if (current?.status === 'complete') return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      resolve();
    }, timeoutMs);
    const onUpdate = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdate);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

async function getCardmarketTab() {
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
  if (!bridgeTabPromise) {
    bridgeTabPromise = (async () => {
      const created = await chrome.tabs.create({ url: 'https://www.cardmarket.com/en/Magic', active: false });
      await waitForTabComplete(created.id);
      // Give document_idle content script a brief beat to register.
      for (let i = 0; i < 10; i += 1) {
        if (await pingTab(created.id)) return created.id;
        await new Promise(r => setTimeout(r, 250));
      }
      return created.id;
    })().finally(() => { bridgeTabPromise = null; });
  }
  return bridgeTabPromise;
}

async function loadIndex(game) {
  const id = GAME_IDS[game] || 1;
  const key = `catalogueIndex:${id}`;
  const { [key]: catalogueIndex } = await chrome.storage.local.get(key);
  if (catalogueIndex?.version === CardmarketCatalog.INDEX_VERSION && Date.now() - catalogueIndex.fetchedAt < CATALOG_MAX_AGE_MS) {
    return catalogueIndex;
  }
  const [catalogue, priceGuide] = await Promise.all([
    fetch(`${EXPORTS}/productList/products_singles_${id}.json`).then(r => r.json()),
    fetch(`${EXPORTS}/priceGuide/price_guide_${id}.json`).then(r => r.json()),
  ]);
  const index = { ...CardmarketCatalog.indexCatalogue(catalogue, priceGuide), fetchedAt: Date.now() };
  await chrome.storage.local.set({ [key]: index });
  await chrome.storage.local.remove('catalogueIndex');
  return index;
}

async function fetchShipping(from, to) {
  const key = `ship:${from}:${to}`;
  const { [key]: cached } = await chrome.storage.local.get(key);
  if (cached && Date.now() - cached.at < SHIPPING_MAX_AGE_MS && Array.isArray(cached.methods)) {
    return cached.methods;
  }
  const response = await fetch(`https://help.cardmarket.com/api/shippingCosts?locale=en&fromCountry=${from}&toCountry=${to}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for shipping ${from}->${to}`);
  const methods = await response.json();
  await chrome.storage.local.set({ [key]: { at: Date.now(), methods } });
  return methods;
}

async function fetchShippingMulti(fromList, to) {
  const unique = [...new Set(fromList.map(Number).filter(Boolean))];
  const tables = {};
  const failed = [];
  const queue = [...unique];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const from = queue.shift();
      const name = COUNTRY_NAME_BY_ID[from] || String(from);
      try {
        tables[name] = await fetchShipping(from, to);
      } catch (error) {
        // Report unsupported pairs rather than failing the whole European batch.
        failed.push(name);
      }
    }
  });
  await Promise.all(workers);
  return { tables, failed };
}

async function printings(ids) {
  const { scryfallPrintings: known = {} } = await chrome.storage.local.get('scryfallPrintings');
  for (const id of ids) {
    if (id in known) continue;
    const response = await fetch(`https://api.scryfall.com/cards/cardmarket/${id}`, { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const card = await response.json();
      known[id] = { name: card.name, set: card.set, number: card.collector_number };
    } else if (response.status === 404) {
      known[id] = null;
    } else {
      throw new Error(`Scryfall answered HTTP ${response.status}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await chrome.storage.local.set({ scryfallPrintings: known });
  return Object.fromEntries(ids.map(id => [id, known[id] ?? null]));
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
        const tabId = await getCardmarketTab();
        const result = await chrome.tabs.sendMessage(tabId, message);
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
        const tabId = await getCardmarketTab();
        const result = await chrome.tabs.sendMessage(tabId, { type: 'cm-token' });
        reply(result || { token: null });
      } catch {
        reply({ token: null });
      }
    })();
    return true;
  }

  if (message.type === 'shipping') {
    fetchShipping(message.from, message.to)
      .then(methods => reply({ methods }), error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'shipping-multi') {
    fetchShippingMulti(message.fromList || [], message.to)
      .then(({ tables, failed }) => reply({ tables, failed }), error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'printings') {
    printings(message.ids).then(found => reply({ found }), error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'plan') {
    const game = message.game || 'Magic';
    indexPromises[game] = indexPromises[game] || loadIndex(game).finally(() => { delete indexPromises[game]; });
    indexPromises[game]
      .then(index => reply({ plan: CardmarketCatalog.planEntries(message.wants, index) }))
      .catch(error => reply({ error: String(error) }));
    return true;
  }

  if (message.type === 'token-catalog') {
    const game = message.game || 'Magic';
    indexPromises[game] = indexPromises[game] || loadIndex(game).finally(() => { delete indexPromises[game]; });
    indexPromises[game]
      .then(index => reply({
        tokens: index.tokens || [],
        catalogueCreatedAt: index.catalogueCreatedAt,
        priceGuideCreatedAt: index.priceGuideCreatedAt,
      }))
      .catch(error => reply({ error: String(error) }));
    return true;
  }

  return false;
});
