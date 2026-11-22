'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../exports.js');
const {
  collectBasketEntries,
  collectLeftOutEntries,
  groupExportEntries,
  formatArchidektExport,
  formatPlainExport,
  safeExportFilename,
} = globalThis.CardmarketExport;

test('collectBasketEntries preserves separate Wants Lists for identical cards from the same seller', () => {
  const parcels = [
    {
      seller: 'ShopA',
      items: [
        { name: 'Sol Ring', game: 'Magic', kind: 'card', listId: '101', listName: 'Alice EDH', idProduct: 10, foil: false },
        { name: 'Sol Ring', game: 'Magic', kind: 'card', listId: '101', listName: 'Alice EDH', idProduct: 10, foil: false },
        { name: 'Sol Ring', game: 'Magic', kind: 'card', listId: '202', listName: 'Bob EDH', idProduct: 10, foil: false },
        { name: 'Ash Blossom', game: 'YuGiOh', kind: 'card', listId: '303', listName: 'YGO Staples', idProduct: 99, foil: false },
        { name: 'Dragon Shield Matte', game: 'Magic', kind: 'product', listId: null, listName: null, idProduct: 500, foil: false },
      ],
    },
  ];

  const entries = collectBasketEntries(parcels);
  assert.equal(entries.length, 4);

  const alice = entries.find(e => e.listId === '101');
  const bob = entries.find(e => e.listId === '202');
  assert.equal(alice.quantity, 2);
  assert.equal(bob.quantity, 1);

  const archGroups = groupExportEntries(entries, 'archidekt');
  assert.deepEqual(
    archGroups.map(g => ({ label: g.label, quantity: g.quantity, sellerCount: g.sellerCount })),
    [
      { label: 'Alice EDH', quantity: 2, sellerCount: 1 },
      { label: 'Bob EDH', quantity: 1, sellerCount: 1 },
    ]
  );

  const plainGroups = groupExportEntries(entries, 'plain');
  assert.deepEqual(
    plainGroups.map(g => ({ label: g.label, game: g.game, kind: g.kind, quantity: g.quantity })),
    [
      { label: 'Alice EDH', game: 'Magic', kind: 'card', quantity: 2 },
      { label: 'Bob EDH', game: 'Magic', kind: 'card', quantity: 1 },
      { label: 'YGO Staples', game: 'YuGiOh', kind: 'card', quantity: 1 },
      { label: 'Extra Products', game: null, kind: 'product', quantity: 1 },
    ]
  );
});

test('groupExportEntries disambiguates two different Wants Lists with the same name', () => {
  const entries = collectBasketEntries([
    {
      seller: 'ShopA',
      items: [
        { name: 'Sol Ring', game: 'Magic', kind: 'card', listId: '101', listName: 'Commander', idProduct: 10, foil: false },
        { name: 'Arcane Signet', game: 'Magic', kind: 'card', listId: '202', listName: 'Commander', idProduct: 20, foil: false },
      ],
    },
  ]);

  const groups = groupExportEntries(entries, 'archidekt');
  assert.deepEqual(groups.map(g => g.label), ['Commander (#101)', 'Commander (#202)']);

  const combinedByList = formatArchidektExport(entries, {}, { categoryBy: 'list' });
  assert.equal(
    combinedByList.text,
    '1x Sol Ring [Commander (#101)]\n1x Arcane Signet [Commander (#202)]'
  );
});

test('formatArchidektExport exports per Wants List cleanly and merges combined copies by category', () => {
  const parcels = [
    {
      seller: 'Seller [One]',
      items: [
        { name: 'Sol Ring', game: 'Magic', kind: 'card', listId: '1', listName: 'Alice', idProduct: 10, foil: false },
        { name: 'Sol Ring', game: 'Magic', kind: 'card', listId: '2', listName: 'Bob', idProduct: 10, foil: false },
        { name: 'Swords to Plowshares', game: 'Magic', kind: 'card', listId: '2', listName: 'Bob', idProduct: 20, foil: true },
        { name: 'Blue-Eyes White Dragon', game: 'YuGiOh', kind: 'card', listId: '9', listName: 'YGO', idProduct: 99, foil: false },
      ],
    },
    {
      seller: 'SellerTwo',
      items: [
        { name: 'Command Tower', game: 'Magic', kind: 'card', listId: '1', listName: 'Alice', idProduct: 30, foil: false },
      ],
    },
  ];
  const printings = {
    10: { name: 'Sol Ring', set: 'CMM', number: '410' },
    20: { name: 'Swords to Plowshares', set: 'STA', number: '10' },
  };
  const entries = collectBasketEntries(parcels);
  const [aliceGroup, bobGroup] = groupExportEntries(entries, 'archidekt');

  const aliceOut = formatArchidektExport(aliceGroup.entries, printings, { categoryBy: 'seller' });
  assert.equal(aliceOut.count, 2);
  assert.equal(
    aliceOut.text,
    '1x Sol Ring (CMM) 410 [Seller One]\n1x Command Tower [SellerTwo]'
  );

  const bobOut = formatArchidektExport(bobGroup.entries, printings, { categoryBy: 'none' });
  assert.equal(bobOut.count, 2);
  assert.equal(
    bobOut.text,
    '1x Sol Ring (CMM) 410\n1x Swords to Plowshares (STA) 10 *F*'
  );

  // Combined by seller merges Alice + Bob's identical Sol Ring from Seller [One] and ignores YGO in count.
  const combinedSeller = formatArchidektExport(entries, printings, { categoryBy: 'seller' });
  assert.equal(combinedSeller.count, 4);
  assert.equal(
    combinedSeller.text,
    '2x Sol Ring (CMM) 410 [Seller One]\n1x Swords to Plowshares (STA) 10 *F* [Seller One]\n1x Command Tower [SellerTwo]'
  );

  // Combined by list keeps Alice and Bob separate with [Alice] / [Bob] categories.
  const combinedList = formatArchidektExport(entries, printings, { categoryBy: 'list' });
  assert.equal(combinedList.count, 4);
  assert.equal(
    combinedList.text,
    '1x Sol Ring (CMM) 410 [Alice]\n1x Sol Ring (CMM) 410 [Bob]\n1x Swords to Plowshares (STA) 10 *F* [Bob]\n1x Command Tower [Alice]'
  );
});

test('collectLeftOutEntries and formatPlainExport support per-list and combined left-out exports', () => {
  const leftOut = [
    { name: 'Mana Crypt', game: 'Magic', kind: 'card', listId: '1', listName: 'Alice', idProduct: 55, amount: 1 },
    { name: 'Jeweled Lotus', game: 'Magic', kind: 'card', listId: '2', listName: 'Bob', idProduct: 56, amount: 2 },
    { name: 'Maxx "C"', game: 'YuGiOh', kind: 'card', listId: '3', listName: 'YGO', idProduct: 77, amount: 3 },
  ];
  const entries = collectLeftOutEntries(leftOut);
  const archGroups = groupExportEntries(entries, 'archidekt');
  assert.equal(archGroups.length, 2);
  assert.equal(archGroups[0].sellerCount, 0);

  const combinedArch = formatArchidektExport(entries, {}, { categoryBy: 'list' });
  assert.equal(combinedArch.count, 3);
  assert.equal(combinedArch.text, '1x Mana Crypt [Alice]\n2x Jeweled Lotus [Bob]');

  const combinedPlain = formatPlainExport(entries, { groupBy: 'auto' });
  assert.equal(combinedPlain.count, 6);
  assert.equal(
    combinedPlain.text,
    '# Alice (Magic)\n1 Mana Crypt\n\n# Bob (Magic)\n2 Jeweled Lotus\n\n# YGO (Yu-Gi-Oh!)\n3 Maxx "C"'
  );

  const singlePlain = formatPlainExport(archGroups[1].entries, { groupBy: 'none' });
  assert.equal(singlePlain.count, 2);
  assert.equal(singlePlain.text, '2 Jeweled Lotus');
});

test('safeExportFilename produces clean ASCII filenames', () => {
  assert.equal(safeExportFilename("Alice's EDH / Deck #1!", 'archidekt'), 'alices-edh-deck-1-archidekt.txt');
  assert.equal(safeExportFilename('   ', 'list'), 'cardmarket-list-list.txt');
});
