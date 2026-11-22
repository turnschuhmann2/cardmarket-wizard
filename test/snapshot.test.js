'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

require('../wizard.js');
require('../exports.js');

const { basketItemSignature, applyBasketRemovals } = globalThis.CardmarketWizard;
const {
  createBasketSnapshot,
  readBasketSnapshot,
  basketFingerprint,
  collectBasketEntries,
  groupExportEntries,
  formatArchidektExport,
  formatPlainExport,
} = globalThis.CardmarketExport;

const DE_TABLE = [
  { name: 'Standard Letter', maxWeight: 20, maxValueCents: 2500, priceCents: 125, tracked: false },
  { name: 'Large Letter', maxWeight: 100, maxValueCents: 2500, priceCents: 200, tracked: false },
];
const TABLES = { default: DE_TABLE, defaultLocation: 'Germany', byLocation: { Germany: DE_TABLE } };

const card = (name, idArticle, idProduct, listId, listName, priceCents, extra = {}) => ({
  key: `${listId}:${name}`, name, kind: 'card', game: 'Magic', listId, listName,
  idArticle, idProduct, foil: false, priceCents, targetCents: priceCents, ...extra,
});

function sampleBasket() {
  const parcels = [
    {
      seller: 'ShopA', location: 'Germany', itemsCents: 600, shippingCents: 125,
      items: [
        card('Sol Ring', 1, 10, '101', 'Alice EDH', 200),
        card('Arcane Signet', 2, 11, '101', 'Alice EDH', 300),
        card('Sol Ring', 3, 10, '202', 'Bob EDH', 100),
      ],
    },
    {
      seller: 'ShopB', location: 'Germany', itemsCents: 500, shippingCents: 125,
      items: [
        card('Lightning Bolt', 4, 12, '101', 'Alice EDH', 400, { foil: true }),
        { ...card('Ash Blossom', 5, 99, '303', 'YGO', 100), game: 'YuGiOh' },
      ],
    },
  ];
  return {
    parcels,
    totalCents: 1350,
    shippingCents: 250,
    curve: [{ sellers: 1, cards: 3, totalCents: 725 }, { sellers: 2, cards: 5, totalCents: 1350 }],
    missing: [],
  };
}

const removal = (id, seller, item) => ({ id, batchId: id, seller, sig: basketItemSignature(seller, item), item: { ...item } });

test('snapshot round-trips through JSON and rebuilds the exact basket after removals', () => {
  const basket = sampleBasket();
  const removedItems = [removal(1, 'ShopA', basket.parcels[0].items[1])];
  const finalBasket = applyBasketRemovals(basket, removedItems, { tables: TABLES });

  const snapshot = createBasketSnapshot({
    basket, finalBasket, removedItems, tables: TABLES, buySellers: 2,
    printings: { 10: { name: 'Sol Ring', set: 'cmm', number: '410' }, 77: { name: 'Unrelated', set: 'x', number: '1' } },
    orderedAt: 123,
  });
  const restored = readBasketSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.ok(restored);
  assert.equal(restored.orderedAt, 123);
  assert.equal(restored.buySellers, 2);
  // Only printings for Magic cards in the final basket are kept.
  assert.deepEqual(Object.keys(restored.printings), ['10']);

  const rebuilt = applyBasketRemovals(restored.basket, restored.removedItems, { tables: restored.tables });
  assert.equal(basketFingerprint(rebuilt), basketFingerprint(finalBasket));
  assert.equal(basketFingerprint(restored.finalBasket), basketFingerprint(finalBasket));
  assert.ok(!rebuilt.parcels[0].items.some(i => i.name === 'Arcane Signet'));
});

test('basketFingerprint detects a different basket', () => {
  const basket = sampleBasket();
  const other = sampleBasket();
  other.parcels[0].items[0] = { ...other.parcels[0].items[0], idArticle: 999 };
  assert.notEqual(basketFingerprint(basket), basketFingerprint(other));
});

test('readBasketSnapshot rejects malformed or future snapshots and clamps buySellers', () => {
  assert.equal(readBasketSnapshot(null), null);
  assert.equal(readBasketSnapshot({ version: 99, finalBasket: sampleBasket() }), null);
  assert.equal(readBasketSnapshot({ version: 1, finalBasket: { parcels: [{ seller: 'X' }] } }), null);
  const snap = readBasketSnapshot({ version: 1, finalBasket: sampleBasket(), buySellers: 50 });
  assert.equal(snap.buySellers, 2);
  // Missing raw basket falls back to the final one; missing removals become [].
  assert.equal(snap.basket, snap.finalBasket);
  assert.deepEqual(snap.removedItems, []);
});

test('Archidekt per-list export from a restored snapshot excludes removed cards and tags sellers with set codes', () => {
  const basket = sampleBasket();
  const removedItems = [removal(1, 'ShopA', basket.parcels[0].items[1])];
  const finalBasket = applyBasketRemovals(basket, removedItems, { tables: TABLES });
  const printings = {
    10: { name: 'Sol Ring', set: 'cmm', number: '410' },
    12: { name: 'Lightning Bolt', set: '2xm', number: '141' },
  };
  const snap = readBasketSnapshot(JSON.parse(JSON.stringify(createBasketSnapshot({
    basket, finalBasket, removedItems, tables: TABLES, printings,
  }))));

  const entries = collectBasketEntries(snap.finalBasket.parcels.slice(0, snap.buySellers));
  const groups = groupExportEntries(entries, 'archidekt');
  assert.deepEqual(groups.map(g => g.label), ['Alice EDH', 'Bob EDH']);

  const alice = formatArchidektExport(groups[0].entries, snap.printings, { categoryBy: 'seller' });
  assert.equal(alice.text, '1x Sol Ring (cmm) 410 [ShopA]\n1x Lightning Bolt (2xm) 141 *F* [ShopB]');
  assert.ok(!alice.text.includes('Arcane Signet'));

  const plain = formatPlainExport(groups[1].entries, { groupBy: 'none' });
  assert.equal(plain.text, '1 Sol Ring');
});

test('buySellers limits which parcels a snapshot exports', () => {
  const basket = sampleBasket();
  const snap = readBasketSnapshot(createBasketSnapshot({ basket, finalBasket: basket, buySellers: 1 }));
  const entries = collectBasketEntries(snap.finalBasket.parcels.slice(0, snap.buySellers));
  assert.ok(entries.every(e => e.seller === 'ShopA'));
});

test('token picks (Map bySeller) survive JSON so a token basket restores exactly', () => {
  require('../tokens.js');
  const { mergeTokensIntoBasket } = globalThis.CardmarketTokens;
  const { parcelShipping } = globalThis.CardmarketWizard;
  const basket = sampleBasket();
  const token = { deckName: 'Alice EDH', idProduct: 500, idArticle: 50, name: 'Treasure', foil: false, priceCents: 10, coveredLabels: ['Treasure'], isCombo: false };
  const tokenResult = {
    assignments: [{ ...token }],
    bySeller: new Map([['ShopA', {
      seller: 'ShopA', addedTokens: [token], tokensCents: 10, baseShippingCents: 125, newShippingCents: 125, shippingDeltaCents: 0, newMethod: null,
    }]]),
    proxyList: [],
    stats: { totalRequestedFaces: 1, coveredFaces: 1, physicalTokensBought: 1, tokensCents: 10, shippingDeltaCents: 0, totalAddedCents: 10 },
  };
  const opts = { tables: TABLES, trackedOnly: [], parcelShippingFn: parcelShipping };
  const merged = mergeTokensIntoBasket(basket, tokenResult, opts);
  const removedItems = [removal(1, 'ShopB', merged.parcels[1].items[0])];
  const finalBasket = applyBasketRemovals(merged, removedItems, { tables: TABLES });

  const snap = readBasketSnapshot(JSON.parse(JSON.stringify(createBasketSnapshot({
    basket, finalBasket, tokenResult, removedItems, tables: TABLES,
  }))));
  assert.ok(snap.tokenResult.bySeller instanceof Map);
  const rebuilt = applyBasketRemovals(mergeTokensIntoBasket(snap.basket, snap.tokenResult, { ...opts, tables: snap.tables }), snap.removedItems, { tables: snap.tables });
  assert.equal(basketFingerprint(rebuilt), basketFingerprint(finalBasket));
  assert.ok(rebuilt.parcels[0].items.some(i => i.kind === 'token'));
});
