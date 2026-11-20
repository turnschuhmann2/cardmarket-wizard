// Loads Cardmarket's public exports (no CORS, so they are fetched here) and plans printings.
importScripts('catalog.js');

const EXPORTS = 'https://downloads.s3.cardmarket.com/productCatalog';
const MAX_AGE_MS = 20 * 60 * 60 * 1000;
let indexPromise = null;

async function loadIndex() {
  const { catalogueIndex } = await chrome.storage.local.get('catalogueIndex');
  if (catalogueIndex?.version === CardmarketCatalog.INDEX_VERSION && Date.now() - catalogueIndex.fetchedAt < MAX_AGE_MS) return catalogueIndex;
  const [catalogue, priceGuide] = await Promise.all([
    fetch(`${EXPORTS}/productList/products_singles_1.json`).then(response => response.json()),
    fetch(`${EXPORTS}/priceGuide/price_guide_1.json`).then(response => response.json()),
  ]);
  const index = { ...CardmarketCatalog.indexCatalogue(catalogue, priceGuide), fetchedAt: Date.now() };
  await chrome.storage.local.set({ catalogueIndex: index });
  return index;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'shipping') {
    fetch(`https://help.cardmarket.com/api/shippingCosts?locale=en&fromCountry=${message.from}&toCountry=${message.to}`)
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(methods => reply({ methods }), error => reply({ error: String(error) }));
    return true;
  }
  if (message.type === 'printings') {
    printings(message.ids).then(found => reply({ found }), error => reply({ error: String(error) }));
    return true;
  }
  if (message.type !== 'plan') return false;
  indexPromise = indexPromise || loadIndex().finally(() => { indexPromise = null; });
  indexPromise
    .then(index => reply({ plan: CardmarketCatalog.planEntries(message.wants, index) }))
    .catch(error => reply({ error: String(error) }));
  return true;
});

// Set code and collector number of Cardmarket printings, from Scryfall (which records each card's
// Cardmarket product id), for exports such as Archidekt. Cached; Scryfall asks for gaps between requests.
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
