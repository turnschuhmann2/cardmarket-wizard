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
