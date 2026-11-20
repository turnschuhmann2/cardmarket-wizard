/*
 * Builds a basket from collected offers.
 *
 * 1. Seller ranking: repeatedly pick the seller whose cheapest set of still-open cards costs the
 *    least above market per card, counting that seller's shipping. Market is each card's target
 *    price, so cheap commons and expensive staples weigh the same, and sellers with many cheap
 *    listings win.
 * 2. Clean-up: move each card to the cheapest seller already in the basket, and drop sellers
 *    whose cards are cheaper elsewhere once shipping is counted.
 * 3. Coverage: sellers in order of their cost above market per card, with running totals, so
 *    "the first N sellers get X cards for Y" can be read off.
 * 4. Top-up: offers the chosen sellers have above the cutoff can be priced as moves into the basket.
 */
(function (root) {
  'use strict';

  function cents(text) {
    const match = /(\d[\d.]*),(\d{2})/.exec(text || '');
    if (!match) throw new Error(`Unreadable amount "${text}"`);
    return parseInt(match[1].replace(/\./g, ''), 10) * 100 + parseInt(match[2], 10);
  }

  // From help.cardmarket.com/api/shippingCosts?locale=en&fromCountry=<id>&toCountry=<id>.
  function parseShippingTable(methods) {
    return methods.filter(method => !method.isVirtual).map(method => ({
      name: method.name, tracked: method.isTracked, maxWeight: method.maxWeight,
      maxValueCents: cents(method.maxValue), priceCents: cents(method.price),
    }));
  }

  // Cardmarket: a 20 g letter holds 4 cards, 50 g holds 17, 100 g holds 40.
  const weightOf = cards => (cards <= 4 ? 20 : cards <= 17 ? 50 : cards <= 40 ? 100 : Math.ceil(cards * 2.5));

  function shipping(table, cards, valueCents) {
    let best = null;
    for (const method of table) {
      if (method.maxWeight >= weightOf(cards) && method.maxValueCents >= valueCents &&
          (!best || method.priceCents < best.priceCents)) best = method;
    }
    return best;
  }

  // One unit is one wanted copy; a card wanted twice is two units.
  function unitsOf(collection) {
    const units = [];
    for (const result of collection.results) {
      for (let copy = 0; copy < result.amount; copy += 1) {
        units.push({ id: `${result.key}#${copy}`, key: result.key, name: result.name, targetCents: result.targetCents, verdict: result.verdict });
      }
    }
    return units;
  }

  function offersBySeller(collection) {
    const sellers = new Map();
    for (const result of collection.results) {
      for (const offer of result.offers) {
        if (!sellers.has(offer.seller)) sellers.set(offer.seller, new Map());
        const byKey = sellers.get(offer.seller);
        if (!byKey.has(result.key)) byKey.set(result.key, []);
        byKey.get(result.key).push(offer);
      }
    }
    for (const byKey of sellers.values()) for (const list of byKey.values()) list.sort((a, b) => a.priceCents - b.priceCents);
    return sellers;
  }

  // Seller-search strategies raced by optimise (see search() for what each setting does).
  const STRATEGIES = [
    { name: 'steady', seed: 1, shake: 3, breadth: 150 },
    { name: 'narrow', seed: 2, shake: 2, breadth: 50 },
    { name: 'wide', seed: 3, shake: 5, breadth: 300 },
    { name: 'from scratch', seed: 4, shake: 3, breadth: 150, start: 'empty' },
  ];

  // trackedOnly: sellers who may only ship tracked (learned from the cart: Cardmarket makes tracked
  // shipping mandatory for some sellers, e.g. new ones or ones with a high loss rate).
  function createPlanner(collection, table, { trackedOnly = [] } = {}) {
    const trackedSellers = new Set(trackedOnly);
    const trackedTable = table.filter(method => method.tracked);
    const tableFor = seller => (trackedSellers.has(seller) ? trackedTable : table);
    const units = unitsOf(collection);
    const sellers = offersBySeller(collection);
    const unitById = new Map(units.map(unit => [unit.id, unit]));

    // assignment: unit id -> { seller, offer }
    function parcels(assignment) {
      const bySeller = new Map();
      for (const [unitId, pick] of assignment) {
        if (!bySeller.has(pick.seller)) bySeller.set(pick.seller, []);
        bySeller.get(pick.seller).push({ unit: unitById.get(unitId), offer: pick.offer });
      }
      return [...bySeller].map(([seller, items]) => {
        const itemsCents = items.reduce((sum, item) => sum + item.offer.priceCents, 0);
        const method = shipping(tableFor(seller), items.length, itemsCents);
        return { seller, items, itemsCents, method, shippingCents: method ? method.priceCents : Infinity };
      });
    }

    const total = assignment => parcels(assignment).reduce((sum, parcel) => sum + parcel.itemsCents + parcel.shippingCents, 0);

    // Copies of an offer already used by other units.
    function used(assignment, except) {
      const counts = new Map();
      for (const [unitId, pick] of assignment) {
        if (unitId !== except) counts.set(pick.offer.idArticle, (counts.get(pick.offer.idArticle) || 0) + 1);
      }
      return counts;
    }

    function cheapestCopy(seller, key, taken) {
      for (const offer of sellers.get(seller)?.get(key) || []) {
        if ((taken.get(offer.idArticle) || 0) < offer.quantity) return offer;
      }
      return null;
    }

    function rank() {
      const assignment = new Map();
      const order = [];
      const open = new Set(units.map(unit => unit.id));
      for (;;) {
        let best = null;
        const taken = used(assignment);
        for (const [seller, byKey] of sellers) {
          if (order.includes(seller)) continue;
          const picks = [];
          const local = new Map(taken);
          for (const unitId of open) {
            const unit = unitById.get(unitId);
            if (!byKey.has(unit.key)) continue;
            const offer = cheapestCopy(seller, unit.key, local);
            if (!offer) continue;
            local.set(offer.idArticle, (local.get(offer.idArticle) || 0) + 1);
            picks.push({ unitId, offer, extra: offer.priceCents - unit.targetCents });
          }
          picks.sort((a, b) => a.extra - b.extra);
          let extra = 0;
          let value = 0;
          picks.forEach((pick, index) => {
            extra += pick.extra;
            value += pick.offer.priceCents;
            const method = shipping(tableFor(seller), index + 1, value);
            if (!method) return;
            const perCard = (extra + method.priceCents) / (index + 1);
            if (!best || perCard < best.perCard) best = { seller, perCard, picks: picks.slice(0, index + 1) };
          });
        }
        if (!best) break;
        order.push(best.seller);
        for (const pick of best.picks) {
          assignment.set(pick.unitId, { seller: best.seller, offer: pick.offer });
          open.delete(pick.unitId);
        }
      }
      return assignment;
    }

    // Moves single cards between chosen sellers and drops sellers while the total goes down.
    function improve(assignment) {
      let current = new Map(assignment);
      let cost = total(current);
      for (let changed = true, rounds = 0; changed && rounds < 20; rounds += 1) {
        changed = false;
        const chosen = [...new Set([...current.values()].map(pick => pick.seller))];
        for (const unitId of current.keys()) {
          const taken = used(current, unitId);
          for (const seller of chosen) {
            const offer = cheapestCopy(seller, unitById.get(unitId).key, taken);
            if (!offer || offer.idArticle === current.get(unitId).offer.idArticle) continue;
            const trial = new Map(current).set(unitId, { seller, offer });
            const trialCost = total(trial);
            if (trialCost < cost) { current = trial; cost = trialCost; changed = true; }
          }
        }
        for (const seller of [...new Set([...current.values()].map(pick => pick.seller))]) {
          const others = [...new Set([...current.values()].map(pick => pick.seller))].filter(other => other !== seller);
          const trial = new Map(current);
          let possible = true;
          for (const [unitId, pick] of current) {
            if (pick.seller !== seller) continue;
            const taken = used(trial, unitId);
            const options = others.map(other => ({ other, offer: cheapestCopy(other, unitById.get(unitId).key, taken) }))
              .filter(option => option.offer).sort((a, b) => a.offer.priceCents - b.offer.priceCents);
            if (!options.length) { possible = false; break; }
            trial.set(unitId, { seller: options[0].other, offer: options[0].offer });
          }
          if (!possible) continue;
          const trialCost = total(trial);
          if (trialCost < cost) { current = trial; cost = trialCost; changed = true; }
        }
      }
      return current;
    }

    function describe(assignment) {
      const list = parcels(assignment).map(parcel => {
        const extraCents = parcel.items.reduce((sum, item) => sum + item.offer.priceCents - item.unit.targetCents, 0) + parcel.shippingCents;
        return {
          seller: parcel.seller, itemsCents: parcel.itemsCents, shippingCents: parcel.shippingCents,
          method: parcel.method?.name ?? null, extraPerCardCents: Math.round(extraCents / parcel.items.length),
          items: parcel.items.map(({ unit, offer }) => ({
            key: unit.key, name: unit.name, idArticle: offer.idArticle, idProduct: offer.idProduct, foil: !!offer.foil,
            priceCents: offer.priceCents, targetCents: unit.targetCents, aboveMarket: offer.priceCents > unit.targetCents,
          })).sort((a, b) => a.name.localeCompare(b.name)),
        };
      }).sort((a, b) => a.extraPerCardCents - b.extraPerCardCents);
      let cards = 0;
      let running = 0;
      const curve = list.map((parcel, index) => {
        cards += parcel.items.length;
        running += parcel.itemsCents + parcel.shippingCents;
        return { sellers: index + 1, cards, totalCents: running };
      });
      const assigned = new Set(assignment.keys());
      return {
        parcels: list, curve, totalCents: running,
        shippingCents: list.reduce((sum, parcel) => sum + parcel.shippingCents, 0),
        // Not collected (the run stopped first) is not the same as nobody selling it.
        missing: units.filter(unit => !assigned.has(unit.id)).map(unit => ({
          key: unit.key, name: unit.name,
          reason: unit.verdict === 'blocked' ? 'not collected' : unit.verdict === 'incomplete' ? 'not fully collected' : 'no offer',
        })),
        assignment,
      };
    }

    // Prices moving one wanted copy to an offer outside the collected range (e.g. from a seller's
    // own offer list). Negative deltaCents saves money.
    function topUp(basket, extraOffers) {
      const base = total(basket.assignment);
      const candidates = [];
      for (const offer of extraOffers) {
        for (const unit of units.filter(candidate => candidate.key === offer.key)) {
          const current = basket.assignment.get(unit.id);
          if (current?.offer.idArticle === offer.idArticle) continue;
          const trial = new Map(basket.assignment).set(unit.id, { seller: offer.seller, offer });
          if ([...used(trial)].some(([idArticle, count]) => idArticle === offer.idArticle && count > offer.quantity)) continue;
          candidates.push({
            unitId: unit.id, name: unit.name, seller: offer.seller, offer, targetCents: unit.targetCents,
            aboveMarket: offer.priceCents > unit.targetCents, replaces: current ? current.seller : null,
            deltaCents: total(trial) - base,
          });
          break;
        }
      }
      return candidates.sort((a, b) => a.deltaCents - b.deltaCents);
    }

    function apply(basket, candidate) {
      return describe(new Map(basket.assignment).set(candidate.unitId, { seller: candidate.seller, offer: candidate.offer }));
    }

    // Sellers with the most wanted cards up to the cutoff, and how many of those at or below target.
    function overlap(limit = 15) {
      return [...sellers].map(([seller, byKey]) => {
        let atTarget = 0;
        let cheapestCents = 0;
        for (const [key, list] of byKey) {
          const result = collection.results.find(candidate => candidate.key === key);
          if (list[0].priceCents <= result.targetCents) atTarget += 1;
          cheapestCents += list[0].priceCents;
        }
        return { seller, cards: byKey.size, atTarget, cheapestCents };
      }).sort((a, b) => b.cards - a.cards || b.atTarget - a.atTarget || a.cheapestCents - b.cheapestCents).slice(0, limit);
    }

    // Each card from the cheapest copy among the given sellers, in wanted-list order.
    function assignWithin(chosen) {
      const assignment = new Map();
      const taken = new Map();
      for (const unit of units) {
        let best = null;
        for (const seller of chosen) {
          const offer = cheapestCopy(seller, unit.key, taken);
          if (offer && (!best || offer.priceCents < best.offer.priceCents)) best = { seller, offer };
        }
        if (!best) continue;
        taken.set(best.offer.idArticle, (taken.get(best.offer.idArticle) || 0) + 1);
        assignment.set(unit.id, best);
      }
      return assignment;
    }

    // A card nobody among the chosen sellers has counts as very expensive, so a seller set that
    // leaves cards out never wins.
    const MISSING_CENTS = 100000;
    const costOf = chosen => {
      const assignment = assignWithin(chosen);
      return { assignment, cents: total(assignment) + (units.length - assignment.size) * MISSING_CENTS };
    };

    // Small deterministic random generator, so reopening a run gives the same basket.
    function random(seed) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const pause = () => new Promise(resolve => setTimeout(resolve, 0));

    /*
     * Searches over which sellers to buy from: drop a seller, add one, or swap one for another,
     * whenever that lowers the total (items plus every parcel's shipping). When no single move
     * helps, it drops `shake` random sellers and searches again, keeping the best set found,
     * until the deadline. Sellers are tried in order of how much they could save, `breadth` per
     * pass. `start: 'empty'` builds the set from nothing instead of from the quick basket.
     */
    async function search(basket, { seed = 1, shake = 3, breadth = 150, start = 'basket' }, deadline) {
      const next = random(seed);
      const candidates = [...sellers.keys()];
      const timeLeft = () => Date.now() < deadline;

      // Only a seller with some card cheaper than what the basket pays for it can lower the total;
      // any other seller only adds shipping (on the 114-card list 1,756 of 3,131 sellers were
      // cheaper somewhere, most by a few cents on a single card).
      function helpful(assignment) {
        const paid = new Map();
        for (const unit of units) {
          const price = assignment.get(unit.id)?.offer.priceCents ?? MISSING_CENTS;
          paid.set(unit.key, Math.max(paid.get(unit.key) ?? 0, price));
        }
        const scored = [];
        for (const seller of candidates) {
          let saving = 0;
          for (const [key, list] of sellers.get(seller)) if (paid.has(key) && list[0].priceCents < paid.get(key)) saving += paid.get(key) - list[0].priceCents;
          if (saving > 0) scored.push([saving, seller]);
        }
        return scored.sort((a, b) => b[0] - a[0]).slice(0, breadth).map(([, seller]) => seller);
      }

      async function polish(from) {
        let chosen = new Set(from);
        let current = costOf(chosen).cents;
        for (let improved = true; improved && timeLeft();) {
          improved = false;
          for (const seller of [...chosen]) {
            const trial = new Set(chosen);
            trial.delete(seller);
            const cents = costOf(trial).cents;
            if (cents < current) { current = cents; chosen = trial; improved = true; }
          }
          for (const [index, seller] of helpful(assignWithin(chosen)).entries()) {
            if (chosen.has(seller)) continue;
            const trial = new Set(chosen).add(seller);
            const cents = costOf(trial).cents;
            if (cents < current) { current = cents; chosen = trial; improved = true; }
            if (index % 200 === 0) { await pause(); if (!timeLeft()) break; }
          }
          if (improved || !timeLeft()) continue;
          // Swap: one seller out, another in.
          for (const out of [...chosen]) {
            const without = new Set(chosen);
            without.delete(out);
            for (const [index, seller] of helpful(assignWithin(without)).entries()) {
              if (chosen.has(seller)) continue;
              const trial = new Set(without).add(seller);
              const cents = costOf(trial).cents;
              if (cents < current) { current = cents; chosen = trial; improved = true; break; }
              if (index % 200 === 0) { await pause(); if (!timeLeft()) break; }
            }
            if (improved || !timeLeft()) break;
          }
        }
        return { chosen, cents: current };
      }

      let best = await polish(start === 'empty' ? [] : basket.parcels.map(parcel => parcel.seller));
      while (timeLeft()) {
        const shaken = [...best.chosen];
        for (let i = 0; i < shake && shaken.length; i += 1) shaken.splice(Math.floor(next() * shaken.length), 1);
        const found = await polish(shaken);
        if (found.cents < best.cents) best = found;
        await pause();
      }
      return best;
    }

    /*
     * Runs several search strategies, each for an equal share of timeMs, and keeps the cheapest
     * basket. On the 114-card list of 2026-11-20 different strategies ended a few cents apart
     * (76,04 and 76,09 EUR from 78,48 EUR), so racing them is cheap insurance.
     */
    async function optimise(basket, { timeMs = 10000, strategies = STRATEGIES, onProgress = () => {} } = {}) {
      const initialCents = total(basket.assignment) + (units.length - basket.assignment.size) * MISSING_CENTS;
      const share = timeMs / strategies.length;
      const results = [];
      let best = null;
      for (const strategy of strategies) {
        const started = Date.now();
        const found = await search(basket, strategy, started + share);
        const assignment = improve(costOf(found.chosen).assignment);
        const cents = total(assignment) + (units.length - assignment.size) * MISSING_CENTS;
        results.push({ strategy: strategy.name, cents, sellers: new Set([...assignment.values()].map(pick => pick.seller)).size, ms: Date.now() - started });
        if (!best || cents < best.cents) best = { cents, assignment, strategy: strategy.name };
        onProgress({ cents: best.cents, sellers: results.at(-1).sellers, strategy: strategy.name, done: results.length, of: strategies.length });
      }
      // Never hand back something dearer than what came in.
      const chosen = best.cents < initialCents ? describe(best.assignment) : basket;
      return Object.assign(chosen, { search: { results, winner: best.cents < initialCents ? best.strategy : 'quick basket', quickCents: initialCents } });
    }

    function revalidate(picks) {
      const assignment = new Map();
      const taken = new Map();
      for (const { unitId, seller, idArticle, idProduct } of picks) {
        const unit = unitById.get(unitId);
        const offer = sellers.get(seller)?.get(unit?.key)?.find(candidate => candidate.idArticle === idArticle && candidate.idProduct === idProduct);
        const count = (taken.get(idArticle) || 0) + 1;
        if (!offer || assignment.has(unitId) || count > offer.quantity) return null;
        taken.set(idArticle, count);
        assignment.set(unitId, { seller, offer });
      }
      const result = describe(assignment);
      return Number.isFinite(result.totalCents) ? result : null;
    }

    /*
     * Cards worth buying elsewhere: leaving a card out can save more than its price when it forces
     * a seller or a dearer parcel. Each round tries every card still in the basket (removing all its
     * copies), re-routes the rest with the clean-up step for the most promising `shortlist`, and
     * keeps the cut that saves most beyond the card's market price. Stops after maxCuts (5 % of the
     * copies by default) or when the best cut saves less than minExtraCents beyond its price.
     * On the 114-card list of 2026-11-20 three cuts saved 6,08 EUR, 2,23 EUR of it beyond the
     * cards' market value.
     */
    function recommendCuts(basket, { maxCuts = Math.max(1, Math.round(units.length * 0.05)), minExtraCents = 20, shortlist = 15 } = {}) {
      let assignment = new Map(basket.assignment);
      let current = total(assignment);
      const cuts = [];
      const marketOf = key => units.filter(unit => unit.key === key).reduce((sum, unit) => sum + (unit.targetCents ?? 0), 0);
      const without = key => new Map([...assignment].filter(([unitId]) => unitById.get(unitId).key !== key));
      for (let round = 0; round < maxCuts; round += 1) {
        const keys = [...new Set([...assignment.keys()].map(unitId => unitById.get(unitId).key))];
        const promising = keys.map(key => ({ key, extra: current - total(without(key)) - marketOf(key) }))
          .sort((a, b) => b.extra - a.extra).slice(0, shortlist);
        let best = null;
        for (const { key } of promising) {
          const rest = improve(without(key));
          const cents = total(rest);
          const extra = current - cents - marketOf(key);
          if (!best || extra > best.extra) best = { key, rest, cents, extra };
        }
        if (!best || best.extra < minExtraCents) break;
        const name = units.find(unit => unit.key === best.key).name;
        cuts.push({ key: best.key, name, marketCents: marketOf(best.key), savedCents: current - best.cents, extraCents: best.extra, basketCents: best.cents });
        assignment = best.rest;
        current = best.cents;
      }
      return cuts;
    }

    return { basket: () => describe(improve(rank())), optimise, revalidate, recommendCuts, topUp, apply, overlap };
  }

  root.CardmarketWizard = { createPlanner, parseShippingTable, shipping, weightOf, STRATEGIES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
