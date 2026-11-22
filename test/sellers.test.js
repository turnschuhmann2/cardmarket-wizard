'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../collector.js');
const { collectBySellers, RetryableError } = globalThis.CardmarketCollector;

const options = { listId: 1, retryDelayMs: 1, intervalMs: 0, minSellerCards: 2 };
const want = (key, printings, extra = {}) => ({
  key, name: key, amount: 1, anyPrinting: true, cardPath: `/en/Magic/Cards/${key}`, languages: [1], minCondition: 4,
  foil: 'any', signed: 'any', altered: 'any', printings: printings.map(idProduct => ({ idProduct })), ...extra,
});
let nextId = 1;
const offer = (seller, idProduct, priceCents, extra = {}) => ({
  idArticle: nextId++, seller, idProduct, priceCents, quantity: 1, language: 1, condition: 2, foil: false, signed: false, altered: false, ...extra,
});

function fakeSite(cardOffers, inventories, { pageSize = 2, retryAfterOnce = null } = {}) {
  const calls = [];
  let retried = false;
  return {
    calls,
    async cardPage(entry) {
      calls.push(['card', entry.key]);
      if (retryAfterOnce === 'cards' && !retried) { retried = true; throw Object.assign(new RetryableError('HTTP 429'), { retryAfterMs: 30 }); }
      return { offers: cardOffers[entry.key] || [], skipped: 0 };
    },
    async sellerWants(seller, listId, page) {
      calls.push(['seller', seller, page]);
      const all = inventories[seller] || [];
      return { offers: all.slice((page - 1) * pageSize, page * pageSize), skipped: 0, total: all.length, hasNext: page * pageSize < all.length };
    },
  };
}

test('asks the sellers cheap for most cards for their whole Wants List overlap', async () => {
  const plan = { entries: [want('a', [1, 2]), want('b', [3]), want('c', [4])] };
  const cardOffers = {
    a: [offer('big', 1, 10), offer('s1', 1, 11), offer('s2', 2, 12), offer('s3', 1, 13), offer('s4', 1, 14)],
    b: [offer('big', 3, 20), offer('s1', 3, 21), offer('s2', 3, 22), offer('s3', 3, 23), offer('s4', 3, 24)],
    c: [offer('s5', 4, 30)],
  };
  // big also has c (above everyone's price) and a French copy of a (filtered out by the want).
  const inventories = { big: [offer('big', 1, 10), offer('big', 3, 20), offer('big', 4, 90), offer('big', 2, 5, { language: 2 })] };
  const site = fakeSite(cardOffers, inventories);
  const run = await collectBySellers(plan, site, options);
  const c = run.results.find(result => result.key === 'c');
  assert.ok(c.offers.some(o => o.seller === 'big' && o.priceCents === 90), 'dearer copy from the big seller is kept');
  assert.ok(!run.results.find(result => result.key === 'a').offers.some(o => o.language === 2), 'want filters apply to seller offers');
  const big = run.sellers.find(state => state.seller === 'big');
  assert.equal(big.status, 'complete');
  assert.equal(big.pages, 2);
  assert.ok(!run.sellers.some(state => state.seller === 's5'), 'a seller cheap for one card only is not asked');
  assert.equal(run.results.find(result => result.key === 'a').targetCents, 14);
});

test('a Retry-After holds that page type, then the request is repeated', async () => {
  const plan = { entries: [want('a', [1])] };
  const site = fakeSite({ a: [offer('x', 1, 10)] }, {}, { retryAfterOnce: 'cards' });
  const events = [];
  const run = await collectBySellers(plan, site, { ...options, log: event => events.push(event) });
  assert.equal(run.results[0].verdict, 'read');
  assert.equal(site.calls.filter(([kind]) => kind === 'card').length, 2);
  assert.ok(events.some(event => event.type === 'wait' && event.bucket === 'cards'));
  assert.equal(run.stats.retries, 0);
});

test('reruns come from the cache', async () => {
  const plan = { entries: [want('a', [1]), want('b', [2])] };
  const cardOffers = { a: [offer('big', 1, 10)], b: [offer('big', 2, 10)] };
  const cache = new Map();
  await collectBySellers(plan, fakeSite(cardOffers, { big: [offer('big', 1, 10)] }), { ...options, cache });
  const site = fakeSite(cardOffers, { big: [offer('big', 1, 10)] });
  await collectBySellers(plan, site, { ...options, cache });
  assert.equal(site.calls.length, 0);
});

test('asks more sellers in batches while that still lowers the basket', async () => {
  const keys = ['a', 'b', 'c'];
  const plan = { entries: keys.map((key, i) => want(key, [i + 1])) };
  // Six sellers, each cheap for all three cards, ranked in this order.
  const sellers = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const cardOffers = Object.fromEntries(keys.map((key, i) => [key, sellers.map(seller => offer(seller, i + 1, 10))]));
  const site = fakeSite(cardOffers, {});
  const costs = [1000, 500, 450];
  const asked = [];
  const run = await collectBySellers(plan, site, {
    ...options, minSellers: 2, sellerBatch: 2, improvementCents: 100,
    evaluate: () => { asked.push(site.calls.filter(([kind]) => kind === 'seller').length); return costs.shift(); },
  });
  // 2 sellers -> 1000; 4 -> 500 (saved 500, go on); 6 -> 450 (saved 50, stop).
  assert.deepEqual(asked, [2, 4, 6]);
  assert.deepEqual(run.stats.sellerBatches.map(batch => batch.savedCents), [null, 500, 50]);
});

test('without a basket price, asks only the first sellers', async () => {
  const keys = ['a', 'b'];
  const plan = { entries: keys.map((key, i) => want(key, [i + 1])) };
  const cardOffers = Object.fromEntries(keys.map((key, i) => [key, ['s1', 's2', 's3'].map(seller => offer(seller, i + 1, 10))]));
  const site = fakeSite(cardOffers, {});
  await collectBySellers(plan, site, { ...options, minSellers: 2 });
  assert.equal(site.calls.filter(([kind]) => kind === 'seller').length, 2);
});

test('groups printings by expansion, cheapest guide first, new printings in the first group', () => {
  const { expansionGroups } = globalThis.CardmarketCollector;
  const printings = [
    { idProduct: 1, idExpansion: 10, guideLowCents: 500 }, { idProduct: 2, idExpansion: 20, guideLowCents: 50 },
    { idProduct: 3, idExpansion: 20, guideLowCents: 900 }, { idProduct: 4, idExpansion: 30, guideLowCents: null },
    { idProduct: 5, idExpansion: 40, guideLowCents: 70 },
  ];
  const groups = expansionGroups(printings, 2);
  assert.deepEqual(groups.map(group => group.expansions), [[30, 20], [40, 10]]);
  assert.deepEqual([...groups[0].products].sort(), [2, 3, 4], 'both printings of expansion 20 stay together');
  assert.equal(groups[1].minGuideCents, 70);
});

test('reads expansion groups until the next one cannot beat the cutoff', async () => {
  const printings = [
    { idProduct: 1, idExpansion: 10, guideLowCents: 10 }, { idProduct: 2, idExpansion: 20, guideLowCents: 15 },
    { idProduct: 3, idExpansion: 30, guideLowCents: 5000 },
  ];
  const plan = { entries: [{ ...want('a', []), printings }] };
  const byExpansion = { 10: [offer('x1', 1, 40), offer('x2', 1, 41), offer('x3', 1, 42)], 20: [offer('y1', 2, 12), offer('y2', 2, 13)], 30: [offer('z', 3, 5000)] };
  const asked = [];
  const site = {
    async cardPage(entry, query) {
      asked.push(query.expansions);
      return { offers: query.expansions.flatMap(id => byExpansion[id]).sort((a, b) => a.priceCents - b.priceCents), skipped: 0 };
    },
    async sellerWants() { return { offers: [], skipped: 0, total: 0, hasNext: false }; },
  };
  const run = await collectBySellers(plan, site, { ...options, expansionGroupSize: 1 });
  assert.deepEqual(asked, [[10], [20]], 'the expansion priced at 50 EUR is not read');
  const [result] = run.results;
  assert.equal(result.offers[0].priceCents, 12, 'the cheaper older printing is found');
  assert.equal(result.groupsSkipped, 1);
});

test('thorough: reads each expansion group once per seller type', async () => {
  const printings = [{ idProduct: 1, idExpansion: 10, guideLowCents: 10 }];
  const plan = { entries: [{ ...want('a', []), printings }] };
  const byType = { 0: [offer('p1', 1, 10), offer('p2', 1, 11)], 1: [offer('r1', 1, 12)], 2: [offer('w1', 1, 13), offer('w2', 1, 14)] };
  const asked = [];
  const site = {
    async cardPage(entry, query) { asked.push(query.sellerType); return { offers: query.sellerType === undefined ? [] : byType[query.sellerType], skipped: 0 }; },
    async sellerWants() { return { offers: [], skipped: 0, total: 0, hasNext: false }; },
  };
  const run = await collectBySellers(plan, site, { ...options, splitBySellerType: true });
  assert.deepEqual(asked, [0, 1, 2]);
  assert.equal(run.results[0].offers.length, 5);
  assert.equal(run.results[0].cardPages, 3);
  asked.length = 0;
  await collectBySellers(plan, site, options);
  assert.deepEqual(asked, [undefined], 'the normal profile reads one page per group');
});

test('a want missing from the catalogue accepts any identified offer', async () => {
  const plan = { entries: [want('a', [], { idProduct: 99 })] };
  const site = fakeSite({ a: [offer('x', 7, 10), offer('y', 8, 12)] }, {});
  const run = await collectBySellers(plan, site, options);
  assert.deepEqual(run.results[0].offers.map(o => o.idProduct).sort(), [7, 8]);
});

test('a specific printing missing from the catalogue accepts only its own id, in both phases', async () => {
  const plan = { entries: [want('a', [], { idProduct: 99, anyPrinting: false }), want('b', [3])] };
  const cardOffers = {
    a: [offer('big', 99, 10), offer('s1', 99, 11), offer('s2', 99, 12), offer('s3', 99, 13), offer('s4', 99, 14), offer('s5', 7, 5)],
    b: [offer('big', 3, 20), offer('s1', 3, 21), offer('s2', 3, 22), offer('s3', 3, 23), offer('s4', 3, 24)],
  };
  // big's Wants List rows: a dearer copy of the wanted printing and another printing of the same card.
  const inventories = { big: [offer('big', 99, 90), offer('big', 7, 5), offer('big', 3, 20)] };
  const run = await collectBySellers(plan, fakeSite(cardOffers, inventories), options);
  const a = run.results.find(result => result.key === 'a');
  assert.ok(a.offers.every(o => o.idProduct === 99), 'other printings are rejected');
  assert.ok(a.offers.some(o => o.seller === 'big' && o.priceCents === 90), 'seller-mode Phase 2 matches the wanted id');
});

test('Phase 2 stops paging early when ascending seller offers exceed remaining card ceilings', async () => {
  // Cards a and b have target ~14-24 cents, cutoff ~64-74 cents, ceiling with +150 margin ~164-174 cents.
  const plan = { entries: [want('a', [1]), want('b', [2]), want('c', [3])] };
  const cardOffers = {
    a: [offer('mega', 1, 10), offer('s1', 1, 11), offer('s2', 1, 12), offer('s3', 1, 13), offer('s4', 1, 14)],
    b: [offer('mega', 2, 20), offer('s1', 2, 21), offer('s2', 2, 22), offer('s3', 2, 23), offer('s4', 2, 24)],
    c: [offer('s1', 3, 30), offer('s2', 3, 31), offer('s3', 3, 32), offer('s4', 3, 33), offer('s5', 3, 34)],
  };
  // mega has 5 ascending pages (2 rows/page): page 1 cheap (10, 20), page 2 crosses ceiling (80, 500),
  // pages 3-5 are expensive foils (600..2000) that cannot beat c's ceiling (184).
  const inventories = {
    mega: [
      offer('mega', 1, 10), offer('mega', 2, 20),
      offer('mega', 3, 80), offer('mega', 3, 500),
      offer('mega', 1, 600), offer('mega', 2, 700),
      offer('mega', 3, 1200), offer('mega', 1, 1500),
      offer('mega', 2, 1800), offer('mega', 3, 2000),
    ],
  };
  const site = fakeSite(cardOffers, inventories, { pageSize: 2 });
  const run = await collectBySellers(plan, site, { ...options, maxSellerPages: 10 });
  const mega = run.sellers.find(s => s.seller === 'mega');
  assert.equal(mega.pages, 2, 'stops at page 2 once ascending prices pass remaining ceiling');
  assert.equal(mega.ceilingStopped, true);
  assert.equal(mega.status, 'complete');
  assert.ok(run.results.find(r => r.key === 'c').offers.some(o => o.seller === 'mega' && o.priceCents === 80));

  // Unsorted seller pages must NOT early-stop so a cheap row on a later page is never missed.
  const unsorted = {
    mega: [
      offer('mega', 1, 500), offer('mega', 2, 10), // non-ascending on page 1!
      offer('mega', 3, 600), offer('mega', 1, 700),
      offer('mega', 3, 45), // cheap offer buried on page 3
    ],
  };
  const site2 = fakeSite(cardOffers, unsorted, { pageSize: 2 });
  const run2 = await collectBySellers(plan, site2, { ...options, maxSellerPages: 10 });
  const mega2 = run2.sellers.find(s => s.seller === 'mega');
  assert.equal(mega2.pages, 3, 'unsorted rows disable price ceiling early stop');
  assert.equal(mega2.ceilingStopped, false);
  assert.ok(run2.results.find(r => r.key === 'c').offers.some(o => o.seller === 'mega' && o.priceCents === 45));
});

test('deduplicates concurrent identical card queries in-flight and honors concurrency > 2', async () => {
  // Two entries pointing to the exact same cardPath & filters across two lists, plus 4 distinct cards.
  const plan = {
    entries: [
      want('dup1', [1], { cardPath: '/en/Magic/Cards/Shared', listId: '10' }),
      want('dup2', [1], { cardPath: '/en/Magic/Cards/Shared', listId: '20' }),
      want('c1', [2], { listId: '10' }),
      want('c2', [3], { listId: '10' }),
      want('c3', [4], { listId: '10' }),
      want('c4', [5], { listId: '10' }),
    ],
  };
  let active = 0;
  let maxActive = 0;
  const cardPathsCalled = [];
  const site = {
    async cardPage(entry) {
      cardPathsCalled.push(entry.cardPath);
      active += 1;
      if (active > maxActive) maxActive = active;
      await new Promise(r => setTimeout(r, 25));
      active -= 1;
      return { offers: [offer('s1', entry.printings[0].idProduct, 50)], skipped: 0 };
    },
    async sellerWants() { return { offers: [], skipped: 0, total: 0, hasNext: false }; },
  };
  const run = await collectBySellers(plan, site, {
    ...options,
    lists: [{ game: 'Magic', listId: '10' }, { game: 'Magic', listId: '20' }],
    concurrency: 4,
    cache: new Map(),
  });
  assert.equal(cardPathsCalled.filter(p => p === '/en/Magic/Cards/Shared').length, 1, 'duplicate card page fetched only once');
  assert.ok(maxActive >= 4, `expected concurrency >= 4 in flight, got ${maxActive}`);
  assert.equal(run.results.find(r => r.key === 'dup1').offers.length, 1);
  assert.equal(run.results.find(r => r.key === 'dup2').offers.length, 1);
});

test('multi-game Phase 2 skips querying a single-game seller on a large list of another game', async () => {
  const mtgEntries = Array.from({ length: 5 }, (_, i) => want(`m${i}`, [100 + i], { game: 'Magic', listId: '10' }));
  const ygoEntries = Array.from({ length: 5 }, (_, i) => want(`y${i}`, [200 + i], { game: 'YuGiOh', listId: '20', cardPath: `/en/YuGiOh/Cards/y${i}` }));
  const plan = { entries: [...mtgEntries, ...ygoEntries] };

  const cardOffers = {};
  for (let i = 0; i < 5; i += 1) {
    cardOffers[`m${i}`] = [offer('mtgOnly', 100 + i, 10), offer('crossShop', 100 + i, 11)];
    cardOffers[`y${i}`] = [offer('ygoOnly', 200 + i, 10), offer('crossShop', 200 + i, 11)];
  }
  const sellerCalls = [];
  const site = {
    async cardPage(entry) { return { offers: cardOffers[entry.key] || [], skipped: 0 }; },
    async sellerWants(seller, listId, page, game) {
      sellerCalls.push({ seller, listId, game });
      return { offers: [], skipped: 0, total: 0, hasNext: false };
    },
  };
  await collectBySellers(plan, site, {
    ...options,
    lists: [{ game: 'Magic', listId: '10' }, { game: 'YuGiOh', listId: '20' }],
  });

  const gamesFor = seller => sellerCalls.filter(c => c.seller === seller).map(c => c.game).sort();
  assert.deepEqual(gamesFor('mtgOnly'), ['Magic'], 'Magic-only seller skips Yu-Gi-Oh! list');
  assert.deepEqual(gamesFor('ygoOnly'), ['YuGiOh'], 'Yu-Gi-Oh!-only seller skips Magic list');
  assert.deepEqual(gamesFor('crossShop'), ['Magic', 'YuGiOh'], 'cross-game seller is queried on both lists');
});
