// Web Worker for basket optimization, cut recommendations, and streaming price-limit estimates.
// Keeps the Better Wizard app tab completely lag-free while running seller searches.
'use strict';

importScripts('wizard.js');

const { createPlanner, filterByLimits, scopeKey, matchesScope, STRATEGIES } = self.CardmarketWizard;

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

self.onmessage = async event => {
  const msg = event.data;
  if (!msg || !msg.id) return;
  if (msg.type in latestJob) latestJob[msg.type] = msg.id;
  const isCancelled = () => msg.type in latestJob && latestJob[msg.type] !== msg.id;
  const postCancelled = () => self.postMessage({ id: msg.id, event: 'done', cancelled: true });

  try {
    if (msg.type === 'optimise') {
      const { collection, tables, trackedOnly = [], activeLimits = [], manualCuts = [], timeMs = 15000, previousPicks = null } = msg;
      const { kept, leftOut, countsByScope } = filterByLimits(collection.results, activeLimits, manualCuts);
      const wanted = { ...collection, results: kept };
      const planner = createPlanner(wanted, tables, { trackedOnly });
      const quick = planner.basket();
      const overlap = planner.overlap(25);

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
      });

      let best = await planner.optimise(quick, {
        timeMs,
        isCancelled,
        onProgress: info => self.postMessage({ id: msg.id, event: 'progress', ...info }),
      });
      if (isCancelled()) { postCancelled(); return; }

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
      self.postMessage({
        id: msg.id,
        event: 'done',
        basket: serializeBasket(best),
        cuts,
        keptPrevious,
        quickCents: quick.totalCents,
      });
      return;
    }

    if (msg.type === 'suggest-limits') {
      const { collection, tables, trackedOnly = [], activeLimits = [], manualCuts = [], scope, candidates = [50, 100, 200, 300, 500, 1000, 2000] } = msg;
      const targetScopeKey = scopeKey(scope);
      // Base rules exclude any existing rule on this exact scope so we preview changing this scope cleanly.
      const baseRules = activeLimits.filter(r => scopeKey(r) !== targetScopeKey);
      const scopedCards = collection.results.filter(r => matchesScope(r, scope));
      const totalScopedCopies = scopedCards.reduce((sum, r) => sum + (r.amount || 1), 0);

      // Baseline basket with baseRules (without a limit on this scope).
      const baseFiltered = filterByLimits(collection.results, baseRules, manualCuts);
      const basePlanner = createPlanner({ ...collection, results: baseFiltered.kept }, tables, { trackedOnly });
      const baseQuick = await basePlanner.optimise(basePlanner.basket(), { timeMs: 450, strategies: [STRATEGIES[0]], isCancelled });
      if (isCancelled()) { postCancelled(); return; }

      const options = [];
      for (const cents of candidates) {
        const overInScope = scopedCards.filter(r => r.targetCents !== null && r.targetCents > cents);
        if (!overInScope.length || overInScope.length === scopedCards.length) continue;

        const trialRules = [...baseRules, { ...scope, cents }];
        const { kept } = filterByLimits(collection.results, trialRules, manualCuts);
        const planner = createPlanner({ ...collection, results: kept }, tables, { trackedOnly });
        const quick = await planner.optimise(planner.basket(), { timeMs: 450, strategies: [STRATEGIES[0]], isCancelled });
        if (isCancelled()) { postCancelled(); return; }

        const option = {
          cents,
          cards: overInScope.reduce((sum, r) => sum + (r.amount || 1), 0),
          leftOutCents: overInScope.reduce((sum, r) => sum + r.targetCents * (r.amount || 1), 0),
          basketCents: quick.totalCents,
          savesCents: baseQuick.totalCents - quick.totalCents,
        };
        options.push(option);
        self.postMessage({ id: msg.id, event: 'limit-row', option, baselineCents: baseQuick.totalCents });
      }

      const suggestion = options.find(o => o.cards <= totalScopedCopies * 0.1) || options.at(-1);
      if (suggestion) suggestion.suggested = true;
      self.postMessage({ id: msg.id, event: 'done', options, baselineCents: baseQuick.totalCents });
      return;
    }

    if (msg.type === 'quick-cost') {
      const { results, tables, trackedOnly = [] } = msg;
      const planner = createPlanner({ results }, tables, { trackedOnly });
      const priced = await planner.optimise(planner.basket(), { timeMs: 2000, strategies: [STRATEGIES[0]] });
      const target = new Map(results.map(result => [result.key, result.targetCents]));
      const totalCents = priced.totalCents + priced.missing.reduce((sum, unit) => sum + (target.get(unit.key) ?? 0) + (target.get(unit.key) ? 125 : 0), 0);
      self.postMessage({ id: msg.id, event: 'done', totalCents });
    }
  } catch (error) {
    self.postMessage({ id: msg.id, event: 'error', error: error?.message || String(error) });
  }
};
