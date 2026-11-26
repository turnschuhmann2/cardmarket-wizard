'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('../collector.js');
require('../wizard.js');
require('../exports.js');

const {
  collect,
  collectBySellers,
  browserSite,
  parseOfferRow,
  parseProductOfferRow,
  normalizeSellerReputation,
  normalizeSellerTypes,
  offerReputationRank,
  matchesSellerFilter,
  queryString,
  checkFilterEcho,
} = globalThis.CardmarketCollector;
const { createPlanner, parseShippingTable, applyBasketRemovals } = globalThis.CardmarketWizard;
const { createBasketSnapshot, readBasketSnapshot } = globalThis.CardmarketExport;

const TABLE = parseShippingTable([
  { name: 'Standard Letter', isTracked: false, isVirtual: false, maxWeight: 20, maxValue: '25,00 €', price: '1,25 €' },
  { name: 'Compact Letter', isTracked: false, isVirtual: false, maxWeight: 50, maxValue: '25,00 €', price: '2,25 €' },
  { name: 'Tracked', isTracked: true, isVirtual: false, maxWeight: 1000, maxValue: '500,00 €', price: '5,00 €' },
]);

function makeEl({ text = '', cls = '', attrs = {}, children = {}, all = {} } = {}) {
  return {
    textContent: text,
    className: cls,
    getAttribute: k => (k in attrs ? attrs[k] : null),
    querySelector: sel => children[sel] || null,
    querySelectorAll: sel => all[sel] || [],
    closest: () => null,
    cloneNode: () => makeEl({ text, cls, attrs, children, all }),
  };
}

function makeOfferRowDom({
  id = 1001,
  seller = 'ShopA',
  location = 'Germany',
  sellerTips = [],
  ratingClass = '',
  condition = 'Near Mint',
  language = 'English',
  price = '1,50 €',
  quantity = '2',
  productImg = null,
} = {}) {
  const tipEls = [`Item location: ${location}`, ...sellerTips].map(t => makeEl({ attrs: { title: t } }));
  const attrEls = [condition, language].filter(Boolean).map(t => makeEl({ attrs: { title: t } }));
  const children = {
    '.seller-name a[href*="/Users/"]': makeEl({ text: seller }),
    '.price-container .color-primary': makeEl({ text: price }),
    '.amount-container .item-count': makeEl({ text: quantity }),
    '.price-container': makeEl({ text: `${price} + 1,48 €` }),
  };
  if (ratingClass) {
    children['[class*="fonticon-seller-rating-"]'] = makeEl({ cls: ratingClass });
  }
  if (productImg) {
    children['[data-bs-title*="product-images"]'] = makeEl({ attrs: { 'data-bs-title': `<img src="${productImg}">` } });
  }
  return {
    id: `articleRow${id}`,
    querySelector: sel => children[sel] || null,
    querySelectorAll: sel => {
      if (sel.includes('.col-seller')) return tipEls;
      if (sel.includes('.product-attributes')) return attrEls;
      return [];
    },
  };
}

test('normalizeSellerReputation and normalizeSellerTypes handle valid, unfiltered, and invalid inputs', () => {
  assert.equal(normalizeSellerReputation(1), 1);
  assert.equal(normalizeSellerReputation(2), 2);
  assert.equal(normalizeSellerReputation('very-good'), 2);
  assert.equal(normalizeSellerReputation('Very Good'), 2);
  assert.equal(normalizeSellerReputation('outstanding'), 1);
  assert.equal(normalizeSellerReputation(4), 4);
  assert.equal(normalizeSellerReputation(5), null, 'Bad (5) means unfiltered');
  assert.equal(normalizeSellerReputation('bad'), null);
  assert.equal(normalizeSellerReputation(null), null);
  assert.equal(normalizeSellerReputation(''), null);
  assert.equal(normalizeSellerReputation(99), null);

  assert.deepEqual(normalizeSellerTypes([1, 2]), [1, 2]);
  assert.deepEqual(normalizeSellerTypes('2,1,2'), [1, 2]);
  assert.deepEqual(normalizeSellerTypes(0), [0]);
  assert.equal(normalizeSellerTypes([0, 1, 2]), null, 'all 3 types means unfiltered');
  assert.equal(normalizeSellerTypes([]), null);
  assert.equal(normalizeSellerTypes(null), null);
});

test('parseOfferRow and parseProductOfferRow extract rating, numeric reputation, sellerType, and tooltip fallback', () => {
  const powerRow = makeOfferRowDom({
    id: 10,
    seller: 'MegaShop',
    sellerTips: ['Powerseller'],
    ratingClass: 'fonticon-seller-rating-outstanding',
  });
  const parsedPower = parseOfferRow(powerRow);
  assert.equal(parsedPower.rating, 'outstanding');
  assert.equal(parsedPower.reputation, 1);
  assert.equal(parsedPower.sellerType, 2);
  assert.equal(parsedPower.professional, true);

  const proRow = makeOfferRowDom({
    id: 11,
    seller: 'ProShop',
    sellerTips: ['Professional', 'Very good seller'],
    ratingClass: '', // tooltip fallback when class is absent
  });
  const parsedPro = parseOfferRow(proRow);
  assert.equal(parsedPro.rating, 'very-good');
  assert.equal(parsedPro.reputation, 2);
  assert.equal(parsedPro.sellerType, 1);
  assert.equal(parsedPro.professional, true);

  const unratedPrivate = makeOfferRowDom({
    id: 12,
    seller: 'Newbie',
    sellerTips: ['Not enough sales'],
    ratingClass: 'fonticon-seller-rating-not-enough-sells',
  });
  const parsedUnrated = parseOfferRow(unratedPrivate);
  assert.equal(parsedUnrated.rating, null);
  assert.equal(parsedUnrated.reputation, null);
  assert.equal(parsedUnrated.sellerType, 0);
  assert.equal(parsedUnrated.professional, false);

  const prodRow = makeOfferRowDom({
    id: 13,
    seller: 'SleevesPro',
    sellerTips: ['Professional'],
    ratingClass: 'fonticon-seller-rating-good',
  });
  const parsedProd = parseProductOfferRow(prodRow);
  assert.equal(parsedProd.rating, 'good');
  assert.equal(parsedProd.reputation, 3);
  assert.equal(parsedProd.sellerType, 1);
  assert.equal(parsedProd.professional, true);
  assert.equal(parsedProd.shippingCents, 148);
});

test('queryString emits sellerReputation and multi-value sellerType only when active', () => {
  const filtered = queryString({
    sellerCountries: [7],
    minCondition: 3,
    sellerReputation: 2,
    sellerType: [1, 2],
  }, false);
  const p1 = new URLSearchParams(filtered);
  assert.equal(p1.get('sellerCountry'), '7');
  assert.equal(p1.get('minCondition'), '3');
  assert.equal(p1.get('sellerReputation'), '2');
  assert.equal(p1.get('sellerType'), '1,2');

  const unfiltered = queryString({
    sellerCountries: [7],
    minCondition: 7,
    sellerReputation: 5,
    sellerType: undefined,
  }, false);
  const p2 = new URLSearchParams(unfiltered);
  assert.equal(p2.has('sellerReputation'), false);
  assert.equal(p2.has('sellerType'), false);
  assert.equal(p2.has('minCondition'), false);
});

test('checkFilterEcho validates single and multi sellerType without failing on sellerReputation', () => {
  assert.doesNotThrow(() => {
    checkFilterEcho(
      JSON.stringify({ idCountries: [7], sellerStatus: [1, 2] }),
      { sellerCountries: [7], sellerType: [1, 2], sellerReputation: 2 },
    );
  });
  assert.doesNotThrow(() => {
    checkFilterEcho(
      JSON.stringify({ idCountries: [7], sellerStatus: { 1: '1', 2: '1' } }),
      { sellerCountries: [7], sellerType: [2, 1], sellerReputation: 1 },
    );
  });
  assert.doesNotThrow(() => {
    checkFilterEcho(
      JSON.stringify({ idCountries: [7], sellerStatus: '0' }),
      { sellerCountries: [7], sellerType: 0 },
    );
  });
  assert.throws(
    () => checkFilterEcho(JSON.stringify({ idCountries: [7], sellerStatus: [0] }), { sellerCountries: [7], sellerType: [1, 2] }),
    /seller type/,
  );
});

test('matchesSellerFilter excludes unrated and low-reputation sellers and respects sellerTypes', () => {
  const outstandingPro = { rating: 'outstanding', reputation: 1, sellerType: 1, professional: true };
  const veryGoodPriv = { rating: 'very-good', reputation: 2, sellerType: 0, professional: false };
  const goodPower = { rating: 'good', reputation: 3, sellerType: 2, professional: true };
  const badPriv = { rating: 'bad', reputation: 5, sellerType: 0, professional: false };
  const unratedPriv = { rating: null, reputation: null, sellerType: 0, professional: false };
  const legacyPro = { rating: 'very-good', professional: true };

  assert.equal(offerReputationRank(legacyPro), 2);

  // Min Very good (2), all seller types
  assert.equal(matchesSellerFilter(outstandingPro, { minReputation: 2 }), true);
  assert.equal(matchesSellerFilter(veryGoodPriv, { minReputation: 2 }), true);
  assert.equal(matchesSellerFilter(goodPower, { minReputation: 2 }), false);
  assert.equal(matchesSellerFilter(badPriv, { minReputation: 2 }), false);
  assert.equal(matchesSellerFilter(unratedPriv, { minReputation: 2 }), false, 'unrated sellers must be excluded when minReputation < 5');

  // Unfiltered (5 = Bad / Any) allows everyone including Bad & unrated
  assert.equal(matchesSellerFilter(badPriv, { minReputation: 5 }), true);
  assert.equal(matchesSellerFilter(unratedPriv, { minReputation: 5 }), true);

  // Commercial sellers only ([1, 2]) + Min Good (3)
  const commercialGood = { minReputation: 3, sellerTypes: [1, 2] };
  assert.equal(matchesSellerFilter(outstandingPro, commercialGood), true);
  assert.equal(matchesSellerFilter(goodPower, commercialGood), true);
  assert.equal(matchesSellerFilter(veryGoodPriv, commercialGood), false);
  assert.equal(matchesSellerFilter(legacyPro, commercialGood), true);
  assert.equal(matchesSellerFilter({ rating: 'outstanding', professional: false }, commercialGood), false);
});

test('browserSite cardPage and productPage send seller filter query params and filter leaked rows client-side', async () => {
  const requestedUrls = [];
  const rows = [
    makeOfferRowDom({ id: 1, seller: 'GreatPro', sellerTips: ['Professional'], ratingClass: 'fonticon-seller-rating-outstanding', price: '1,00 €', productImg: '/100/100.jpg' }),
    makeOfferRowDom({ id: 2, seller: 'GreatPriv', sellerTips: [], ratingClass: 'fonticon-seller-rating-very-good', price: '0,80 €', productImg: '/100/100.jpg' }),
    makeOfferRowDom({ id: 3, seller: 'SloppyShop', sellerTips: ['Powerseller'], ratingClass: 'fonticon-seller-rating-average', price: '0,50 €', productImg: '/100/100.jpg' }),
    makeOfferRowDom({ id: 4, seller: 'BrandNew', sellerTips: [], ratingClass: 'fonticon-seller-rating-not-enough-sells', price: '0,40 €', productImg: '/100/100.jpg' }),
  ];

  const prevDOMParser = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      const table = {
        querySelectorAll: sel => (sel.includes('.article-row') ? rows : []),
      };
      return {
        title: 'Dragon Shield Matte | Cardmarket',
        querySelector: sel => {
          if (sel === '#table') return table;
          if (sel === 'input[name="idProduct"]') return { value: '555' };
          if (sel === 'main h1' || sel === 'h1') return makeEl({ text: 'Dragon Shield Matte' });
          return null;
        },
        querySelectorAll: sel => (sel.includes('.article-row') ? rows : []),
        getElementById: () => null,
      };
    }
  };

  try {
    const site = browserSite({
      fetchImpl: async url => {
        requestedUrls.push(url);
        return { ok: true, status: 200, url, redirected: false, headers: { get: () => null }, text: async () => '<html></html>' };
      },
      baseOrigin: 'https://www.cardmarket.com',
    });

    const cardRes = await site.cardPage(
      { name: 'Sol Ring', cardPath: '/en/Magic/Cards/Sol-Ring' },
      { sellerCountries: [7], minCondition: 3, sellerReputation: 2, sellerType: [1, 2] },
    );
    assert.equal(requestedUrls.length, 1);
    const cardUrl = new URL(requestedUrls[0]);
    assert.equal(cardUrl.searchParams.get('sellerReputation'), '2');
    assert.equal(cardUrl.searchParams.get('sellerType'), '1,2');
    assert.deepEqual(cardRes.offers.map(o => o.seller), ['GreatPro']);
    assert.equal(cardRes.skipped, 3);

    const prodRes = await site.productPage(
      { name: 'Dragon Shield', productPath: '/en/Magic/Products/Sleeves/Dragon-Shield' },
      { sellerCountries: [7], minCondition: 7, sellerReputation: 2 },
    );
    const prodUrl = new URL(requestedUrls[1]);
    assert.equal(prodUrl.searchParams.get('sellerReputation'), '2');
    assert.equal(prodUrl.searchParams.has('sellerType'), false);
    assert.deepEqual(prodRes.offers.map(o => o.seller), ['GreatPro', 'GreatPriv']);
    assert.equal(prodRes.skipped, 2);
  } finally {
    globalThis.DOMParser = prevDOMParser;
  }
});

test('collectBySellers enforces seller filters in Phase 1, isolates cache, splits allowed types in Thorough, and propagates sellerMeta to Phase 2', async () => {
  const seenCardQueries = [];
  const seenProdQueries = [];
  const seenSellers = [];

  const cardOffers = [
    { idArticle: 1, idProduct: 10, seller: 'GoodPro', location: 'Germany', rating: 'very-good', reputation: 2, sellerType: 1, professional: true, condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 100, quantity: 2 },
    { idArticle: 2, idProduct: 10, seller: 'BadSmall', location: 'Germany', rating: 'bad', reputation: 5, sellerType: 0, professional: false, condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 20, quantity: 2 },
    { idArticle: 3, idProduct: 10, seller: 'UnratedNew', location: 'Germany', rating: null, reputation: null, sellerType: 0, professional: false, condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 15, quantity: 2 },
    { idArticle: 4, idProduct: 10, seller: 'GreatPriv', location: 'Germany', rating: 'outstanding', reputation: 1, sellerType: 0, professional: false, condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 90, quantity: 2 },
  ];

  const cardOffersB = cardOffers.map((o, idx) => ({ ...o, idArticle: 20 + idx, idProduct: 20 }));

  const site = {
    async cardPage(entry, query) {
      seenCardQueries.push({ card: entry.name, sellerReputation: query.sellerReputation ?? null, sellerType: query.sellerType });
      // Return ALL offers unfiltered to verify client-side defense-in-depth too
      const src = entry.key === 'a' ? cardOffers : cardOffersB;
      return { offers: src, skipped: 0 };
    },
    async productPage(entry, query) {
      seenProdQueries.push({ sellerReputation: query.sellerReputation ?? null, sellerType: query.sellerType });
      return {
        offers: [
          { idArticle: 50, idProduct: 500, seller: 'GoodPro', location: 'Germany', rating: 'very-good', reputation: 2, sellerType: 1, professional: true, condition: 2, language: null, foil: false, signed: false, altered: false, priceCents: 800, shippingCents: 148, quantity: 5 },
          { idArticle: 51, idProduct: 500, seller: 'UnratedNew', location: 'Germany', rating: null, reputation: null, sellerType: 0, professional: false, condition: 2, language: null, foil: false, signed: false, altered: false, priceCents: 500, shippingCents: 148, quantity: 5 },
        ],
        skipped: 0,
        meta: { name: 'Sleeves', game: 'Magic', category: 'Sleeves', path: entry.productPath, idProduct: 500 },
      };
    },
    async sellerWants(seller) {
      seenSellers.push(seller);
      // Notice Phase 2 /Users/<seller>/Offers/Singles does NOT include location/rating/sellerType!
      return {
        offers: [
          { idArticle: 900, idProduct: 10, seller, condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 95, quantity: 1 },
          { idArticle: 901, idProduct: 20, seller, condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 95, quantity: 1 },
        ],
        skipped: 0,
        total: 2,
        hasNext: false,
      };
    },
  };

  const plan = {
    entries: [
      { key: 'a', kind: 'card', game: 'Magic', listId: '1', name: 'Card A', amount: 1, cardPath: '/en/Magic/Cards/A', languages: [1], minCondition: 3, foil: 'any', signed: 'any', altered: 'any', printings: [{ idProduct: 10, idExpansion: 1 }] },
      { key: 'b', kind: 'card', game: 'Magic', listId: '1', name: 'Card B', amount: 1, cardPath: '/en/Magic/Cards/B', languages: [1], minCondition: 3, foil: 'any', signed: 'any', altered: 'any', printings: [{ idProduct: 20, idExpansion: 1 }] },
      { key: 'p1', kind: 'product', game: 'Magic', name: 'Sleeves', amount: 1, productPath: '/en/Magic/Products/Sleeves/X', languages: [], minCondition: 7, printings: [] },
    ],
  };

  const cache = new Map();

  // Run 1: minReputation=2 (Very good), commercial only ([1, 2]) in Quick mode
  const run1 = await collectBySellers(plan, site, {
    lists: [{ game: 'Magic', listId: '1' }],
    minReputation: 2,
    sellerTypes: [1, 2],
    minSellerCards: 2,
    intervalMs: 0,
    cache,
  });

  assert.deepEqual(run1.sellerFilter, { minReputation: 2, sellerTypes: [1, 2] });
  assert.deepEqual(seenCardQueries.map(q => q.sellerReputation), [2, 2]);
  assert.deepEqual(seenCardQueries.map(q => q.sellerType), [[1, 2], [1, 2]]);
  assert.deepEqual(seenProdQueries, [{ sellerReputation: 2, sellerType: [1, 2] }]);
  // Only GoodPro qualified (BadSmall, UnratedNew, and private GreatPriv were excluded)
  assert.deepEqual(seenSellers, ['GoodPro']);

  // Verify Phase 2 offer inherited location, rating, reputation, sellerType, professional from Phase 1!
  const phase2Offer = run1.results[0].offers.find(o => o.idArticle === 900);
  assert.ok(phase2Offer, 'Phase 2 offer should be present');
  assert.equal(phase2Offer.location, 'Germany');
  assert.equal(phase2Offer.rating, 'very-good');
  assert.equal(phase2Offer.reputation, 2);
  assert.equal(phase2Offer.sellerType, 1);
  assert.equal(phase2Offer.professional, true);
  assert.deepEqual(run1.results[2].offers.map(o => o.seller), ['GoodPro']);

  // Run 2: Different seller filter (minReputation=1, all seller types) must NOT reuse Run 1 cache
  seenCardQueries.length = 0;
  seenSellers.length = 0;
  const run2 = await collectBySellers(plan, site, {
    lists: [{ game: 'Magic', listId: '1' }],
    minReputation: 1,
    sellerTypes: [0, 1, 2],
    minSellerCards: 2,
    intervalMs: 0,
    cache,
  });
  assert.equal(seenCardQueries.length, 2, 'must miss cache when seller filter changes');
  assert.deepEqual(seenCardQueries.map(q => q.sellerReputation), [1, 1]);
  assert.deepEqual(seenCardQueries.map(q => q.sellerType), [undefined, undefined]);
  assert.deepEqual(seenSellers, ['GreatPriv'], 'only Outstanding seller qualifies');

  // Run 3: Thorough mode (splitBySellerType: true) with sellerTypes=[1, 2] only queries types 1 and 2 (skips 0)
  seenCardQueries.length = 0;
  await collectBySellers({ entries: [plan.entries[0]] }, site, {
    lists: [{ game: 'Magic', listId: '1' }],
    minReputation: 2,
    sellerTypes: [1, 2],
    splitBySellerType: true,
    intervalMs: 0,
    cache: new Map(),
  });
  assert.deepEqual(seenCardQueries.map(q => q.sellerType), [1, 2]);
});

test('collect() respects sellerReputation and splits capped queries only across allowed sellerTypes', async () => {
  const asked = [];
  const makePage = (sellerType, from, count) => Array.from({ length: count }, (_, i) => ({
    idArticle: (sellerType ?? 9) * 1000 + from + i,
    seller: `s${sellerType ?? 9}_${i % 10}`,
    location: 'Germany',
    rating: 'very-good',
    reputation: 2,
    sellerType: Array.isArray(sellerType) ? sellerType[i % sellerType.length] : (sellerType ?? 1),
    professional: true,
    priceCents: 100,
    quantity: 1,
  }));

  const site = {
    async firstPage(query) {
      asked.push({ sellerReputation: query.sellerReputation, sellerType: query.sellerType });
      const capped = Array.isArray(query.sellerType);
      return { offers: makePage(query.sellerType, 0, 5), cursor: null, capped };
    },
    async nextPage() {
      return { offers: [], cursor: null, capped: false };
    },
  };

  const plan = {
    entries: [{
      key: 'x', name: 'Card X', amount: 1, languages: [1], minCondition: 3, foil: 'any', signed: 'any', altered: 'any',
      printings: [{ idProduct: 1, guideLowCents: 100 }],
    }],
  };

  const res = await collect(plan, site, {
    minReputation: 2,
    sellerTypes: [1, 2],
    intervalMs: 0,
  });

  assert.deepEqual(res.sellerFilter, { minReputation: 2, sellerTypes: [1, 2] });
  assert.deepEqual(asked, [
    { sellerReputation: 2, sellerType: [1, 2] },
    { sellerReputation: 2, sellerType: 1 },
    { sellerReputation: 2, sellerType: 2 },
  ]);
});

test('wizard carries seller reputation and type onto parcels & overlap and preserves them across removals and snapshots', () => {
  const collection = {
    results: [
      {
        key: 'a', name: 'Card A', amount: 1, kind: 'card', game: 'Magic', listId: '1', listName: 'Deck',
        targetCents: 100, verdict: 'read',
        offers: [
          { idArticle: 1, idProduct: 10, seller: 'AlphaShop', location: 'Germany', rating: 'outstanding', reputation: 1, sellerType: 2, professional: true, priceCents: 100, quantity: 1 },
        ],
      },
      {
        key: 'b', name: 'Card B', amount: 1, kind: 'card', game: 'Magic', listId: '1', listName: 'Deck',
        targetCents: 100, verdict: 'read',
        offers: [
          { idArticle: 2, idProduct: 20, seller: 'AlphaShop', location: 'Germany', rating: 'outstanding', reputation: 1, sellerType: 2, professional: true, priceCents: 110, quantity: 1 },
        ],
      },
    ],
  };

  const planner = createPlanner(collection, TABLE);
  const basket = planner.basket();
  assert.equal(basket.parcels.length, 1);
  assert.equal(basket.parcels[0].rating, 'outstanding');
  assert.equal(basket.parcels[0].reputation, 1);
  assert.equal(basket.parcels[0].sellerType, 2);
  assert.equal(basket.parcels[0].professional, true);

  const top = planner.overlap(5);
  assert.equal(top[0].rating, 'outstanding');
  assert.equal(top[0].reputation, 1);
  assert.equal(top[0].sellerType, 2);
  assert.equal(top[0].professional, true);

  // Removal of 1 item preserves seller metadata on remaining parcel
  const afterRemove = applyBasketRemovals(basket, [{ seller: 'AlphaShop', item: basket.parcels[0].items[0] }], { tables: TABLE });
  assert.equal(afterRemove.parcels[0].rating, 'outstanding');
  assert.equal(afterRemove.parcels[0].sellerType, 2);

  // Snapshot round-trip preserves seller metadata
  const snap = createBasketSnapshot({ basket, finalBasket: afterRemove, overlap: top, tables: TABLE });
  const revived = readBasketSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.equal(revived.finalBasket.parcels[0].rating, 'outstanding');
  assert.equal(revived.finalBasket.parcels[0].sellerType, 2);
  assert.equal(revived.overlap[0].rating, 'outstanding');
});
