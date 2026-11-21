'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../wizard.js');
require('../collector.js');

const { createPlanner, parseShippingTable, parcelShipping, filterByLimits, scopeKey } = globalThis.CardmarketWizard;
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
