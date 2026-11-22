'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

require('../wizard.js');
const { summarizeBasketBySource } = globalThis.CardmarketWizard;

const TABLE = [
  { name: 'Standard Letter', priceCents: 125, maxWeight: 20, maxValueCents: 2500, tracked: false, isLetter: true },
  { name: 'Compact Letter', priceCents: 225, maxWeight: 50, maxValueCents: 2500, tracked: false, isLetter: true },
  { name: 'Parcel', priceCents: 550, maxWeight: 2000, maxValueCents: 10000, tracked: true, isLetter: false },
];

test('summarizeBasketBySource computes exact per-list, per-product, and per-token totals for dedicated parcels', () => {
  const parcels = [
    {
      seller: 'ShopA',
      location: 'Germany',
      shippingCents: 125,
      items: [
        { key: 'Magic:1:sol', name: 'Sol Ring', kind: 'card', game: 'Magic', listId: '1', listName: 'Edgar EDH', priceCents: 150 },
        { key: 'Magic:1:cmd', name: 'Command Tower', kind: 'card', game: 'Magic', listId: '1', listName: 'Edgar EDH', priceCents: 50 },
      ],
    },
    {
      seller: 'ShopB',
      location: 'Germany',
      shippingCents: 399,
      items: [
        { key: 'product:/en/Magic/Products/Sleeves/Dragon-Shield', name: 'Dragon Shield Matte Black', kind: 'product', game: 'Magic', listId: null, listName: null, priceCents: 999, offerShippingCents: 399 },
        { key: 'product:/en/Magic/Products/Sleeves/Dragon-Shield', name: 'Dragon Shield Matte Black', kind: 'product', game: 'Magic', listId: null, listName: null, priceCents: 999, offerShippingCents: 399 },
      ],
    },
    {
      seller: 'ShopC',
      location: 'Germany',
      shippingCents: 349,
      items: [
        { key: 'product:/en/Magic/Products/Deck-Boxes/Boulder', name: 'Ultimate Guard Boulder 100+', kind: 'product', game: 'Magic', listId: null, listName: null, priceCents: 850, offerShippingCents: 349 },
      ],
    },
  ];

  const { rows, totals } = summarizeBasketBySource(parcels, {
    missing: [{ key: 'Magic:1:miss', name: 'Mana Crypt', kind: 'card', game: 'Magic', listId: '1', listName: 'Edgar EDH' }],
    leftOut: [{ key: 'Magic:1:cut', name: 'Dockside', kind: 'card', game: 'Magic', listId: '1', listName: 'Edgar EDH', amount: 2 }],
  });

  // 1 Wants List + 2 distinct products (each product has its own row!)
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'card');
  assert.equal(rows[0].label, 'Edgar EDH');
  assert.equal(rows[0].itemsCents, 200);
  assert.equal(rows[0].shippingCents, 125);
  assert.equal(rows[0].totalCents, 325);
  assert.equal(rows[0].missingCount, 1);
  assert.equal(rows[0].leftOutCount, 2);
  assert.equal(rows[0].sharedSellerCount, 0);

  const sleeves = rows.find(r => r.label === 'Dragon Shield Matte Black');
  const boulder = rows.find(r => r.label === 'Ultimate Guard Boulder 100+');
  assert.equal(sleeves.itemCount, 2);
  assert.equal(sleeves.itemsCents, 1998);
  assert.equal(sleeves.shippingCents, 399);
  assert.equal(sleeves.totalCents, 2397);

  assert.equal(boulder.itemCount, 1);
  assert.equal(boulder.itemsCents, 850);
  assert.equal(boulder.shippingCents, 349);
  assert.equal(boulder.totalCents, 1199);

  assert.equal(totals.hasSharedParcels, false);
  assert.equal(totals.itemsCents, 3048);
  assert.equal(totals.shippingCents, 873);
  assert.equal(totals.totalCents, 3921);
});

test('summarizeBasketBySource splits shared card-only parcel shipping by item count with exact-cent rounding', () => {
  const parcels = [
    {
      seller: 'ComboShop',
      location: 'Germany',
      shippingCents: 225,
      items: [
        { key: 'Magic:10:a', name: 'Card A', kind: 'card', game: 'Magic', listId: '10', listName: 'Deck A', priceCents: 100 },
        { key: 'Magic:10:b', name: 'Card B', kind: 'card', game: 'Magic', listId: '10', listName: 'Deck A', priceCents: 100 },
        { key: 'Magic:10:c', name: 'Card C', kind: 'card', game: 'Magic', listId: '10', listName: 'Deck A', priceCents: 100 },
        { key: 'YuGiOh:20:x', name: 'Ash Blossom', kind: 'card', game: 'YuGiOh', listId: '20', listName: 'YGO Main', priceCents: 500 },
        { key: 'token:Deck A:1', name: 'Treasure Token', kind: 'token', game: 'Magic', listId: 'token:Deck A', listName: 'Deck A', priceCents: 5 },
      ],
    },
  ];

  const { rows, totals } = summarizeBasketBySource(parcels);
  assert.equal(rows.length, 3);
  assert.equal(totals.hasSharedParcels, true);

  // 3/5 of 225 = 135c, 1/5 = 45c, 1/5 = 45c -> exact 225c
  const deckA = rows.find(r => r.label === 'Deck A');
  const ygo = rows.find(r => r.label === 'YGO Main');
  const tokens = rows.find(r => r.label === 'Tokens: Deck A');

  assert.equal(deckA.shippingCents, 135);
  assert.equal(ygo.shippingCents, 45);
  assert.equal(tokens.shippingCents, 45);
  assert.equal(deckA.sharedSellerCount, 1);

  assert.equal(rows.reduce((s, r) => s + r.shippingCents, 0), totals.shippingCents);
  assert.equal(rows.reduce((s, r) => s + r.totalCents, 0), totals.totalCents);
});

test('summarizeBasketBySource weights mixed product + card parcels by standalone shipping and preserves exact totals', () => {
  const parcels = [
    {
      seller: 'MegaStore',
      location: 'Germany',
      shippingCents: 399,
      items: [
        { key: 'product:sleeves', name: 'Dragon Shield Matte', kind: 'product', game: 'Magic', priceCents: 1000, offerShippingCents: 399 },
        { key: 'Magic:1:a', name: 'Opt', kind: 'card', game: 'Magic', listId: '1', listName: 'Blue Deck', priceCents: 10 },
        { key: 'Magic:1:b', name: 'Consider', kind: 'card', game: 'Magic', listId: '1', listName: 'Blue Deck', priceCents: 15 },
      ],
    },
  ];

  const { rows, totals } = summarizeBasketBySource(parcels, { tables: { Germany: TABLE } });
  const sleeves = rows.find(r => r.kind === 'product');
  const deck = rows.find(r => r.kind === 'card');

  // Sleeves standalone shipping = 399, 2 cards standalone = 125 -> sleeves takes ~76% (~304c), deck takes ~24% (~95c)
  assert.ok(sleeves.shippingCents > deck.shippingCents * 2);
  assert.equal(sleeves.shippingCents + deck.shippingCents, 399);
  assert.equal(sleeves.totalCents + deck.totalCents, totals.totalCents);
});

test('summarizeBasketBySource disambiguates duplicate Wants List names with different listIds', () => {
  const parcels = [
    {
      seller: 'ShopA',
      shippingCents: 125,
      items: [
        { key: 'Magic:101:a', name: 'Sol Ring', kind: 'card', game: 'Magic', listId: '101', listName: 'Commander', priceCents: 100 },
        { key: 'Magic:202:b', name: 'Arcane Signet', kind: 'card', game: 'Magic', listId: '202', listName: 'Commander', priceCents: 80 },
      ],
    },
  ];

  const { rows } = summarizeBasketBySource(parcels);
  assert.deepEqual(rows.map(r => r.label).sort(), ['Commander (#101)', 'Commander (#202)']);
  assert.equal(rows.reduce((s, r) => s + r.shippingCents, 0), 125);
});
