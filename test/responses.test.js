'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../collector.js');
const { browserSite, createRunner, BlockedError, RefusedError, RetryableError } = globalThis.CardmarketCollector;

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
