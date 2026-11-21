# AGENTS.md — Cardmarket Better Wizard

Unofficial Chrome MV3 extension (vanilla JS, no build step) that collects Cardmarket offers across Magic: The Gathering, Yu-Gi-Oh!, and non-card products, optimizes cross-game/multi-list baskets in a Web Worker, and adds chosen orders to the Cardmarket cart.

## Architecture

- `manifest.json` — Chrome MV3 manifest.
- `background.js` — Service worker: downloads/caches S3 catalogues & price guides (24h), fetches per-country shipping tables, relays `cm-fetch` / `cm-token` strictly from `app.html` to a logged-in Cardmarket tab.
- `bridge.js` — Content script on `https://www.cardmarket.com/*` that executes credentialed `GET`/`POST` fetches inside the user's logged-in session.
- `content.js` — Lightweight UI entry bar on Cardmarket Wants List and non-card Product pages.
- `catalog.js` — Matches Wants List entries against Cardmarket's S3 catalogue and daily price guide (`idMetacard`, `idProduct`, `idExpansion`).
- `collector.js` — HTML/XML parsers, `browserSite`, paced/retryable `createRunner`, per-printing `collect`, and seller-first `collectBySellers`.
- `wizard.js` — Shipping table pricing, greedy quick basket, multi-strategy seller search (`optimise`), recommended cuts, and scoped price-limit suggestions.
- `optimizer-worker.js` — Web Worker wrapper around `wizard.js` with job-ID cancellation.
- `app.html`, `app.css`, `app.js` — Full-page extension UI (`chrome-extension://.../app.html`).
- `test/*.test.js` — Offline Node unit tests (`node --test test/*.test.js`).
- `benchmarks/bench.js` — Offline optimizer benchmarks on local JSON exports.

## Commands

```sh
# Run all unit tests (fast, offline, zero network calls)
node --test test/*.test.js

# Syntax check edited files
node --check app.js collector.js wizard.js background.js bridge.js content.js catalog.js optimizer-worker.js
```

## Non-Negotiable Cardmarket Rate-Limit & Cloudflare Rules

Read **[`docs/cardmarket-rate-limits.md`](docs/cardmarket-rate-limits.md)** before touching any fetching, pagination, caching, cart-add, or live-testing code. Key invariants:

1. **Stay inside the user's Chrome session (`bridge.js`).** Direct server/headless/Playwright fetches get `403`/Turnstile loops from Cloudflare.
2. **Avoid `/Products/*` and `POST /AjaxAction/Product_LoadMoreArticles` for cards.** Cloudflare enforces separate per-path rules:
   - `/Products/*` throttles around **~0.3 req/s (~20 req/min)** with `HTTP 429` + `Retry-After: 541` (~9 min).
   - `POST /AjaxAction/*` ("Show more" and cart adds) triggers endpoint-scoped `HTTP 403` challenges after as few as **4 requests** (show more) or ~80 unspaced cart POSTs.
   - `/Cards/*` and `/Users/*/Offers/Singles?idWantslist=...` are in separate buckets and reliably handle **~240 requests in ~4.5 min at 1 req/s** (`collectBySellers` default).
3. **Keep `expansionGroupSize <= 12` on `/Cards/*` queries.** Unfiltered `/Cards` pages only show the ~7 newest printings, and `>20` selected expansions silently drop older printings again.
4. **Always route Cardmarket HTTP calls through `createRunner` / `pacer`.** Keep cart POSTs bulk per-seller (`addSellerToCart`) with `bucketIntervals.cart >= 2000` ms, never auto-retry cart POSTs on `5xx`/network errors, and never blindly fall back to per-item adds after ambiguous bulk errors (`RetryableError`, `RefusedError`, `TypeError`).
5. **Classify responses carefully (`browserSite`).** Check `cf-mitigated: challenge` and `<title>Just a moment…</title>` *before* treating `429` as a plain rate limit; treat `403`/`Attention Required`/`Access Denied` as `RefusedError` (not a solvable CAPTCHA); honour `Retry-After` per bucket and persist long holds in `collectionRetryAfter`.
6. **Do not make Thorough mode the default** (~680 requests triggered a 30-min `403` block in live tests for minimal savings) and **do not run live probes concurrently** with the user's browser (Cloudflare blocks are per-IP).
7. **Prefer offline tests and cached runs.** Preserve the 8-hour `CACHE_MAX_AGE_MS` cache so recomputes, price limits, cuts, and region/shipping changes make 0 requests.
