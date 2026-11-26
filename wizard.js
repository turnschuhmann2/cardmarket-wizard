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
  function parcelShippingStats(table, cards, products, productFloorCents, valueCents) {
    if (!table || !table.length) return null;
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
    return parcelShippingStats(table, cards, products, productFloorCents, valueCents);
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
    const sellerMeta = new Map();
    for (const result of collection.results) {
      for (const offer of result.offers) {
        if (!sellers.has(offer.seller)) sellers.set(offer.seller, new Map());
        if (offer.location && !sellerLocations.has(offer.seller)) sellerLocations.set(offer.seller, offer.location);
        if (offer.rating || offer.reputation != null || offer.sellerType != null || typeof offer.professional === 'boolean') {
          let meta = sellerMeta.get(offer.seller);
          if (!meta) {
            meta = { rating: null, reputation: null, sellerType: null, professional: null };
            sellerMeta.set(offer.seller, meta);
          }
          if (offer.rating && !meta.rating) meta.rating = offer.rating;
          if (offer.reputation != null && meta.reputation == null) meta.reputation = offer.reputation;
          if (typeof offer.sellerType === 'number' && meta.sellerType == null) meta.sellerType = offer.sellerType;
          if (typeof offer.professional === 'boolean' && meta.professional == null) meta.professional = offer.professional;
        }
        const byKey = sellers.get(offer.seller);
        if (!byKey.has(result.key)) byKey.set(result.key, []);
        byKey.get(result.key).push(offer);
      }
    }
    for (const byKey of sellers.values()) for (const list of byKey.values()) list.sort((a, b) => a.priceCents - b.priceCents);
    return { sellers, sellerLocations, sellerMeta };
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
    const { sellers, sellerLocations, sellerMeta } = offersBySeller(collection);
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

    const resultByKey = new Map(collection.results.map(result => [result.key, result]));
    const tableCache = new Map();
    const tableFor = seller => {
      if (tableCache.has(seller)) return tableCache.get(seller);
      const location = sellerLocations.get(seller);
      const base = (location && byLocation[location]) || defaultTable;
      const resolved = trackedSellers.has(seller) ? onlyTracked(base) : base;
      tableCache.set(seller, resolved);
      return resolved;
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
        const meta = sellerMeta.get(seller);
        return {
          seller, location: sellerLocations.get(seller) || null,
          ...(meta?.rating ? { rating: meta.rating } : {}),
          ...(meta?.reputation != null ? { reputation: meta.reputation } : {}),
          ...(meta?.sellerType != null ? { sellerType: meta.sellerType } : {}),
          ...(meta?.professional != null ? { professional: meta.professional } : {}),
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

    function cheapestCopyExcluding(offerList, taken, excludeArticleId) {
      if (!offerList) return null;
      for (let i = 0; i < offerList.length; i += 1) {
        const offer = offerList[i];
        const count = (taken.get(offer.idArticle) || 0) - (offer.idArticle === excludeArticleId ? 1 : 0);
        if (count < offer.quantity) return offer;
      }
      return null;
    }

    function maxQuoteOf(quotes) {
      if (!quotes || !quotes.length) return null;
      let m = quotes[0];
      for (let i = 1; i < quotes.length; i += 1) {
        if (quotes[i] > m) m = quotes[i];
      }
      return m;
    }

    function quoteOf(unit, offer) {
      if (unit.kind !== 'product') return null;
      const q = offer?.shippingCents;
      return typeof q === 'number' && q >= 0 ? q : null;
    }

    function quotesWithout(quotes, val) {
      if (val === null || !quotes || !quotes.length) return quotes;
      const idx = quotes.indexOf(val);
      if (idx < 0) return quotes;
      const copy = quotes.slice();
      copy.splice(idx, 1);
      return copy;
    }

    function quotesWith(quotes, val) {
      if (val === null) return quotes;
      return quotes && quotes.length ? quotes.concat(val) : [val];
    }

    // Incremental O(1) parcel cost ledger for fast local search (improve, relieveCliffs, recommendCuts).
    // Tracks finite totals and Infinity parcel count separately so Infinity - Infinity never produces NaN.
    function createParcelLedger(assignment, { groupUnits = false } = {}) {
      const taken = new Map();
      const bySeller = new Map();
      const unitsBySeller = groupUnits ? new Map() : null;
      let finiteTotal = 0;
      let infiniteSellers = 0;

      const shipFor = (seller, cards, products, quotes, itemsCents) => {
        if (cards + products === 0) return 0;
        const m = parcelShippingStats(tableFor(seller), cards, products, maxQuoteOf(quotes), itemsCents);
        return m ? m.priceCents : Infinity;
      };

      for (const [unitId, pick] of assignment) {
        const unit = unitById.get(unitId);
        const seller = pick.seller;
        const offer = pick.offer;
        taken.set(offer.idArticle, (taken.get(offer.idArticle) || 0) + 1);
        let st = bySeller.get(seller);
        if (!st) {
          st = { cards: 0, products: 0, quotes: null, itemsCents: 0, shipCents: 0 };
          bySeller.set(seller, st);
        }
        if (unit.kind === 'product') {
          st.products += 1;
          const q = quoteOf(unit, offer);
          if (q !== null) {
            if (!st.quotes) st.quotes = [q];
            else st.quotes.push(q);
          }
        } else {
          st.cards += 1;
        }
        st.itemsCents += offer.priceCents;
        if (unitsBySeller) {
          let arr = unitsBySeller.get(seller);
          if (!arr) { arr = []; unitsBySeller.set(seller, arr); }
          arr.push(unitId);
        }
      }

      for (const [seller, st] of bySeller) {
        st.shipCents = shipFor(seller, st.cards, st.products, st.quotes, st.itemsCents);
        if (Number.isFinite(st.shipCents)) finiteTotal += st.itemsCents + st.shipCents;
        else infiniteSellers += 1;
      }

      const totalCost = () => (infiniteSellers > 0 ? Infinity : finiteTotal);

      function costAfterMove(unit, fromPick, toSeller, toOffer) {
        const fromSeller = fromPick.seller;
        const fromOffer = fromPick.offer;
        const isProd = unit.kind === 'product';
        const fromQ = isProd ? quoteOf(unit, fromOffer) : null;
        const toQ = isProd ? quoteOf(unit, toOffer) : null;

        if (fromSeller === toSeller) {
          const st = bySeller.get(fromSeller);
          const newItems = st.itemsCents - fromOffer.priceCents + toOffer.priceCents;
          const newQuotes = fromQ === toQ ? st.quotes : quotesWith(quotesWithout(st.quotes, fromQ), toQ);
          const newShip = shipFor(fromSeller, st.cards, st.products, newQuotes, newItems);
          const oldInf = Number.isFinite(st.shipCents) ? 0 : 1;
          const newInf = Number.isFinite(newShip) ? 0 : 1;
          if (infiniteSellers - oldInf + newInf > 0) return Infinity;
          return finiteTotal - (oldInf ? 0 : st.itemsCents + st.shipCents) + newItems + newShip;
        }

        const fromSt = bySeller.get(fromSeller);
        const fCards = fromSt.cards - (isProd ? 0 : 1);
        const fProds = fromSt.products - (isProd ? 1 : 0);
        const fItems = fromSt.itemsCents - fromOffer.priceCents;
        const fQuotes = isProd ? quotesWithout(fromSt.quotes, fromQ) : fromSt.quotes;
        const fNewShip = shipFor(fromSeller, fCards, fProds, fQuotes, fItems);
        const fOldInf = Number.isFinite(fromSt.shipCents) ? 0 : 1;
        const fNewInf = Number.isFinite(fNewShip) ? 0 : 1;

        const toSt = bySeller.get(toSeller);
        const tOldItems = toSt ? toSt.itemsCents : 0;
        const tOldShip = toSt ? toSt.shipCents : 0;
        const tOldInf = toSt && !Number.isFinite(tOldShip) ? 1 : 0;
        const tCards = (toSt ? toSt.cards : 0) + (isProd ? 0 : 1);
        const tProds = (toSt ? toSt.products : 0) + (isProd ? 1 : 0);
        const tItems = tOldItems + toOffer.priceCents;
        const tQuotes = isProd ? quotesWith(toSt ? toSt.quotes : null, toQ) : (toSt ? toSt.quotes : null);
        const tNewShip = shipFor(toSeller, tCards, tProds, tQuotes, tItems);
        const tNewInf = Number.isFinite(tNewShip) ? 0 : 1;

        if (infiniteSellers - fOldInf + fNewInf - tOldInf + tNewInf > 0) return Infinity;
        return finiteTotal
          - (fOldInf ? 0 : fromSt.itemsCents + fromSt.shipCents) + (fCards + fProds > 0 ? fItems + fNewShip : 0)
          - (tOldInf ? 0 : tOldItems + tOldShip) + tItems + tNewShip;
      }

      function applyMove(unit, fromPick, toSeller, toOffer) {
        const fromSeller = fromPick.seller;
        const fromOffer = fromPick.offer;
        const isProd = unit.kind === 'product';
        const fromQ = isProd ? quoteOf(unit, fromOffer) : null;
        const toQ = isProd ? quoteOf(unit, toOffer) : null;

        const prevCount = (taken.get(fromOffer.idArticle) || 1) - 1;
        if (prevCount <= 0) taken.delete(fromOffer.idArticle);
        else taken.set(fromOffer.idArticle, prevCount);
        taken.set(toOffer.idArticle, (taken.get(toOffer.idArticle) || 0) + 1);

        if (fromSeller === toSeller) {
          const st = bySeller.get(fromSeller);
          if (Number.isFinite(st.shipCents)) finiteTotal -= st.itemsCents + st.shipCents;
          else infiniteSellers -= 1;
          st.itemsCents = st.itemsCents - fromOffer.priceCents + toOffer.priceCents;
          if (fromQ !== toQ) st.quotes = quotesWith(quotesWithout(st.quotes, fromQ), toQ);
          st.shipCents = shipFor(fromSeller, st.cards, st.products, st.quotes, st.itemsCents);
          if (Number.isFinite(st.shipCents)) finiteTotal += st.itemsCents + st.shipCents;
          else infiniteSellers += 1;
          return;
        }

        const fromSt = bySeller.get(fromSeller);
        if (Number.isFinite(fromSt.shipCents)) finiteTotal -= fromSt.itemsCents + fromSt.shipCents;
        else infiniteSellers -= 1;
        if (isProd) {
          fromSt.products -= 1;
          if (fromQ !== null) fromSt.quotes = quotesWithout(fromSt.quotes, fromQ);
        } else {
          fromSt.cards -= 1;
        }
        fromSt.itemsCents -= fromOffer.priceCents;
        if (fromSt.cards + fromSt.products === 0) {
          bySeller.delete(fromSeller);
        } else {
          fromSt.shipCents = shipFor(fromSeller, fromSt.cards, fromSt.products, fromSt.quotes, fromSt.itemsCents);
          if (Number.isFinite(fromSt.shipCents)) finiteTotal += fromSt.itemsCents + fromSt.shipCents;
          else infiniteSellers += 1;
        }

        let toSt = bySeller.get(toSeller);
        if (!toSt) {
          toSt = { cards: 0, products: 0, quotes: null, itemsCents: 0, shipCents: 0 };
          bySeller.set(toSeller, toSt);
        } else if (Number.isFinite(toSt.shipCents)) {
          finiteTotal -= toSt.itemsCents + toSt.shipCents;
        } else {
          infiniteSellers -= 1;
        }
        if (isProd) {
          toSt.products += 1;
          if (toQ !== null) toSt.quotes = quotesWith(toSt.quotes, toQ);
        } else {
          toSt.cards += 1;
        }
        toSt.itemsCents += toOffer.priceCents;
        toSt.shipCents = shipFor(toSeller, toSt.cards, toSt.products, toSt.quotes, toSt.itemsCents);
        if (Number.isFinite(toSt.shipCents)) finiteTotal += toSt.itemsCents + toSt.shipCents;
        else infiniteSellers += 1;
      }

      // Cost after removing a small set of { unit, pick } entries (used by recommendCuts).
      function costAfterRemovals(entries) {
        const perSeller = new Map();
        for (const { unit, pick } of entries) {
          let d = perSeller.get(pick.seller);
          if (!d) {
            const st = bySeller.get(pick.seller);
            d = { st, cards: st.cards, products: st.products, quotes: st.quotes, itemsCents: st.itemsCents };
            perSeller.set(pick.seller, d);
          }
          if (unit.kind === 'product') {
            d.products -= 1;
            const q = quoteOf(unit, pick.offer);
            if (q !== null) d.quotes = quotesWithout(d.quotes, q);
          } else {
            d.cards -= 1;
          }
          d.itemsCents -= pick.offer.priceCents;
        }
        let nextInf = infiniteSellers;
        let nextFin = finiteTotal;
        for (const [seller, d] of perSeller) {
          if (Number.isFinite(d.st.shipCents)) nextFin -= d.st.itemsCents + d.st.shipCents;
          else nextInf -= 1;
          if (d.cards + d.products > 0) {
            const newShip = shipFor(seller, d.cards, d.products, d.quotes, d.itemsCents);
            if (Number.isFinite(newShip)) nextFin += d.itemsCents + newShip;
            else nextInf += 1;
          }
        }
        return nextInf > 0 ? Infinity : nextFin;
      }

      // Cost after dropping dropSeller and reassigning all its units to other chosen sellers.
      function costAfterDropSeller(dropSeller, moves) {
        const dropSt = bySeller.get(dropSeller);
        if (!dropSt) return totalCost();
        const perTarget = new Map();
        for (const { unit, toSeller, toOffer } of moves) {
          let d = perTarget.get(toSeller);
          if (!d) {
            const st = bySeller.get(toSeller);
            d = {
              st,
              cards: st ? st.cards : 0,
              products: st ? st.products : 0,
              quotes: st ? st.quotes : null,
              itemsCents: st ? st.itemsCents : 0,
            };
            perTarget.set(toSeller, d);
          }
          if (unit.kind === 'product') {
            d.products += 1;
            const q = quoteOf(unit, toOffer);
            if (q !== null) d.quotes = quotesWith(d.quotes, q);
          } else {
            d.cards += 1;
          }
          d.itemsCents += toOffer.priceCents;
        }
        let nextInf = infiniteSellers;
        let nextFin = finiteTotal;
        if (Number.isFinite(dropSt.shipCents)) nextFin -= dropSt.itemsCents + dropSt.shipCents;
        else nextInf -= 1;
        for (const [seller, d] of perTarget) {
          if (d.st) {
            if (Number.isFinite(d.st.shipCents)) nextFin -= d.st.itemsCents + d.st.shipCents;
            else nextInf -= 1;
          }
          const newShip = shipFor(seller, d.cards, d.products, d.quotes, d.itemsCents);
          if (Number.isFinite(newShip)) nextFin += d.itemsCents + newShip;
          else nextInf += 1;
        }
        return nextInf > 0 ? Infinity : nextFin;
      }

      return { taken, bySeller, unitsBySeller, totalCost, costAfterMove, applyMove, costAfterRemovals, costAfterDropSeller };
    }

    function rank(allowedSellers = null) {
      const assignment = new Map();
      const assignedBySeller = new Map();
      const taken = new Map();
      const openByKey = new Map();
      for (const unit of units) {
        let arr = openByKey.get(unit.key);
        if (!arr) { arr = []; openByKey.set(unit.key, arr); }
        arr.push(unit);
      }

      let activeSellers = [];
      for (const entry of sellers) {
        if (allowedSellers && !allowedSellers.has(entry[0])) continue;
        activeSellers.push(entry);
      }

      while (openByKey.size > 0 && activeSellers.length > 0) {
        let best = null;
        const nextActive = [];

        for (let sIdx = 0; sIdx < activeSellers.length; sIdx += 1) {
          const sellerEntry = activeSellers[sIdx];
          const seller = sellerEntry[0];
          const byKey = sellerEntry[1];
          let picks = null;
          let localUsed = null;

          for (const [key, offerList] of byKey) {
            const openUnits = openByKey.get(key);
            if (!openUnits) continue;
            for (let uIdx = 0; uIdx < openUnits.length; uIdx += 1) {
              let offer = null;
              for (let oIdx = 0; oIdx < offerList.length; oIdx += 1) {
                const cand = offerList[oIdx];
                const usedCount = (taken.get(cand.idArticle) || 0) + (localUsed ? (localUsed.get(cand.idArticle) || 0) : 0);
                if (usedCount < cand.quantity) { offer = cand; break; }
              }
              if (!offer) break;
              if (!localUsed) localUsed = new Map();
              localUsed.set(offer.idArticle, (localUsed.get(offer.idArticle) || 0) + 1);
              const unit = openUnits[uIdx];
              if (!picks) picks = [];
              picks.push({ unitId: unit.id, unit, offer, extra: offer.priceCents - (unit.targetCents ?? offer.priceCents) });
            }
          }

          if (!picks) continue;
          nextActive.push(sellerEntry);
          if (picks.length > 1) picks.sort((a, b) => a.extra - b.extra);

          const existing = assignedBySeller.get(seller);
          let cards = existing ? existing.cards : 0;
          let products = existing ? existing.products : 0;
          let productFloorCents = existing ? existing.productFloorCents : null;
          const baseValue = existing ? existing.value : 0;
          const baseShip = existing ? existing.ship : 0;
          let extra = 0;
          let value = 0;
          const sellerTable = tableFor(seller);

          for (let index = 0; index < picks.length; index += 1) {
            const pick = picks[index];
            extra += pick.extra;
            value += pick.offer.priceCents;
            if (pick.unit.kind === 'product') {
              products += 1;
              const q = pick.offer.shippingCents;
              if (typeof q === 'number' && q >= 0) {
                productFloorCents = productFloorCents === null ? q : Math.max(productFloorCents, q);
              }
            } else {
              cards += 1;
            }
            const method = parcelShippingStats(sellerTable, cards, products, productFloorCents, baseValue + value);
            if (!method) continue;
            const marginalShip = method.priceCents - baseShip;
            const perCard = (extra + marginalShip) / (index + 1);
            if (!best || perCard < best.perCard) {
              best = {
                seller, perCard, picks, count: index + 1,
                newCards: cards, newProducts: products, newProductFloor: productFloorCents,
                newValue: baseValue + value, newShip: method.priceCents,
              };
            }
          }
        }

        activeSellers = nextActive;
        if (!best) break;

        assignedBySeller.set(best.seller, {
          cards: best.newCards,
          products: best.newProducts,
          productFloorCents: best.newProductFloor,
          value: best.newValue,
          ship: best.newShip,
        });
        for (let i = 0; i < best.count; i += 1) {
          const pick = best.picks[i];
          assignment.set(pick.unitId, { seller: best.seller, offer: pick.offer });
          taken.set(pick.offer.idArticle, (taken.get(pick.offer.idArticle) || 0) + 1);
          const arr = openByKey.get(pick.unit.key);
          if (arr) {
            const pos = arr.indexOf(pick.unit);
            if (pos >= 0) arr.splice(pos, 1);
            if (!arr.length) openByKey.delete(pick.unit.key);
          }
        }
      }
      return assignment;
    }

    // Moves single items between chosen sellers and drops sellers while the total goes down.
    function improve(assignment) {
      const current = new Map(assignment);
      const ledger = createParcelLedger(current);
      let cost = ledger.totalCost();

      for (let changed = true, rounds = 0; changed && rounds < 20; rounds += 1) {
        changed = false;
        const chosen = [...ledger.bySeller.keys()];
        const chosenMaps = chosen.map(s => [s, sellers.get(s)]);

        for (const [unitId, initialPick] of current) {
          const unit = unitById.get(unitId);
          let curPick = initialPick;
          for (let i = 0; i < chosenMaps.length; i += 1) {
            const [seller, byKey] = chosenMaps[i];
            if (!byKey) continue;
            const offerList = byKey.get(unit.key);
            if (!offerList) continue;
            const offer = cheapestCopyExcluding(offerList, ledger.taken, curPick.offer.idArticle);
            if (!offer || offer.idArticle === curPick.offer.idArticle) continue;
            const trialCost = ledger.costAfterMove(unit, curPick, seller, offer);
            if (trialCost < cost) {
              ledger.applyMove(unit, curPick, seller, offer);
              curPick = { seller, offer };
              current.set(unitId, curPick);
              cost = trialCost;
              changed = true;
            }
          }
        }

        for (const seller of [...ledger.bySeller.keys()]) {
          if (!ledger.bySeller.has(seller)) continue;
          const others = [...ledger.bySeller.keys()].filter(other => other !== seller);
          if (!others.length) continue;
          const otherMaps = others.map(s => [s, sellers.get(s)]);
          const moves = [];
          const addedTaken = new Map();
          const freedTaken = new Map();
          let possible = true;

          for (const [unitId, pick] of current) {
            if (pick.seller !== seller) continue;
            const unit = unitById.get(unitId);
            const curId = pick.offer.idArticle;
            freedTaken.set(curId, (freedTaken.get(curId) || 0) + 1);
            let bestAlt = null;
            for (let i = 0; i < otherMaps.length; i += 1) {
              const [other, byKey] = otherMaps[i];
              const offerList = byKey?.get(unit.key);
              if (!offerList) continue;
              for (let j = 0; j < offerList.length; j += 1) {
                const cand = offerList[j];
                const usedCount = (ledger.taken.get(cand.idArticle) || 0)
                  - (freedTaken.get(cand.idArticle) || 0)
                  + (addedTaken.get(cand.idArticle) || 0);
                if (usedCount < cand.quantity) {
                  if (!bestAlt || cand.priceCents < bestAlt.offer.priceCents) {
                    bestAlt = { seller: other, offer: cand };
                  }
                  break;
                }
              }
            }
            if (!bestAlt) { possible = false; break; }
            addedTaken.set(bestAlt.offer.idArticle, (addedTaken.get(bestAlt.offer.idArticle) || 0) + 1);
            moves.push({ unitId, unit, fromPick: pick, toSeller: bestAlt.seller, toOffer: bestAlt.offer });
          }

          if (!possible || !moves.length) continue;
          const trialCost = ledger.costAfterDropSeller(seller, moves);
          if (trialCost < cost) {
            for (const m of moves) {
              ledger.applyMove(m.unit, m.fromPick, m.toSeller, m.toOffer);
              current.set(m.unitId, { seller: m.toSeller, offer: m.toOffer });
            }
            cost = trialCost;
            changed = true;
          }
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
          ...(parcel.rating ? { rating: parcel.rating } : {}),
          ...(parcel.reputation != null ? { reputation: parcel.reputation } : {}),
          ...(parcel.sellerType != null ? { sellerType: parcel.sellerType } : {}),
          ...(parcel.professional != null ? { professional: parcel.professional } : {}),
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
          const result = resultByKey.get(key);
          if (!result) continue;
          if (result.game) games.add(result.game);
          if (result.targetCents !== null && list[0].priceCents <= result.targetCents) atTarget += 1;
          cheapestCents += list[0].priceCents;
        }
        const row = { seller, cards: byKey.size, atTarget, cheapestCents };
        const loc = sellerLocations.get(seller);
        if (loc) row.location = loc;
        const meta = sellerMeta.get(seller);
        if (meta?.rating) row.rating = meta.rating;
        if (meta?.reputation != null) row.reputation = meta.reputation;
        if (meta?.sellerType != null) row.sellerType = meta.sellerType;
        if (meta?.professional != null) row.professional = meta.professional;
        if (games.size) row.games = [...games];
        return row;
      }).sort((a, b) => b.cards - a.cards || b.atTarget - a.atTarget || a.cheapestCents - b.cheapestCents).slice(0, limit);
    }

    // Each item from the cheapest copy among the given sellers, in wanted-list order.
    function assignWithin(chosen) {
      const assignment = new Map();
      const taken = new Map();
      const chosenEntries = [];
      for (const seller of chosen) {
        const byKey = sellers.get(seller);
        if (byKey) chosenEntries.push([seller, byKey]);
      }
      if (!chosenEntries.length) return assignment;
      for (let u = 0; u < units.length; u += 1) {
        const unit = units[u];
        let best = null;
        for (let i = 0; i < chosenEntries.length; i += 1) {
          const offerList = chosenEntries[i][1].get(unit.key);
          if (!offerList) continue;
          let offer = null;
          for (let j = 0; j < offerList.length; j += 1) {
            const cand = offerList[j];
            if ((taken.get(cand.idArticle) || 0) < cand.quantity) { offer = cand; break; }
          }
          if (offer && (!best || offer.priceCents < best.offer.priceCents)) {
            best = { seller: chosenEntries[i][0], offer };
          }
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
      const ledger = createParcelLedger(assignment, { groupUnits: true });
      let currentCost = ledger.totalCost();
      if (chosen.size <= 1) return { assignment, cost: currentCost };

      const expensive = [];
      for (const [seller, st] of ledger.bySeller) {
        if (st.shipCents >= 500) expensive.push({ seller, shipCents: st.shipCents });
      }
      if (!expensive.length) return { assignment, cost: currentCost };
      expensive.sort((a, b) => b.shipCents - a.shipCents);

      const current = new Map(assignment);
      const chosenEntries = [];
      for (const seller of chosen) {
        const byKey = sellers.get(seller);
        if (byKey) chosenEntries.push([seller, byKey]);
      }

      for (const { seller: expSeller } of expensive) {
        const parcelUnits = ledger.unitsBySeller.get(expSeller);
        if (!parcelUnits || !parcelUnits.length) continue;
        const movables = [];
        for (let u = 0; u < parcelUnits.length; u += 1) {
          const unitId = parcelUnits[u];
          const pick = current.get(unitId);
          if (!pick || pick.seller !== expSeller) continue;
          const unit = unitById.get(unitId);
          let bestAlt = null;
          for (let i = 0; i < chosenEntries.length; i += 1) {
            const [altSeller, byKey] = chosenEntries[i];
            if (altSeller === expSeller) continue;
            const offer = cheapestCopyExcluding(byKey.get(unit.key), ledger.taken, pick.offer.idArticle);
            if (offer && (!bestAlt || offer.priceCents < bestAlt.offer.priceCents)) bestAlt = { seller: altSeller, offer };
          }
          if (bestAlt) movables.push({ unitId, premium: bestAlt.offer.priceCents - pick.offer.priceCents });
        }
        if (!movables.length) continue;
        movables.sort((a, b) => a.premium - b.premium);

        const limit = Math.min(movables.length, 8);
        const appliedMoves = [];
        let bestPrefixLen = 0;
        let bestCost = currentCost;

        for (let i = 0; i < limit; i += 1) {
          const { unitId } = movables[i];
          const unit = unitById.get(unitId);
          const curPick = current.get(unitId);
          if (!curPick || curPick.seller !== expSeller) continue;
          let alt = null;
          for (let j = 0; j < chosenEntries.length; j += 1) {
            const [altSeller, byKey] = chosenEntries[j];
            if (altSeller === expSeller) continue;
            const offer = cheapestCopyExcluding(byKey.get(unit.key), ledger.taken, curPick.offer.idArticle);
            if (offer && (!alt || offer.priceCents < alt.offer.priceCents)) alt = { seller: altSeller, offer };
          }
          if (!alt) continue;
          ledger.applyMove(unit, curPick, alt.seller, alt.offer);
          current.set(unitId, alt);
          appliedMoves.push({ unitId, unit, prevPick: curPick, nextPick: alt });
          const trialCost = ledger.totalCost();
          if (trialCost < bestCost) {
            bestCost = trialCost;
            bestPrefixLen = appliedMoves.length;
          }
        }

        // Roll back moves past the best prefix in reverse order.
        for (let i = appliedMoves.length - 1; i >= bestPrefixLen; i -= 1) {
          const m = appliedMoves[i];
          ledger.applyMove(m.unit, m.nextPick, m.prevPick.seller, m.prevPick.offer);
          current.set(m.unitId, m.prevPick);
        }
        currentCost = bestCost;
      }
      return { assignment: current, cost: currentCost };
    }

    // Compute MISSING_CENTS dynamically above any worst-case basket cost + shipping so expensive
    // items (> €1,000) are never dropped, and compare coverage lexicographically before cost.
    let maxOfferCents = 0;
    let maxProductShipCents = 0;
    for (const result of collection.results) {
      for (const offer of result.offers || []) {
        if (Number.isFinite(offer.priceCents) && offer.priceCents > maxOfferCents) maxOfferCents = offer.priceCents;
        if (Number.isFinite(offer.shippingCents) && offer.shippingCents > maxProductShipCents) maxProductShipCents = offer.shippingCents;
      }
    }
    let maxTableShipCents = 0;
    for (const tbl of [defaultTable, ...Object.values(byLocation)]) {
      if (!Array.isArray(tbl)) continue;
      for (const m of tbl) {
        if (Number.isFinite(m.priceCents) && m.priceCents > maxTableShipCents) maxTableShipCents = m.priceCents;
      }
    }
    const maxSingleUnitCents = maxOfferCents + Math.max(maxProductShipCents, maxTableShipCents, 5000);
    const MISSING_CENTS = Math.max(100000, (maxSingleUnitCents + 10000) * Math.max(1, units.length));
    const costOf = chosen => {
      const { assignment, cost } = relieveCliffs(assignWithin(chosen), chosen);
      return { assignment, size: assignment.size, rawCents: cost, cents: cost + (units.length - assignment.size) * MISSING_CENTS };
    };
    const isBetterState = (cand, best) => {
      if (!best) return true;
      const candFinite = Number.isFinite(cand.rawCents);
      const bestFinite = Number.isFinite(best.rawCents);
      if (candFinite !== bestFinite) return candFinite;
      if (!candFinite) return cand.size > best.size;
      if (cand.size !== best.size) return cand.size > best.size;
      return cand.rawCents < best.rawCents;
    };

    let cachedDomBaseline = undefined;
    function domesticBaselineAssignment() {
      if (cachedDomBaseline !== undefined) return cachedDomBaseline;
      if (!hasMultipleLocations || !domesticLocation) {
        cachedDomBaseline = null;
        return null;
      }
      const domSellers = new Set([...sellers.keys()].filter(s => sellerLocations.get(s) === domesticLocation));
      if (!domSellers.size) {
        cachedDomBaseline = null;
        return null;
      }
      cachedDomBaseline = improve(rank(domSellers));
      return cachedDomBaseline;
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

    // patience: stop after this many shakes in a row find nothing better (default: use the whole budget).
    async function search(basket, { seed = 1, shake = 3, breadth = 150, start = 'basket', startSellers = null, patience = Infinity }, deadline, isCancelled = () => false) {
      const next = random(seed);
      const candidates = [...sellers.keys()];
      const timeLeft = () => !isCancelled() && Date.now() < deadline;
      let lastYield = Date.now();
      const maybeYield = async () => {
        const now = Date.now();
        if (now - lastYield >= 20) {
          await pause();
          lastYield = Date.now();
        }
      };

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
            const rp = rawPaid.get(key);
            if (rp !== undefined && p < rp) rawSaving += rp - p;
            const lp = landedPaid.get(key);
            if (lp !== undefined && p < lp) {
              landedGross += lp - p;
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
        for (let improved = true; improved && timeLeft();) {
          improved = false;
          for (const seller of [...chosen]) {
            if (!timeLeft()) break;
            const trial = new Set(chosen);
            trial.delete(seller);
            const state = costOf(trial);
            if (isBetterState(state, currentState)) { currentState = state; chosen = trial; improved = true; }
            await maybeYield();
          }
          if (!timeLeft()) break;
          for (const seller of helpful(currentState.assignment)) {
            if (!timeLeft()) break;
            if (chosen.has(seller)) continue;
            const trial = new Set(chosen).add(seller);
            const state = costOf(trial);
            if (isBetterState(state, currentState)) { currentState = state; chosen = trial; improved = true; }
            await maybeYield();
          }
          if (improved || !timeLeft()) continue;
          // Swap: one seller out, another in.
          for (const out of [...chosen]) {
            if (!timeLeft()) break;
            const without = new Set(chosen);
            without.delete(out);
            const withoutState = costOf(without);
            for (const seller of helpful(withoutState.assignment)) {
              if (!timeLeft()) break;
              if (chosen.has(seller)) continue;
              const trial = new Set(without).add(seller);
              const state = costOf(trial);
              if (isBetterState(state, currentState)) { currentState = state; chosen = trial; improved = true; break; }
              await maybeYield();
            }
            if (improved || !timeLeft()) break;
          }
        }
        return { chosen, size: currentState.size, rawCents: currentState.rawCents, cents: currentState.cents };
      }

      const initialSellers = Array.isArray(startSellers)
        ? startSellers.filter(seller => sellers.has(seller))
        : start === 'empty'
          ? []
          : basket.parcels.map(parcel => parcel.seller);
      let best = await polish(initialSellers);
      for (let stale = 0; timeLeft() && stale < patience;) {
        const shaken = [...best.chosen];
        for (let i = 0; i < shake && shaken.length; i += 1) shaken.splice(Math.floor(next() * shaken.length), 1);
        const found = await polish(shaken);
        if (isBetterState(found, best)) { best = found; stale = 0; } else stale += 1;
        await pause();
        lastYield = Date.now();
      }
      return best;
    }

    async function optimise(basket, { timeMs = 10000, strategies = STRATEGIES, onProgress = () => {}, isCancelled = () => false } = {}) {
      const initialRawCents = total(basket.assignment);
      const initialCents = initialRawCents + (units.length - basket.assignment.size) * MISSING_CENTS;
      const initialState = { size: basket.assignment.size, rawCents: initialRawCents, cents: initialCents };
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
        const domRawCents = total(domBaseline);
        const domState = { size: domBaseline.size, rawCents: domRawCents, cents: domRawCents + (units.length - domBaseline.size) * MISSING_CENTS, assignment: domBaseline, strategy: 'domestic baseline' };
        if (isBetterState(domState, initialState)) best = domState;
      }
      for (const strategy of runStrategies) {
        if (isCancelled()) break;
        const started = Date.now();
        const found = await search(basket, strategy, started + share, isCancelled);
        if (isCancelled()) break;
        const assignment = improve(costOf(found.chosen).assignment);
        const rawCents = total(assignment);
        const cand = { size: assignment.size, rawCents, cents: rawCents + (units.length - assignment.size) * MISSING_CENTS, assignment, strategy: strategy.name };
        results.push({ strategy: strategy.name, cents: cand.cents, sellers: new Set([...assignment.values()].map(pick => pick.seller)).size, ms: Date.now() - started });
        if (isBetterState(cand, best)) best = cand;
        onProgress({ cents: best.cents, sellers: results.at(-1).sellers, strategy: strategy.name, done: results.length, of: runStrategies.length });
      }
      // Superseded jobs stop early with nothing better than what came in.
      if (!best) return Object.assign(basket, { search: { results, winner: 'quick basket', quickCents: initialCents } });
      // Never hand back something dearer (or covering fewer items) than what came in.
      const beatsInitial = isBetterState(best, initialState);
      const chosen = beatsInitial ? describe(best.assignment) : basket;
      return Object.assign(chosen, { search: { results, winner: beatsInitial ? best.strategy : 'quick basket', quickCents: initialCents } });
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

    function recommendCuts(basket, { maxCuts = Math.max(1, Math.round(units.length * 0.05)), minExtraCents = 20, shortlist = 15, timeMs = 3000, isCancelled = () => false } = {}) {
      let assignment = new Map(basket.assignment);
      let current = total(assignment);
      if (!Number.isFinite(current)) return [];
      const cuts = [];
      const deadline = timeMs > 0 ? Date.now() + timeMs : Infinity;
      const unitByKey = new Map();
      for (const unit of units) {
        if (!unitByKey.has(unit.key)) unitByKey.set(unit.key, unit);
      }

      const without = key => {
        const next = new Map();
        for (const [unitId, pick] of assignment) {
          if (unitById.get(unitId).key !== key) next.set(unitId, pick);
        }
        return next;
      };

      for (let round = 0; round < maxCuts; round += 1) {
        if (isCancelled() || Date.now() >= deadline) break;
        const ledger = createParcelLedger(assignment);
        const entriesByKey = new Map();
        for (const [unitId, pick] of assignment) {
          const unit = unitById.get(unitId);
          let arr = entriesByKey.get(unit.key);
          if (!arr) { arr = []; entriesByKey.set(unit.key, arr); }
          arr.push({ unit, pick });
        }

        const promising = [];
        for (const [key, keyEntries] of entriesByKey) {
          let market = 0;
          let validMarket = true;
          for (let i = 0; i < keyEntries.length; i += 1) {
            const t = keyEntries[i].unit.targetCents;
            if (t == null || !Number.isFinite(t)) { validMarket = false; break; }
            market += t;
          }
          if (!validMarket) continue;
          const withoutCents = ledger.costAfterRemovals(keyEntries);
          if (!Number.isFinite(withoutCents)) continue;
          promising.push({ key, market, extra: current - withoutCents - market });
        }
        promising.sort((a, b) => b.extra - a.extra);
        let best = null;
        for (const { key, market } of promising.slice(0, shortlist)) {
          if (isCancelled() || Date.now() >= deadline) break;
          const rest = improve(without(key));
          const cents = total(rest);
          if (!Number.isFinite(cents)) continue;
          const extra = current - cents - market;
          if (!Number.isFinite(extra)) continue;
          if (!best || extra > best.extra) best = { key, rest, cents, extra, market };
        }
        if (isCancelled() || !best || !Number.isFinite(best.extra) || best.extra < minExtraCents) break;
        const unit = unitByKey.get(best.key);
        cuts.push({
          key: best.key, name: unit.name, game: unit.game, listName: unit.listName, kind: unit.kind,
          marketCents: best.market, savedCents: current - best.cents, extraCents: best.extra, basketCents: best.cents,
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
    let remainingShippingDeltaCents = 0;

    const curve = nextParcels.map((parcel, index) => {
      cards += parcel.items.length;
      totalShipping += parcel.shippingCents;
      running += parcel.itemsCents + parcel.shippingCents;
      let parcelHasTokens = false;
      for (const it of parcel.items) {
        if (it.kind === "token") {
          parcelHasTokens = true;
          remainingTokens += 1;
          remainingTokenCents += Number.isFinite(it.priceCents) ? it.priceCents : 0;
        }
      }
      if (parcelHasTokens && defaultTable) {
        const nonTokens = parcel.items.filter(it => it.kind !== "token");
        if (!nonTokens.length) {
          remainingShippingDeltaCents += Number.isFinite(parcel.shippingCents) ? parcel.shippingCents : 0;
        } else {
          const tbl = tableForParcel(parcel);
          if (tbl && tbl.length && Number.isFinite(parcel.shippingCents)) {
            const baseItemsCents = nonTokens.reduce((s, it) => s + (Number.isFinite(it.priceCents) ? it.priceCents : 0), 0);
            const baseSim = nonTokens.map(it => ({
              kind: it.kind || "card",
              offer: { shippingCents: it.offerShippingCents ?? null },
            }));
            const baseShip = parcelShipping(tbl, baseSim, baseItemsCents);
            if (baseShip && Number.isFinite(baseShip.priceCents)) {
              remainingShippingDeltaCents += Math.max(0, parcel.shippingCents - baseShip.priceCents);
            }
          }
        }
      }
      return { sellers: index + 1, cards, totalCents: running };
    });

    let nextTokenStats = basket.tokenStats;
    if (basket.tokenStats) {
      if (remainingTokens === 0) {
        nextTokenStats = null;
      } else {
        const shipDelta = defaultTable ? remainingShippingDeltaCents : (basket.tokenStats.shippingDeltaCents || 0);
        nextTokenStats = {
          ...basket.tokenStats,
          physicalTokensBought: remainingTokens,
          tokensCents: remainingTokenCents,
          shippingDeltaCents: shipDelta,
          totalAddedCents: remainingTokenCents + shipDelta,
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
    createPlanner, parseShippingTable, shipping, shippingByWeight, parcelShipping, parcelShippingStats, weightOf,
    scopeKey, matchesScope, effectiveLimitRule, filterByLimits, previewLimitLeftOut, summarizeBasketBySource,
    basketItemSignature, applyBasketRemovals, STRATEGIES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
