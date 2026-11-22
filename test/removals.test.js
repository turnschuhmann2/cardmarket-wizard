const test = require('node:test');
const assert = require('node:assert/strict');

require('../wizard.js');
require('../exports.js');

const {
  basketItemSignature,
  applyBasketRemovals,
  summarizeBasketBySource,
} = globalThis.CardmarketWizard;

const {
  formatPlainExport,
  formatArchidektExport,
  groupExportEntries,
} = globalThis.CardmarketExport;

const DE_TABLE = [
  { name: 'Standard Letter', maxWeight: 20, maxValueCents: 2500, priceCents: 125, tracked: false },
  { name: 'Compact Letter', maxWeight: 50, maxValueCents: 2500, priceCents: 225, tracked: false },
  { name: 'Tracked Letter', maxWeight: 50, maxValueCents: 50000, priceCents: 450, tracked: true },
  { name: 'Parcel', maxWeight: 2000, maxValueCents: 500000, priceCents: 699, tracked: true },
];

function makeCard(overrides = {}) {
  return {
    key: 'Magic:1:card',
    name: 'Lightning Bolt',
    kind: 'card',
    game: 'Magic',
    listId: '1',
    listName: 'Red Deck',
    idArticle: 1001,
    idProduct: 2001,
    foil: false,
    priceCents: 100,
    targetCents: 100,
    aboveMarket: false,
    offerShippingCents: null,
    ...overrides,
  };
}

function makeBasket(parcels, extra = {}) {
  let cards = 0;
  let running = 0;
  let shippingCents = 0;
  const curve = parcels.map((p, idx) => {
    cards += p.items.length;
    running += p.itemsCents + p.shippingCents;
    shippingCents += p.shippingCents;
    return { sellers: idx + 1, cards, totalCents: running };
  });
  return {
    parcels,
    curve,
    totalCents: running,
    shippingCents,
    missing: [],
    ...extra,
  };
}

test('removing one card recalculates only that seller shipping tier without touching other sellers', () => {
  const fiveCards = [1, 2, 3, 4, 5].map(i => makeCard({
    key: `Magic:1:c${i}`,
    name: `Card ${i}`,
    idArticle: 100 + i,
    idProduct: 200 + i,
    priceCents: 50,
  }));
  const otherCard = makeCard({
    key: 'Magic:1:other',
    name: 'Sol Ring',
    idArticle: 901,
    idProduct: 902,
    priceCents: 120,
  });

  const basket = makeBasket([
    {
      seller: 'ShopA',
      location: 'Germany',
      games: ['Magic'],
      hasProducts: false,
      hasTokens: false,
      tokenCount: 0,
      itemsCents: 250,
      shippingCents: 225, // 5 cards -> Compact Letter
      method: 'Compact Letter',
      items: fiveCards,
    },
    {
      seller: 'ShopB',
      location: 'Germany',
      games: ['Magic'],
      hasProducts: false,
      hasTokens: false,
      tokenCount: 0,
      itemsCents: 120,
      shippingCents: 125,
      method: 'Standard Letter',
      items: [otherCard],
    },
  ]);

  const removed = [{ seller: 'ShopA', sig: basketItemSignature('ShopA', fiveCards[4]), item: fiveCards[4] }];
  const next = applyBasketRemovals(basket, removed, { tables: { default: DE_TABLE, byLocation: { Germany: DE_TABLE } } });

  // Original basket is untouched (non-destructive).
  assert.equal(basket.parcels[0].items.length, 5);
  assert.equal(basket.totalCents, 720);

  // Seller order and ShopB are strictly preserved (no recompute).
  assert.deepEqual(next.parcels.map(p => p.seller), ['ShopA', 'ShopB']);
  assert.strictEqual(next.parcels[1], basket.parcels[1]);

  // ShopA dropped from 5 cards -> 4 cards, dropping shipping from 225c to 125c.
  assert.equal(next.parcels[0].items.length, 4);
  assert.equal(next.parcels[0].itemsCents, 200);
  assert.equal(next.parcels[0].shippingCents, 125);
  assert.equal(next.parcels[0].method, 'Standard Letter');

  // Basket totals & savings include both card price (50c) and shipping tier drop (100c).
  assert.equal(next.totalCents, 570);
  assert.equal(next.shippingCents, 250);
  assert.equal(next.removedCount, 1);
  assert.equal(next.removedNonTokenCount, 1);
  assert.equal(next.savedByRemovalsCents, 150);
  assert.deepEqual(next.curve, [
    { sellers: 1, cards: 4, totalCents: 325 },
    { sellers: 2, cards: 5, totalCents: 570 },
  ]);
});

test('removing one copy of a duplicate article only removes a single copy', () => {
  const dup = makeCard({ name: 'Swamp', idArticle: 555, idProduct: 666, priceCents: 20 });
  const basket = makeBasket([
    {
      seller: 'ShopA',
      location: 'Germany',
      games: ['Magic'],
      hasProducts: false,
      itemsCents: 60,
      shippingCents: 125,
      method: 'Standard Letter',
      items: [dup, { ...dup }, { ...dup }],
    },
  ]);

  const removed = [{ seller: 'ShopA', sig: basketItemSignature('ShopA', dup), item: dup }];
  const next = applyBasketRemovals(basket, removed, { tables: DE_TABLE });

  assert.equal(next.parcels[0].items.length, 2);
  assert.equal(next.parcels[0].itemsCents, 40);
  assert.equal(next.removedCount, 1);
  assert.equal(next.savedByRemovalsCents, 20);
});

test('removing all items from a seller drops the seller parcel without reassigning its cards', () => {
  const c1 = makeCard({ key: 'k1', name: 'Card 1', idArticle: 1, priceCents: 100 });
  const c2 = makeCard({ key: 'k2', name: 'Card 2', idArticle: 2, priceCents: 200 });
  const c3 = makeCard({ key: 'k3', name: 'Card 3', idArticle: 3, priceCents: 150 });

  const basket = makeBasket([
    {
      seller: 'ShopA',
      location: 'Germany',
      games: ['Magic'],
      itemsCents: 300,
      shippingCents: 125,
      method: 'Standard Letter',
      items: [c1, c2],
    },
    {
      seller: 'ShopB',
      location: 'Germany',
      games: ['Magic'],
      itemsCents: 150,
      shippingCents: 125,
      method: 'Standard Letter',
      items: [c3],
    },
  ]);

  const removed = [c1, c2].map(item => ({ seller: 'ShopA', sig: basketItemSignature('ShopA', item), item }));
  const next = applyBasketRemovals(basket, removed, { tables: DE_TABLE });

  assert.equal(next.parcels.length, 1);
  assert.equal(next.parcels[0].seller, 'ShopB');
  assert.equal(next.parcels[0].items.length, 1);
  assert.equal(next.totalCents, 275);
  assert.equal(next.shippingCents, 125);
  assert.equal(next.removedCount, 2);
  assert.equal(next.savedByRemovalsCents, 425);
  assert.deepEqual(next.curve, [{ sellers: 1, cards: 1, totalCents: 275 }]);

  // Breakdown also reflects only the remaining seller.
  const breakdown = summarizeBasketBySource(next.parcels, { tables: DE_TABLE });
  assert.equal(breakdown.totals.totalCents, 275);
  assert.equal(breakdown.totals.itemCount, 1);
});

test('removing every seller yields an empty basket with full savings', () => {
  const c1 = makeCard({ key: 'k1', name: 'Sol Ring', idArticle: 1, priceCents: 150 });
  const basket = makeBasket([
    {
      seller: 'ShopA',
      location: 'Germany',
      games: ['Magic'],
      itemsCents: 150,
      shippingCents: 125,
      method: 'Standard Letter',
      items: [c1],
    },
  ]);

  const removed = [{ seller: 'ShopA', sig: basketItemSignature('ShopA', c1), item: c1 }];
  const next = applyBasketRemovals(basket, removed, { tables: DE_TABLE });

  assert.deepEqual(next.parcels, []);
  assert.deepEqual(next.curve, []);
  assert.equal(next.totalCents, 0);
  assert.equal(next.shippingCents, 0);
  assert.equal(next.savedByRemovalsCents, 275);
});

test('tracked-only seller stays on tracked shipping after partial removal', () => {
  const items = [1, 2].map(i => makeCard({ key: `k${i}`, name: `Card ${i}`, idArticle: i, priceCents: 100 }));
  const basket = makeBasket([
    {
      seller: 'TrackedShop',
      location: 'Germany',
      games: ['Magic'],
      itemsCents: 200,
      shippingCents: 450,
      method: 'Tracked Letter',
      items,
    },
  ]);

  const removed = [{ seller: 'TrackedShop', sig: basketItemSignature('TrackedShop', items[0]), item: items[0] }];
  const next = applyBasketRemovals(basket, removed, {
    tables: DE_TABLE,
    trackedOnly: ['TrackedShop'],
  });

  assert.equal(next.parcels[0].shippingCents, 450);
  assert.equal(next.parcels[0].method, 'Tracked Letter');
  assert.equal(next.totalCents, 550);
});

test('removing tokens updates tokenCount, hasTokens, tokenStats, and keeps removedNonTokenCount separate', () => {
  const card = makeCard({ key: 'k1', name: 'Arcane Signet', idArticle: 10, priceCents: 100 });
  const tok1 = makeCard({
    key: 'token:Edgar:1:901',
    name: 'Vampire Token',
    kind: 'token',
    listId: 'token:Edgar',
    listName: 'Edgar',
    idArticle: 901,
    idProduct: 8001,
    priceCents: 10,
  });
  const tok2 = makeCard({
    key: 'token:Edgar:2:902',
    name: 'Treasure Token',
    kind: 'token',
    listId: 'token:Edgar',
    listName: 'Edgar',
    idArticle: 902,
    idProduct: 8002,
    priceCents: 15,
  });

  const basket = makeBasket(
    [
      {
        seller: 'ShopA',
        location: 'Germany',
        games: ['Magic'],
        hasProducts: false,
        hasTokens: true,
        tokenCount: 2,
        itemsCents: 125,
        shippingCents: 125,
        method: 'Standard Letter',
        items: [card, tok1, tok2],
      },
    ],
    {
      tokenStats: {
        physicalTokensBought: 2,
        tokensCents: 25,
        shippingDeltaCents: 0,
        totalAddedCents: 25,
      },
    },
  );

  // Remove 1 token
  const afterOne = applyBasketRemovals(
    basket,
    [{ seller: 'ShopA', sig: basketItemSignature('ShopA', tok1), item: tok1 }],
    { tables: DE_TABLE },
  );
  assert.equal(afterOne.parcels[0].hasTokens, true);
  assert.equal(afterOne.parcels[0].tokenCount, 1);
  assert.equal(afterOne.removedCount, 1);
  assert.equal(afterOne.removedNonTokenCount, 0);
  assert.equal(afterOne.tokenStats.physicalTokensBought, 1);
  assert.equal(afterOne.tokenStats.tokensCents, 15);

  // Remove both tokens
  const afterBoth = applyBasketRemovals(
    basket,
    [tok1, tok2].map(t => ({ seller: 'ShopA', sig: basketItemSignature('ShopA', t), item: t })),
    { tables: DE_TABLE },
  );
  assert.equal(afterBoth.parcels[0].hasTokens, false);
  assert.equal(afterBoth.parcels[0].tokenCount, 0);
  assert.equal(afterBoth.tokenStats, null);
  assert.equal(afterBoth.removedCount, 2);
  assert.equal(afterBoth.removedNonTokenCount, 0);
});

test('removed records format cleanly for plain and Archidekt clipboard export', () => {
  const entries = [
    { name: 'Sol Ring', game: 'Magic', kind: 'card', listId: '1', listName: 'Commander', idProduct: 10, foil: false, seller: 'ShopA', order: 0, quantity: 1 },
    { name: 'Sol Ring', game: 'Magic', kind: 'card', listId: '1', listName: 'Commander', idProduct: 10, foil: false, seller: 'ShopA', order: 1, quantity: 1 },
    { name: 'Dragon Shield Sleeves', game: 'Magic', kind: 'product', listId: null, listName: null, idProduct: 20, foil: false, seller: 'ShopA', order: 2, quantity: 1 },
  ];

  const plain = formatPlainExport(entries, { groupBy: 'auto' });
  assert.equal(plain.count, 3);
  assert.match(plain.text, /# Commander \(Magic\)\n2 Sol Ring/);
  assert.match(plain.text, /# Extra Products\n1 Dragon Shield Sleeves/);

  const archGroups = groupExportEntries(entries, 'archidekt');
  assert.equal(archGroups.length, 1);
  const arch = formatArchidektExport(entries, { 10: { name: 'Sol Ring', set: 'CMM', number: '410' } }, { categoryBy: 'none' });
  assert.equal(arch.count, 2);
  assert.equal(arch.text, '2x Sol Ring (CMM) 410');
});
