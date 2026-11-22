'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../collector.js');
const { browserSite, createRunner, BlockedError, StoppedError, RefusedError, RetryableError, CartRejectError, TokenExpiredError } = globalThis.CardmarketCollector;

globalThis.location = { href: 'https://www.cardmarket.com/en/Magic/Wants/1' };
const reply = (status, title, headers = {}) => async () => ({
  status, ok: status < 300, redirected: false, url: 'https://www.cardmarket.com/en/Magic/Cards/X',
  headers: new Headers(headers), text: async () => `<html><head><title>${title}</title></head><body>${title} body</body></html>`,
});
const entry = { name: 'X', cardPath: '/en/Magic/Cards/X' };
const query = { language: 1, sellerCountries: [7], minCondition: 4, foil: 'any', signed: 'any', altered: 'any' };
const read = fetchImpl => browserSite({ fetchImpl, onResponse: response => seen.push(response) }).cardPage(entry, query);
let seen = [];

test('tells a check, a refusal and a rate limit apart, and logs what a refusal said', async () => {
  await assert.rejects(read(reply(403, 'Just a moment...', { 'cf-mitigated': 'challenge' })), BlockedError);
  await assert.rejects(read(reply(429, 'Just a moment...', { 'cf-mitigated': 'challenge' })), BlockedError);
  seen = [];
  await assert.rejects(read(reply(403, 'Attention Required! | Cloudflare')), error => error instanceof RefusedError && !(error instanceof BlockedError));
  assert.match(seen[0].snippet, /Attention Required/);
  await assert.rejects(read(reply(403, 'Forbidden')), RefusedError);
  await assert.rejects(read(reply(429, 'Access denied | www.cardmarket.com used Cloudflare to restrict access', { 'retry-after': '541' })),
    error => error instanceof RetryableError && error.retryAfterMs === 541000);
});

test('stops after three refusals in a row', async () => {
  let calls = 0;
  const site = { async thing() { calls += 1; throw new RefusedError('no'); } };
  const runner = createRunner(site, { intervalMs: 0 });
  for (let i = 0; i < 3; i += 1) await assert.rejects(runner.call('thing'), RefusedError);
  await assert.rejects(runner.call('thing'), BlockedError);
  assert.equal(calls, 3);
});

test('numbers each wait, and stops after the set number of waits in a row', async () => {
  const attempts = [];
  const site = { async thing() { throw new BlockedError('check'); } };
  const runner = createRunner(site, { intervalMs: 0, maxPausesWithoutSuccess: 5, waitForUser: async (message, attempt) => { attempts.push(attempt); } });
  await assert.rejects(runner.call('thing'), /still refused after 5 waits/);
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
});

test('a check that lifts after a wait lets the request through', async () => {
  let refused = 2;
  const site = { async thing() { if (refused-- > 0) throw new BlockedError('check'); return 'ok'; } };
  const runner = createRunner(site, { intervalMs: 0, waitForUser: async () => {} });
  assert.equal(await runner.call('thing'), 'ok');
});

test('cart requests keep their own, longer gap', async () => {
  const times = [];
  const site = { async addToCart() { times.push(Date.now()); } };
  const runner = createRunner(site, { intervalMs: 0, bucketIntervals: { cart: 120 } });
  for (let i = 0; i < 3; i += 1) await runner.call('addToCart');
  assert.ok(times[1] - times[0] >= 110 && times[2] - times[1] >= 110, String(times));
});

test('read failures retry four times before offering Continue', async () => {
  let calls = 0;
  const events = [];
  const runner = createRunner({ async cardPage() {
    calls += 1;
    if (calls <= 5) throw new RetryableError('HTTP 429');
    return 'ok';
  } }, { intervalMs: 0, readRetryDelays: [1, 2, 3, 4],
    onWait: ({ retry }) => events.push(retry), waitForUser: async () => { events.push(`continue at ${calls}`); } });
  assert.equal(await runner.call('cardPage'), 'ok');
  assert.deepEqual(events, [1, 2, 3, 4, 'continue at 5']);
});

test('read checks, refusals and access denial are retried; only a login request stops at once', async () => {
  for (const error of [new BlockedError('verification'), new RefusedError('denied'),
    Object.assign(new RetryableError('HTTP 429'), { accessDenied: true })]) {
    let calls = 0;
    const runner = createRunner({ async cardPage() { calls += 1; if (calls <= 2) throw error; return 'ok'; } }, {
      intervalMs: 0, readRetryDelays: [0, 0, 0, 0], waitForUser: () => assert.fail('unexpected prompt'),
    });
    assert.equal(await runner.call('cardPage'), 'ok');
    assert.equal(calls, 3);
  }
  let calls = 0;
  const login = createRunner({ async cardPage() { calls += 1; throw Object.assign(new BlockedError('log in'), { login: true }); } }, {
    intervalMs: 0, readRetryDelays: [0, 0], waitForUser: () => assert.fail('unexpected prompt'),
  });
  await assert.rejects(login.call('cardPage'), /log in/);
  assert.equal(calls, 1);
});

test('long Retry-After defers the run; Stop cancels a shorter wait', async () => {
  const blocked = createRunner({ async cardPage() {
    throw Object.assign(new RetryableError('HTTP 429'), { readRetryAfterMs: 181000 });
  } }, { intervalMs: 0, readRetryDelays: [4000] });
  await assert.rejects(blocked.call('cardPage'), /resume later/);
  assert.equal(blocked.stats.requests, 1);
  const controller = new AbortController();
  const stopped = createRunner({ async cardPage() { throw new RetryableError('HTTP 503'); } }, {
    signal: controller.signal, intervalMs: 0, readRetryDelays: [4000], onWait: () => controller.abort(),
  });
  await assert.rejects(stopped.call('cardPage'), /Stopped/);
  assert.equal(stopped.stats.requests, 1);
});

test('cart call stops immediately when Retry-After exceeds maxWaitMs', async () => {
  let calls = 0;
  const runner = createRunner({
    async addSellerToCart() {
      calls += 1;
      throw Object.assign(new RetryableError('HTTP 429', { cause: 'rate' }), { retryAfterMs: 541000 });
    },
  }, { intervalMs: 0, bucketIntervals: {}, maxWaitMs: 120000 });
  await assert.rejects(runner.call('addSellerToCart', [], 'Magic'), err => err instanceof BlockedError && /rate-limited/i.test(err.message));
  assert.equal(calls, 1);
});

test('cart call aborts promptly when Stop is clicked during a Retry-After wait', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const runner = createRunner({
    async addSellerToCart() {
      throw Object.assign(new RetryableError('HTTP 429', { cause: 'rate' }), { retryAfterMs: 60000 });
    },
  }, {
    intervalMs: 0,
    bucketIntervals: {},
    maxWaitMs: 120000,
    signal: controller.signal,
    onWait: () => setTimeout(() => controller.abort(), 15),
  });
  await assert.rejects(runner.call('addSellerToCart', [], 'Magic'), StoppedError);
  assert.ok(Date.now() - started < 2000, 'abort should not wait for full Retry-After');
});

test('cart call stops immediately on login redirect without prompting or auto-retrying', async () => {
  let calls = 0;
  const runner = createRunner({
    async addSellerToCart() {
      calls += 1;
      throw Object.assign(new BlockedError('Cardmarket asked for a login.'), { login: true });
    },
  }, { intervalMs: 0, bucketIntervals: {}, waitForUser: () => assert.fail('unexpected waitForUser on login') });
  await assert.rejects(runner.call('addSellerToCart', [], 'Magic'), err => err instanceof BlockedError && err.login);
  assert.equal(calls, 1);
});

test('browserSite cartRequest classifies XML rejections vs HTML errors and refreshes stale tokens', async () => {
  const prevDOMParser = globalThis.DOMParser;
  globalThis.DOMParser = class FakeDOMParser {
    parseFromString(text) {
      return {
        getElementsByTagName(tag) {
          const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
          return m ? [{ textContent: m[1] }] : [];
        },
      };
    }
  };
  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  const okReply = (url, body) => ({ status: 200, ok: true, redirected: false, url, headers: new Headers(), text: async () => body });

  try {
    // 1. refreshToken falls back from empty ShoppingCart to Wants and overrides stale DOM token
    const seenTokens = [];
    const urls = [];
    const site1 = browserSite({
      getToken: async () => 'STALE_DOM_TOKEN',
      fetchImpl: async (url, init) => {
        urls.push(url);
        if (url.endsWith('/ShoppingCart')) return okReply(url, '<html><body>Empty cart</body></html>');
        if (url.endsWith('/Wants')) return okReply(url, '<html><input name="__cmtkn" value="FRESH_WANTS_TOKEN"></html>');
        seenTokens.push(init.body.get('__cmtkn'));
        return okReply(url, `<response><resultsCode>${b64('generalOK')}</resultsCode></response>`);
      },
    });
    const refreshed = await site1.refreshToken('Magic');
    assert.equal(refreshed, 'FRESH_WANTS_TOKEN');
    await site1.addSellerToCart([{ idArticle: 42, amount: 1 }], 'Magic');
    assert.deepEqual(seenTokens, ['FRESH_WANTS_TOKEN']);

    // 2. Deterministic XML business error throws CartRejectError; HTML error throws plain Error
    const site2 = browserSite({
      getToken: async () => 'TOK',
      fetchImpl: async url => okReply(url, `<response><resultsCode>${b64('generalError')}</resultsCode><resultsMessage>${b64('Article no longer available')}</resultsMessage></response>`),
    });
    await assert.rejects(
      site2.addSellerToCart([{ idArticle: 1, amount: 1 }], 'Magic'),
      err => err instanceof CartRejectError && err.code === 'generalError' && /no longer available/i.test(err.message),
    );

    const site3 = browserSite({
      getToken: async () => 'TOK',
      fetchImpl: async url => okReply(url, '<html><body>Unexpected HTML page</body></html>'),
    });
    await assert.rejects(
      site3.addSellerToCart([{ idArticle: 1, amount: 1 }], 'Magic'),
      err => !(err instanceof CartRejectError) && /without a result code/i.test(err.message),
    );

    // 3. Explicit XML token rejection clears cached token and throws TokenExpiredError (no unpaced auto-retry)
    let postCount = 0;
    let getCount = 0;
    const postedTokens = [];
    const site4 = browserSite({
      getToken: async () => 'OLD_TOK',
      fetchImpl: async (url, init) => {
        if (url.endsWith('/ShoppingCart')) {
          getCount += 1;
          return okReply(url, '<input name="__cmtkn" value="NEW_TOK">');
        }
        postCount += 1;
        postedTokens.push(init.body.get('__cmtkn'));
        if (postCount === 1) {
          return okReply(url, `<response><resultsCode>${b64('generalError')}</resultsCode><resultsMessage>${b64('Invalid CSRF token')}</resultsMessage></response>`);
        }
        return okReply(url, `<response><resultsCode>${b64('generalOK')}</resultsCode></response>`);
      },
    });
    await assert.rejects(
      site4.addSellerToCart([{ idArticle: 7, amount: 2 }], 'Magic'),
      err => err instanceof TokenExpiredError && !(err instanceof CartRejectError),
    );
    assert.equal(getCount, 0, 'cartRequest must not issue unpaced GETs on token expiry');
    assert.deepEqual(postedTokens, ['OLD_TOK']);
    // Caller-driven paced refreshToken + retry succeeds cleanly with NEW_TOK.
    await site4.refreshToken('Magic');
    await site4.addSellerToCart([{ idArticle: 7, amount: 2 }], 'Magic');
    assert.deepEqual(postedTokens, ['OLD_TOK', 'NEW_TOK']);
  } finally {
    globalThis.DOMParser = prevDOMParser;
  }
});

test('read path adaptively slows down on rate limits (debounced per wave) and recovers after clean responses', async () => {
  let cardCalls = 0;
  const events = [];
  const runner = createRunner({
    async cardPage() {
      cardCalls += 1;
      const n = cardCalls;
      // Simulate real network latency so both requests are genuinely in flight during the same wave.
      if (n <= 2) {
        await new Promise(r => setTimeout(r, 35));
        throw new RetryableError('HTTP 429', { cause: 'rate' });
      }
      return 'ok';
    },
  }, {
    concurrency: 2,
    intervalMs: 10,
    bucketIntervals: {},
    jitter: false,
    recoverEvery: 3,
    readRetryDelays: [40, 40, 40],
    log: e => events.push(e),
  });

  // Two concurrent failures in the same wave should trigger only ONE slowdown.
  await Promise.all([runner.call('cardPage'), runner.call('cardPage')]);
  const slowdowns = events.filter(e => e.type === 'pace-slowdown');
  assert.equal(slowdowns.length, 1, 'same-wave failures debounce to one multiplicative slowdown');
  const slowedMs = runner.pace.intervalMs;
  assert.ok(slowedMs > 10, `expected slowed interval > 10, got ${slowedMs}`);

  // Clean streak should recover pacing step-by-step back toward baseIntervalMs.
  for (let i = 0; i < 6; i += 1) await runner.call('cardPage');
  assert.ok(runner.pace.intervalMs < slowedMs, `expected recovery below ${slowedMs}, got ${runner.pace.intervalMs}`);
  assert.ok(events.some(e => e.type === 'pace-recover'));
});

test('products bucket enforces its own slower floor independently of faster cards pacing', async () => {
  const prodTimes = [];
  const cardTimes = [];
  const runner = createRunner({
    async productPage() { prodTimes.push(Date.now()); return 'ok'; },
    async cardPage() { cardTimes.push(Date.now()); return 'ok'; },
  }, {
    concurrency: 4,
    intervalMs: 10,
    bucketIntervals: { products: 110, cart: 2000 },
    jitter: false,
    readRetryDelays: [10],
  });

  await Promise.all([runner.call('productPage'), runner.call('productPage')]);
  assert.ok(prodTimes[1] - prodTimes[0] >= 100, `expected product gap >= 100ms, got ${prodTimes[1] - prodTimes[0]}`);

  await Promise.all([runner.call('cardPage'), runner.call('cardPage'), runner.call('cardPage')]);
  assert.ok(cardTimes[2] - cardTimes[0] < 100, `expected cards not blocked by product floor, got ${cardTimes[2] - cardTimes[0]}ms`);
});

test('browserSite sellerWants requests sortBy=price_asc by default', async () => {
  const prevDOMParser = globalThis.DOMParser;
  globalThis.DOMParser = class FakeDOMParser {
    parseFromString() {
      return {
        querySelector: sel => (sel === '#UserOffersTable' ? {} : null),
        querySelectorAll: () => [],
      };
    }
  };
  const urls = [];
  try {
    const site = browserSite({
      fetchImpl: async url => {
        urls.push(url);
        return { status: 200, ok: true, redirected: false, url, headers: new Headers(), text: async () => '' };
      },
    });
    await site.sellerWants('BigShop', '12345', 1, 'Magic');
    await site.sellerWants('BigShop', '12345', 2, 'Magic');
    assert.match(urls[0], /idWantslist=12345/);
    assert.match(urls[0], /sortBy=price_asc/);
    assert.doesNotMatch(urls[0], /site=/);
    assert.match(urls[1], /sortBy=price_asc/);
    assert.match(urls[1], /site=2/);
  } finally {
    globalThis.DOMParser = prevDOMParser;
  }
});
