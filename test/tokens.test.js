'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Load pure modules in Node
require('../catalog.js');
require('../wizard.js');
require('../collector.js');
require('../exports.js');
require('../tokens.js');

const { isTokenProductName, indexCatalogue } = globalThis.CardmarketCatalog;
const { parcelShipping } = globalThis.CardmarketWizard;
const { collectSellerTokens } = globalThis.CardmarketCollector;
const { collectBasketEntries, groupExportEntries, formatArchidektExport, formatPlainExport } = globalThis.CardmarketExport;
const {
  buildTokenCatalog,
  parseTokenListText,
  matchTokenDecks,
  optimizeTokens,
  mergeTokensIntoBasket,
  formatProxyListText,
} = globalThis.CardmarketTokens;

const STANDARD_TABLE = [
  { name: 'Standard Letter', priceCents: 125, maxWeight: 20, maxValueCents: 2500, tracked: false, isLetter: true },
  { name: 'Compact Letter', priceCents: 225, maxWeight: 50, maxValueCents: 2500, tracked: false, isLetter: true },
  { name: 'Registered Letter', priceCents: 450, maxWeight: 100, maxValueCents: 10000, tracked: true, isLetter: true },
];

const SAMPLE_TOKEN_TUPLES = [
  // [idProduct, name, lowCents, lowFoilCents, idExpansion, idMetacard]
  [1001, 'Vampire Token (Black 1/1)', 2, 10, 100, 1],
  [1002, 'Treasure Token', 3, 15, 100, 2],
  [1003, 'Vampire Token (Black 1/1) // Treasure Token', 5, 25, 101, 3],
  [1004, 'Squirrel Token (Green 1/1)', 4, 20, 102, 4],
  [1005, 'Food Token', 2, 12, 102, 5],
  [1006, 'Squirrel Token (Green 1/1) / Food Token (V.1)', 6, 30, 102, 6],
  [1007, 'Spirit Token (White 1/1)', 3, 10, 103, 7],
  [1008, 'Construct Token (Colorless */*)', 95, 250, 104, 8],
  [1009, 'Emblem Elspeth, Knight-Errant', 18, null, 105, 9],
  [1010, 'The Monarch', 12, null, 106, 10],
];

test('catalog.isTokenProductName identifies tokens/emblems/helpers without regular-card false positives', () => {
  assert.equal(isTokenProductName('Treasure Token'), true);
  assert.equal(isTokenProductName('Vampire Token (Black 1/1) // Zombie Token (Black 2/2)'), true);
  assert.equal(isTokenProductName('Emblem Elspeth, Knight-Errant'), true);
  assert.equal(isTokenProductName('The Monarch'), true);
  assert.equal(isTokenProductName('The Initiative'), true);
  assert.equal(isTokenProductName("City's Blessing"), true);
  assert.equal(isTokenProductName('Day // Night'), true);

  assert.equal(isTokenProductName('Sol Ring'), false);
  assert.equal(isTokenProductName('Dungeon Geists'), false);
  assert.equal(isTokenProductName('Undercity Shade'), false);
  assert.equal(isTokenProductName('Day of Judgment'), false);
  assert.equal(isTokenProductName("Night's Whisper"), false);

  const indexed = indexCatalogue(
    {
      createdAt: '2026-11-22T00:00:00Z',
      products: [
        { idProduct: 1, name: 'Sol Ring', idExpansion: 10, idMetacard: 1 },
        { idProduct: 2, name: 'Treasure Token', idExpansion: 10, idMetacard: 2 },
        { idProduct: 3, name: 'Dungeon Geists', idExpansion: 10, idMetacard: 3 },
      ],
    },
    {
      createdAt: '2026-11-22T00:00:00Z',
      priceGuides: [
        { idProduct: 1, low: 0.99 },
        { idProduct: 2, low: 0.03, 'low-foil': 0.15 },
        { idProduct: 3, low: 0.25 },
      ],
    }
  );
  assert.equal(indexed.tokens.length, 1);
  assert.deepEqual(indexed.tokens[0], [2, 'Treasure Token', 3, 15, 10, 2]);
});

test('parseTokenListText handles multi-deck headers, (no combos), quantities, and deduplication', () => {
  const text = `
    # Edgar Markov
    4x 1/1 Black Vampire
    2 Vampire (B 1/1)
    2x Treasure (TCMM) 15 [Tokens]

    [Chatterfang] (no combos)
    3 1/1 Green Squirrel
    x2 Food
  `;
  const decks = parseTokenListText(text);
  assert.equal(decks.length, 2);

  assert.equal(decks[0].deckName, 'Edgar Markov');
  assert.equal(decks[0].allowCombos, true);
  assert.equal(decks[0].requests.length, 2);
  assert.equal(decks[0].requests[0].qty, 6); // 4 + 2 merged within deck
  assert.equal(decks[0].requests[1].qty, 2);

  assert.equal(decks[1].deckName, 'Chatterfang');
  assert.equal(decks[1].allowCombos, false);
  assert.equal(decks[1].requests.length, 2);
  assert.equal(decks[1].requests[0].qty, 3);
  assert.equal(decks[1].requests[1].qty, 2);

  // Explicit override takes precedence over header
  const overridden = parseTokenListText(text, { Chatterfang: { allowCombos: true } });
  assert.equal(overridden[1].allowCombos, true);
});

test('matchTokenDecks matches single/DFC/slash printings, relaxes flying trait, and scopes DFC combos per deck', () => {
  const catalog = buildTokenCatalog(SAMPLE_TOKEN_TUPLES);
  const decks = parseTokenListText(`
    # Deck A
    2x 1/1 Black Vampire
    1x Treasure
    1x 1/1 White Spirit flying
    1x */* Colorless Construct

    # Deck B
    2x 1/1 Green Squirrel
    2x Food
  `);

  const plan = matchTokenDecks(decks, catalog, { maxPriceCents: 20, foil: 'N' });
  const deckA = plan.decks[0];
  const deckB = plan.decks[1];

  // Deck A Vampire matches single (1001) + DFC (1003)
  assert.ok(deckA.requests[0].productIds.has(1001));
  assert.ok(deckA.requests[0].productIds.has(1003));
  // Deck A Spirit flying relaxes trait to match Cardmarket's "Spirit Token (White 1/1)"
  assert.ok(deckA.requests[2].productIds.has(1007));
  assert.equal(deckA.requests[2].relaxedTraits, true);
  // Construct guide low is 95c > 20c -> likelyProxy
  assert.equal(deckA.requests[3].likelyProxy, true);
  // Deck A detects Vampire // Treasure combo
  assert.equal(deckA.combos.length, 1);
  assert.equal(deckA.combos[0].name, 'Vampire Token (Black 1/1) // Treasure Token');

  // Deck B detects single-slash "Squirrel Token (Green 1/1) / Food Token (V.1)" combo
  assert.equal(deckB.combos.length, 1);
  assert.ok(deckB.requests[0].productIds.has(1006));
  assert.ok(deckB.requests[1].productIds.has(1006));
});

test('optimizeTokens enforces hard deck boundary: NEVER combines tokens across different decks on one DFC', () => {
  const catalog = buildTokenCatalog(SAMPLE_TOKEN_TUPLES);
  const decks = parseTokenListText(`
    # Deck A
    1x 1/1 Black Vampire

    # Deck B
    1x Treasure
  `);
  const plan = matchTokenDecks(decks, catalog, { maxPriceCents: 20 });

  const parcels = [
    {
      seller: 'ShopA',
      location: 'Germany',
      items: [{ kind: 'card', priceCents: 100 }],
      itemsCents: 100,
      shippingCents: 125,
      method: 'Standard Letter',
    },
  ];

  // Only 1 copy of the DFC in stock -> MUST cover only 1 deck, leaving the other for proxy!
  const oneCopy = optimizeTokens(
    plan,
    parcels,
    { ShopA: [{ idArticle: 501, idProduct: 1003, priceCents: 5, quantity: 1, condition: 2, language: 1, foil: false }] },
    catalog,
    { tables: { Germany: STANDARD_TABLE }, maxPriceCents: 20, parcelShippingFn: parcelShipping }
  );
  assert.equal(oneCopy.assignments.length, 1);
  assert.equal(oneCopy.assignments[0].isCombo, false);
  assert.equal(oneCopy.assignments[0].coveredLabels.length, 1);
  assert.equal(oneCopy.stats.coveredFaces, 1);
  assert.equal(oneCopy.stats.proxyFaces, 1);

  // With 2 copies of the DFC in stock -> buys 2 separate cards (1 per deck), still zero cross-deck combos!
  const twoCopies = optimizeTokens(
    plan,
    parcels,
    { ShopA: [{ idArticle: 501, idProduct: 1003, priceCents: 5, quantity: 2, condition: 2, language: 1, foil: false }] },
    catalog,
    { tables: { Germany: STANDARD_TABLE }, maxPriceCents: 20, parcelShippingFn: parcelShipping }
  );
  assert.equal(twoCopies.assignments.length, 2);
  assert.ok(twoCopies.assignments.every(a => !a.isCombo));
  assert.deepEqual(new Set(twoCopies.assignments.map(a => a.deckName)), new Set(['Deck A', 'Deck B']));
  assert.equal(twoCopies.stats.tokensCents, 10);
});

test('optimizeTokens uses 2-for-1 DFC within the SAME deck and respects allowCombos: false', () => {
  const catalog = buildTokenCatalog(SAMPLE_TOKEN_TUPLES);
  const parcels = [
    {
      seller: 'ShopA',
      location: 'Germany',
      items: [{ kind: 'card', priceCents: 100 }],
      itemsCents: 100,
      shippingCents: 125,
      method: 'Standard Letter',
    },
  ];
  const offers = {
    ShopA: [
      { idArticle: 601, idProduct: 1001, priceCents: 4, quantity: 2, condition: 2, language: 1, foil: false },
      { idArticle: 602, idProduct: 1002, priceCents: 4, quantity: 2, condition: 2, language: 1, foil: false },
      { idArticle: 603, idProduct: 1003, priceCents: 5, quantity: 1, condition: 2, language: 1, foil: false },
    ],
  };

  // Same deck, combos ON -> prefers 1x 5c DFC (2.5c/face) over 2x 4c singles (8c total)
  const planOn = matchTokenDecks(parseTokenListText('# Deck A\n1x 1/1 Black Vampire\n1x Treasure'), catalog);
  const resOn = optimizeTokens(planOn, parcels, offers, catalog, { tables: { Germany: STANDARD_TABLE }, maxPriceCents: 20, parcelShippingFn: parcelShipping });
  assert.equal(resOn.assignments.length, 1);
  assert.equal(resOn.assignments[0].isCombo, true);
  assert.equal(resOn.assignments[0].idProduct, 1003);
  assert.equal(resOn.stats.tokensCents, 5);
  assert.equal(resOn.stats.comboCardsUsed, 1);

  // Same deck, combos OFF -> buys 2 separate 4c singles (never uses 2-for-1)
  const planOff = matchTokenDecks(parseTokenListText('# Deck A (no combos)\n1x 1/1 Black Vampire\n1x Treasure'), catalog);
  const resOff = optimizeTokens(planOff, parcels, offers, catalog, { tables: { Germany: STANDARD_TABLE }, maxPriceCents: 20, parcelShippingFn: parcelShipping });
  assert.equal(resOff.assignments.length, 2);
  assert.ok(resOff.assignments.every(a => !a.isCombo));
  assert.equal(resOff.stats.tokensCents, 8);
});

test('optimizeTokens never opens new sellers, respects shipping-tier jumps, and amortizes multi-token bundles', () => {
  const catalog = buildTokenCatalog(SAMPLE_TOKEN_TUPLES);

  // Parcel at 4 cards (max for Standard Letter 1.25 EUR; 5th card jumps +1.00 EUR to Compact Letter 2.25 EUR)
  const tightParcel = {
    seller: 'TightShop',
    location: 'Germany',
    items: Array.from({ length: 4 }, () => ({ kind: 'card', priceCents: 50 })),
    itemsCents: 200,
    shippingCents: 125,
    method: 'Standard Letter',
  };

  // 1 token needed -> would trigger +1.00 EUR shipping jump -> rejected & sent to proxy with shipping jump reason!
  // OutsideShop is NOT in parcels -> must be ignored!
  const planOne = matchTokenDecks(parseTokenListText('# Deck\n1x Treasure'), catalog);
  const resOne = optimizeTokens(
    planOne,
    [tightParcel],
    {
      TightShop: [{ idArticle: 701, idProduct: 1002, priceCents: 5, quantity: 10, condition: 2, language: 1, foil: false }],
      OutsideShop: [{ idArticle: 702, idProduct: 1002, priceCents: 2, quantity: 10, condition: 2, language: 1, foil: false }],
    },
    catalog,
    { tables: { Germany: STANDARD_TABLE }, maxPriceCents: 20, parcelShippingFn: parcelShipping }
  );
  assert.equal(resOne.assignments.length, 0);
  assert.equal(resOne.proxyList.length, 1);
  assert.match(resOne.proxyList[0].reason, /1,00 € shipping jump/);

  // 10 tokens needed at TightShop at 4c each -> bundle = 40c + 100c shipping jump = 140c -> 14c/face <= 20c cap!
  const planTen = matchTokenDecks(parseTokenListText('# Deck\n10x Treasure'), catalog);
  const resTen = optimizeTokens(
    planTen,
    [tightParcel],
    {
      TightShop: [{ idArticle: 701, idProduct: 1002, priceCents: 4, quantity: 10, condition: 2, language: 1, foil: false }],
    },
    catalog,
    { tables: { Germany: STANDARD_TABLE }, maxPriceCents: 20, parcelShippingFn: parcelShipping }
  );
  assert.equal(resTen.assignments.length, 10);
  assert.equal(resTen.stats.tokensCents, 40);
  assert.equal(resTen.stats.shippingDeltaCents, 100);
  assert.equal(resTen.stats.avgPerFaceCents, 14);
  assert.equal(resTen.proxyList.length, 0);
});

test('optimizeTokens enforces hard price cap and condition/foil filters with clear proxy reasons', () => {
  const catalog = buildTokenCatalog(SAMPLE_TOKEN_TUPLES);
  const parcels = [
    { seller: 'ShopA', location: 'Germany', items: [{ kind: 'card', priceCents: 100 }], itemsCents: 100, shippingCents: 125, method: 'Standard Letter' },
  ];
  const plan = matchTokenDecks(parseTokenListText('# Deck\n1x Treasure\n1x Food\n1x 1/1 Green Squirrel'), catalog);
  const res = optimizeTokens(
    plan,
    parcels,
    {
      ShopA: [
        { idArticle: 801, idProduct: 1002, priceCents: 35, quantity: 1, condition: 2, language: 1, foil: false }, // > 20c cap
        { idArticle: 802, idProduct: 1005, priceCents: 10, quantity: 1, condition: 2, language: 1, foil: true },  // foil only
        // Squirrel not in stock
      ],
    },
    catalog,
    { tables: { Germany: STANDARD_TABLE }, maxPriceCents: 20, minCondition: 5, foil: 'N', parcelShippingFn: parcelShipping }
  );

  assert.equal(res.assignments.length, 0);
  assert.equal(res.proxyList.length, 3);
  assert.match(res.proxyList[0].reason, /0,35 €/);
  assert.match(res.proxyList[1].reason, /condition\/language\/foil/);
  assert.match(res.proxyList[2].reason, /Not in stock/);
});

test('mergeTokensIntoBasket and CardmarketExport integrate tokens cleanly without polluting Archidekt export', () => {
  const catalog = buildTokenCatalog(SAMPLE_TOKEN_TUPLES);
  const baseBasket = {
    parcels: [
      {
        seller: 'ShopA',
        location: 'Germany',
        games: ['Magic'],
        hasProducts: false,
        itemsCents: 200,
        shippingCents: 125,
        method: 'Standard Letter',
        items: [
          { key: 'Magic:1:sol', name: 'Sol Ring', kind: 'card', game: 'Magic', listId: '1', listName: 'Edgar EDH', idArticle: 11, idProduct: 50, foil: false, priceCents: 200 },
        ],
      },
    ],
    curve: [{ sellers: 1, cards: 1, totalCents: 325 }],
    totalCents: 325,
    shippingCents: 125,
    missing: [],
  };

  const plan = matchTokenDecks(parseTokenListText('# Edgar EDH\n1x 1/1 Black Vampire\n1x Treasure'), catalog);
  const tokenRes = optimizeTokens(
    plan,
    baseBasket.parcels,
    { ShopA: [{ idArticle: 901, idProduct: 1003, priceCents: 5, quantity: 1, condition: 2, language: 1, foil: false }] },
    catalog,
    { tables: { Germany: STANDARD_TABLE }, maxPriceCents: 20, parcelShippingFn: parcelShipping }
  );

  const merged = mergeTokensIntoBasket(baseBasket, tokenRes);
  // Original basket is untouched
  assert.equal(baseBasket.parcels[0].items.length, 1);
  assert.equal(baseBasket.totalCents, 325);

  // Merged basket includes token
  assert.equal(merged.parcels[0].items.length, 2);
  assert.equal(merged.parcels[0].hasTokens, true);
  assert.equal(merged.parcels[0].tokenCount, 1);
  assert.equal(merged.totalCents, 330);
  assert.equal(merged.curve[0].cards, 2);

  // Exports: Archidekt excludes tokens, Plain groups tokens cleanly by deck
  const entries = collectBasketEntries(merged.parcels);
  const archGroups = groupExportEntries(entries, 'archidekt');
  assert.equal(archGroups.length, 1);
  assert.equal(archGroups[0].label, 'Edgar EDH');
  const archOut = formatArchidektExport(entries);
  assert.equal(archOut.count, 1);
  assert.equal(archOut.text, '1x Sol Ring [ShopA]');

  const plainOut = formatPlainExport(entries);
  assert.equal(plainOut.count, 2);
  assert.match(plainOut.text, /# Edgar EDH \(Magic\)\n1 Sol Ring/);
  assert.match(plainOut.text, /# Tokens: Edgar EDH\n1 Vampire Token \(Black 1\/1\) \/\/ Treasure Token/);

  // formatProxyListText formats multi-deck output cleanly
  const proxyText = formatProxyListText([
    { deckName: 'Deck A', label: 'Treasure', remainingQty: 2 },
    { deckName: 'Deck B', label: '1/1 Green Squirrel', remainingQty: 4 },
  ]);
  assert.equal(proxyText, '# Deck A\n2x Treasure\n\n# Deck B\n4x 1/1 Green Squirrel');
});

test('collectSellerTokens caches full cheap-token snapshots, falls back for mega-powersellers, and handles ignored idRarity', async () => {
  const calls = [];
  const tokenIds = new Set([1001, 1002, 1003, 1004, 1005]);
  const cacheMap = new Map();
  const cache = { get: k => cacheMap.get(k), set: (k, v) => cacheMap.set(k, v) };

  const site = {
    async sellerTokens(seller, opts) {
      calls.push({ seller, ...opts });
      if (seller === 'SmallShop') {
        if (opts.pageNumber === 1) {
          return {
            offers: [{ idArticle: 1, seller, idProduct: 1001, priceCents: 3, quantity: 2, condition: 2, language: 1, foil: false }],
            skipped: 0, total: 25, hasNext: true,
          };
        }
        return {
          offers: [{ idArticle: 2, seller, idProduct: 1002, priceCents: 5, quantity: 1, condition: 2, language: 1, foil: false }],
          skipped: 0, total: 25, hasNext: false,
        };
      }
      if (seller === 'MegaShop') {
        if (!opts.name) {
          return {
            offers: [{ idArticle: 10, seller, idProduct: 1001, priceCents: 2, quantity: 1, condition: 2, language: 1, foil: false }],
            skipped: 0, total: 500, hasNext: true,
          };
        }
        return {
          offers: opts.name === 'Treasure'
            ? [{ idArticle: 11, seller, idProduct: 1002, priceCents: 4, quantity: 3, condition: 2, language: 1, foil: false }]
            : [],
          skipped: 0, total: 1, hasNext: false,
        };
      }
      if (seller === 'RarityBrokenShop') {
        if (!opts.name) {
          // Returns non-token ids -> should trigger rarityIgnored fallback
          return {
            offers: [
              { idArticle: 20, seller, idProduct: 9991, priceCents: 2, quantity: 1 },
              { idArticle: 21, seller, idProduct: 9992, priceCents: 2, quantity: 1 },
              { idArticle: 22, seller, idProduct: 9993, priceCents: 2, quantity: 1 },
              { idArticle: 23, seller, idProduct: 9994, priceCents: 2, quantity: 1 },
            ],
            skipped: 0, total: 4, hasNext: false,
          };
        }
        return {
          offers: opts.name === 'Treasure'
            ? [{ idArticle: 24, seller, idProduct: 1002, priceCents: 6, quantity: 1 }]
            : [],
          skipped: 0, total: 1, hasNext: false,
        };
      }
      return { offers: [], skipped: 0, total: 0, hasNext: false };
    },
  };

  const tokenPlan = { searchTerms: ['Treasure', 'Vampire'] };
  const res1 = await collectSellerTokens(
    ['SmallShop', 'MegaShop', 'RarityBrokenShop'],
    tokenPlan,
    site,
    { maxPriceCents: 20, tokenIds, cache, intervalMs: 1 }
  );

  assert.equal(res1.offersBySeller.SmallShop.length, 2);
  assert.equal(res1.offersBySeller.MegaShop.length, 2);
  assert.equal(res1.offersBySeller.RarityBrokenShop.length, 1);
  assert.equal(res1.offersBySeller.RarityBrokenShop[0].idProduct, 1002);

  // Verify modes logged
  const byName = Object.fromEntries(res1.sellerSummaries.map(s => [s.seller, s]));
  assert.equal(byName.SmallShop.mode, 'full');
  assert.equal(byName.MegaShop.mode, 'targeted');
  assert.equal(byName.RarityBrokenShop.mode, 'targeted-fallback');

  // Verify RarityBrokenShop dropped rarity filter in fallback queries
  const brokenTargeted = calls.filter(c => c.seller === 'RarityBrokenShop' && c.name);
  assert.ok(brokenTargeted.length >= 1);
  assert.ok(brokenTargeted.every(c => c.rarity === null));

  // Second run for SmallShop uses 8h full cache -> 0 new HTTP requests!
  const callsBefore = calls.length;
  const res2 = await collectSellerTokens(['SmallShop'], tokenPlan, site, { maxPriceCents: 20, tokenIds, cache, intervalMs: 1 });
  assert.equal(calls.length, callsBefore);
  assert.equal(res2.stats.cachedQueries, 1);
  assert.equal(res2.offersBySeller.SmallShop.length, 2);
});
