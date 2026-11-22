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

  function previewLimitLeftOut(results, activeLimits = [], manualCuts = [], scope = { type: 'all' }, cents) {
    if (!Array.isArray(results) || !Number.isFinite(cents) || cents <= 0) {
      return { items: [], totalCopies: 0, totalMarketCents: 0, scopedEligibleCount: 0 };
    }
    const targetScopeKey = scopeKey(scope);
    const baseRules = (activeLimits || []).filter(r => scopeKey(r) !== targetScopeKey);
    const candidateRule = { ...scope, cents };
    const trialRules = [...baseRules, candidateRule];
    const manual = new Set(manualCuts || []);

    let scopedEligibleCount = 0;
    for (const result of results) {
      if (result.kind === 'product' || manual.has(result.key)) continue;
      const winner = effectiveLimitRule(result, trialRules);
      if (winner && scopeKey(winner) === targetScopeKey) scopedEligibleCount += 1;
    }

    const { leftOut } = filterByLimits(results, trialRules, manualCuts);
    const items = leftOut
      .filter(r => r.cutReason === 'limit' && r.cutRule && scopeKey(r.cutRule) === targetScopeKey)
      .map(r => {
        const amount = r.amount || 1;
        const targetCents = r.targetCents;
        const totalMarketCents = Number.isFinite(targetCents) ? targetCents * amount : null;
        let cheapestOfferCents = null;
        if (Array.isArray(r.offers) && r.offers.length) {
          for (const offer of r.offers) {
            if (Number.isFinite(offer?.priceCents) && (cheapestOfferCents === null || offer.priceCents < cheapestOfferCents)) {
              cheapestOfferCents = offer.priceCents;
            }
          }
        }
        return {
          key: r.key,
          name: r.name,
          game: r.game || 'Magic',
          listId: r.listId ?? null,
          listName: r.listName ?? null,
          amount,
          targetCents,
          totalMarketCents,
          cheapestOfferCents,
        };
      })
      .sort((a, b) =>
        (b.targetCents ?? -1) - (a.targetCents ?? -1) ||
        (b.totalMarketCents ?? -1) - (a.totalMarketCents ?? -1) ||
        String(a.name || '').localeCompare(String(b.name || ''))
      );

    const totalCopies = items.reduce((sum, item) => sum + item.amount, 0);
    const totalMarketCents = items.reduce((sum, item) => sum + (item.totalMarketCents ?? 0), 0);
    return { items, totalCopies, totalMarketCents, scopedEligibleCount };
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
    if (Array.isArray(tableOrMap)) return { defaultTable: tableOrMap, defaultLocation: null, byLocation: {} };
    if (tableOrMap && typeof tableOrMap === 'object') {
      const byLocation = tableOrMap.byLocation || tableOrMap;
      const defaultTable = tableOrMap.default || Object.values(byLocation).find(Array.isArray) || [];
      const defaultLocation = typeof tableOrMap.defaultLocation === 'string' ? tableOrMap.defaultLocation : null;
      return { defaultTable, defaultLocation, byLocation };
    }
    return { defaultTable: [], defaultLocation: null, byLocation: {} };
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
    const { defaultTable, defaultLocation, byLocation } = normaliseTables(tableOrMap);
    const trackedSellers = new Set(trackedOnly);
    const trackedCache = new WeakMap();
    const onlyTracked = table => {
      if (!trackedCache.has(table)) trackedCache.set(table, table.filter(method => method.tracked));
      return trackedCache.get(table);
    };

    const units = unitsOf(collection);
    const { sellers, sellerLocations } = offersBySeller(collection);
    const unitById = new Map(units.map(unit => [unit.id, unit]));

    const uniqueLocations = [...new Set([...sellerLocations.values()].filter(Boolean))];
    const hasMultipleLocations = uniqueLocations.length > 1;
    let domesticLocation = defaultLocation && uniqueLocations.includes(defaultLocation) ? defaultLocation : null;
    if (!domesticLocation && hasMultipleLocations) {
      let bestCost = Infinity;
      let bestTracked = Infinity;
      for (const loc of uniqueLocations) {
        const tbl = byLocation[loc];
        if (!Array.isArray(tbl) || !tbl.length) continue;
        const small = shipping(tbl, 1, 100)?.priceCents ?? Infinity;
        const tracked = shipping(tbl, 15, 3000)?.priceCents ?? Infinity;
        if (small < bestCost || (small === bestCost && tracked < bestTracked)) {
          bestCost = small;
          bestTracked = tracked;
          domesticLocation = loc;
        }
      }
    }

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

    function rank(allowedSellers = null) {
      const assignment = new Map();
      const assignedBySeller = new Map();
      const open = new Set(units.map(unit => unit.id));
      for (;;) {
        let best = null;
        const taken = used(assignment);
        for (const [seller, byKey] of sellers) {
          if (allowedSellers && !allowedSellers.has(seller)) continue;
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
          if (!picks.length) continue;
          picks.sort((a, b) => a.extra - b.extra);
          const existing = assignedBySeller.get(seller);
          const baseItems = existing ? existing.items : [];
          const baseValue = existing ? existing.value : 0;
          const baseShip = existing ? existing.ship : 0;
          let extra = 0;
          let value = 0;
          const sellerTable = tableFor(seller);
          const combined = baseItems.slice();
          picks.forEach((pick, index) => {
            extra += pick.extra;
            value += pick.offer.priceCents;
            combined.push(pick);
            const method = parcelShipping(sellerTable, combined, baseValue + value);
            if (!method) return;
            const marginalShip = method.priceCents - baseShip;
            const perCard = (extra + marginalShip) / (index + 1);
            if (!best || perCard < best.perCard) {
              best = {
                seller, perCard, picks: picks.slice(0, index + 1),
                newValue: baseValue + value, newShip: method.priceCents,
              };
            }
          });
        }
        if (!best) break;
        const prev = assignedBySeller.get(best.seller);
        const items = prev ? prev.items.concat(best.picks) : best.picks.slice();
        assignedBySeller.set(best.seller, { items, value: best.newValue, ship: best.newShip });
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

    // When a mixed seller set pushes an international/heavy parcel across a sharp shipping cliff
    // (e.g. >25 EUR tracked ES/IT/PL or 5+ cards NL), assignWithin's raw-price greedy rule never
    // offloads items to a slightly dearer domestic seller. This fast check only activates when a
    // parcel pays >= 5,00 EUR shipping, so low-shipping domestic runs pay zero overhead.
    function relieveCliffs(assignment, chosen) {
      const list = parcels(assignment);
      let currentCost = list.reduce((sum, parcel) => sum + parcel.itemsCents + parcel.shippingCents, 0);
      if (chosen.size <= 1) return { assignment, cost: currentCost };
      const expensive = list.filter(parcel => parcel.shippingCents >= 500).sort((a, b) => b.shippingCents - a.shippingCents);
      if (!expensive.length) return { assignment, cost: currentCost };

      let current = assignment;
      const others = [...chosen];
      for (const parcel of expensive) {
        const movables = [];
        const baseTaken = used(current);
        for (const [unitId, pick] of current) {
          if (pick.seller !== parcel.seller) continue;
          const unit = unitById.get(unitId);
          let bestAlt = null;
          for (const altSeller of others) {
            if (altSeller === parcel.seller) continue;
            const offer = cheapestCopy(altSeller, unit.key, baseTaken);
            if (offer && (!bestAlt || offer.priceCents < bestAlt.offer.priceCents)) bestAlt = { seller: altSeller, offer };
          }
          if (bestAlt) movables.push({ unitId, premium: bestAlt.offer.priceCents - pick.offer.priceCents });
        }
        if (!movables.length) continue;
        movables.sort((a, b) => a.premium - b.premium);
        const trial = new Map(current);
        let bestTrial = null;
        let bestCost = currentCost;
        const limit = Math.min(movables.length, 8);
        for (let i = 0; i < limit; i += 1) {
          const { unitId } = movables[i];
          const unit = unitById.get(unitId);
          const taken = used(trial, unitId);
          let alt = null;
          for (const altSeller of others) {
            if (altSeller === parcel.seller) continue;
            const offer = cheapestCopy(altSeller, unit.key, taken);
            if (offer && (!alt || offer.priceCents < alt.offer.priceCents)) alt = { seller: altSeller, offer };
          }
          if (!alt) continue;
          trial.set(unitId, alt);
          const trialCost = total(trial);
          if (trialCost < bestCost) {
            bestCost = trialCost;
            bestTrial = new Map(trial);
          }
        }
        if (bestTrial) {
          current = bestTrial;
          currentCost = bestCost;
        }
      }
      return { assignment: current, cost: currentCost };
    }

    // An item nobody among the chosen sellers has counts as very expensive, so a seller set that
    // leaves items out never wins.
    const MISSING_CENTS = 100000;
    const costOf = chosen => {
      const { assignment, cost } = relieveCliffs(assignWithin(chosen), chosen);
      return { assignment, cents: cost + (units.length - assignment.size) * MISSING_CENTS };
    };

    function domesticBaselineAssignment() {
      if (!hasMultipleLocations || !domesticLocation) return null;
      const domSellers = new Set([...sellers.keys()].filter(s => sellerLocations.get(s) === domesticLocation));
      if (!domSellers.size) return null;
      return improve(rank(domSellers));
    }

    function quickAssignment() {
      const all = improve(rank());
      const dom = domesticBaselineAssignment();
      if (dom && (dom.size > all.size || (dom.size === all.size && total(dom) < total(all)))) return dom;
      return all;
    }

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

    async function search(basket, { seed = 1, shake = 3, breadth = 150, start = 'basket', startSellers = null }, deadline, isCancelled = () => false) {
      const next = random(seed);
      const candidates = [...sellers.keys()];
      const timeLeft = () => !isCancelled() && Date.now() < deadline;

      function helpful(assignment) {
        const rawPaid = new Map();
        const landedPaid = new Map();
        const shipShareBySeller = new Map();
        for (const parcel of parcels(assignment)) {
          shipShareBySeller.set(parcel.seller, parcel.items.length ? parcel.shippingCents / parcel.items.length : 0);
        }
        for (const unit of units) {
          const pick = assignment.get(unit.id);
          const raw = pick ? pick.offer.priceCents : MISSING_CENTS;
          const landed = pick ? raw + (shipShareBySeller.get(pick.seller) || 0) : MISSING_CENTS;
          rawPaid.set(unit.key, Math.max(rawPaid.get(unit.key) ?? 0, raw));
          landedPaid.set(unit.key, Math.max(landedPaid.get(unit.key) ?? 0, landed));
        }
        const scored = [];
        for (const seller of candidates) {
          let rawSaving = 0;
          let landedGross = 0;
          let matchedCount = 0;
          let matchedValue = 0;
          for (const [key, list] of sellers.get(seller)) {
            const p = list[0].priceCents;
            if (rawPaid.has(key) && p < rawPaid.get(key)) rawSaving += rawPaid.get(key) - p;
            if (landedPaid.has(key) && p < landedPaid.get(key)) {
              landedGross += landedPaid.get(key) - p;
              matchedCount += 1;
              matchedValue += p;
            }
          }
          let netLanded = 0;
          if (matchedCount > 0) {
            const candShip = shipping(tableFor(seller), matchedCount, matchedValue)?.priceCents ?? Infinity;
            if (Number.isFinite(candShip) && landedGross > candShip) netLanded = landedGross - candShip;
          }
          const score = netLanded + rawSaving;
          if (score > 0) scored.push([score, seller]);
        }
        return scored.sort((a, b) => b[0] - a[0]).slice(0, breadth).map(([, seller]) => seller);
      }

      async function polish(from) {
        let chosen = new Set(from);
        let currentState = costOf(chosen);
        let current = currentState.cents;
        for (let improved = true; improved && timeLeft();) {
          improved = false;
          for (const seller of [...chosen]) {
            const trial = new Set(chosen);
            trial.delete(seller);
            const state = costOf(trial);
            if (state.cents < current) { current = state.cents; currentState = state; chosen = trial; improved = true; }
          }
          for (const [index, seller] of helpful(currentState.assignment).entries()) {
            if (chosen.has(seller)) continue;
            const trial = new Set(chosen).add(seller);
            const state = costOf(trial);
            if (state.cents < current) { current = state.cents; currentState = state; chosen = trial; improved = true; }
            if (index % 200 === 0) { await pause(); if (!timeLeft()) break; }
          }
          if (improved || !timeLeft()) continue;
          // Swap: one seller out, another in.
          for (const out of [...chosen]) {
            const without = new Set(chosen);
            without.delete(out);
            const withoutState = costOf(without);
            for (const [index, seller] of helpful(withoutState.assignment).entries()) {
              if (chosen.has(seller)) continue;
              const trial = new Set(without).add(seller);
              const state = costOf(trial);
              if (state.cents < current) { current = state.cents; currentState = state; chosen = trial; improved = true; break; }
              if (index % 200 === 0) { await pause(); if (!timeLeft()) break; }
            }
            if (improved || !timeLeft()) break;
          }
        }
        return { chosen, cents: current };
      }

      const initialSellers = Array.isArray(startSellers)
        ? startSellers
        : start === 'empty'
          ? []
          : basket.parcels.map(parcel => parcel.seller);
      let best = await polish(initialSellers);
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
      const runStrategies = [...strategies];
      const domBaseline = strategies === STRATEGIES ? domesticBaselineAssignment() : null;
      if (domBaseline && domBaseline.size >= basket.assignment.size) {
        const domSellers = [...new Set([...domBaseline.values()].map(pick => pick.seller))];
        runStrategies.push({ name: 'domestic first', seed: 5, shake: 3, breadth: 150, startSellers: domSellers });
      }
      const share = timeMs / runStrategies.length;
      const results = [];
      let best = null;
      if (domBaseline && domBaseline.size >= basket.assignment.size) {
        const domCents = total(domBaseline) + (units.length - domBaseline.size) * MISSING_CENTS;
        if (domCents < initialCents) best = { cents: domCents, assignment: domBaseline, strategy: 'domestic baseline' };
      }
      for (const strategy of runStrategies) {
        if (isCancelled()) break;
        const started = Date.now();
        const found = await search(basket, strategy, started + share, isCancelled);
        if (isCancelled()) break;
        const assignment = improve(costOf(found.chosen).assignment);
        const cents = total(assignment) + (units.length - assignment.size) * MISSING_CENTS;
        results.push({ strategy: strategy.name, cents, sellers: new Set([...assignment.values()].map(pick => pick.seller)).size, ms: Date.now() - started });
        if (!best || cents < best.cents) best = { cents, assignment, strategy: strategy.name };
        onProgress({ cents: best.cents, sellers: results.at(-1).sellers, strategy: strategy.name, done: results.length, of: runStrategies.length });
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

    return { basket: () => describe(quickAssignment()), optimise, revalidate, recommendCuts, topUp, apply, overlap };
  }

  function allocateIntegerCents(totalCents, weightedItems) {
    const out = new Map();
    if (!weightedItems.length) return out;
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      for (const w of weightedItems) out.set(w.key, 0);
      return out;
    }
    const weightSum = weightedItems.reduce((s, w) => s + (w.weight > 0 ? w.weight : 0), 0);
    const effective = weightSum > 0
      ? weightedItems
      : weightedItems.map(w => ({ ...w, weight: 1 }));
    const denom = effective.reduce((s, w) => s + w.weight, 0);

    const parts = effective.map(w => {
      const exact = (totalCents * w.weight) / denom;
      const floor = Math.floor(exact);
      return { key: w.key, weight: w.weight, floor, rem: exact - floor };
    });
    let remainder = totalCents - parts.reduce((s, p) => s + p.floor, 0);
    parts.sort((a, b) => b.rem - a.rem || b.weight - a.weight || a.key.localeCompare(b.key));
    for (let i = 0; i < parts.length; i += 1) {
      out.set(parts[i].key, parts[i].floor + (i < remainder ? 1 : 0));
    }
    return out;
  }

  function sourceMetaForItem(item) {
    const kind = item.kind || 'card';
    const game = item.game || 'Magic';
    if (kind === 'product') {
      const id = item.key || (item.idProduct != null ? String(item.idProduct) : item.name || 'product');
      return {
        key: `product:${id}`,
        kind: 'product',
        game,
        listId: null,
        listName: null,
        label: item.name || 'Extra Product',
      };
    }
    if (kind === 'token') {
      const deck = item.listName || 'Default';
      return {
        key: `token:${deck}`,
        kind: 'token',
        game: 'Magic',
        listId: item.listId ?? `token:${deck}`,
        listName: deck,
        label: deck !== 'Default' ? `Tokens: ${deck}` : 'Magic Tokens',
      };
    }
    const gameText = game === 'YuGiOh' ? 'Yu-Gi-Oh!' : 'Magic';
    const hasListId = item.listId != null && item.listId !== '';
    const key = hasListId
      ? `list:${game}:${item.listId}`
      : item.listName
        ? `name:${game}:${item.listName}`
        : `game:${game}`;
    const label = item.listName || (hasListId ? `${gameText} Wants #${item.listId}` : gameText);
    return {
      key,
      kind: 'card',
      game,
      listId: hasListId ? String(item.listId) : null,
      listName: item.listName || null,
      label,
    };
  }

  // Summarizes items cost, allocated shipping share, and total per Wants List, per Extra Product,
  // and per Token deck. Dedicated parcels attribute 100% of shipping to their single source; shared
  // parcels split shipping proportionally (by card count for card-only parcels, or by standalone
  // shipping weight when products and cards share a parcel) with exact-cent largest-remainder rounding.
  function summarizeBasketBySource(parcels, { tables = null, trackedOnly = [], missing = [], leftOut = [] } = {}) {
    const { defaultTable, byLocation } = tables ? normaliseTables(tables) : { defaultTable: null, byLocation: {} };
    const trackedSet = new Set(trackedOnly || []);
    const tableForParcel = parcel => {
      if (!defaultTable) return null;
      const base = (parcel.location && byLocation[parcel.location]) || defaultTable;
      return trackedSet.has(parcel.seller) ? base.filter(m => m.tracked) : base;
    };

    const groups = new Map();
    const ensureGroup = meta => {
      let g = groups.get(meta.key);
      if (!g) {
        g = {
          ...meta,
          itemCount: 0,
          missingCount: 0,
          leftOutCount: 0,
          itemsCents: 0,
          shippingCents: 0,
          sellers: new Set(),
          sharedSellers: new Set(),
          unknownShipping: false,
        };
        groups.set(meta.key, g);
      }
      return g;
    };

    let hasSharedParcels = false;
    let totalShippingCents = 0;
    let totalItemsCents = 0;
    let totalItemCount = 0;

    for (const parcel of parcels || []) {
      const items = parcel.items || [];
      if (!items.length) continue;

      const bySource = new Map();
      let parcelHasProduct = false;
      for (const item of items) {
        const meta = sourceMetaForItem(item);
        const g = ensureGroup(meta);
        const price = Number.isFinite(item.priceCents) ? item.priceCents : 0;
        g.itemCount += 1;
        g.itemsCents += price;
        g.sellers.add(parcel.seller);
        totalItemCount += 1;
        totalItemsCents += price;
        if (meta.kind === 'product') parcelHasProduct = true;

        let local = bySource.get(meta.key);
        if (!local) {
          local = { key: meta.key, kind: meta.kind, count: 0, itemsCents: 0, rawItems: [] };
          bySource.set(meta.key, local);
        }
        local.count += 1;
        local.itemsCents += price;
        local.rawItems.push(item);
      }

      const ship = Number.isFinite(parcel.shippingCents) ? parcel.shippingCents : 0;
      const finiteShip = Number.isFinite(parcel.shippingCents);
      if (finiteShip) totalShippingCents += ship;

      const sourceList = [...bySource.values()];
      if (sourceList.length === 1) {
        const g = groups.get(sourceList[0].key);
        if (finiteShip) g.shippingCents += ship;
        else g.unknownShipping = true;
      } else {
        hasSharedParcels = true;
        const parcelTable = tableForParcel(parcel);
        const weighted = sourceList.map(local => {
          let weight = local.count;
          if (parcelHasProduct) {
            if (parcelTable && parcelTable.length) {
              const simItems = local.rawItems.map(it => ({
                kind: it.kind || 'card',
                offer: { shippingCents: it.offerShippingCents ?? null },
              }));
              const standalone = parcelShipping(parcelTable, simItems, local.itemsCents);
              if (standalone && Number.isFinite(standalone.priceCents) && standalone.priceCents > 0) {
                weight = standalone.priceCents;
              }
            }
            if (weight === local.count) {
              if (local.kind === 'product') {
                const quotes = local.rawItems.map(it => it.offerShippingCents).filter(v => typeof v === 'number' && v > 0);
                weight = quotes.length ? Math.max(...quotes) : 350;
              } else {
                weight = local.count <= 4 ? 125 : local.count <= 17 ? 225 : 450;
              }
            }
          }
          return { key: local.key, weight };
        });

        const alloc = finiteShip ? allocateIntegerCents(ship, weighted) : null;
        for (const local of sourceList) {
          const g = groups.get(local.key);
          g.sharedSellers.add(parcel.seller);
          if (alloc) g.shippingCents += alloc.get(local.key) || 0;
          else g.unknownShipping = true;
        }
      }
    }

    for (const item of missing || []) {
      const meta = sourceMetaForItem(item);
      const g = groups.get(meta.key);
      if (g) g.missingCount += 1;
    }
    for (const item of leftOut || []) {
      const meta = sourceMetaForItem(item);
      const g = groups.get(meta.key);
      if (g) g.leftOutCount += item.amount || 1;
    }

    const list = [...groups.values()];
    const labelCounts = new Map();
    for (const g of list) labelCounts.set(g.label, (labelCounts.get(g.label) || 0) + 1);

    const grandTotalCents = totalItemsCents + totalShippingCents;
    const kindOrder = { card: 0, product: 1, token: 2 };
    const rows = list.map(g => {
      const totalCents = g.itemsCents + g.shippingCents;
      const label = labelCounts.get(g.label) > 1 && g.listId != null ? `${g.label} (#${g.listId})` : g.label;
      return {
        key: g.key,
        kind: g.kind,
        game: g.game,
        listId: g.listId,
        listName: g.listName,
        label,
        itemCount: g.itemCount,
        missingCount: g.missingCount,
        leftOutCount: g.leftOutCount,
        sellerCount: g.sellers.size,
        sharedSellerCount: g.sharedSellers.size,
        itemsCents: g.itemsCents,
        shippingCents: g.shippingCents,
        totalCents,
        sharePct: grandTotalCents > 0 ? Math.round((totalCents / grandTotalCents) * 100) : 0,
        unknownShipping: g.unknownShipping,
      };
    }).sort((a, b) =>
      (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)
      || b.totalCents - a.totalCents
      || a.label.localeCompare(b.label)
    );

    return {
      rows,
      totals: {
        itemCount: totalItemCount,
        itemsCents: totalItemsCents,
        shippingCents: totalShippingCents,
        totalCents: grandTotalCents,
        sellerCount: (parcels || []).length,
        hasSharedParcels,
      },
    };
  }

  function basketItemSignature(seller, item) {
    return `${seller || ""}|${item?.kind || "card"}|${item?.key || ""}|${item?.idArticle ?? ""}|${item?.idProduct ?? ""}|${item?.listId ?? ""}|${item?.foil ? 1 : 0}`;
  }

  // Non-destructively removes individual items or entire sellers from an already-computed basket
  // WITHOUT recomputing or reassigning cards to other sellers. Remaining sellers keep their exact
  // order and items; only affected parcels recalculate their itemsCents and shipping tier.
  function applyBasketRemovals(basket, removedItems, { tables = null, trackedOnly = [] } = {}) {
    if (!basket || !Array.isArray(removedItems) || !removedItems.length) return basket;

    const dropCount = new Map();
    for (const rec of removedItems) {
      const sig = rec?.sig || (rec?.item ? basketItemSignature(rec.seller, rec.item) : null);
      if (!sig) continue;
      dropCount.set(sig, (dropCount.get(sig) || 0) + 1);
    }
    if (!dropCount.size) return basket;

    const { defaultTable, byLocation } = tables ? normaliseTables(tables) : { defaultTable: null, byLocation: {} };
    const trackedSet = new Set(trackedOnly || []);
    const tableForParcel = parcel => {
      if (!defaultTable) return null;
      const base = (parcel.location && byLocation[parcel.location]) || defaultTable;
      return trackedSet.has(parcel.seller) ? base.filter(m => m.tracked) : base;
    };

    const nextParcels = [];
    let removedCount = 0;
    let removedNonTokenCount = 0;

    for (const parcel of basket.parcels || []) {
      const items = parcel.items || [];
      const kept = [];
      let removedHere = 0;

      for (const item of items) {
        const sig = basketItemSignature(parcel.seller, item);
        const left = dropCount.get(sig) || 0;
        if (left > 0) {
          dropCount.set(sig, left - 1);
          removedHere += 1;
          removedCount += 1;
          if ((item.kind || "card") !== "token") removedNonTokenCount += 1;
        } else {
          kept.push(item);
        }
      }

      if (removedHere === 0) {
        nextParcels.push(parcel);
        continue;
      }
      if (kept.length === 0) continue;

      const itemsCents = kept.reduce((sum, it) => sum + (Number.isFinite(it.priceCents) ? it.priceCents : 0), 0);
      const games = [...new Set(kept.filter(it => (it.kind || "card") !== "product" && it.game).map(it => it.game))];
      const hasProducts = kept.some(it => it.kind === "product");
      const tokenCount = kept.filter(it => it.kind === "token").length;
      const hasTokens = tokenCount > 0;

      let shippingCents = parcel.shippingCents;
      let method = parcel.method;
      const tbl = tableForParcel(parcel);
      if (tbl && tbl.length) {
        const simItems = kept.map(it => ({
          kind: it.kind || "card",
          offer: { shippingCents: it.offerShippingCents ?? null },
        }));
        const recalc = parcelShipping(tbl, simItems, itemsCents);
        if (recalc && Number.isFinite(recalc.priceCents)) {
          shippingCents = recalc.priceCents;
          method = recalc.name || parcel.method;
        }
      }

      nextParcels.push({
        ...parcel,
        items: kept,
        itemsCents,
        shippingCents,
        method,
        games,
        hasProducts,
        hasTokens,
        tokenCount,
      });
    }

    if (removedCount === 0) return basket;

    let cards = 0;
    let running = 0;
    let totalShipping = 0;
    let remainingTokens = 0;
    let remainingTokenCents = 0;

    const curve = nextParcels.map((parcel, index) => {
      cards += parcel.items.length;
      totalShipping += parcel.shippingCents;
      running += parcel.itemsCents + parcel.shippingCents;
      for (const it of parcel.items) {
        if (it.kind === "token") {
          remainingTokens += 1;
          remainingTokenCents += Number.isFinite(it.priceCents) ? it.priceCents : 0;
        }
      }
      return { sellers: index + 1, cards, totalCents: running };
    });

    let nextTokenStats = basket.tokenStats;
    if (basket.tokenStats) {
      if (remainingTokens === 0) {
        nextTokenStats = null;
      } else if (remainingTokens !== basket.tokenStats.physicalTokensBought) {
        nextTokenStats = {
          ...basket.tokenStats,
          physicalTokensBought: remainingTokens,
          tokensCents: remainingTokenCents,
          totalAddedCents: remainingTokenCents,
        };
      }
    }

    const savedByRemovalsCents = Number.isFinite(basket.totalCents) && Number.isFinite(running)
      ? Math.max(0, basket.totalCents - running)
      : 0;

    return {
      ...basket,
      parcels: nextParcels,
      curve,
      totalCents: running,
      shippingCents: totalShipping,
      tokenStats: nextTokenStats,
      removedCount,
      removedNonTokenCount,
      savedByRemovalsCents,
    };
  }

  root.CardmarketWizard = {
    createPlanner, parseShippingTable, shipping, shippingByWeight, parcelShipping, weightOf,
    scopeKey, matchesScope, effectiveLimitRule, filterByLimits, previewLimitLeftOut, summarizeBasketBySource,
    basketItemSignature, applyBasketRemovals, STRATEGIES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
