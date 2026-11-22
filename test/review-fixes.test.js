'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../collector.js');
require('../wizard.js');
require('../tokens.js');

const {
  browserSite, createRunner, collect, collectBySellers, collectSellerTokens,
  parseUserOffersPage, BlockedError, StoppedError, RetryableError, TokenExpiredError, LANGUAGES,
} = globalThis.CardmarketCollector;
const { createPlanner, parseShippingTable, parcelShipping, applyBasketRemovals } = globalThis.CardmarketWizard;
const { mergeTokensIntoBasket } = globalThis.CardmarketTokens;

const SHIP_TABLE = [
  { name: 'Standard Letter', priceCents: 125, maxValueCents: 2500, maxWeight: 20, tracked: false },
  { name: 'Large Letter', priceCents: 225, maxValueCents: 2500, maxWeight: 50, tracked: false },
  { name: 'Tracked Letter', priceCents: 395, maxValueCents: 10000, maxWeight: 50, tracked: true },
  { name: 'Parcel', priceCents: 695, maxValueCents: 500000, maxWeight: 2000, tracked: true },
];

test('A1: browserSite sellerWants allows empty 0-match pages and askSeller isolates per-list errors', async () => {
  const prevDOMParser = globalThis.DOMParser;
  globalThis.DOMParser = class FakeDOMParser {
    parseFromString(html) {
      return {
        body: { textContent: html },
        querySelector(sel) {
          if (sel === '#UserOffersTable') return null;
          if (sel.includes('.noResults') && html.includes('no-results')) return {};
          return null;
        },
        querySelectorAll() { return []; },
      };
    }
  };
  try {
    const site = browserSite({
      fetchImpl: async url => ({
        ok: true, status: 200, redirected: false, url, headers: new Headers(),
        text: async () => '<div class="no-results">Sorry, no matches for your query</div>',
      }),
    });
    const empty = await site.sellerWants('ShopA', '123', 1, 'Magic');
    assert.deepEqual(empty, { offers: [], skipped: 0, total: 0, hasNext: false });
  } finally {
    globalThis.DOMParser = prevDOMParser;
  }

  // Multi-list askSeller: list 2 throws a non-blocked error, list 1 offers still collected & seller marked partial
  const plan = {
    entries: [
      { key: 'Magic:1:c1', game: 'Magic', listId: '1', listName: 'L1', name: 'Card1', amount: 1, cardPath: '/en/Magic/Cards/C1', languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any', printings: [{ idProduct: 101, idExpansion: 1 }] },
      { key: 'Magic:2:c2', game: 'Magic', listId: '2', listName: 'L2', name: 'Card2', amount: 1, cardPath: '/en/Magic/Cards/C2', languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any', printings: [{ idProduct: 102, idExpansion: 1 }] },
    ],
  };
  const fakeSite = {
    async cardPage(entry) {
      const idProduct = entry.printings[0].idProduct;
      return {
        offers: [
          { idArticle: idProduct * 10 + 1, idProduct, seller: 'ShopA', location: 'Germany', condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 100, quantity: 2 },
        ],
        skipped: 0,
      };
    },
    async sellerWants(seller, listId) {
      if (String(listId) === '2') throw new Error('Transient parse glitch on list 2');
      return {
        offers: [{ idArticle: 9001, idProduct: 101, seller, condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 80, quantity: 1 }],
        skipped: 0, total: 1, hasNext: false,
      };
    },
  };
  const col = await collectBySellers(plan, fakeSite, {
    lists: [{ game: 'Magic', listId: '1' }, { game: 'Magic', listId: '2' }],
    minSellerCards: 1,
    intervalMs: 0,
    bucketIntervals: {},
    jitter: false,
  });
  const s = col.sellers.find(x => x.seller === 'ShopA');
  assert.ok(s);
  assert.equal(s.status, 'partial');
  assert.match(s.error, /Transient parse glitch/);
  const c1 = col.results.find(r => r.key === 'Magic:1:c1');
  assert.ok(c1.offers.some(o => o.idArticle === 9001), 'list 1 seller offer must be kept despite list 2 error');
});

test('A2: createRunner.read aborts sibling waiters immediately on budget-exceeded Retry-After without poisoning holds', async () => {
  let calls = 0;
  let deferredUntil = null;
  const runner = createRunner({
    async cardPage() {
      calls += 1;
      const err = new RetryableError('HTTP 429', { cause: 'rate' });
      err.readRetryAfterMs = 30 * 60 * 1000; // 30 minutes > 180s budget
      throw err;
    },
  }, {
    concurrency: 2,
    intervalMs: 40,
    bucketIntervals: {},
    jitter: false,
    readRetryDelays: [10, 20],
    readRetryBudgetMs: 1000,
    onDeferred: async ({ until }) => { deferredUntil = until; },
  });

  const started = Date.now();
  const [r1, r2] = await Promise.allSettled([runner.call('cardPage'), runner.call('cardPage')]);
  const elapsed = Date.now() - started;

  assert.equal(r1.status, 'rejected');
  assert.equal(r2.status, 'rejected');
  assert.ok(r1.reason instanceof BlockedError && !(r1.reason instanceof StoppedError));
  assert.equal(r2.reason, r1.reason, 'sibling must receive original BlockedError, not StoppedError');
  assert.ok(elapsed < 500, `expected immediate abort (<500ms), took ${elapsed}ms`);
  assert.ok(deferredUntil > Date.now());
  assert.equal(runner.pace.holds.get('cards'), undefined, 'budget-exceeded failure must not poison pace.holds');
  assert.equal(calls, 1, 'second slot must not fire after first slot blocked the runner');
  runner.finish();
});

test('A8: pacer.wait re-checks holds set while a sibling slot was sleeping', async () => {
  const times = [];
  let calls = 0;
  const runner = createRunner({
    async cardPage() {
      calls += 1;
      const t = Date.now();
      times.push({ call: calls, t });
      if (calls === 1) {
        const err = new RetryableError('HTTP 429', { cause: 'rate' });
        err.readRetryAfterMs = 90;
        throw err;
      }
      return 'ok';
    },
  }, {
    concurrency: 2,
    intervalMs: 25,
    bucketIntervals: {},
    jitter: false,
    readRetryDelays: [90],
  });

  const t0 = Date.now();
  await Promise.all([runner.call('cardPage'), runner.call('cardPage')]);
  // Call 1 failed at ~t0 and set a 90ms hold; Call 2 woke from its 25ms pacing sleep and must wait out the hold!
  assert.ok(times[1].t - t0 >= 80, `second call fired into active hold after only ${times[1].t - t0}ms`);
  runner.finish();
});

test('A4: browserSite.productPage normalises non-English locale prefix to /en/', async () => {
  const prevDOMParser = globalThis.DOMParser;
  globalThis.DOMParser = class FakeDOMParser {
    parseFromString() {
      return {
        title: 'Dragon Shield | Cardmarket',
        querySelector(sel) {
          if (sel === '#table') return { querySelectorAll: () => [] };
          if (sel === 'input[name="idProduct"]') return { value: '555' };
          return null;
        },
        querySelectorAll() { return []; },
      };
    }
  };
  try {
    const requestedUrls = [];
    const site = browserSite({
      baseOrigin: 'https://www.cardmarket.com',
      fetchImpl: async url => {
        requestedUrls.push(url);
        return { ok: true, status: 200, redirected: false, url, headers: new Headers(), text: async () => '<html></html>' };
      },
    });
    await site.productPage({ productPath: '/de/Magic/Products/Sleeves/Dragon-Shield', name: 'Dragon Shield' }, { sellerCountries: [7], minCondition: 7 });
    await site.productPage({ url: 'https://www.cardmarket.com/fr/Magic/Products/Sleeves/Dragon-Shield', name: 'Dragon Shield' }, { sellerCountries: [7], minCondition: 7 });
    assert.ok(requestedUrls[0].startsWith('https://www.cardmarket.com/en/Magic/Products/Sleeves/Dragon-Shield'), `got ${requestedUrls[0]}`);
    assert.ok(requestedUrls[1].startsWith('https://www.cardmarket.com/en/Magic/Products/Sleeves/Dragon-Shield'), `got ${requestedUrls[1]}`);
  } finally {
    globalThis.DOMParser = prevDOMParser;
  }
});

test('A5: collectSellerTokens does not poison cache when blocked mid-pagination', async () => {
  const cache = new Map();
  let pageCalls = 0;
  const site = {
    async sellerTokens(seller, { pageNumber }) {
      pageCalls += 1;
      if (pageNumber === 1) {
        return {
          offers: [{ idArticle: 1, idProduct: 500, priceCents: 5, quantity: 1 }],
          total: 40,
          hasNext: true,
        };
      }
      throw new BlockedError('Verification check');
    },
  };
  const res = await collectSellerTokens(['ShopA'], { searchTerms: ['Treasure'] }, site, {
    cache,
    intervalMs: 0,
    bucketIntervals: {},
    jitter: false,
  });
  assert.ok(res.blocked);
  assert.equal(pageCalls, 2);
  assert.equal(cache.size, 0, 'blocked token pagination must not cache partial results');
  assert.equal(res.sellerSummaries[0].status, 'blocked');
});

test('A6: Any-language wants issue one language:null query instead of 11 language queries', async () => {
  const allLangs = Object.values(LANGUAGES);
  const seenCardQueries = [];
  const seenProdQueries = [];
  const plan = {
    entries: [{
      key: 'c1', game: 'Magic', name: 'Sol Ring', amount: 1,
      cardPath: '/en/Magic/Cards/Sol-Ring',
      languages: allLangs,
      minCondition: 4, foil: 'any', signed: 'any', altered: 'any',
      printings: [{ idProduct: 100, idExpansion: 1, guideLowCents: 100 }],
    }],
  };
  await collectBySellers(plan, {
    async cardPage(_entry, query) {
      seenCardQueries.push(query.language);
      return { offers: [{ idArticle: 1, idProduct: 100, seller: 'S1', location: 'Germany', condition: 2, language: 3, foil: false, signed: false, altered: false, priceCents: 100, quantity: 1 }], skipped: 0 };
    },
  }, { intervalMs: 0, bucketIntervals: {}, jitter: false });
  assert.deepEqual(seenCardQueries, [null], 'collectBySellers must query once with language:null for all languages');

  await collect(plan, {
    async firstPage(query) {
      seenProdQueries.push(query.language);
      return { offers: [{ idArticle: 1, idProduct: 100, seller: 'S1', location: 'Germany', condition: 2, language: 3, foil: false, signed: false, altered: false, priceCents: 100, quantity: 1 }], cursor: null, capped: false };
    },
  }, { intervalMs: 0, bucketIntervals: {}, jitter: false });
  assert.deepEqual(seenProdQueries, [null], 'collect() must query once with language:null for all languages');
});

test('A9: collect() marks failed non-card productPage as incomplete instead of aborting the run', async () => {
  const plan = {
    entries: [
      { key: 'prod:1', kind: 'product', game: 'Magic', name: 'Broken Sleeves', amount: 1, productPath: '/en/Magic/Products/Sleeves/Broken', languages: [], minCondition: 7, printings: [] },
      { key: 'card:1', kind: 'card', game: 'Magic', name: 'Bolt', amount: 1, languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any', printings: [{ idProduct: 10, guideLowCents: 50 }] },
    ],
  };
  const out = await collect(plan, {
    async productPage() { throw new Error('Product page layout changed'); },
    async firstPage() {
      return { offers: [{ idArticle: 1, idProduct: 10, seller: 'S1', location: 'Germany', condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 50, quantity: 2 }], cursor: null, capped: false };
    },
  }, { intervalMs: 0, bucketIntervals: {}, jitter: false });

  assert.equal(out.results.length, 2);
  const prod = out.results.find(r => r.key === 'prod:1');
  const card = out.results.find(r => r.key === 'card:1');
  assert.equal(prod.verdict, 'incomplete');
  assert.match(prod.error, /layout changed/);
  assert.equal(card.verdict, 'complete');
});

test('A12: collectBySellers stops on repeated Infinity evaluate results and skips evaluate after block', async () => {
  const plan = {
    entries: [
      { key: 'c1', game: 'Magic', listId: '1', name: 'C1', amount: 1, cardPath: '/en/Magic/Cards/C1', languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any', printings: [{ idProduct: 1, idExpansion: 1 }] },
    ],
  };
  let evalCalls = 0;
  const col = await collectBySellers(plan, {
    async cardPage() {
      return {
        offers: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((seller, i) => ({
          idArticle: i + 1, idProduct: 1, seller, location: 'Germany', condition: 2, language: 1, foil: false, signed: false, altered: false, priceCents: 100, quantity: 1,
        })),
        skipped: 0,
      };
    },
    async sellerWants() { return { offers: [], skipped: 0, total: 0, hasNext: false }; },
  }, {
    listId: '1', minSellerCards: 1, minSellers: 1, sellerBatch: 1, sellerLimit: 6,
    intervalMs: 0, bucketIntervals: {}, jitter: false,
    evaluate: async () => { evalCalls += 1; return Infinity; },
  });
  assert.equal(evalCalls, 2, 'must stop after second Infinity instead of looping through all 6 sellers');
  assert.equal(col.sellers.length, 2);
});

test('A13: parseUserOffersPage skips malformed price/quantity rows instead of failing the page', () => {
  const makeRow = (id, priceText, qtyText) => ({
    id,
    querySelector(sel) {
      if (sel.includes('.price-container')) return { textContent: priceText };
      if (sel.includes('.item-count')) return { textContent: qtyText };
      if (sel.includes('product-images')) return { getAttribute: () => '/123/456.jpg' };
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('.product-attributes')) {
        return [
          { getAttribute: a => (a === 'title' ? 'Near Mint' : '') },
          { getAttribute: a => (a === 'title' ? 'English' : '') },
        ];
      }
      return [];
    },
  });
  const page = {
    querySelector(sel) {
      if (sel === '#UserOffersTable') return {};
      if (sel === '.total-count') return { textContent: '3 Hits' };
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('stockRow')) {
        return [
          makeRow('stockRow10', '1,50 €', '2'),
          makeRow('stockRow11', 'N/A', '1'),
          makeRow('stockRow12', '2,00 €', '0'),
        ];
      }
      return [];
    },
  };
  const parsed = parseUserOffersPage(page, 'ShopA', 1);
  assert.equal(parsed.offers.length, 1);
  assert.equal(parsed.offers[0].idArticle, 10);
  assert.equal(parsed.skipped, 2);
});

test('B4: wizard optimise never drops an item costing > 1,000 EUR', async () => {
  const collection = {
    results: [
      {
        key: 'lotus', name: 'Black Lotus', amount: 1, targetCents: 250000, verdict: 'complete',
        offers: [{ idArticle: 1, idProduct: 1, seller: 'PowerShop', location: 'Germany', priceCents: 250000, quantity: 1 }],
      },
      {
        key: 'bolt', name: 'Lightning Bolt', amount: 1, targetCents: 100, verdict: 'complete',
        offers: [
          { idArticle: 2, idProduct: 2, seller: 'CheapShop', location: 'Germany', priceCents: 50, quantity: 1 },
          { idArticle: 3, idProduct: 2, seller: 'PowerShop', location: 'Germany', priceCents: 100, quantity: 1 },
        ],
      },
    ],
  };
  const planner = createPlanner(collection, SHIP_TABLE);
  const quick = planner.basket();
  assert.equal(quick.missing.length, 0);
  const opt = await planner.optimise(quick, { timeMs: 80 });
  assert.equal(opt.missing.length, 0, '2,500 EUR item must never be dropped during optimisation');
  assert.equal(opt.parcels.reduce((s, p) => s + p.items.length, 0), 2);
});

test('B9: recommendCuts handles Infinity baskets, null targetCents, and partial assignments safely', () => {
  // 1. Null targetCents item must be skipped instead of treated as 0 EUR market value
  const col = {
    results: [
      {
        key: 'rare', name: 'Unknown Price Card', amount: 1, targetCents: null, verdict: 'complete',
        offers: [{ idArticle: 1, idProduct: 1, seller: 'SoloSeller', location: 'Germany', priceCents: 500, quantity: 1 }],
      },
      {
        key: 'common', name: 'Common Card', amount: 1, targetCents: 50, verdict: 'complete',
        offers: [{ idArticle: 2, idProduct: 2, seller: 'MainSeller', location: 'Germany', priceCents: 50, quantity: 1 }],
      },
    ],
  };
  const planner = createPlanner(col, SHIP_TABLE);
  const basket = planner.basket();
  const cuts = planner.recommendCuts(basket, { maxCuts: 2, minExtraCents: 20 });
  assert.ok(!cuts.some(c => c.key === 'rare'), 'item with null targetCents must not be recommended as a cut');

  // 2. Partial assignment (wanted 4 copies, only 1 assigned): marketOf must use 1 assigned copy, not 4
  const colPartial = {
    results: [
      {
        key: 'c1', name: 'Scarce Card', amount: 4, targetCents: 100, verdict: 'short',
        offers: [{ idArticle: 10, idProduct: 10, seller: 'SoloSeller', location: 'Germany', priceCents: 100, quantity: 1 }],
      },
      {
        key: 'c2', name: 'Normal Card', amount: 1, targetCents: 100, verdict: 'complete',
        offers: [{ idArticle: 11, idProduct: 11, seller: 'MainSeller', location: 'Germany', priceCents: 100, quantity: 1 }],
      },
    ],
  };
  const p2 = createPlanner(colPartial, SHIP_TABLE);
  const b2 = p2.basket();
  const cuts2 = p2.recommendCuts(b2, { maxCuts: 1, minExtraCents: 20 });
  assert.equal(cuts2.length, 1);
  assert.equal(cuts2[0].marketCents, 100, 'marketCents must reflect 1 assigned copy, not 4 wanted copies');
});

test('B5 & B10: mergeTokensIntoBasket recalculates shipping and applyBasketRemovals preserves token shippingDeltaCents', () => {
  // 3 cards (<= 4 cards = 20g -> 1.25 EUR). Adding 2 tokens = 5 cards (50g -> 2.25 EUR, +1.00 EUR shipping delta).
  const baseCards = [1, 2, 3].map(i => ({
    key: `c${i}`, name: `Card ${i}`, kind: 'card', game: 'Magic',
    idArticle: 100 + i, idProduct: 100 + i, priceCents: 100, targetCents: 100, offerShippingCents: null,
  }));
  const baseBasket = {
    parcels: [{
      seller: 'ShopA', location: 'Germany', items: baseCards, itemsCents: 300,
      shippingCents: 125, method: 'Standard Letter', games: ['Magic'],
    }],
    curve: [{ sellers: 1, cards: 3, totalCents: 425 }],
    totalCents: 425,
    shippingCents: 125,
    missing: [],
  };
  // Deliberately pass stale newShippingCents: 999 to verify live recalculation overrides it!
  const tokenResult = {
    assignments: [
      { seller: 'ShopA', deckName: 'D1', idArticle: 201, idProduct: 501, name: 'Treasure', coveredLabels: ['Treasure'], isCombo: false, priceCents: 5 },
      { seller: 'ShopA', deckName: 'D1', idArticle: 202, idProduct: 502, name: 'Zombie', coveredLabels: ['Zombie'], isCombo: false, priceCents: 5 },
    ],
    bySeller: new Map([['ShopA', {
      seller: 'ShopA',
      addedTokens: [
        { seller: 'ShopA', deckName: 'D1', idArticle: 201, idProduct: 501, name: 'Treasure', coveredLabels: ['Treasure'], isCombo: false, priceCents: 5 },
        { seller: 'ShopA', deckName: 'D1', idArticle: 202, idProduct: 502, name: 'Zombie', coveredLabels: ['Zombie'], isCombo: false, priceCents: 5 },
      ],
      tokensCents: 10,
      baseShippingCents: 125,
      newShippingCents: 999, // stale!
      shippingDeltaCents: 874, // stale!
      newMethod: 'Stale Method',
    }]]),
    stats: { physicalTokensBought: 2, tokensCents: 10, shippingDeltaCents: 874, totalAddedCents: 884 },
  };

  const merged = mergeTokensIntoBasket(baseBasket, tokenResult, {
    tables: SHIP_TABLE,
    trackedOnly: [],
    parcelShippingFn: parcelShipping,
  });
  assert.equal(merged.parcels[0].shippingCents, 225, 'shipping recalculated from 18g->22g Large Letter');
  assert.equal(merged.tokenStats.shippingDeltaCents, 100);
  assert.equal(merged.tokenStats.totalAddedCents, 110);

  // Removing 1 of the 2 tokens drops count from 5 -> 4 cards (20g -> Standard Letter 1.25 EUR, delta 0)
  const afterDropToken = applyBasketRemovals(merged, [{
    seller: 'ShopA',
    item: merged.parcels[0].items[4], // second token
  }], { tables: SHIP_TABLE });
  assert.equal(afterDropToken.parcels[0].shippingCents, 125);
  assert.equal(afterDropToken.tokenStats.physicalTokensBought, 1);
  assert.equal(afterDropToken.tokenStats.tokensCents, 5);
  assert.equal(afterDropToken.tokenStats.shippingDeltaCents, 0);
  assert.equal(afterDropToken.tokenStats.totalAddedCents, 5);

  // 4 cards + 2 tokens = 6 cards (50g -> 2.25 EUR). Dropping 1 regular card leaves 3 cards + 2 tokens = 5 cards (2.25 EUR)
  // vs 3 cards alone (20g -> 1.25 EUR) => shippingDeltaCents = 100, totalAddedCents = 110.
  const fourCardsBasket = {
    ...baseBasket,
    parcels: [{
      ...baseBasket.parcels[0],
      items: [...baseCards, { key: 'c4', name: 'Card 4', kind: 'card', game: 'Magic', idArticle: 104, idProduct: 104, priceCents: 100, targetCents: 100, offerShippingCents: null }],
      itemsCents: 400,
      shippingCents: 125,
    }],
  };
  const merged4 = mergeTokensIntoBasket(fourCardsBasket, tokenResult, {
    tables: SHIP_TABLE,
    trackedOnly: [],
    parcelShippingFn: parcelShipping,
  });
  const afterDropCard = applyBasketRemovals(merged4, [{
    seller: 'ShopA',
    item: merged4.parcels[0].items[3], // Card 4
  }], { tables: SHIP_TABLE });
  assert.equal(afterDropCard.tokenStats.physicalTokensBought, 2);
  assert.equal(afterDropCard.tokenStats.tokensCents, 10);
  assert.equal(afterDropCard.tokenStats.shippingDeltaCents, 100);
  assert.equal(afterDropCard.tokenStats.totalAddedCents, 110);
});
