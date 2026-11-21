// Run: node --test cardmarket-wizard/test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../collector.js');
const { collect, createRunner, browserSite, RetryableError, BlockedError } = globalThis.CardmarketCollector;

// A fake Cardmarket: offers per printing, served cheapest-first, 50 per page, at most 300 per query.
function fakeSite(catalogue, { failFirst = 0, broken = new Set(), blockAfter = Infinity } = {}) {
  const calls = [];
  let failures = failFirst;
  const matching = query => (catalogue[query.idProduct] || [])
    .filter(offer => query.sellerType === undefined || offer.sellerType === query.sellerType)
    .sort((a, b) => a.priceCents - b.priceCents || a.idArticle - b.idArticle);
  const page = (query, number) => {
    const all = matching(query).slice(0, 300);
    const offers = all.slice(number * 50, number * 50 + 50);
    const capped = matching(query).length > 300 && (number + 1) * 50 >= 300;
    const more = (number + 1) * 50 < all.length;
    return { offers: offers.map(offer => ({ ...offer })), cursor: more ? { page: number + 1 } : null, capped: capped && !more };
  };
  const guard = query => {
    calls.push(query.idProduct);
    if (calls.length > blockAfter) throw new BlockedError('check');
    if (failures > 0) { failures -= 1; throw new RetryableError('HTTP 429'); }
    if (broken.has(query.idProduct)) throw new Error('unreadable');
  };
  return {
    calls,
    async firstPage(query) { guard(query); return page(query, 0); },
    async nextPage(query, cursor) { guard(query); return page(query, cursor.page); },
  };
}

let nextId = 1;
const offers = (count, from, step, extra = {}) => Array.from({ length: count }, (_, i) => ({
  idArticle: nextId++, seller: `s${nextId % 97}`, priceCents: from + i * step, quantity: 1, sellerType: i % 3, ...extra,
}));
const entry = (printings, amount = 1) => ({
  key: 'k', name: 'Card', amount, languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any', printings,
});
const options = { retryDelayMs: 1, intervalMs: 0 };

// Every offer up to the cutoff, across all printings, must be kept.
function assertComplete(catalogue, result) {
  const kept = new Set(result.offers.map(offer => offer.idArticle));
  const missing = Object.values(catalogue).flat().filter(offer => offer.priceCents <= result.cutoffCents && !kept.has(offer.idArticle));
  assert.deepEqual(missing, []);
}

test('reads cheapest-first and stops at the cutoff', async () => {
  const catalogue = { 1: offers(200, 100, 10), 2: offers(40, 300, 50), 3: offers(10, 2000, 10) };
  const site = fakeSite(catalogue);
  const plan = { entries: [entry([{ idProduct: 1, guideLowCents: 90 }, { idProduct: 2, guideLowCents: 280 }, { idProduct: 3, guideLowCents: 1900 }])] };
  const [result] = (await collect(plan, site, options)).results;
  assert.equal(result.verdict, 'complete');
  assert.equal(result.targetCents, 140, '5th cheapest copy');
  assert.equal(result.cutoffCents, 280, 'twice the target');
  assertComplete(catalogue, result);
  assert.equal(site.calls.filter(id => id === 3).length, 0, 'printing 3 skipped by its guide price');
  assert.equal(site.calls.filter(id => id === 1).length, 1, 'printing 1 needs no second page');
});

test('target needs 3 sellers, and at least as many copies as wanted', async () => {
  const twoSellers = { 1: offers(6, 100, 10).map((offer, i) => ({ ...offer, seller: `s${i % 2}` })).concat(offers(1, 300, 0)) };
  const [result] = (await collect({ entries: [entry([{ idProduct: 1, guideLowCents: 100 }])] }, fakeSite(twoSellers), options)).results;
  assert.equal(result.targetCents, 300);
  const catalogue = { 1: offers(10, 100, 100) };
  const [many] = (await collect({ entries: [entry([{ idProduct: 1, guideLowCents: 100 }], 8)] }, fakeSite(catalogue), options)).results;
  assert.equal(many.targetCents, 800);
  assert.equal(many.cutoffCents, 1600);
});

test('a cheap card keeps a cutoff margin of at least 50 cents', async () => {
  const catalogue = { 1: offers(10, 10, 0) };
  const [result] = (await collect({ entries: [entry([{ idProduct: 1, guideLowCents: 10 }])] }, fakeSite(catalogue), options)).results;
  assert.equal(result.cutoffCents, 60);
});

test('with too few copies for a target, reads everything', async () => {
  const catalogue = { 1: offers(2, 100, 1000), 2: offers(1, 5000, 0) };
  const plan = { entries: [entry([{ idProduct: 1, guideLowCents: 100 }, { idProduct: 2, guideLowCents: 5000 }])] };
  const [result] = (await collect(plan, fakeSite(catalogue), options)).results;
  assert.equal(result.cutoffCents, null);
  assert.equal(result.offers.length, 3);
  assert.equal(result.targetCents, 100, 'the cheapest copy, not the dearest, stands in for market');
});

test('splits a capped printing by seller type and keeps all offers under the cutoff', async () => {
  const catalogue = { 1: offers(700, 100, 0) };
  const [result] = (await collect({ entries: [entry([{ idProduct: 1, guideLowCents: 100 }])] }, fakeSite(catalogue), options)).results;
  assert.equal(result.verdict, 'complete');
  assert.ok(result.queries.some(query => query.status === 'split'));
  assertComplete(catalogue, result);
});

test('reports a cap it cannot split past', async () => {
  const catalogue = { 1: offers(1200, 100, 0, { sellerType: 0 }) };
  const [result] = (await collect({ entries: [entry([{ idProduct: 1, guideLowCents: 100 }])] }, fakeSite(catalogue), options)).results;
  assert.equal(result.verdict, 'capped');
});

test('reads printings without a guide price and never counts errors as empty', async () => {
  const catalogue = { 1: offers(3, 500, 1), 2: offers(3, 100, 1) };
  const plan = { entries: [entry([{ idProduct: 1, guideLowCents: 500 }, { idProduct: 2, guideLowCents: null }])] };
  const [found] = (await collect(plan, fakeSite(catalogue), options)).results;
  assert.equal(found.offers[0].priceCents, 100);
  const [broken] = (await collect(plan, fakeSite(catalogue, { broken: new Set([2]) }), options)).results;
  assert.equal(broken.verdict, 'incomplete');
});

test('retries rate limits and stops everything on a verification check', async () => {
  const catalogue = { 1: offers(3, 100, 1) };
  const plan = { entries: [entry([{ idProduct: 1, guideLowCents: 100 }])] };
  const run = await collect(plan, fakeSite(catalogue, { failFirst: 2 }), options);
  assert.equal(run.results[0].verdict, 'complete');
  assert.equal(run.stats.retries, 2);
  const blocked = await collect({ entries: [plan.entries[0], { ...plan.entries[0], key: 'b' }] }, fakeSite(catalogue, { blockAfter: 1 }), options);
  assert.ok(blocked.blocked);
  assert.ok(blocked.results.some(result => result.verdict === 'blocked'));
});

test('treats a Cloudflare challenge as a stop, even when it arrives as HTTP 429', async () => {
  const challenge = async () => ({
    status: 429, ok: false, url: 'https://www.cardmarket.com/en/Magic/Products',
    headers: new Headers({ 'cf-mitigated': 'challenge' }), text: async () => '<title>Just a moment...</title>',
  });
  const site = browserSite({ fetchImpl: challenge });
  await assert.rejects(site.firstPage({ idProduct: 1, language: 1, sellerCountries: [7], minCondition: 7, foil: 'any', signed: 'any', altered: 'any' }), BlockedError);
});

test('resumes from cached snapshots without new requests', async () => {
  const catalogue = { 1: offers(120, 100, 1), 2: offers(5, 150, 1) };
  const plan = { entries: [entry([{ idProduct: 1, guideLowCents: 100 }, { idProduct: 2, guideLowCents: 150 }])] };
  const cache = new Map();
  const first = await collect(plan, fakeSite(catalogue), { ...options, cache });
  const site = fakeSite(catalogue);
  const second = await collect(plan, site, { ...options, cache });
  assert.equal(site.calls.length, 0);
  assert.equal(second.stats.cachedQueries, 2);
  const ids = run => run.results[0].offers.map(offer => offer.idArticle).sort((a, b) => a - b);
  assert.deepEqual(ids(second), ids(first));
  assertComplete(catalogue, second.results[0]);
});

test('re-reads a cached printing that stopped below a higher cutoff', async () => {
  const catalogue = { 1: offers(120, 100, 10) };
  const cache = new Map();
  const plan = amount => ({ entries: [entry([{ idProduct: 1, guideLowCents: 100 }], amount)] });
  await collect(plan(1), fakeSite(catalogue), { ...options, cache });
  const [result] = (await collect(plan(60), fakeSite(catalogue), { ...options, cache })).results;
  assertComplete(catalogue, result);
});

test('stops when aborted and keeps what it read', async () => {
  const catalogue = { 1: offers(3, 100, 1), 2: offers(3, 100, 1) };
  const controller = new AbortController();
  const cache = new Map();
  const site = fakeSite(catalogue);
  const original = site.firstPage;
  site.firstPage = async query => { const page = await original(query); controller.abort(); return page; };
  const run = await collect({ entries: [entry([{ idProduct: 1, guideLowCents: 100 }]), { ...entry([{ idProduct: 2, guideLowCents: 100 }]), key: 'b' }] },
    site, { ...options, cache, signal: controller.signal, concurrency: 1 });
  assert.equal(run.blocked, 'Stopped.');
  assert.equal(cache.size, 1);
});

test('waits for the user at a check, slows down, then finishes', async () => {
  const catalogue = { 1: offers(3, 100, 1), 2: offers(3, 100, 1) };
  const site = fakeSite(catalogue);
  const original = site.firstPage;
  let checks = 1;
  site.firstPage = async query => {
    if (checks > 0) { checks -= 1; throw new BlockedError('check'); }
    return original(query);
  };
  const events = [];
  let asked = 0;
  const run = await collect({ entries: [entry([{ idProduct: 1, guideLowCents: 100 }]), { ...entry([{ idProduct: 2, guideLowCents: 100 }]), key: 'b' }] },
    site, { ...options, intervalMs: 10, waitForUser: async () => { asked += 1; }, log: event => events.push(event) });
  assert.equal(asked, 1);
  assert.equal(run.blocked, null);
  assert.deepEqual(run.results.map(result => result.verdict), ['complete', 'complete']);
  assert.equal(run.stats.intervalMs, 15);
  for (const type of ['run-start', 'pause', 'resume', 'printing', 'card', 'run-end']) assert.ok(events.some(event => event.type === type), type);
});

test('stops when the user declines to continue', async () => {
  const site = fakeSite({ 1: offers(3, 100, 1) }, { blockAfter: 0 });
  const run = await collect({ entries: [entry([{ idProduct: 1, guideLowCents: 100 }])] }, site,
    { ...options, waitForUser: () => Promise.reject(new Error('stop')) });
  assert.equal(run.blocked, 'Stopped.');
  assert.equal(run.results[0].verdict, 'blocked');
});

test('finishes cards a few at a time', async () => {
  const catalogue = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i + 1, offers(3, 100, 1)]));
  const site = fakeSite(catalogue);
  const plan = { entries: Object.keys(catalogue).map(id => ({ ...entry([{ idProduct: Number(id), guideLowCents: 100 }]), key: id })) };
  await collect(plan, site, { ...options, entryConcurrency: 2 });
  assert.deepEqual(site.calls.slice(0, 2).sort(), [1, 2]);
  assert.deepEqual(site.calls.slice(-2).sort(), [5, 6]);
});

test('browser site goes straight to a known product page and logs redirects', async () => {
  globalThis.location = { href: 'https://www.cardmarket.com/en/Magic/Wants/1' };
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    return { status: 200, ok: true, redirected: !url.includes('Singles'), url: 'https://www.cardmarket.com/en/Magic/Products/Singles/Set/Card',
      headers: new Headers(), text: async () => '<title>x</title>' };
  };
  const paths = new Map([[2, '/en/Magic/Products/Singles/Other/Card']]);
  const seen = [];
  const site = browserSite({ fetchImpl, paths, onResponse: response => seen.push(response) });
  const query = id => ({ idProduct: id, language: 1, sellerCountries: [7], minCondition: 4, foil: 'any', signed: 'any', altered: 'any' });
  // No DOMParser in Node: the page check fails after the request, which is all this test needs.
  await assert.rejects(site.firstPage(query(2)));
  assert.equal(urls[0], '/en/Magic/Products/Singles/Other/Card?language=1&sellerCountry=7&minCondition=4');
  await assert.rejects(site.firstPage(query(3)));
  assert.match(urls[1], /^\/en\/Magic\/Products\?idProduct=3&/);
  assert.equal(seen[1].redirectedTo, '/en/Magic/Products/Singles/Set/Card');
});

test('a want\'s maximum price caps the offers and the cutoff', async () => {
  const catalogue = { 1: offers(20, 100, 10) };
  const wanted = { ...entry([{ idProduct: 1, guideLowCents: 100 }]), maxPriceCents: 150 };
  const [result] = (await collect({ entries: [wanted] }, fakeSite(catalogue), options)).results;
  assert.equal(result.maxPriceCents, 150);
  assert.equal(result.cutoffCents, 150, 'cutoff is clamped to the maximum price');
  assert.ok(result.offers.length > 0);
  assert.ok(result.offers.every(offer => offer.priceCents <= 150), 'no offer above the maximum price is kept');
});

test('a 5xx on a cart request is not retried, but a rate limit is', async () => {
  const runnerOptions = { retryDelayMs: 1, intervalMs: 0, bucketIntervals: {} };
  let serverCalls = 0;
  const failing = createRunner({ async addToCart() { serverCalls += 1; throw new RetryableError('HTTP 500'); } }, runnerOptions);
  await assert.rejects(failing.call('addToCart', 1, 1), /HTTP 500/);
  assert.equal(serverCalls, 1, 'the cart POST is sent once');

  let rateCalls = 0;
  const limited = createRunner({
    async addToCart() {
      rateCalls += 1;
      if (rateCalls === 1) throw new RetryableError('HTTP 429', { cause: 'rate' });
    },
  }, runnerOptions);
  await limited.call('addToCart', 1, 1);
  assert.equal(rateCalls, 2, 'a 429 is retried');
});
