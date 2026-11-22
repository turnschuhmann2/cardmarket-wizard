// Web Worker for basket optimization, cut recommendations, and streaming price-limit estimates.
// Keeps the Better Wizard app tab completely lag-free while running seller searches.
'use strict';

importScripts('wizard.js');

const { createPlanner, filterByLimits, previewLimitLeftOut, scopeKey, matchesScope, STRATEGIES } = self.CardmarketWizard;

function serializeBasket(basket) {
  const picks = [...basket.assignment].map(([unitId, { seller, offer }]) => ({
    unitId, seller, idArticle: offer.idArticle, idProduct: offer.idProduct,
  }));
  return {
    parcels: basket.parcels,
    curve: basket.curve,
    totalCents: basket.totalCents,
    shippingCents: basket.shippingCents,
    missing: basket.missing,
    search: basket.search || null,
    picks,
  };
}

// Latest job id per long-running type; an older job stops as soon as a newer one arrives.
const latestJob = { optimise: 0, 'suggest-limits': 0 };

// The app sends a collection once per worker and then only its id, so repeat jobs (every scope
// pill, every recompute) skip structured-cloning several MB of offers.
let cachedCollection = { id: 0, collection: null };
function resolveCollection(msg) {
  if (msg.collection) {
    cachedCollection = { id: msg.collectionId || 0, collection: msg.collection };
    return msg.collection;
  }
  if (msg.collectionId && cachedCollection.id === msg.collectionId) return cachedCollection.collection;
  const error = new Error('collection-missing');
  error.code = 'collection-missing';
  throw error;
}

// Baseline baskets per (collection, tables, other rules, cuts): switching scope pills without
// other limits reuses the same baseline instead of re-searching it.
const baselineCache = new Map();
const keptSignature = kept => kept.map(r => `${r.key}x${r.amount || 1}`).sort().join('|');

self.onmessage = async event => {
  const msg = event.data;
  if (!msg || !msg.id) return;
  if (msg.type in latestJob) latestJob[msg.type] = msg.id;
  const isCancelled = () => msg.type in latestJob && latestJob[msg.type] !== msg.id;
  const postCancelled = () => self.postMessage({ id: msg.id, event: 'done', cancelled: true });

  try {
    // Stops whatever price-limit estimate this worker is still running (a newer one superseded it).
    if (msg.type === 'cancel-limits') {
      latestJob['suggest-limits'] = msg.id;
      self.postMessage({ id: msg.id, event: 'done', cancelled: true });
      return;
    }

    if (msg.type === 'optimise') {
      const t0 = Date.now();
      const { tables, trackedOnly = [], activeLimits = [], manualCuts = [], timeMs = 15000, previousPicks = null } = msg;
      const collection = resolveCollection(msg);
      const { kept, leftOut, countsByScope } = filterByLimits(collection.results, activeLimits, manualCuts);
      const tFilter = Date.now();
      const wanted = { ...collection, results: kept };
      const planner = createPlanner(wanted, tables, { trackedOnly });
      const quick = planner.basket();
      const overlap = planner.overlap(25);
      const tQuick = Date.now();

      self.postMessage({
        id: msg.id,
        event: 'quick',
        basket: serializeBasket(quick),
        overlap,
        leftOut: leftOut.map(r => ({
          key: r.key, name: r.name, game: r.game || 'Magic', listId: r.listId ?? null, listName: r.listName ?? null,
          kind: r.kind || 'card', amount: r.amount, targetCents: r.targetCents, cutReason: r.cutReason,
          idProduct: r.offers?.[0]?.idProduct ?? null,
        })),
        countsByScope: Object.fromEntries(countsByScope),
        timing: { filterMs: tFilter - t0, quickMs: tQuick - tFilter },
      });

      let best = await planner.optimise(quick, {
        timeMs,
        isCancelled,
        onProgress: info => self.postMessage({ id: msg.id, event: 'progress', ...info }),
      });
      if (isCancelled()) { postCancelled(); return; }
      const tSearch = Date.now();

      let keptPrevious = false;
      if (Array.isArray(previousPicks) && previousPicks.length) {
        const fallback = planner.revalidate(previousPicks);
        if (fallback && fallback.assignment.size >= best.assignment.size &&
            (fallback.assignment.size > best.assignment.size || fallback.totalCents < best.totalCents)) {
          best = Object.assign(fallback, { search: best.search });
          keptPrevious = true;
        }
      }

      const cuts = planner.recommendCuts(best);
      const tDone = Date.now();
      self.postMessage({
        id: msg.id,
        event: 'done',
        basket: serializeBasket(best),
        cuts,
        keptPrevious,
        quickCents: quick.totalCents,
        timing: {
          filterMs: tFilter - t0,
          quickMs: tQuick - tFilter,
          searchMs: tSearch - tQuick,
          cutsMs: tDone - tSearch,
          totalMs: tDone - t0,
          keptCount: kept.length,
          leftOutCount: leftOut.length,
          strategies: best.search?.results || [],
        },
      });
      return;
    }

    if (msg.type === 'suggest-limits') {
      const t0 = Date.now();
      const { tables, trackedOnly = [], activeLimits = [], manualCuts = [], scope, candidates = [50, 100, 200, 300, 500, 1000, 2000] } = msg;
      const collection = resolveCollection(msg);
      const targetScopeKey = scopeKey(scope);
      // Base rules exclude any existing rule on this exact scope so we preview changing this scope cleanly.
      const baseRules = activeLimits.filter(r => scopeKey(r) !== targetScopeKey);
      const scopedCards = collection.results.filter(r => matchesScope(r, scope));
      const totalScopedCopies = scopedCards.reduce((sum, r) => sum + (r.amount || 1), 0);

      // Each estimate is a short local search that stops once a few shakes in a row find nothing
      // better (patience), instead of always burning its whole time budget.
      const estimate = async (results, startSellers) => {
        const planner = createPlanner({ ...collection, results }, tables, { trackedOnly });
        const strategy = { ...STRATEGIES[0], patience: 4, ...(startSellers ? { startSellers } : {}) };
        return planner.optimise(planner.basket(), { timeMs: 450, strategies: [strategy], isCancelled });
      };

      // Baseline basket with baseRules (without a limit on this scope). The app may pass one in when
      // it splits candidates across several workers, so every row is compared to the same baseline.
      const baseKey = `${cachedCollection.id}|${msg.tablesId ?? ''}|${JSON.stringify(baseRules.map(r => [scopeKey(r), r.cents]))}|${[...manualCuts].sort().join(',')}|${[...trackedOnly].sort().join(',')}`;
      let baseQuick = msg.baseline || baselineCache.get(baseKey);
      if (!baseQuick) {
        const baseFiltered = filterByLimits(collection.results, baseRules, manualCuts);
        const found = await estimate(baseFiltered.kept, null);
        if (isCancelled()) { postCancelled(); return; }
        baseQuick = { totalCents: found.totalCents, sellers: found.parcels.map(p => p.seller) };
        if (baselineCache.size > 20) baselineCache.clear();
        baselineCache.set(baseKey, baseQuick);
      }
      const tBase = Date.now();

      const options = [];
      const bySignature = new Map();
      for (const cents of candidates) {
        const preview = previewLimitLeftOut(collection.results, activeLimits, manualCuts, scope, cents);
        if (!preview.items.length || preview.items.length === preview.scopedEligibleCount) continue;

        const trialRules = [...baseRules, { ...scope, cents }];
        const { kept } = filterByLimits(collection.results, trialRules, manualCuts);
        // Two limits that leave out the same cards price the same basket: search it once.
        const sig = keptSignature(kept);
        let quick = bySignature.get(sig);
        if (!quick) {
          // Warm-start from the baseline's sellers: a limit only drops cards, so most stay useful.
          quick = await estimate(kept, baseQuick.sellers);
          if (isCancelled()) { postCancelled(); return; }
          bySignature.set(sig, quick);
        }

        const option = {
          cents,
          cards: preview.totalCopies,
          leftOutCents: preview.totalMarketCents,
          basketCents: quick.totalCents,
          savesCents: baseQuick.totalCents - quick.totalCents,
        };
        options.push(option);
        self.postMessage({ id: msg.id, event: 'limit-row', option, baselineCents: baseQuick.totalCents });
      }
      const tDone = Date.now();

      if (msg.markSuggestion !== false) {
        const suggestion = options.find(o => o.cards <= totalScopedCopies * 0.1) || options.at(-1);
        if (suggestion) suggestion.suggested = true;
      }
      self.postMessage({
        id: msg.id,
        event: 'done',
        options,
        baselineCents: baseQuick.totalCents,
        baseline: baseQuick,
        totalScopedCopies,
        timing: {
          baseMs: tBase - t0,
          candidatesMs: tDone - tBase,
          totalMs: tDone - t0,
          evaluatedCount: options.length,
        },
      });
      return;
    }

    if (msg.type === 'quick-cost') {
      const t0 = Date.now();
      const { results, tables, trackedOnly = [] } = msg;
      const planner = createPlanner({ results }, tables, { trackedOnly });
      const priced = await planner.optimise(planner.basket(), { timeMs: 2000, strategies: [STRATEGIES[0]] });
      const target = new Map(results.map(result => [result.key, result.targetCents]));
      const totalCents = priced.totalCents + priced.missing.reduce((sum, unit) => sum + (target.get(unit.key) ?? 0) + (target.get(unit.key) ? 125 : 0), 0);
      self.postMessage({
        id: msg.id,
        event: 'done',
        totalCents,
        timing: { totalMs: Date.now() - t0 },
      });
    }
  } catch (error) {
    self.postMessage({ id: msg.id, event: 'error', error: error?.message || String(error), code: error?.code || null });
  }
};
