/*
 * Builds a basket from collected offers.
 *
 * 1. Seller ranking: repeatedly pick the seller whose cheapest set of still-open items costs the
 *    least above market per item, counting that seller's shipping (per country, tracked-only, and
 *    non-card product shipping rates).
 * 2. Clean-up: move each item to the cheapest seller already in the basket, and drop sellers
 *    whose items are cheaper elsewhere once shipping is counted.
 * 3. Coverage: sellers in order of their cost above market per item, with running totals, so
 *    "the first N sellers get X items for Y" can be read off.
 * 4. Top-up: offers the chosen sellers have above the cutoff can be priced as moves into the basket.
 * 5. Scoped price limits: leave out cards above a limit for all cards, a single game, or a
 *    specific Wants List, then recompute the whole combined basket from the cached offers.
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
      isLetter: method.isLetter !== false,
    }));
  }

  // Cardmarket: a 20 g letter holds 4 cards, 50 g holds 17, 100 g holds 40.
  const weightOf = cards => (cards <= 0 ? 0 : cards <= 4 ? 20 : cards <= 17 ? 50 : cards <= 40 ? 100 : Math.ceil(cards * 2.5));

  function shippingByWeight(table, weightGrams, valueCents) {
    let best = null;
    for (const method of table) {
      if (method.maxWeight >= weightGrams && method.maxValueCents >= valueCents &&
          (!best || method.priceCents < best.priceCents)) best = method;
    }
    return best;
  }

  function shipping(table, cards, valueCents) {
    return shippingByWeight(table, weightOf(cards), valueCents);
  }

  // Shipping for a mixed parcel (cards and/or non-card products like sleeves or deck boxes).
  // Non-card offers carry `offer.shippingCents` read directly from their Cardmarket product page
  // (which includes commercial sellers' Personal Shipping Methods, e.g. 1,48 EUR instead of 3,40 EUR).
  function parcelShipping(table, items, valueCents) {
    if (!table || !table.length) return null;
    let cards = 0;
    let products = 0;
    let productFloorCents = null;
    for (const item of items) {
      if (item.unit?.kind === 'product' || item.kind === 'product') {
        products += 1;
        const quote = item.offer?.shippingCents;
        if (typeof quote === 'number' && quote >= 0) {
          productFloorCents = productFloorCents === null ? quote : Math.max(productFloorCents, quote);
        }
      } else {
        cards += 1;
      }
    }
    if (products === 0) return shipping(table, cards, valueCents);

    const cardWeight = weightOf(cards);
    // If no per-offer shipping quote was read, assume Maxibrief/parcel (~600 g per product).
    if (productFloorCents === null) {
      return shippingByWeight(table, cardWeight + products * 600, valueCents);
    }

    // Check what standard shipping method is required by total order value and combined weight.
    const extraWeight = products > 1 ? products * 250 : 0;
    const baseMethod = shippingByWeight(table, Math.max(20, cardWeight + extraWeight), valueCents);
    if (!baseMethod) return null;

    // If order value (or a tracked-only table) requires tracked shipping, price a tracked method
    // that can actually hold a non-card product (at least 500 g).
    if (baseMethod.tracked) {
      const trackedForProduct = shippingByWeight(table, Math.max(500, cardWeight + products * 250), valueCents) || baseMethod;
      if (trackedForProduct.priceCents >= productFloorCents) return trackedForProduct;
    }

    if (productFloorCents >= baseMethod.priceCents) {
      const matched = table.find(m => m.priceCents === productFloorCents && m.maxValueCents >= valueCents);
      return matched || {
        name: 'Product shipping',
        tracked: baseMethod.tracked,
        maxWeight: Math.max(1000, baseMethod.maxWeight),
        maxValueCents: Math.max(valueCents, baseMethod.maxValueCents),
        priceCents: productFloorCents,
      };
    }
    return baseMethod;
  }

  // Scoped price limits:
  // scope: { type: 'all' } | { type: 'game', game: 'Magic'|'YuGiOh' } | { type: 'list', game, listId, label? }
  function scopeKey(scope) {
    if (!scope || scope.type === 'all') return 'all';
    if (scope.type === 'game') return `game:${scope.game}`;
    return `list:${scope.game || 'Magic'}:${scope.listId}`;
  }

  function matchesScope(result, scope) {
    if (result.kind === 'product') return false;
    if (!scope || scope.type === 'all') return true;
    const game = result.game || 'Magic';
    if (scope.type === 'game') return game === scope.game;
    if (scope.type === 'list') return game === (scope.game || 'Magic') && String(result.listId ?? '') === String(scope.listId ?? '');
    return false;
  }

  // Specificity: list (3) > game (2) > all (1). Allows e.g. "All <= 3 EUR, except YGO: no limit"
  // or "YGO only <= 2 EUR" while keeping Magic untouched.
  function effectiveLimitRule(result, rules = []) {
    if (result.kind === 'product' || !rules.length) return null;
    const rank = { all: 1, game: 2, list: 3 };
    let winner = null;
    for (const rule of rules) {
      if (!matchesScope(result, rule)) continue;
      if (!winner || (rank[rule.type] || 0) > (rank[winner.type] || 0)) winner = rule;
    }
    return winner;
  }

  function filterByLimits(results, rules = [], manualCuts = []) {
    const manual = new Set(manualCuts);
    const kept = [];
    const leftOut = [];
    const countsByScope = new Map();
    for (const result of results) {
      if (manual.has(result.key)) {
        leftOut.push({ ...result, cutReason: 'manual', cutRule: null });
        continue;
      }
      const rule = effectiveLimitRule(result, rules);
      if (rule && rule.cents !== null && Number.isFinite(rule.cents) &&
          result.targetCents !== null && result.targetCents > rule.cents) {
        const key = scopeKey(rule);
        countsByScope.set(key, (countsByScope.get(key) || 0) + (result.amount || 1));
        leftOut.push({ ...result, cutReason: 'limit', cutRule: rule });
        continue;
      }
      kept.push(result);
    }
    return { kept, leftOut, countsByScope };
  }

  // One unit is one wanted copy; a card wanted twice is two units.
  function unitsOf(collection) {
    const units = [];
    for (const result of collection.results) {
      for (let copy = 0; copy < result.amount; copy += 1) {
        units.push({
          id: `${result.key}#${copy}`, key: result.key, name: result.name,
          targetCents: result.targetCents, verdict: result.verdict,
          kind: result.kind || 'card', game: result.game || 'Magic',
          listId: result.listId ?? null, listName: result.listName ?? null,
        });
      }
    }
    return units;
  }

  function offersBySeller(collection) {
    const sellers = new Map();
    const sellerLocations = new Map();
    for (const result of collection.results) {
      for (const offer of result.offers) {
        if (!sellers.has(offer.seller)) sellers.set(offer.seller, new Map());
        if (offer.location && !sellerLocations.has(offer.seller)) sellerLocations.set(offer.seller, offer.location);
        const byKey = sellers.get(offer.seller);
        if (!byKey.has(result.key)) byKey.set(result.key, []);
        byKey.get(result.key).push(offer);
      }
    }
    for (const byKey of sellers.values()) for (const list of byKey.values()) list.sort((a, b) => a.priceCents - b.priceCents);
    return { sellers, sellerLocations };
  }

  // Normalises either a single shipping table (Method[]) or a per-country table map
  // ({ default?: Method[], byLocation?: { [name]: Method[] } } or { [name]: Method[] }).
  function normaliseTables(tableOrMap) {
    if (Array.isArray(tableOrMap)) return { defaultTable: tableOrMap, byLocation: {} };
    if (tableOrMap && typeof tableOrMap === 'object') {
      const byLocation = tableOrMap.byLocation || tableOrMap;
      const defaultTable = tableOrMap.default || Object.values(byLocation).find(Array.isArray) || [];
      return { defaultTable, byLocation };
    }
    return { defaultTable: [], byLocation: {} };
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
  function createPlanner(collection, tableOrMap, { trackedOnly = [] } = {}) {
    const { defaultTable, byLocation } = normaliseTables(tableOrMap);
    const trackedSellers = new Set(trackedOnly);
    const trackedCache = new WeakMap();
    const onlyTracked = table => {
      if (!trackedCache.has(table)) trackedCache.set(table, table.filter(method => method.tracked));
      return trackedCache.get(table);
    };

    const units = unitsOf(collection);
    const { sellers, sellerLocations } = offersBySeller(collection);
    const unitById = new Map(units.map(unit => [unit.id, unit]));

    const tableFor = seller => {
      const location = sellerLocations.get(seller);
      const base = (location && byLocation[location]) || defaultTable;
      return trackedSellers.has(seller) ? onlyTracked(base) : base;
    };

    // assignment: unit id -> { seller, offer }
    function parcels(assignment) {
      const bySeller = new Map();
      for (const [unitId, pick] of assignment) {
        if (!bySeller.has(pick.seller)) bySeller.set(pick.seller, []);
        bySeller.get(pick.seller).push({ unit: unitById.get(unitId), offer: pick.offer });
      }
      return [...bySeller].map(([seller, items]) => {
        const itemsCents = items.reduce((sum, item) => sum + item.offer.priceCents, 0);
        const method = parcelShipping(tableFor(seller), items, itemsCents);
        return {
          seller, location: sellerLocations.get(seller) || null,
          items, itemsCents, method, shippingCents: method ? method.priceCents : Infinity,
        };
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
            picks.push({ unitId, unit, offer, extra: offer.priceCents - (unit.targetCents ?? offer.priceCents) });
          }
          picks.sort((a, b) => a.extra - b.extra);
          let extra = 0;
          let value = 0;
          const sellerTable = tableFor(seller);
          const prefix = [];
          picks.forEach((pick, index) => {
            extra += pick.extra;
            value += pick.offer.priceCents;
            prefix.push(pick);
            const method = parcelShipping(sellerTable, prefix, value);
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

    // Moves single items between chosen sellers and drops sellers while the total goes down.
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
        const extraCents = parcel.items.reduce((sum, item) => sum + item.offer.priceCents - (item.unit.targetCents ?? item.offer.priceCents), 0) + parcel.shippingCents;
        const games = [...new Set(parcel.items.map(item => item.unit.game).filter(Boolean))];
        const hasProducts = parcel.items.some(item => item.unit.kind === 'product');
        return {
          seller: parcel.seller, location: parcel.location, games, hasProducts,
          itemsCents: parcel.itemsCents, shippingCents: parcel.shippingCents,
          method: parcel.method?.name ?? null, extraPerCardCents: Math.round(extraCents / parcel.items.length),
          items: parcel.items.map(({ unit, offer }) => ({
            key: unit.key, name: unit.name, kind: unit.kind, game: unit.game,
            listId: unit.listId, listName: unit.listName,
            idArticle: offer.idArticle, idProduct: offer.idProduct, foil: !!offer.foil,
            priceCents: offer.priceCents, targetCents: unit.targetCents,
            aboveMarket: unit.targetCents !== null && offer.priceCents > unit.targetCents,
            offerShippingCents: offer.shippingCents ?? null,
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
          key: unit.key, name: unit.name, kind: unit.kind, game: unit.game, listId: unit.listId, listName: unit.listName,
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
            aboveMarket: unit.targetCents !== null && offer.priceCents > unit.targetCents, replaces: current ? current.seller : null,
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

    // Sellers with the most wanted items up to the cutoff, and how many of those at or below target.
    function overlap(limit = 15) {
      return [...sellers].map(([seller, byKey]) => {
        let atTarget = 0;
        let cheapestCents = 0;
        const games = new Set();
        for (const [key, list] of byKey) {
          const result = collection.results.find(candidate => candidate.key === key);
          if (result.game) games.add(result.game);
          if (result.targetCents !== null && list[0].priceCents <= result.targetCents) atTarget += 1;
          cheapestCents += list[0].priceCents;
        }
        const row = { seller, cards: byKey.size, atTarget, cheapestCents };
        const loc = sellerLocations.get(seller);
        if (loc) row.location = loc;
        if (games.size) row.games = [...games];
        return row;
      }).sort((a, b) => b.cards - a.cards || b.atTarget - a.atTarget || a.cheapestCents - b.cheapestCents).slice(0, limit);
    }

    // Each item from the cheapest copy among the given sellers, in wanted-list order.
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

    // An item nobody among the chosen sellers has counts as very expensive, so a seller set that
    // leaves items out never wins.
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

    async function search(basket, { seed = 1, shake = 3, breadth = 150, start = 'basket' }, deadline, isCancelled = () => false) {
      const next = random(seed);
      const candidates = [...sellers.keys()];
      const timeLeft = () => !isCancelled() && Date.now() < deadline;

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

    async function optimise(basket, { timeMs = 10000, strategies = STRATEGIES, onProgress = () => {}, isCancelled = () => false } = {}) {
      const initialCents = total(basket.assignment) + (units.length - basket.assignment.size) * MISSING_CENTS;
      const share = timeMs / strategies.length;
      const results = [];
      let best = null;
      for (const strategy of strategies) {
        if (isCancelled()) break;
        const started = Date.now();
        const found = await search(basket, strategy, started + share, isCancelled);
        if (isCancelled()) break;
        const assignment = improve(costOf(found.chosen).assignment);
        const cents = total(assignment) + (units.length - assignment.size) * MISSING_CENTS;
        results.push({ strategy: strategy.name, cents, sellers: new Set([...assignment.values()].map(pick => pick.seller)).size, ms: Date.now() - started });
        if (!best || cents < best.cents) best = { cents, assignment, strategy: strategy.name };
        onProgress({ cents: best.cents, sellers: results.at(-1).sellers, strategy: strategy.name, done: results.length, of: strategies.length });
      }
      // Superseded jobs stop early with nothing better than what came in.
      if (!best) return Object.assign(basket, { search: { results, winner: 'quick basket', quickCents: initialCents } });
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
        const unit = units.find(candidate => candidate.key === best.key);
        cuts.push({
          key: best.key, name: unit.name, game: unit.game, listName: unit.listName, kind: unit.kind,
          marketCents: marketOf(best.key), savedCents: current - best.cents, extraCents: best.extra, basketCents: best.cents,
        });
        assignment = best.rest;
        current = best.cents;
      }
      return cuts;
    }

    return { basket: () => describe(improve(rank())), optimise, revalidate, recommendCuts, topUp, apply, overlap };
  }

  root.CardmarketWizard = {
    createPlanner, parseShippingTable, shipping, shippingByWeight, parcelShipping, weightOf,
    scopeKey, matchesScope, effectiveLimitRule, filterByLimits, STRATEGIES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
