'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../wizard.js');
const { createPlanner, parseShippingTable, shipping } = globalThis.CardmarketWizard;

// Germany to Germany, as served by Cardmarket on 2026-11-20.
const table = parseShippingTable(require('./fixtures/shipping-de-de.json'));

let nextId = 1;
const offer = (seller, priceCents, quantity = 1) => ({ idArticle: nextId++, seller, priceCents, quantity, idProduct: 1 });
const card = (key, targetCents, offers, amount = 1) => ({ key, name: key, amount, targetCents, offers });

test('shipping follows card count and order value', () => {
  assert.equal(shipping(table, 4, 500).priceCents, 125);
  assert.equal(shipping(table, 5, 500).priceCents, 140);
  assert.equal(shipping(table, 30, 2000).priceCents, 230);
  assert.equal(shipping(table, 5, 3000).priceCents, 395, 'tracked above 25 €');
  assert.equal(shipping(table, 30, 3000).priceCents, 465);
});

test('saved basket is repriced with the current shipping, price and quantity', () => {
  const saved = offer('tracked', 20, 2);
  const picks = [0, 1].map(copy => ({ unitId: `x#${copy}`, seller: saved.seller, idArticle: saved.idArticle, idProduct: saved.idProduct }));
  const snapshot = (priceCents, quantity) => ({ results: [card('x', 20, [{ ...saved, priceCents, quantity }], 2)] });
  const valid = createPlanner(snapshot(21, 2), table, { trackedOnly: ['tracked'] }).revalidate(picks);
  assert.equal(valid.shippingCents, 395);
  assert.equal(valid.totalCents, 437);
  assert.equal(createPlanner(snapshot(21, 1), table).revalidate(picks), null);
  assert.equal(createPlanner(snapshot(21, 2), table).revalidate([...picks, picks[0]]), null);
});

test('buys from the seller with many cheap cards instead of the cheapest copy of each', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  // bulk has every card 2 cents above the cheapest; each cheapest copy sits with a different seller.
  const collection = { results: keys.map((key, i) => card(key, 20, [offer(`single${i}`, 18), offer('bulk', 20)])) };
  const basket = createPlanner(collection, table).basket();
  assert.equal(basket.parcels.length, 1);
  assert.equal(basket.parcels[0].seller, 'bulk');
  assert.equal(basket.totalCents, 6 * 20 + 140);
});

test('still splits when another seller is cheaper by more than the shipping', () => {
  const collection = { results: [
    card('cheap', 20, [offer('bulk', 20)]),
    card('staple', 1000, [offer('bulk', 1500), offer('specialist', 1000)]),
  ] };
  const basket = createPlanner(collection, table).basket();
  assert.deepEqual(basket.parcels.map(parcel => parcel.seller).sort(), ['bulk', 'specialist']);
});

test('reports cards nobody offers, respects quantities, and builds a coverage curve', () => {
  const collection = { results: [
    card('pair', 50, [offer('x', 50, 1), offer('y', 60, 1)], 2),
    card('rare', 100, []),
  ] };
  const basket = createPlanner(collection, table).basket();
  assert.deepEqual(basket.missing.map(unit => unit.key), ['rare']);
  assert.equal(basket.parcels.reduce((sum, parcel) => sum + parcel.items.length, 0), 2);
  assert.equal(basket.curve.at(-1).cards, 2);
  assert.equal(basket.curve.at(-1).totalCents, basket.totalCents);
});

test('top-up prices a chosen seller\'s above-market copy against a separate parcel', () => {
  const collection = { results: [
    card('a', 20, [offer('bulk', 20)]), card('b', 20, [offer('bulk', 20)]),
    card('c', 30, [offer('other', 30)]),
  ] };
  const planner = createPlanner(collection, table);
  const basket = planner.basket();
  assert.equal(basket.parcels.length, 2);
  const extra = { ...offer('bulk', 90), key: 'c' };
  const [candidate] = planner.topUp(basket, [extra]);
  assert.equal(candidate.aboveMarket, true);
  assert.equal(candidate.deltaCents, 90 - 30 - 125);
  const merged = planner.apply(basket, candidate);
  assert.equal(merged.parcels.length, 1);
});

test('tells cards nobody sells apart from cards never collected, and ranks sellers by overlap', () => {
  const collection = { results: [
    card('a', 20, [offer('big', 20), offer('small', 18)]), card('b', 20, [offer('big', 25)]),
    { ...card('c', null, []), verdict: 'blocked' }, { ...card('d', null, []), verdict: 'unavailable' },
  ] };
  const planner = createPlanner(collection, table);
  assert.deepEqual(planner.basket().missing.map(unit => unit.reason), ['not collected', 'no offer']);
  const [top] = planner.overlap();
  assert.deepEqual(top, { seller: 'big', cards: 2, atTarget: 1, cheapestCents: 45 });
});

test('seller search replaces two small parcels with one seller who has everything', async () => {
  // Greedy takes B (a and b at market), then needs D for c: 2 x 100 + 1,25 + 100 + 1,25 = 5,50.
  // C alone has all three at 1,25: 3,75 + 1,25 = 5,00.
  const collection = { results: [
    card('a', 100, [offer('B', 100), offer('C', 125)]),
    card('b', 100, [offer('B', 100), offer('C', 125)]),
    card('c', 100, [offer('D', 100), offer('C', 125)]),
  ] };
  const planner = createPlanner(collection, table);
  const greedy = planner.basket();
  assert.equal(greedy.totalCents, 550);
  const better = await planner.optimise(greedy, { timeMs: 300 });
  assert.equal(better.totalCents, 500);
  assert.deepEqual(better.parcels.map(parcel => parcel.seller), ['C']);
});

test('seller search never returns a dearer basket', async () => {
  const collection = { results: ['a', 'b', 'c'].map(key => card(key, 20, [offer('bulk', 20)])) };
  const planner = createPlanner(collection, table);
  const basket = planner.basket();
  assert.equal((await planner.optimise(basket, { timeMs: 100 })).totalCents, basket.totalCents);
});

test('recommends leaving out a card that forces its own parcel', () => {
  // c is only sold by D, alone: leaving it out saves its 0,30 and D's 1,25 letter.
  const collection = { results: [
    card('a', 50, [offer('B', 50)]), card('b', 50, [offer('B', 50)]), card('c', 30, [offer('D', 30)]),
  ] };
  const planner = createPlanner(collection, table);
  const [cut, ...rest] = planner.recommendCuts(planner.basket());
  assert.equal(cut.key, 'c');
  assert.equal(cut.savedCents, 155);
  assert.equal(cut.extraCents, 125);
  assert.equal(cut.basketCents, 225);
  assert.deepEqual(rest, [], 'cutting a or b would save no more than their price');
});
