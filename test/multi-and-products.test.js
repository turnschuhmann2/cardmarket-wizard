'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../wizard.js');
require('../collector.js');

const { createPlanner, parseShippingTable, parcelShipping, filterByLimits, previewLimitLeftOut, scopeKey } = globalThis.CardmarketWizard;
const { collectBySellers, parseProductOfferRow, parseWantsOverview, parseWantsListName } = globalThis.CardmarketCollector;

const deTable = parseShippingTable(require('./fixtures/shipping-de-de.json'));
// Simulated Austria -> Germany table (higher international letter rates).
const atTable = [
  { name: 'Priority Letter 20g', tracked: false, maxWeight: 20, maxValueCents: 2500, priceCents: 250, isLetter: true },
  { name: 'Priority Letter 75g', tracked: false, maxWeight: 75, maxValueCents: 2500, priceCents: 360, isLetter: true },
  { name: 'Tracked Letter 75g', tracked: true, maxWeight: 75, maxValueCents: 10000, priceCents: 690, isLetter: true },
  { name: 'Tracked Parcel 2kg', tracked: true, maxWeight: 2000, maxValueCents: 50000, priceCents: 1290, isLetter: false },
];

let nextId = 1000;
const offer = (seller, priceCents, extra = {}) => ({
  idArticle: nextId++, seller, priceCents, quantity: 1, idProduct: 1, location: 'Germany', ...extra,
});

test('multi-country shipping picks foreign seller only when total including international shipping beats domestic', () => {
  const tables = { default: deTable, byLocation: { Germany: deTable, Austria: atTable } };
  // Case 1: Austrian seller is only 0,50 EUR cheaper on cards, but shipping is 1,25 EUR more -> pick DE.
  const c1 = { results: [
    { key: 'a', name: 'A', amount: 1, targetCents: 100, offers: [
      offer('deSeller', 100, { location: 'Germany' }),
      offer('atSeller', 50, { location: 'Austria' }),
    ] },
  ] };
  const b1 = createPlanner(c1, tables).basket();
  assert.equal(b1.parcels[0].seller, 'deSeller');
  assert.equal(b1.parcels[0].location, 'Germany');
  assert.equal(b1.totalCents, 225);

  // Case 2: Austrian seller is 2,00 EUR cheaper -> beats 1,25 EUR higher international shipping!
  const c2 = { results: [
    { key: 'a', name: 'A', amount: 1, targetCents: 300, offers: [
      offer('deSeller', 300, { location: 'Germany' }),
      offer('atSeller', 100, { location: 'Austria' }),
    ] },
  ] };
  const b2 = createPlanner(c2, tables).basket();
  assert.equal(b2.parcels[0].seller, 'atSeller');
  assert.equal(b2.parcels[0].location, 'Austria');
  assert.equal(b2.parcels[0].shippingCents, 250);
  assert.equal(b2.totalCents, 350);
});

test('cross-game optimizer combines Magic and Yu-Gi-Oh! cards from the same seller into one parcel', () => {
  const collection = {
    results: [
      { key: 'mtg:1', name: 'Sol Ring', game: 'Magic', listId: '10', listName: 'EDH', amount: 1, targetCents: 100,
        offers: [offer('mtgOnly', 90), offer('crossShop', 110)] },
      { key: 'ygo:1', name: 'Ash Blossom', game: 'YuGiOh', listId: '20', listName: 'YGO', amount: 1, targetCents: 200,
        offers: [offer('ygoOnly', 190), offer('crossShop', 210)] },
    ],
  };
  // Separate sellers: 90 + 125 + 190 + 125 = 530. Combined crossShop: 110 + 210 + 125 = 445!
  const basket = createPlanner(collection, deTable).basket();
  assert.equal(basket.parcels.length, 1);
  assert.equal(basket.parcels[0].seller, 'crossShop');
  assert.deepEqual(basket.parcels[0].games.sort(), ['Magic', 'YuGiOh']);
  assert.equal(basket.totalCents, 445);
});

test('non-card product shipping uses per-seller product quotes, handles Personal Shipping Methods, and bumps to tracked above 25 EUR', () => {
  // Sleeves with custom Personal Shipping Method (1,48 EUR) + 2 cards = 1,48 EUR shipping (<= 25 EUR).
  const custom = parcelShipping(deTable, [
    { unit: { kind: 'product' }, offer: { shippingCents: 148 } },
    { unit: { kind: 'card' }, offer: {} },
    { unit: { kind: 'card' }, offer: {} },
  ], 1000);
  assert.equal(custom.priceCents, 148);

  // Sleeves with standard Maxibrief (3,40 EUR) + 5 cards (1,40 EUR) = 3,40 EUR Maxibrief.
  const maxi = parcelShipping(deTable, [
    { unit: { kind: 'product' }, offer: { shippingCents: 340 } },
    ...Array.from({ length: 5 }, () => ({ unit: { kind: 'card' }, offer: {} })),
  ], 1500);
  assert.equal(maxi.priceCents, 340);
  assert.equal(maxi.name, 'Maxibrief');

  // Sleeves (3,40 EUR) + expensive card pushing total to 30,00 EUR (> 25 EUR) -> tracked >= 500g (Grossbrief + Einschreiben 4,65 EUR).
  const tracked = parcelShipping(deTable, [
    { unit: { kind: 'product' }, offer: { shippingCents: 340 } },
    { unit: { kind: 'card' }, offer: {} },
  ], 3000);
  assert.equal(tracked.tracked, true);
  assert.equal(tracked.priceCents, 465);

  // Optimizer prefers buying sleeves from a seller we already buy cards from when it saves a parcel.
  const collection = {
    results: [
      { key: 'c1', name: 'Card 1', kind: 'card', game: 'Magic', amount: 1, targetCents: 100, offers: [offer('Method999', 100)] },
      { key: 'c2', name: 'Card 2', kind: 'card', game: 'Magic', amount: 1, targetCents: 100, offers: [offer('Method999', 100)] },
      { key: 'p1', name: 'Dragon Shield Sleeves', kind: 'product', game: 'Magic', amount: 1, targetCents: 600,
        offers: [
          offer('Goodgameguys', 784, { shippingCents: 148 }), // standalone: 932
          offer('Method999', 598, { shippingCents: 340 }),    // combined with c1+c2: adds 598 + (340-125) = 813!
        ] },
    ],
  };
  const basket = createPlanner(collection, deTable).basket();
  assert.equal(basket.parcels.length, 1);
  assert.equal(basket.parcels[0].seller, 'Method999');
  assert.equal(basket.parcels[0].hasProducts, true);
  assert.equal(basket.totalCents, 100 + 100 + 598 + 340);
});

test('scoped price limits support per-game, per-list, specificity precedence, and leave products untouched', () => {
  const results = [
    { key: 'm1', name: 'Cheap MTG', game: 'Magic', listId: '1', kind: 'card', amount: 1, targetCents: 100 },
    { key: 'm2', name: 'Pricey MTG (List 1)', game: 'Magic', listId: '1', kind: 'card', amount: 1, targetCents: 800 },
    { key: 'm3', name: 'Pricey MTG (List 2)', game: 'Magic', listId: '2', kind: 'card', amount: 1, targetCents: 800 },
    { key: 'y1', name: 'Pricey YGO', game: 'YuGiOh', listId: '3', kind: 'card', amount: 2, targetCents: 500 },
    { key: 'p1', name: 'Dragon Shield Sleeves', game: 'Magic', listId: null, kind: 'product', amount: 1, targetCents: 900 },
  ];

  // Limit only Yu-Gi-Oh! to 3,00 EUR -> Magic cards and sleeves remain kept!
  const ygoOnly = filterByLimits(results, [{ type: 'game', game: 'YuGiOh', cents: 300 }]);
  assert.deepEqual(ygoOnly.kept.map(r => r.key), ['m1', 'm2', 'm3', 'p1']);
  assert.deepEqual(ygoOnly.leftOut.map(r => r.key), ['y1']);
  assert.equal(ygoOnly.countsByScope.get(scopeKey({ type: 'game', game: 'YuGiOh' })), 2);

  // Limit only Magic List 1 to 3,00 EUR -> List 2's expensive Magic card stays!
  const list1Only = filterByLimits(results, [{ type: 'list', game: 'Magic', listId: '1', cents: 300 }]);
  assert.deepEqual(list1Only.kept.map(r => r.key), ['m1', 'm3', 'y1', 'p1']);
  assert.deepEqual(list1Only.leftOut.map(r => r.key), ['m2']);

  // Specificity: All <= 3,00 EUR, except Magic List 2 has no limit (cents: null) -> List 2 stays!
  const override = filterByLimits(results, [
    { type: 'all', cents: 300 },
    { type: 'list', game: 'Magic', listId: '2', cents: null },
  ]);
  assert.deepEqual(override.kept.map(r => r.key), ['m1', 'm3', 'p1']);
  assert.deepEqual(override.leftOut.map(r => r.key), ['m2', 'y1']);
});

test('previewLimitLeftOut returns sorted left-out cards with prices, respects scope overrides and manual cuts', () => {
  const results = [
    { key: 'm1', name: 'Cheap MTG', game: 'Magic', listId: '1', listName: 'Commander', kind: 'card', amount: 1, targetCents: 100, offers: [offer('A', 90)] },
    { key: 'm2', name: 'Rhystic Study', game: 'Magic', listId: '1', listName: 'Commander', kind: 'card', amount: 1, targetCents: 2800, offers: [offer('A', 2950), offer('B', 2650)] },
    { key: 'm3', name: 'Smothering Tithe', game: 'Magic', listId: '2', listName: 'Cube', kind: 'card', amount: 1, targetCents: 1800, offers: [] },
    { key: 'y1', name: 'Ash Blossom', game: 'YuGiOh', listId: '3', listName: 'Main Deck', kind: 'card', amount: 3, targetCents: 450, offers: [offer('C', 410), offer('D', 500)] },
    { key: 'm4', name: 'Manually Cut Card', game: 'Magic', listId: '1', listName: 'Commander', kind: 'card', amount: 1, targetCents: 900, offers: [offer('A', 850)] },
    { key: 'p1', name: 'Dragon Shield Sleeves', game: 'Magic', listId: null, kind: 'product', amount: 1, targetCents: 900, offers: [offer('A', 900)] },
  ];

  // Preview All cards <= 3,00 EUR with an existing All cards <= 1,00 EUR (replaced cleanly),
  // a more-specific override on List 2 (No limit -> m3 stays kept), and m4 manually cut.
  const allPreview = previewLimitLeftOut(
    results,
    [
      { type: 'all', cents: 100 },
      { type: 'list', game: 'Magic', listId: '2', cents: null },
    ],
    ['m4'],
    { type: 'all' },
    300,
  );
  assert.deepEqual(allPreview.items.map(i => i.key), ['m2', 'y1']);
  assert.equal(allPreview.items[0].targetCents, 2800);
  assert.equal(allPreview.items[0].cheapestOfferCents, 2650);
  assert.equal(allPreview.items[0].totalMarketCents, 2800);
  assert.equal(allPreview.items[1].amount, 3);
  assert.equal(allPreview.items[1].targetCents, 450);
  assert.equal(allPreview.items[1].cheapestOfferCents, 410);
  assert.equal(allPreview.items[1].totalMarketCents, 1350);
  assert.equal(allPreview.totalCopies, 4);
  assert.equal(allPreview.totalMarketCents, 4150);
  assert.equal(allPreview.scopedEligibleCount, 3); // m1, m2, y1 (m3 overridden by list 2, m4 manual, p1 product)

  // Preview a list-specific limit when a broader All-cards limit is active.
  const list2Preview = previewLimitLeftOut(
    results,
    [{ type: 'all', cents: 300 }],
    [],
    { type: 'list', game: 'Magic', listId: '2' },
    500,
  );
  assert.deepEqual(list2Preview.items.map(i => i.key), ['m3']);
  assert.equal(list2Preview.items[0].cheapestOfferCents, null);
  assert.equal(list2Preview.totalCopies, 1);
  assert.equal(list2Preview.totalMarketCents, 1800);

  // Custom limit higher than every card returns an empty list cleanly.
  const noneLeftOut = previewLimitLeftOut(results, [], [], { type: 'all' }, 5000);
  assert.equal(noneLeftOut.items.length, 0);
  assert.equal(noneLeftOut.totalCopies, 0);
  assert.equal(noneLeftOut.totalMarketCents, 0);
});

test('parseProductOfferRow extracts price, per-seller shipping, location, and optional condition', () => {
  // Lightweight DOM mock matching Cardmarket's non-single product offer row structure.
  const makeEl = ({ text = '', attrs = {}, cls = '', children = {} } = {}) => ({
    id: attrs.id || '',
    textContent: text,
    className: cls,
    getAttribute: name => attrs[name] ?? null,
    querySelector: sel => children[sel] || null,
    querySelectorAll: sel => {
      if (sel.startsWith('.col-seller')) return [makeEl({ attrs: { title: 'Item location: Germany' } }), makeEl({ attrs: { title: 'Powerseller' } })];
      if (sel.startsWith('.product-attributes')) return [makeEl({ attrs: { title: 'English' } })];
      return [];
    },
    closest: () => makeEl({ text: '1,48 €' }),
  });

  const shipIcon = makeEl({ attrs: { title: 'Shipping' } });
  const priceBox = makeEl({
    text: '7,84 €  1,48 €',
    children: {
      '[class*="shipping"], [class*="delivery"], [class*="package"], [title*="Shipping"], [data-bs-original-title*="Shipping"]': shipIcon,
    },
  });
  const row = makeEl({
    attrs: { id: 'articleRow987654' },
    children: {
      '.seller-name a[href*="/Users/"]': makeEl({ text: 'Goodgameguys' }),
      '.price-container .color-primary': makeEl({ text: '7,84 €' }),
      '.price-container': priceBox,
      '.amount-container .item-count': makeEl({ text: '7' }),
      '[class*="fonticon-seller-rating-"]': makeEl({ cls: 'fonticon-seller-rating-outstanding' }),
    },
  });

  const parsed = parseProductOfferRow(row);
  assert.equal(parsed.idArticle, 987654);
  assert.equal(parsed.seller, 'Goodgameguys');
  assert.equal(parsed.location, 'Germany');
  assert.equal(parsed.professional, true);
  assert.equal(parsed.priceCents, 784);
  assert.equal(parsed.shippingCents, 148);
  assert.equal(parsed.quantity, 7);
  assert.equal(parsed.language, 1);
  assert.equal(parsed.condition, 2);
});

test('parseWantsOverview extracts Wants Lists from table and Bootstrap card layouts without using action labels', () => {
  const mkTableLink = (href, text, countText, nameCellText = null) => {
    const tdLink = { textContent: text };
    const tdCount = { textContent: countText };
    const cells = nameCellText ? [{ textContent: nameCellText }, tdCount, tdLink] : [tdLink, tdCount];
    const tr = { querySelectorAll: () => cells };
    return {
      getAttribute: () => href,
      textContent: text,
      closest: sel => (sel === 'tr' ? tr : sel === 'td' ? tdLink : null),
    };
  };
  const tablePage = {
    querySelectorAll: () => [
      mkTableLink('/en/Magic/Wants/111', 'Commander Deck', '85'),
      mkTableLink('/en/Magic/Wants/111', 'Edit', '85'),
      mkTableLink('/en/Magic/Wants/222', 'View / Edit List', '24', 'Cube Staples'),
    ],
  };
  assert.deepEqual(parseWantsOverview(tablePage, 'Magic'), [
    { game: 'Magic', listId: '111', name: 'Commander Deck', count: 85, path: '/en/Magic/Wants/111' },
    { game: 'Magic', listId: '222', name: 'Cube Staples', count: 24, path: '/en/Magic/Wants/222' },
  ]);

  // Bootstrap card layout where <a> text is "View / Edit List" inside .card-body.
  const mkCardLink = (href, headingText, cardText, badgeText = null) => {
    const card = {
      textContent: cardText,
      querySelector: sel => {
        if (sel === '.card-title') return { textContent: headingText };
        if (sel === '.badge' && badgeText != null) return { textContent: badgeText };
        return null;
      },
    };
    return {
      getAttribute: () => href,
      textContent: 'View / Edit List',
      closest: sel => (sel === '.card' ? card : null),
    };
  };
  const cardPage = {
    querySelectorAll: () => [
      mkCardLink('/en/Magic/Wants/333', 'Atraxa Superfriends', 'Atraxa Superfriends 62 cards View / Edit List'),
      mkCardLink('/en/Magic/Wants/444', 'Pauper Burn', 'Pauper Burn View / Edit List', '19'),
    ],
  };
  assert.deepEqual(parseWantsOverview(cardPage, 'Magic'), [
    { game: 'Magic', listId: '333', name: 'Atraxa Superfriends', count: 62, path: '/en/Magic/Wants/333' },
    { game: 'Magic', listId: '444', name: 'Pauper Burn', count: 19, path: '/en/Magic/Wants/444' },
  ]);
});

test('parseWantsListName reads clean list title and skips generic headings', () => {
  const mkHeading = text => ({
    textContent: text,
    cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }),
  });

  // Direct h1 title
  assert.equal(
    parseWantsListName({ querySelector: sel => (sel === 'main h1' ? mkHeading('Eldrazi Ramp') : null) }, '101'),
    'Eldrazi Ramp',
  );

  // Generic h1 ("My Wants") falls back to active breadcrumb or document title
  assert.equal(
    parseWantsListName({
      title: 'Blue-Eyes White Dragon | Cardmarket',
      querySelector: sel => {
        if (sel === 'main h1') return mkHeading('My Wants');
        if (sel === '.breadcrumb-item.active, nav[aria-label="breadcrumb"] .active') return mkHeading('Blue-Eyes Deck');
        return null;
      },
    }, '202'),
    'Blue-Eyes Deck',
  );

  // Generic h1 + no breadcrumb falls back to stripped document title
  assert.equal(
    parseWantsListName({
      title: 'My Wants: Legacy Lands | Cardmarket',
      querySelector: sel => (sel === 'main h1' ? mkHeading('My Wants') : null),
    }, '303'),
    'Legacy Lands',
  );

  // Complete fallback uses listId
  assert.equal(
    parseWantsListName({ title: 'My Wants | Cardmarket', querySelector: () => null }, '404'),
    'Wants List 404',
  );
});

test('collectBySellers collects across multiple games, multiple lists, and non-card products while propagating seller location', async () => {
  const plan = {
    entries: [
      { key: 'm:1', game: 'Magic', listId: '10', listName: 'EDH', kind: 'card', name: 'Sol Ring', amount: 1, anyPrinting: true,
        cardPath: '/en/Magic/Cards/Sol-Ring', languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any',
        printings: [{ idProduct: 101, idExpansion: 1, guideLowCents: 80 }] },
      { key: 'y:1', game: 'YuGiOh', listId: '20', listName: 'YGO', kind: 'card', name: 'Ash Blossom', amount: 1, anyPrinting: true,
        cardPath: '/en/YuGiOh/Cards/Ash-Blossom', languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any',
        printings: [{ idProduct: 201, idExpansion: 2, guideLowCents: 200 }] },
      { key: 'p:1', game: 'Magic', listId: null, listName: null, kind: 'product', name: 'Dragon Shield', amount: 1,
        productPath: '/en/Magic/Products/Sleeves/Dragon-Shield', languages: [], minCondition: 7, printings: [] },
    ],
  };

  const sellerCalls = [];
  const site = {
    async cardPage(entry) {
      if (entry.key === 'm:1') {
        return { skipped: 0, offers: [
          { idArticle: 1, seller: 'CrossShop', location: 'Austria', idProduct: 101, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 100, quantity: 2 },
        ] };
      }
      return { skipped: 0, offers: [
        { idArticle: 2, seller: 'CrossShop', location: 'Austria', idProduct: 201, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 210, quantity: 1 },
      ] };
    },
    async productPage() {
      return {
        skipped: 0,
        meta: { name: '100 Dragon Shield Matte Black', game: 'Magic', category: 'Sleeves', idProduct: 999, path: '/en/Magic/Products/Sleeves/Dragon-Shield' },
        offers: [
          { idArticle: 3, seller: 'CrossShop', location: 'Austria', idProduct: 999, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 650, shippingCents: 290, quantity: 4 },
        ],
      };
    },
    async sellerWants(seller, listId, pageNumber, game) {
      sellerCalls.push({ seller, listId, game });
      if (game === 'Magic') {
        return { skipped: 0, total: 1, hasNext: false, offers: [
          { idArticle: 4, seller, idProduct: 101, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 95, quantity: 1 },
        ] };
      }
      return { skipped: 0, total: 0, hasNext: false, offers: [] };
    },
  };

  const result = await collectBySellers(plan, site, {
    lists: [{ game: 'Magic', listId: '10', listName: 'EDH' }, { game: 'YuGiOh', listId: '20', listName: 'YGO' }],
    sellerCountries: [],
    intervalMs: 0,
    minSellerCards: 2,
  });

  assert.equal(result.results.length, 3);
  const magicRes = result.results.find(r => r.key === 'm:1');
  const ygoRes = result.results.find(r => r.key === 'y:1');
  const prodRes = result.results.find(r => r.key === 'p:1');
  assert.equal(magicRes.game, 'Magic');
  assert.equal(magicRes.listName, 'EDH');
  assert.equal(ygoRes.game, 'YuGiOh');
  assert.equal(prodRes.kind, 'product');
  assert.equal(prodRes.name, '100 Dragon Shield Matte Black');
  assert.equal(prodRes.offers[0].shippingCents, 290);
  // Seller offer from sellerWants got CrossShop's location ('Austria') propagated!
  const fromSeller = magicRes.offers.find(o => o.idArticle === 4);
  assert.equal(fromSeller.location, 'Austria');
  assert.deepEqual(sellerCalls, [
    { seller: 'CrossShop', listId: '10', game: 'Magic' },
    { seller: 'CrossShop', listId: '20', game: 'YuGiOh' },
  ]);
});

test('collectBySellers seeds domestic offers on crowded multi-country pages and reuses domestic 8h cache', async () => {
  const mkCard = (key, idProduct) => ({
    key, game: 'Magic', listId: '10', listName: 'EDH', kind: 'card', name: key, amount: 1, anyPrinting: true,
    cardPath: `/en/Magic/Cards/${key}`, languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any',
    printings: [{ idProduct, idExpansion: 1, guideLowCents: 100 }],
  });
  const mkProd = () => ({
    key: 'p:sleeves', game: 'Magic', listId: null, listName: null, kind: 'product', name: 'Sleeves', amount: 1,
    productPath: '/en/Magic/Products/Sleeves/Test', languages: [], minCondition: 7, printings: [],
  });
  const plan = { entries: [mkCard('crowded', 101), mkCard('sparse', 102), mkProd()] };

  // Build 50 foreign offers + 1 German offer on crowded card & product, only 5 offers on sparse card.
  const foreignCardOffers = Array.from({ length: 50 }, (_, i) => ({
    idArticle: 1000 + i, seller: `ES_${i}`, location: 'Spain', idProduct: 101, language: 1, condition: 2,
    foil: false, signed: false, altered: false, priceCents: 100 + i, quantity: 1,
  }));
  const deCardOffers = [
    foreignCardOffers[0], // duplicate idArticle check (cardOffers must stay unique)
    { idArticle: 2001, seller: 'DE_Shop', location: 'Germany', idProduct: 101, language: 1, condition: 2,
      foil: false, signed: false, altered: false, priceCents: 180, quantity: 2 },
  ];
  const sparseOffers = [
    { idArticle: 3001, seller: 'ES_0', location: 'Spain', idProduct: 102, language: 1, condition: 2,
      foil: false, signed: false, altered: false, priceCents: 100, quantity: 1 },
    { idArticle: 3002, seller: 'DE_Shop', location: 'Germany', idProduct: 102, language: 1, condition: 2,
      foil: false, signed: false, altered: false, priceCents: 120, quantity: 1 },
  ];
  const foreignProdOffers = Array.from({ length: 50 }, (_, i) => ({
    idArticle: 4000 + i, seller: `ES_P_${i}`, location: 'Spain', idProduct: 900, language: 1, condition: 2,
    foil: false, signed: false, altered: false, priceCents: 600 + i, shippingCents: 1604, quantity: 1,
  }));
  const deProdOffers = [
    { idArticle: 5001, seller: 'DE_Shop', location: 'Germany', idProduct: 900, language: 1, condition: 2,
      foil: false, signed: false, altered: false, priceCents: 699, shippingCents: 148, quantity: 3 },
  ];

  const calls = [];
  const site = {
    async cardPage(entry, query) {
      calls.push(['card', entry.key, query.sellerCountries.join(',')]);
      if (entry.key === 'sparse') return { offers: sparseOffers, skipped: 0 };
      if (query.sellerCountries.length === 1 && query.sellerCountries[0] === 7) return { offers: deCardOffers, skipped: 0 };
      return { offers: foreignCardOffers, skipped: 0 };
    },
    async productPage(entry, query) {
      calls.push(['product', entry.key, query.sellerCountries.join(',')]);
      if (query.sellerCountries.length === 1 && query.sellerCountries[0] === 7) {
        return { offers: deProdOffers, skipped: 0, meta: { name: 'Sleeves', game: 'Magic', category: 'Sleeves', idProduct: 900 } };
      }
      return { offers: foreignProdOffers, skipped: 0, meta: { name: 'Sleeves', game: 'Magic', category: 'Sleeves', idProduct: 900 } };
    },
    async sellerWants() { return { offers: [], skipped: 0, total: 0, hasNext: false }; },
  };

  const cache = new Map();
  const eu = [7, 10, 12];
  const run1 = await collectBySellers(plan, site, {
    lists: [{ game: 'Magic', listId: '10', listName: 'EDH' }],
    sellerCountries: eu, domesticCountry: 7, domesticLocation: 'Germany',
    intervalMs: 0, minSellerCards: 2, cache,
  });

  // Crowded card and crowded product fetched both EU and domestic [7]; sparse card skipped redundant [7].
  assert.ok(calls.some(([t, k, c]) => t === 'card' && k === 'crowded' && c === '7'));
  assert.ok(calls.some(([t, k, c]) => t === 'product' && k === 'p:sleeves' && c === '7'));
  assert.ok(!calls.some(([t, k, c]) => t === 'card' && k === 'sparse' && c === '7'));

  const crowdedRes = run1.results.find(r => r.key === 'crowded');
  assert.ok(crowdedRes.offers.some(o => o.seller === 'DE_Shop'), 'domestic seller merged despite page-1 crowding');
  assert.equal(crowdedRes.cardOffers, crowdedRes.offers.length, 'duplicate idArticles are not double-counted');
  assert.equal(crowdedRes.sellerOffers, 0);

  const prodRes = run1.results.find(r => r.key === 'p:sleeves');
  assert.ok(prodRes.offers.some(o => o.seller === 'DE_Shop' && o.shippingCents === 148));

  // Switching to Germany-only now reuses the seeded domestic cache for crowded card & product!
  calls.length = 0;
  await collectBySellers(plan, site, {
    lists: [{ game: 'Magic', listId: '10', listName: 'EDH' }],
    sellerCountries: [7], domesticCountry: 7, domesticLocation: 'Germany',
    intervalMs: 0, minSellerCards: 2, cache,
  });
  assert.ok(!calls.some(([t, k]) => t === 'card' && k === 'crowded'), 'crowded card served from shared domestic cache');
  assert.ok(!calls.some(([t, k]) => t === 'product' && k === 'p:sleeves'), 'product served from shared domestic cache');
  assert.ok(calls.some(([t, k]) => t === 'card' && k === 'sparse'), 'sparse card fetched once for DE-only');
});

test('collectBySellers Phase 2 ranks sellers shipping-aware, reserves domestic slots, and skips failed countries', async () => {
  const entries = Array.from({ length: 6 }, (_, i) => ({
    key: `c${i}`, game: 'Magic', listId: '10', listName: 'EDH', kind: 'card', name: `Card ${i}`, amount: 1, anyPrinting: true,
    cardPath: `/en/Magic/Cards/C${i}`, languages: [1], minCondition: 4, foil: 'any', signed: 'any', altered: 'any',
    printings: [{ idProduct: i + 1, idExpansion: 1, guideLowCents: 100 }],
  }));
  const jpTable = [{ name: 'JP Courier', tracked: true, maxWeight: 2000, maxValueCents: 50000, priceCents: 3871, isLetter: false }];
  const tables = {
    default: deTable,
    defaultLocation: 'Germany',
    byLocation: { Germany: deTable, Austria: atTable, Japan: jpTable, BrokenLand: [] },
  };

  let id = 10000;
  const cardOffers = Object.fromEntries(entries.map((e, i) => [e.key, [
    // Japan & BrokenLand have ALL 6 cards at lowest raw price; Austria has 4; Germany sellers have 3 each.
    { idArticle: id++, seller: 'JP_Mega', location: 'Japan', idProduct: i + 1, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 90, quantity: 1 },
    { idArticle: id++, seller: 'Broken_Mega', location: 'BrokenLand', idProduct: i + 1, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 85, quantity: 1 },
    ...(i < 4 ? [{ idArticle: id++, seller: 'AT_Shop', location: 'Austria', idProduct: i + 1, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 95, quantity: 1 }] : []),
    ...(i < 3 ? [
      { idArticle: id++, seller: 'DE_1', location: 'Germany', idProduct: i + 1, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 110, quantity: 1 },
      { idArticle: id++, seller: 'DE_2', location: 'Germany', idProduct: i + 1, language: 1, condition: 2, foil: false, signed: false, altered: false, priceCents: 115, quantity: 1 },
    ] : []),
  ]]));

  const asked = [];
  const site = {
    async cardPage(entry) { return { offers: cardOffers[entry.key], skipped: 0 }; },
    async sellerWants(seller) { asked.push(seller); return { offers: [], skipped: 0, total: 0, hasNext: false }; },
  };

  await collectBySellers({ entries }, site, {
    lists: [{ game: 'Magic', listId: '10', listName: 'EDH' }],
    sellerCountries: [1, 7, 36], domesticCountry: 7, domesticLocation: 'Germany',
    loadShippingTables: async () => tables,
    minSellers: 3, sellerLimit: 3, minSellerCards: 2, intervalMs: 0,
  });

  // Top 3 sellers must include both German sellers (60% share -> 2 of 3) + Austria (beats Japan's 38.71 EUR penalty),
  // and must never waste a Phase-2 query on BrokenLand (empty shipping table).
  assert.ok(!asked.includes('Broken_Mega'), 'country with empty shipping table is skipped');
  assert.ok(asked.includes('DE_1') && asked.includes('DE_2'), 'domestic sellers get reserved Phase-2 slots');
  assert.ok(asked.includes('AT_Shop'), 'moderate-shipping Austria beats 38.71 EUR Japan');
  assert.ok(!asked.includes('JP_Mega'), 'Japan penalized below Austria');
});

test('wizard rank() never strands items across the 25 EUR shipping cliff and multi-country optimise() beats high-cliff foreign traps', async () => {
  // 1. Single seller with 10 x 3,30 EUR cards (33 EUR > 25 EUR cliff) must assign all 10 cards, 0 missing.
  const singleSellerCol = {
    results: Array.from({ length: 10 }, (_, i) => ({
      key: `c${i}`, name: `Card ${i}`, amount: 1, kind: 'card', game: 'Magic', targetCents: 330, verdict: 'read',
      offers: [offer('GermanBulk', 330, { idProduct: i + 1, location: 'Germany' })],
    })),
  };
  const singleBasket = createPlanner(singleSellerCol, deTable).basket();
  assert.equal(singleBasket.missing.length, 0);
  assert.equal(singleBasket.parcels[0].items.length, 10);
  assert.equal(singleBasket.totalCents, 3300 + 395);

  // 2. Multi-country trap: Spain has all 10 cards at 3,00 EUR (30 EUR -> 16,04 EUR tracked = 46,04 EUR),
  //    while Germany has all 10 at 3,30 EUR (33 EUR -> 3,95 EUR tracked = 36,95 EUR).
  //    Mixed split (8 cards ES @ 3,00 = 24,00 + 2,60 = 26,60 + 2 cards DE @ 3,30 = 6,60 + 1,25 = 7,85 -> 34,45 EUR) is even cheaper!
  const esTable = [
    { name: 'ES Letter 50g', tracked: false, maxWeight: 50, maxValueCents: 2500, priceCents: 260, isLetter: true },
    { name: 'ES Tracked 250g', tracked: true, maxWeight: 250, maxValueCents: 50000, priceCents: 1604, isLetter: true },
  ];
  const tables = { default: deTable, defaultLocation: 'Germany', byLocation: { Germany: deTable, Spain: esTable } };
  const trapCol = {
    results: Array.from({ length: 10 }, (_, i) => ({
      key: `c${i}`, name: `Card ${i}`, amount: 1, kind: 'card', game: 'Magic', targetCents: 300, verdict: 'read',
      offers: [
        offer('SpainBulk', 300, { idProduct: i + 1, location: 'Spain' }),
        offer('GermanBulk', 330, { idProduct: i + 1, location: 'Germany' }),
      ],
    })),
  };
  const planner = createPlanner(trapCol, tables);
  const quick = planner.basket();
  const opt = await planner.optimise(quick, { timeMs: 600 });
  assert.equal(opt.missing.length, 0);
  assert.ok(opt.totalCents <= 3695, `multi-country basket (${opt.totalCents}) must never exceed DE-only (3695)`);
  assert.equal(opt.totalCents, 3445, 'relieves 25 EUR Spain cliff by offloading 2 cards to Germany');
});

test('parseOfferRow and parseProductOfferRow trim location whitespace', () => {
  const { parseOfferRow } = globalThis.CardmarketCollector;
  const makeEl = ({ text = '', attrs = {}, cls = '', children = {} } = {}) => ({
    id: attrs.id || '',
    textContent: text,
    className: cls,
    getAttribute: name => attrs[name] ?? null,
    querySelector: sel => children[sel] || null,
    querySelectorAll: sel => {
      if (sel.startsWith('.col-seller')) return [makeEl({ attrs: { title: 'Item location: Germany  ' } })];
      if (sel.startsWith('.product-attributes')) return [makeEl({ attrs: { title: 'Near Mint' } }), makeEl({ attrs: { title: 'English' } })];
      return [];
    },
    closest: () => makeEl({ text: '1,48 €' }),
  });
  const row = makeEl({
    attrs: { id: 'articleRow12345' },
    children: {
      '.seller-name a[href*="/Users/"]': makeEl({ text: 'TestSeller' }),
      '.price-container .color-primary': makeEl({ text: '1,50 €' }),
      '.price-container': makeEl({ text: '1,50 € 1,48 €' }),
      '.amount-container .item-count': makeEl({ text: '2' }),
    },
  });
  assert.equal(parseOfferRow(row).location, 'Germany');
  assert.equal(parseProductOfferRow(row).location, 'Germany');
});
