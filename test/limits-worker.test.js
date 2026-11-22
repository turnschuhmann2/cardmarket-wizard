'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Load the optimiser worker in-process with a fake worker global.
globalThis.self = globalThis;
globalThis.importScripts = file => require(path.join(__dirname, '..', file));
const posted = [];
globalThis.postMessage = msg => posted.push(msg);
require('../optimizer-worker.js');
const { createPlanner, parseShippingTable, STRATEGIES } = globalThis.CardmarketWizard;
const table = parseShippingTable(require('./fixtures/shipping-de-de.json'));

function collection() {
  const results = [];
  for (let i = 0; i < 12; i += 1) {
    const offers = [];
    for (let s = 0; s < 6; s += 1) {
      offers.push({ idArticle: i * 100 + s, idProduct: i + 1, seller: `s${s}`, priceCents: 20 + i * 40 + s * 7, quantity: 1 });
    }
    results.push({ key: `card${i}`, name: `Card ${i}`, game: 'Magic', listId: i < 6 ? 1 : 2, listName: i < 6 ? 'A' : 'B', amount: 1, targetCents: 20 + i * 40, offers });
  }
  return { results };
}

async function send(data) {
  posted.length = 0;
  await globalThis.onmessage({ data });
  return posted.find(m => m.event === 'done' || m.event === 'error');
}

test('seller search with patience stops well before its time budget once it converges', async () => {
  const planner = createPlanner(collection(), table);
  const t0 = Date.now();
  await planner.optimise(planner.basket(), { timeMs: 3000, strategies: [{ ...STRATEGIES[0], patience: 3 }] });
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('suggest-limits reuses a cached collection by id and a passed-in baseline', async () => {
  const col = collection();
  const scope = { type: 'all', label: 'All' };
  const first = await send({ id: 1, type: 'suggest-limits', collection: col, collectionId: 7, tables: table, tablesId: 1, scope, candidates: [] });
  assert.equal(first.event, 'done');
  assert.ok(first.baseline.totalCents > 0);
  assert.equal(first.totalScopedCopies, 12);

  // No collection payload: the worker must use the one it cached under id 7.
  const split = await send({ id: 2, type: 'suggest-limits', collectionId: 7, tables: table, tablesId: 1, scope, baseline: first.baseline, candidates: [100, 300], markSuggestion: false });
  assert.equal(split.event, 'done');
  assert.equal(split.baselineCents, first.baseline.totalCents);
  assert.ok(split.options.length > 0);
  assert.ok(split.options.every(o => !o.suggested));
  assert.ok(split.options.every(o => o.savesCents === first.baseline.totalCents - o.basketCents));

  const missing = await send({ id: 3, type: 'suggest-limits', collectionId: 99, tables: table, scope, candidates: [] });
  assert.equal(missing.event, 'error');
  assert.equal(missing.code, 'collection-missing');
});

test('cancel-limits supersedes a running estimate', async () => {
  const run = globalThis.onmessage({ data: { id: 10, type: 'suggest-limits', collectionId: 7, tables: table, scope: { type: 'all', label: 'All' }, candidates: [50, 100, 200, 300, 500] } });
  await globalThis.onmessage({ data: { id: 11, type: 'cancel-limits' } });
  await run;
  assert.ok(posted.some(m => m.id === 10 && m.cancelled));
});
