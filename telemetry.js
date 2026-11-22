// Structured performance telemetry, span tracing, and run summarization for Cardmarket Better Wizard.
// Works in browser pages, Web Workers, Service Workers, and Node.js (tests & CLI analyzer).
(function (root) {
  'use strict';

  function round1(n) {
    return Math.round((Number(n) || 0) * 10) / 10;
  }

  function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '–';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(1);
    return `${mins}m ${secs}s`;
  }

  function percentile(values, p) {
    if (!Array.isArray(values) || !values.length) return 0;
    const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    if (p <= 0) return sorted[0];
    if (p >= 100) return sorted[sorted.length - 1];
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  function summarizeSeries(values) {
    const clean = (Array.isArray(values) ? values : []).filter(Number.isFinite);
    if (!clean.length) {
      return { count: 0, totalMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
    }
    const sorted = [...clean].sort((a, b) => a - b);
    let total = 0;
    for (const v of sorted) total += v;
    const atP = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
    return {
      count: sorted.length,
      totalMs: Math.round(total),
      avgMs: round1(total / sorted.length),
      p50Ms: Math.round(atP(50)),
      p95Ms: Math.round(atP(95)),
      maxMs: Math.round(sorted[sorted.length - 1]),
    };
  }

  function classifyUrlBucket(url, method = 'GET') {
    const raw = String(url || '');
    let path = raw;
    try {
      path = new URL(raw, 'https://www.cardmarket.com').pathname;
    } catch {
      path = raw;
    }
    if (/\/AjaxAction\/ShoppingCart_/i.test(path)) return 'cart';
    if (/\/AjaxAction\/Product_LoadMore/i.test(path)) return 'products';
    if (/\/ShoppingCart(?:\/|$)/i.test(path)) return 'cart-read';
    if (/\/Wants(?:\/|$)/i.test(path)) return 'wants';
    if (/\/Cards\//i.test(path)) return 'cards';
    if (/\/Users\/[^/]+\/Offers/i.test(path)) return 'users';
    if (/\/Products(?:\/|$)/i.test(path)) return 'products';
    if (String(method || 'GET').toUpperCase() === 'POST') return 'cart';
    return 'other';
  }

  function shortUrl(url) {
    try {
      const u = new URL(String(url || ''), 'https://www.cardmarket.com');
      const full = `${u.pathname}${u.search}`;
      return full.length > 110 ? `${full.slice(0, 107)}...` : full;
    } catch {
      return String(url || '').slice(0, 110);
    }
  }

  function createTracer({ runId = null, action = 'action', meta = {}, onEvent = null } = {}) {
    const startedAt = Date.now();
    const id = runId || `perf:${action}:${startedAt}:${Math.random().toString(36).slice(2, 6)}`;
    const events = [];

    function push(entry) {
      events.push(entry);
      if (typeof onEvent === 'function') onEvent(entry);
      return entry;
    }

    function mark(type, data = {}) {
      const now = Date.now();
      return push({
        t: new Date(now).toISOString(),
        relMs: now - startedAt,
        type,
        ...data,
      });
    }

    function recordSpan(name, ms, data = {}) {
      const now = Date.now();
      return push({
        t: new Date(now).toISOString(),
        relMs: now - startedAt,
        type: 'span',
        name,
        ms: Math.max(0, Math.round(ms)),
        ok: data.ok !== false,
        ...data,
      });
    }

    async function span(name, metaOrFn, maybeFn) {
      let spanMeta = {};
      let fn = metaOrFn;
      if (typeof metaOrFn !== 'function') {
        spanMeta = metaOrFn && typeof metaOrFn === 'object' ? { ...metaOrFn } : {};
        fn = maybeFn;
      }
      const s0 = Date.now();
      const setMeta = extra => {
        if (extra && typeof extra === 'object') Object.assign(spanMeta, extra);
      };
      try {
        const result = await fn(setMeta);
        recordSpan(name, Date.now() - s0, { ...spanMeta, ok: true });
        return result;
      } catch (error) {
        recordSpan(name, Date.now() - s0, {
          ...spanMeta,
          ok: false,
          error: error?.message || String(error),
        });
        throw error;
      }
    }

    mark('action-start', { runId: id, action, ...meta });

    return {
      runId: id,
      action,
      startedAt,
      meta,
      events,
      mark,
      span,
      recordSpan,
      finish(extra = {}) {
        const finishedAt = Date.now();
        const wallMs = Math.max(0, finishedAt - startedAt);
        mark('action-end', { runId: id, action, wallMs, ok: extra.ok !== false, ...extra });
        return { runId: id, action, startedAt, finishedAt, wallMs, meta, events };
      },
    };
  }

  function summarizeRun(events = [], opts = {}) {
    const list = Array.isArray(events) ? events : [];
    const collection = opts.collection || null;

    let action = opts.action || null;
    let startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : null;
    let finishedAt = Number.isFinite(opts.finishedAt) ? opts.finishedAt : null;
    let wallMs = Number.isFinite(opts.wallMs) ? opts.wallMs : null;

    const parseTs = ev => {
      if (typeof ev?.t === 'string') {
        const ms = Date.parse(ev.t);
        if (Number.isFinite(ms)) return ms;
      }
      return null;
    };

    const spanBuckets = new Map();
    const phases = [];
    const httpAll = [];
    const httpByBucket = new Map();
    const statusCounts = {};
    let httpOk = 0;
    let httpErrors = 0;
    let httpChallenges = 0;
    let httpRateLimits = 0;
    let httpServerErrors = 0;
    let httpBytes = 0;
    let tabCacheHits = 0;
    let tabCacheMisses = 0;

    const runnerCallMs = [];
    const runnerPaceWaitMs = [];
    const runnerHoldMs = [];
    const runnerExecMs = [];
    const runnerByBucket = new Map();
    let runnerCalls = 0;
    let runnerRetries = 0;
    let runnerWaits = 0;
    let runnerPauses = 0;
    let runnerSlowdowns = 0;
    let runnerRecoveries = 0;
    let runnerCachedQueries = 0;
    let initialIntervalMs = null;
    let finalIntervalMs = null;

    const phase1 = {
      cardPages: 0,
      cachedCardPages: 0,
      domesticSeedPages: 0,
      domesticSeedCached: 0,
      productPages: 0,
      cachedProductPages: 0,
      errors: 0,
      totalOffers: 0,
      keptOffers: 0,
    };

    const phase2 = {
      sellersAsked: 0,
      complete: 0,
      partial: 0,
      errors: 0,
      totalPages: 0,
      totalRows: 0,
      matchedOffers: 0,
      ceilingStops: 0,
      crossGameSkips: 0,
      batches: [],
      sellerRecords: [],
    };

    const optimizerRuns = [];
    const errors = [];
    let firstHttpTs = null;
    let lastHttpTs = null;
    let firstEventTs = null;
    let lastEventTs = null;

    for (const ev of list) {
      if (!ev || typeof ev !== 'object') continue;
      const ts = parseTs(ev);
      if (ts !== null) {
        if (firstEventTs === null || ts < firstEventTs) firstEventTs = ts;
        if (lastEventTs === null || ts > lastEventTs) lastEventTs = ts;
      }

      if (ev.type === 'action-start') {
        if (!action && ev.action) action = ev.action;
        if (startedAt === null && ts !== null) startedAt = ts;
      } else if (ev.type === 'action-end') {
        if (!action && ev.action) action = ev.action;
        if (finishedAt === null && ts !== null) finishedAt = ts;
        if (wallMs === null && Number.isFinite(ev.wallMs)) wallMs = ev.wallMs;
      } else if (ev.type === 'run-start') {
        if (initialIntervalMs === null && Number.isFinite(ev.intervalMs)) initialIntervalMs = ev.intervalMs;
        if (!action) action = ev.method ? `fetch:${ev.method}` : 'fetch';
      } else if (ev.type === 'run-end' || ev.type === 'tokens-end') {
        if (Number.isFinite(ev.startedAt) && startedAt === null) startedAt = ev.startedAt;
        if (Number.isFinite(ev.finishedAt)) finishedAt = Math.max(finishedAt || 0, ev.finishedAt);
        if (Number.isFinite(ev.intervalMs)) finalIntervalMs = ev.intervalMs;
        if (Number.isFinite(ev.cachedQueries)) runnerCachedQueries = Math.max(runnerCachedQueries, ev.cachedQueries);
        if (ev.timings && typeof ev.timings === 'object') {
          if (initialIntervalMs === null && Number.isFinite(ev.timings.initialIntervalMs)) {
            initialIntervalMs = ev.timings.initialIntervalMs;
          }
        }
      } else if (ev.type === 'span' && ev.name) {
        let b = spanBuckets.get(ev.name);
        if (!b) {
          b = { name: ev.name, durations: [], errors: 0, lastMeta: null };
          spanBuckets.set(ev.name, b);
        }
        if (Number.isFinite(ev.ms)) b.durations.push(ev.ms);
        if (ev.ok === false) b.errors += 1;
        const { t: _t, relMs: _r, type: _ty, name: _n, ms: _m, ok: _o, ...rest } = ev;
        if (Object.keys(rest).length) b.lastMeta = rest;
      } else if (ev.type === 'phase-end' && ev.phase) {
        phases.push({
          phase: ev.phase,
          ms: Number.isFinite(ev.ms) ? Math.round(ev.ms) : 0,
          requests: ev.requests ?? null,
          cachedQueries: ev.cachedQueries ?? null,
          items: ev.items ?? null,
          sellers: ev.sellers ?? null,
        });
      } else if (ev.type === 'http') {
        const bucket = ev.bucket || classifyUrlBucket(ev.url, ev.method);
        const statusKey = String(ev.status ?? 'err');
        statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;
        if (ev.status >= 200 && ev.status < 400 && ev.cfMitigated !== 'challenge') httpOk += 1;
        else httpErrors += 1;
        if (ev.cfMitigated === 'challenge' || /^just a moment/i.test(ev.title || '')) httpChallenges += 1;
        if (ev.status === 429) httpRateLimits += 1;
        if (ev.status >= 500) httpServerErrors += 1;
        if (Number.isFinite(ev.bytes)) httpBytes += ev.bytes;
        if (ev.tabCacheHit === true) tabCacheHits += 1;
        else if (ev.tabCacheHit === false) tabCacheMisses += 1;
        if (ts !== null) {
          if (firstHttpTs === null || ts < firstHttpTs) firstHttpTs = ts;
          if (lastHttpTs === null || ts > lastHttpTs) lastHttpTs = ts;
        }
        const rec = {
          bucket,
          method: ev.method || 'GET',
          status: ev.status ?? null,
          ms: Number.isFinite(ev.ms) ? ev.ms : null,
          fetchMs: Number.isFinite(ev.fetchMs) ? ev.fetchMs : null,
          headersMs: Number.isFinite(ev.headersMs) ? ev.headersMs : null,
          bodyMs: Number.isFinite(ev.bodyMs) ? ev.bodyMs : null,
          bridgeOverheadMs: Number.isFinite(ev.bridgeOverheadMs) ? ev.bridgeOverheadMs : null,
          tabResolveMs: Number.isFinite(ev.tabResolveMs) ? ev.tabResolveMs : null,
          bytes: Number.isFinite(ev.bytes) ? ev.bytes : 0,
          url: shortUrl(ev.url),
        };
        httpAll.push(rec);
        let bk = httpByBucket.get(bucket);
        if (!bk) {
          bk = { count: 0, errors: 0, bytes: 0, ms: [], fetchMs: [], headersMs: [], bodyMs: [], bridgeOverheadMs: [] };
          httpByBucket.set(bucket, bk);
        }
        bk.count += 1;
        if (!(ev.status >= 200 && ev.status < 400) || ev.cfMitigated === 'challenge') bk.errors += 1;
        bk.bytes += rec.bytes;
        if (rec.ms !== null) bk.ms.push(rec.ms);
        if (rec.fetchMs !== null) bk.fetchMs.push(rec.fetchMs);
        if (rec.headersMs !== null) bk.headersMs.push(rec.headersMs);
        if (rec.bodyMs !== null) bk.bodyMs.push(rec.bodyMs);
        if (rec.bridgeOverheadMs !== null) bk.bridgeOverheadMs.push(rec.bridgeOverheadMs);
      } else if (ev.type === 'runner-call') {
        runnerCalls += 1;
        const pMs = Number.isFinite(ev.paceWaitMs) ? ev.paceWaitMs : 0;
        const hMs = Number.isFinite(ev.holdMs) ? ev.holdMs : 0;
        const eMs = Number.isFinite(ev.execMs) ? ev.execMs : 0;
        runnerPaceWaitMs.push(pMs);
        runnerHoldMs.push(hMs);
        runnerExecMs.push(eMs);
        runnerCallMs.push(pMs + hMs + eMs);
        const bucket = ev.bucket || 'other';
        let rb = runnerByBucket.get(bucket);
        if (!rb) {
          rb = { calls: 0, paceWaitMs: 0, holdMs: 0, execMs: 0, retries: 0 };
          runnerByBucket.set(bucket, rb);
        }
        rb.calls += 1;
        rb.paceWaitMs += pMs;
        rb.holdMs += hMs;
        rb.execMs += eMs;
        if (Number.isFinite(ev.retries)) rb.retries += ev.retries;
      } else if (ev.type === 'retry') {
        runnerRetries += 1;
      } else if (ev.type === 'wait') {
        runnerWaits += 1;
      } else if (ev.type === 'pause') {
        runnerPauses += 1;
      } else if (ev.type === 'pace-slowdown') {
        runnerSlowdowns += 1;
        if (Number.isFinite(ev.intervalMs)) finalIntervalMs = ev.intervalMs;
      } else if (ev.type === 'pace-recover') {
        runnerRecoveries += 1;
        if (Number.isFinite(ev.intervalMs)) finalIntervalMs = ev.intervalMs;
      } else if (ev.type === 'card-page') {
        phase1.cardPages += 1;
        if (ev.cached) phase1.cachedCardPages += 1;
        if (ev.domesticSeed) {
          phase1.domesticSeedPages += 1;
          if (ev.cached) phase1.domesticSeedCached += 1;
        }
        if (Number.isFinite(ev.offers)) phase1.totalOffers += ev.offers;
        if (Number.isFinite(ev.kept)) phase1.keptOffers += ev.kept;
      } else if (ev.type === 'product-page') {
        phase1.productPages += 1;
        if (ev.cached) phase1.cachedProductPages += 1;
        if (ev.domesticSeed) {
          phase1.domesticSeedPages += 1;
          if (ev.cached) phase1.domesticSeedCached += 1;
        }
        if (Number.isFinite(ev.offers)) phase1.totalOffers += ev.offers;
        if (Number.isFinite(ev.kept)) phase1.keptOffers += ev.kept;
      } else if (ev.type === 'card-error' || ev.type === 'product-error') {
        phase1.errors += 1;
        errors.push({ type: ev.type, target: ev.card || ev.product || null, message: ev.error || 'Error' });
      } else if (ev.type === 'seller') {
        phase2.sellersAsked += 1;
        if (ev.status === 'complete') phase2.complete += 1;
        else if (ev.status === 'partial') phase2.partial += 1;
        else if (ev.status === 'error' || ev.status === 'blocked') phase2.errors += 1;
        phase2.totalPages += Number(ev.pages) || 0;
        phase2.totalRows += Number(ev.rows) || 0;
        phase2.matchedOffers += Number(ev.matched) || 0;
        if (ev.ceilingStopped) phase2.ceilingStops += 1;
        phase2.crossGameSkips += Number(ev.crossGameSkips) || 0;
        phase2.sellerRecords.push({
          seller: ev.seller,
          location: ev.location || null,
          pages: Number(ev.pages) || 0,
          rows: Number(ev.rows) || 0,
          matched: Number(ev.matched) || 0,
          ms: Number.isFinite(ev.ms) ? Math.round(ev.ms) : null,
          ceilingStopped: Boolean(ev.ceilingStopped),
          status: ev.status || 'unknown',
        });
      } else if (ev.type === 'seller-batch') {
        phase2.batches.push({
          asked: ev.asked ?? null,
          basketCents: ev.basketCents ?? null,
          savedCents: ev.savedCents ?? null,
          sellersMs: Number.isFinite(ev.sellersMs) ? Math.round(ev.sellersMs) : null,
          evalMs: Number.isFinite(ev.evalMs) ? Math.round(ev.evalMs) : null,
          batchMs: Number.isFinite(ev.batchMs) ? Math.round(ev.batchMs) : null,
          pages: ev.pages ?? null,
          ceilingStops: ev.ceilingStops ?? null,
        });
      } else if (ev.type === 'worker-optimise' || ev.type === 'worker-suggest-limits' || ev.type === 'worker-quick-cost') {
        optimizerRuns.push({
          kind: ev.type.replace(/^worker-/, ''),
          ...ev,
        });
      } else if (ev.type === 'error' || ev.type === 'tokens-error' || ev.type === 'shipping-tables-error') {
        errors.push({ type: ev.type, message: ev.message || ev.error || 'Error' });
      }
    }

    if (startedAt === null) startedAt = collection?.stats?.startedAt ?? firstEventTs;
    if (finishedAt === null) finishedAt = collection?.stats?.finishedAt ?? lastEventTs;
    if (wallMs === null && startedAt !== null && finishedAt !== null) {
      wallMs = Math.max(0, finishedAt - startedAt);
    }
    if (wallMs === null) wallMs = 0;

    if (collection?.stats) {
      if (!runnerCachedQueries && Number.isFinite(collection.stats.cachedQueries)) {
        runnerCachedQueries = collection.stats.cachedQueries;
      }
      if (finalIntervalMs === null && Number.isFinite(collection.stats.intervalMs)) {
        finalIntervalMs = collection.stats.intervalMs;
      }
    }

    const spans = {};
    const spansList = [];
    for (const [name, b] of spanBuckets) {
      const s = summarizeSeries(b.durations);
      const entry = {
        name,
        ...s,
        pctOfWall: wallMs > 0 ? round1((s.totalMs / wallMs) * 100) : 0,
        errors: b.errors,
        lastMeta: b.lastMeta,
      };
      spans[name] = entry;
      spansList.push(entry);
    }
    spansList.sort((a, b) => b.totalMs - a.totalMs);

    const phasesOut = phases.map(p => ({
      ...p,
      pctOfWall: wallMs > 0 ? round1((p.ms / wallMs) * 100) : 0,
    }));

    const httpSpanMs = firstHttpTs !== null && lastHttpTs !== null && lastHttpTs > firstHttpTs
      ? (lastHttpTs - firstHttpTs)
      : wallMs;
    const effectiveReqPerSec = httpAll.length > 0 && httpSpanMs > 0
      ? round1((httpAll.length * 1000) / httpSpanMs)
      : 0;

    const httpBucketsOut = {};
    for (const [bucket, bk] of httpByBucket) {
      httpBucketsOut[bucket] = {
        count: bk.count,
        errors: bk.errors,
        bytes: bk.bytes,
        totalMs: summarizeSeries(bk.ms),
        fetchMs: summarizeSeries(bk.fetchMs),
        headersMs: summarizeSeries(bk.headersMs),
        bodyMs: summarizeSeries(bk.bodyMs),
        bridgeOverheadMs: summarizeSeries(bk.bridgeOverheadMs),
      };
    }

    const slowestRequests = [...httpAll]
      .filter(r => Number.isFinite(r.ms))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5);

    const http = {
      total: httpAll.length,
      ok: httpOk,
      errors: httpErrors,
      challenges: httpChallenges,
      rateLimits: httpRateLimits,
      serverErrors: httpServerErrors,
      bytes: httpBytes,
      statusCounts,
      effectiveReqPerSec,
      tabCacheHits,
      tabCacheMisses,
      totalMs: summarizeSeries(httpAll.map(r => r.ms)),
      fetchMs: summarizeSeries(httpAll.map(r => r.fetchMs)),
      headersMs: summarizeSeries(httpAll.map(r => r.headersMs)),
      bodyMs: summarizeSeries(httpAll.map(r => r.bodyMs)),
      bridgeOverheadMs: summarizeSeries(httpAll.map(r => r.bridgeOverheadMs)),
      tabResolveMs: summarizeSeries(httpAll.map(r => r.tabResolveMs)),
      byBucket: httpBucketsOut,
      slowest: slowestRequests,
    };

    const runnerByBucketOut = {};
    for (const [bucket, rb] of runnerByBucket) {
      runnerByBucketOut[bucket] = {
        calls: rb.calls,
        paceWaitMs: Math.round(rb.paceWaitMs),
        holdMs: Math.round(rb.holdMs),
        execMs: Math.round(rb.execMs),
        retries: rb.retries,
      };
    }

    const paceWaitSummary = summarizeSeries(runnerPaceWaitMs);
    const holdSummary = summarizeSeries(runnerHoldMs);
    const execSummary = summarizeSeries(runnerExecMs);
    const runner = {
      calls: runnerCalls || collection?.stats?.requests || 0,
      cachedQueries: runnerCachedQueries,
      retries: runnerRetries || collection?.stats?.retries || 0,
      waits: runnerWaits || collection?.stats?.waits || 0,
      pauses: runnerPauses || collection?.stats?.pauses || 0,
      slowdowns: runnerSlowdowns,
      recoveries: runnerRecoveries,
      initialIntervalMs,
      finalIntervalMs,
      paceWaitMs: paceWaitSummary.totalMs,
      holdMs: holdSummary.totalMs,
      execMs: execSummary.totalMs,
      paceWait: paceWaitSummary,
      exec: execSummary,
      byBucket: runnerByBucketOut,
    };

    const sellerMsSeries = summarizeSeries(phase2.sellerRecords.map(s => s.ms));
    const slowestSellers = [...phase2.sellerRecords]
      .sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1) || b.pages - a.pages)
      .slice(0, 5);
    const phase2Out = {
      sellersAsked: phase2.sellersAsked,
      complete: phase2.complete,
      partial: phase2.partial,
      errors: phase2.errors,
      totalPages: phase2.totalPages,
      avgPagesPerSeller: phase2.sellersAsked ? round1(phase2.totalPages / phase2.sellersAsked) : 0,
      totalRows: phase2.totalRows,
      matchedOffers: phase2.matchedOffers,
      ceilingStops: phase2.ceilingStops,
      crossGameSkips: phase2.crossGameSkips,
      sellerMs: sellerMsSeries,
      batches: phase2.batches,
      slowestSellers,
    };

    // Derive automated optimization hints from measured telemetry.
    const hints = [];
    if (http.rateLimits > 0 || http.challenges > 0 || runner.slowdowns > 0) {
      hints.push({
        severity: 'warn',
        code: 'rate-limited',
        title: 'Rate-limit / challenge pressure detected',
        detail: `${http.rateLimits} HTTP 429, ${http.challenges} challenge(s), ${runner.slowdowns} adaptive slowdown(s)`
          + (runner.finalIntervalMs && runner.initialIntervalMs && runner.finalIntervalMs > runner.initialIntervalMs
            ? ` (interval rose ${runner.initialIntervalMs} -> ${runner.finalIntervalMs} ms).`
            : '.'),
      });
    } else if (runner.calls >= 10 && runner.paceWaitMs > runner.execMs * 1.5 && runner.execMs > 0) {
      hints.push({
        severity: 'info',
        code: 'pacing-bound',
        title: 'Run was pacing-bound with zero rate limits',
        detail: `Runner spent ${fmtMs(runner.paceWaitMs)} waiting on pacer slots vs ${fmtMs(runner.execMs)} executing requests (${http.effectiveReqPerSec} req/s effective).`,
      });
    }

    if (http.bridgeOverheadMs.count >= 5 && (http.bridgeOverheadMs.p50Ms >= 80 || http.tabCacheMisses > 2)) {
      hints.push({
        severity: 'warn',
        code: 'bridge-overhead',
        title: 'Elevated extension bridge / IPC overhead',
        detail: `Bridge overhead p50 ${http.bridgeOverheadMs.p50Ms} ms (p95 ${http.bridgeOverheadMs.p95Ms} ms), tab cache misses: ${http.tabCacheMisses}.`,
      });
    }

    if (http.headersMs.count >= 5 && http.headersMs.p50Ms >= 700) {
      hints.push({
        severity: 'info',
        code: 'slow-ttfb',
        title: 'Cardmarket TTFB is the dominant latency component',
        detail: `Response headers p50 ${http.headersMs.p50Ms} ms (p95 ${http.headersMs.p95Ms} ms) vs body download p50 ${http.bodyMs.p50Ms} ms.`,
      });
    }

    const netCardPages = Math.max(0, phase1.cardPages - phase1.cachedCardPages);
    const netDomesticSeed = Math.max(0, phase1.domesticSeedPages - phase1.domesticSeedCached);
    if (netCardPages >= 10 && netDomesticSeed / netCardPages >= 0.35) {
      hints.push({
        severity: 'info',
        code: 'heavy-domestic-seeding',
        title: 'High domestic seeding ratio in Phase 1',
        detail: `${netDomesticSeed}/${netCardPages} (${Math.round((netDomesticSeed / netCardPages) * 100)}%) uncached Phase-1 card fetches were domestic follow-up pages.`,
      });
    }

    const evalMsTotal = phase2Out.batches.reduce((s, b) => s + (b.evalMs || 0), 0);
    const sellersMsTotal = phase2Out.batches.reduce((s, b) => s + (b.sellersMs || 0), 0);
    if (evalMsTotal > 2000 && sellersMsTotal > 0 && evalMsTotal / (evalMsTotal + sellersMsTotal) >= 0.25) {
      hints.push({
        severity: 'warn',
        code: 'slow-batch-eval',
        title: 'Phase 2 batch evaluation took a large share of time',
        detail: `Batch quick-cost evaluation took ${fmtMs(evalMsTotal)} vs ${fmtMs(sellersMsTotal)} fetching sellers across ${phase2Out.batches.length} batch(es).`,
      });
    }

    const lastOpt = [...optimizerRuns].reverse().find(r => r.kind === 'optimise');
    if (lastOpt && Number.isFinite(lastOpt.searchMs) && lastOpt.searchMs >= 13000) {
      hints.push({
        severity: 'info',
        code: 'optimizer-budget-cap',
        title: 'Basket optimizer hit its time budget',
        detail: `Search spent ${fmtMs(lastOpt.searchMs)} (total worker time ${fmtMs(lastOpt.totalMs)}).`,
      });
    }

    return {
      action: action || 'run',
      meta: opts.meta || {},
      startedAt,
      finishedAt,
      wallMs,
      eventCount: list.length,
      spans,
      spansList,
      phases: phasesOut,
      http,
      runner,
      phase1,
      phase2: phase2Out,
      optimizer: optimizerRuns,
      errors,
      hints,
    };
  }

  function formatPerfMarkdown(summary) {
    if (!summary) return '# Performance Report\n\nNo telemetry data available.\n';
    const lines = [];
    lines.push(`# Cardmarket Better Wizard — Perf Report (${summary.action})`);
    lines.push('');
    const metaParts = [
      `Wall: **${fmtMs(summary.wallMs)}**`,
      `HTTP: **${summary.http.total}** (${summary.http.effectiveReqPerSec} req/s, ${(summary.http.bytes / 1024).toFixed(1)} KB)`,
      `Cached queries: **${summary.runner.cachedQueries}**`,
      `Retries: **${summary.runner.retries}**`,
    ];
    if (summary.startedAt) metaParts.unshift(`Started: ${new Date(summary.startedAt).toISOString()}`);
    lines.push(metaParts.join(' · '));
    lines.push('');

    if (summary.hints?.length) {
      lines.push('## Optimization Hints');
      for (const h of summary.hints) {
        lines.push(`- **[${h.severity.toUpperCase()}] ${h.title}**: ${h.detail}`);
      }
      lines.push('');
    }

    if (summary.phases?.length) {
      lines.push('## Collection Phases');
      lines.push('| Phase | Duration | Share | Requests | Cached |');
      lines.push('| --- | ---: | ---: | ---: | ---: |');
      for (const p of summary.phases) {
        lines.push(`| ${p.phase} | ${fmtMs(p.ms)} | ${p.pctOfWall}% | ${p.requests ?? '–'} | ${p.cachedQueries ?? '–'} |`);
      }
      lines.push('');
    }

    if (summary.spansList?.length) {
      lines.push('## Action Spans');
      lines.push('| Span | Count | Total | Avg | p50 | p95 | Max | Share |');
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const s of summary.spansList) {
        lines.push(`| ${s.name} | ${s.count} | ${fmtMs(s.totalMs)} | ${fmtMs(s.avgMs)} | ${fmtMs(s.p50Ms)} | ${fmtMs(s.p95Ms)} | ${fmtMs(s.maxMs)} | ${s.pctOfWall}% |`);
      }
      lines.push('');
    }

    if (summary.http.total > 0) {
      lines.push('## HTTP Breakdown');
      const h = summary.http;
      lines.push(`- Total: **${h.total}** (ok ${h.ok}, errors ${h.errors}, 429 ${h.rateLimits}, challenges ${h.challenges})`);
      lines.push(`- End-to-end ms: p50 **${h.totalMs.p50Ms} ms** · p95 **${h.totalMs.p95Ms} ms** · max **${h.totalMs.maxMs} ms**`);
      if (h.fetchMs.count) {
        lines.push(`- Network fetch ms: p50 **${h.fetchMs.p50Ms} ms** (TTFB p50 **${h.headersMs.p50Ms} ms**, body p50 **${h.bodyMs.p50Ms} ms**)`);
      }
      if (h.bridgeOverheadMs.count) {
        lines.push(`- Bridge IPC overhead: p50 **${h.bridgeOverheadMs.p50Ms} ms** · p95 **${h.bridgeOverheadMs.p95Ms} ms** (tab cache hits ${h.tabCacheHits}, misses ${h.tabCacheMisses})`);
      }
      lines.push('');
      lines.push('| Bucket | Reqs | Err | Total p50 | Fetch p50 | TTFB p50 | IPC p50 | Size |');
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const [bucket, bk] of Object.entries(h.byBucket)) {
        lines.push(`| ${bucket} | ${bk.count} | ${bk.errors} | ${bk.totalMs.p50Ms} ms | ${bk.fetchMs.count ? `${bk.fetchMs.p50Ms} ms` : '–'} | ${bk.headersMs.count ? `${bk.headersMs.p50Ms} ms` : '–'} | ${bk.bridgeOverheadMs.count ? `${bk.bridgeOverheadMs.p50Ms} ms` : '–'} | ${(bk.bytes / 1024).toFixed(1)} KB |`);
      }
      lines.push('');
    }

    if (summary.runner.calls > 0 && (summary.runner.paceWaitMs > 0 || summary.runner.execMs > 0)) {
      const r = summary.runner;
      lines.push('## Runner Pacing vs Execution');
      lines.push(`- Calls: **${r.calls}** · Pace wait: **${fmtMs(r.paceWaitMs)}** · Hold wait: **${fmtMs(r.holdMs)}** · Exec: **${fmtMs(r.execMs)}**`);
      if (r.initialIntervalMs != null || r.finalIntervalMs != null) {
        lines.push(`- Interval: **${r.initialIntervalMs ?? '–'} ms** → **${r.finalIntervalMs ?? '–'} ms** (slowdowns: ${r.slowdowns}, recoveries: ${r.recoveries})`);
      }
      lines.push('');
    }

    if (summary.phase2.sellersAsked > 0) {
      const p2 = summary.phase2;
      lines.push('## Phase 2 (Sellers)');
      lines.push(`- Sellers asked: **${p2.sellersAsked}** (complete ${p2.complete}, partial ${p2.partial}, errors ${p2.errors})`);
      lines.push(`- Pages: **${p2.totalPages}** (avg **${p2.avgPagesPerSeller}**/seller) · Ceiling early stops: **${p2.ceilingStops}** · Cross-game skips: **${p2.crossGameSkips}**`);
      if (p2.batches.length) {
        lines.push('');
        lines.push('| Batch | Sellers Asked | Pages | Ceiling Stops | Fetch | Eval | Batch Total | Saved |');
        lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
        p2.batches.forEach((b, i) => {
          const saved = b.savedCents == null ? '–' : `${(b.savedCents / 100).toFixed(2)} €`;
          lines.push(`| ${i + 1} | ${b.asked ?? '–'} | ${b.pages ?? '–'} | ${b.ceilingStops ?? '–'} | ${b.sellersMs != null ? fmtMs(b.sellersMs) : '–'} | ${b.evalMs != null ? fmtMs(b.evalMs) : '–'} | ${b.batchMs != null ? fmtMs(b.batchMs) : '–'} | ${saved} |`);
        });
      }
      if (p2.slowestSellers.length) {
        lines.push('');
        lines.push('Slowest sellers: ' + p2.slowestSellers.map(s =>
          `${s.seller} (${s.ms != null ? fmtMs(s.ms) : '?'}, ${s.pages}p, ${s.matched}m${s.ceilingStopped ? ', ceiling-stop' : ''})`
        ).join(', '));
      }
      lines.push('');
    }

    if (summary.http.slowest?.length) {
      lines.push('## Slowest HTTP Requests');
      lines.push('| Bucket | Status | Total | Fetch | TTFB | IPC | URL |');
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
      for (const r of summary.http.slowest) {
        lines.push(`| ${r.bucket} | ${r.status ?? '–'} | ${r.ms} ms | ${r.fetchMs ?? '–'} ms | ${r.headersMs ?? '–'} ms | ${r.bridgeOverheadMs ?? '–'} ms | \`${r.url}\` |`);
      }
      lines.push('');
    }

    if (summary.optimizer?.length) {
      lines.push('## Worker / Optimizer Breakdown');
      for (const opt of summary.optimizer) {
        if (opt.kind === 'optimise') {
          lines.push(`- **optimise**: total ${fmtMs(opt.totalMs)} (filter ${fmtMs(opt.filterMs)}, quick ${fmtMs(opt.quickMs)}, search ${fmtMs(opt.searchMs)}, cuts ${fmtMs(opt.cutsMs)})`);
          if (Array.isArray(opt.strategies) && opt.strategies.length) {
            lines.push('  - Strategies: ' + opt.strategies.map(s => `${s.strategy} ${fmtMs(s.ms)} (${(s.cents / 100).toFixed(2)} €, ${s.sellers}s)`).join(' · '));
          }
        } else if (opt.kind === 'suggest-limits') {
          lines.push(`- **suggest-limits**: total ${fmtMs(opt.totalMs)} (base ${fmtMs(opt.baseMs)}, ${opt.evaluatedCount ?? 0} candidates ${fmtMs(opt.candidatesMs)})`);
        } else {
          lines.push(`- **${opt.kind}**: total ${fmtMs(opt.totalMs)}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  const PRIORITY_EVENT_TYPES = new Set([
    'action-start', 'action-end', 'span', 'phase-start', 'phase-end',
    'start', 'run-start', 'run-end', 'tokens-start', 'tokens-end',
    'seller-batch', 'seller', 'seller-tokens',
    'pace-slowdown', 'pace-recover', 'retry', 'wait', 'pause', 'resume', 'refused',
    'worker-optimise', 'worker-suggest-limits', 'worker-quick-cost',
    'error', 'card-error', 'product-error', 'tokens-error', 'shipping-tables-error',
  ]);

  function compactEvent(ev) {
    if (!ev || typeof ev !== 'object') return ev;
    const copy = { ...ev };
    if ('snippet' in copy) delete copy.snippet;
    if (copy.type === 'sellers-chosen' && Array.isArray(copy.sellers) && copy.sellers.length > 15) {
      copy.sellersCount = copy.sellers.length;
      copy.sellers = copy.sellers.slice(0, 15);
    }
    return copy;
  }

  // Bounds stored event logs for chrome.storage.local while preserving every structural/timing event
  // and keeping the slowest + most recent raw HTTP/card-page events for post-hoc debugging.
  function sanitizeEventsForStorage(events = [], maxEvents = 600) {
    const list = Array.isArray(events) ? events : [];
    const compacted = list.map(compactEvent);
    if (compacted.length <= maxEvents) return compacted;

    const keepIdx = new Set();
    const otherIdx = [];
    for (let i = 0; i < compacted.length; i += 1) {
      if (PRIORITY_EVENT_TYPES.has(compacted[i]?.type)) keepIdx.add(i);
      else otherIdx.push(i);
    }

    const remainingBudget = Math.max(0, maxEvents - keepIdx.size);
    if (remainingBudget > 0 && otherIdx.length > 0) {
      const slowBudget = Math.min(40, Math.floor(remainingBudget / 3));
      const slowestHttp = otherIdx
        .filter(i => compacted[i]?.type === 'http' && Number.isFinite(compacted[i]?.ms))
        .sort((a, b) => compacted[b].ms - compacted[a].ms)
        .slice(0, slowBudget);
      for (const i of slowestHttp) keepIdx.add(i);

      const tailBudget = Math.max(0, remainingBudget - slowestHttp.length);
      if (tailBudget > 0) {
        const tail = otherIdx.filter(i => !keepIdx.has(i)).slice(-tailBudget);
        for (const i of tail) keepIdx.add(i);
      }
    }

    const out = [...keepIdx].sort((a, b) => a - b).map(i => compacted[i]);
    if (out.length > maxEvents) return out.slice(-maxEvents);
    return out;
  }

  const api = {
    fmtMs,
    percentile,
    summarizeSeries,
    classifyUrlBucket,
    shortUrl,
    createTracer,
    summarizeRun,
    formatPerfMarkdown,
    sanitizeEventsForStorage,
  };

  root.CardmarketTelemetry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
