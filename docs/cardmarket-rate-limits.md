# Cardmarket Rate Limits, Cloudflare Behaviour, and Workarounds

Empirical findings gathered during live probes and real-world runs of `cardmarket-wizard` (November 2026). Read this before changing any Cardmarket fetching, pagination, caching, cart-add logic, or live-testing workflow.

---

## 1. Core Architectural Constraint

**All live Cardmarket requests must run inside the user's real, logged-in Chrome session** via `bridge.js` (`credentials: 'include'`) on a `https://www.cardmarket.com/*` tab.

- **Direct HTTP / server-side fetches (e.g. `curl`, Node, Vercel backend):** Blocked immediately with `HTTP 403` by Cloudflare. Datacenter IPs are challenged aggressively and share rate limits across all users.
- **Playwright / automated browser profiles:** Repeatedly hit Cloudflare Turnstile challenge loops (`"Performing security verification"` / `"Just a moment…"`), even after manual clicks.
- **Per-IP scope:** Cloudflare rate limits and blocks apply to the user's **entire public IP**, not just one tab or profile. Never run live Cardmarket probes in a second browser while the user's extension is collecting.
- **No free/official offer API exists:**
  - Cardmarket's official API is closed to new apps.
  - Scryfall only exposes aggregate reference prices per printing, not per-seller offers.
  - Public S3 files (`downloads.s3.cardmarket.com` — catalogues and daily price guides) have **no Cloudflare or rate-limit issues**, but contain only product metadata and daily guide/trend/low prices, never individual listings.

---

## 2. Where Rate Limits and Cloudflare Blocks Kick In

Cardmarket/Cloudflare enforces **separate rules per URL family and HTTP method** rather than one global counter:

| Endpoint / Surface | Bucket (`collector.js`) | Observed Trigger & Threshold | Observed Response |
| --- | --- | --- | --- |
| `GET /en/<Game>/Products/...` (single printing or non-card product) | `products` | **Strictest GET limit.**<br>• Bursting at ~5–10 req/s triggered an immediate IP-wide `429` challenge.<br>• Paced at ~0.4 req/s (165 requests in 6.8 min), Cloudflare challenged after 12 of 119 cards.<br>• Sustained ceiling was **~0.3 req/s (~20 req/min)**: 82 requests produced 41 `429`s (~50% limited).<br>• Note: `?idProduct=<id>` redirects to the canonical slug, costing **2 requests** per uncached printing. | `HTTP 429` (`Access denied \| www.cardmarket.com used Cloudflare to restrict access`) with `Retry-After: 541` (~9 min), or `HTTP 429`/`403` with `cf-mitigated: challenge`. |
| `POST /en/<Game>/AjaxAction/*` (`Product_LoadMoreArticles`, `ShoppingCart_Add_*`) | `products` / `cart` | **Strictest POST limit — endpoint-scoped.**<br>• `Product_LoadMoreArticles` ("Show more") in Thorough mode tripped a Cloudflare challenge after **4 requests** on the very first card.<br>• `ShoppingCart_Add_AddArticlesFromProductPage` (~80 per-card POSTs at 1 s spacing) tripped a multi-minute (`>4 min`) block scoped specifically to that endpoint while normal GET pages still returned `200`. | `HTTP 403` with `cf-mitigated: challenge` (`Just a moment…`, answered in ~22 ms). Opening `/en/Magic` in a tab does **not** display a check because only `/AjaxAction/*` is blocked. |
| `GET /en/<Game>/Cards/<Card>?idExpansion=...` (card-level multi-printing page) | `cards` | **Separate bucket from `/Products`.** Loaded `200` normally *while* `/Products` was returning `429` (`Retry-After: 541`).<br>• Standard seller-first run (~132 card pages + ~108 seller pages = **240 requests in 4.5 min at 1 req/s**) succeeded with **0 retries, 0 waits, 0 refusals**.<br>• High-volume Thorough run (~679 requests) still tripped an IP-level `403` challenge (18 failed reads; still challenged 29 min later). | `200 OK` at moderate volume; eventually `HTTP 403` + `cf-mitigated: challenge` (no `429`, no `Retry-After`) at high volume (~400–680+ requests). |
| `GET /en/<Game>/Users/<Seller>/Offers/Singles?idWantslist=<id>` | `users` | **Separate bucket from `/Products`.** Loaded `200` (20 rows/page) while `/Products` was rate-limited. Ran cleanly alongside `/Cards` in the 240-request / 4.5-min run at 1 req/s. | `200 OK` at moderate volume; affected by IP-level `403` challenges during heavy (~680-req) Thorough runs. |
| `GET https://downloads.s3.cardmarket.com/...` | N/A (`background.js`) | None observed. | `200 OK` JSON (cached 24h). |

---

## 3. Response Classification & Gotchas

Implemented in `browserSite().request()` (`collector.js`):

1. **Cloudflare Challenge → `BlockedError`**
   - Detected when `cf-mitigated: challenge` header is present **or** `<title>` starts with `Just a moment`.
   - **Gotcha:** Cloudflare challenges can arrive as **either `HTTP 403` or `HTTP 429`**. Always check `cf-mitigated` / title *before* treating `429` as a plain rate limit.
2. **Hard Refusal → `RefusedError`**
   - Detected on `HTTP 403`, or any non-OK non-`429` response whose `<title>` matches `Attention Required` or `Access Denied`.
   - **Gotcha:** This is **not** a user-solvable CAPTCHA. Showing a "complete verification in another tab" prompt loops forever.
3. **Rate Limit / Transient Server Error → `RetryableError`**
   - `HTTP 429` (`cause: 'rate'`), `HTTP 5xx`, or GET `TypeError` network failures.
   - Parses `Retry-After` (both integer seconds and HTTP-date). Also flags `error.accessDenied` when a `429` carries `Attention Required` / `Access Denied`.
   - **Gotcha:** Never auto-retry `POST` requests on network errors or `5xx` (a `502`/`504` after Cardmarket processed the add would duplicate cart items). Only `429` (`cause === 'rate'`) may auto-retry on cart POSTs.
4. **Login Redirect → `BlockedError` with `{ login: true }`**
   - Redirect pathname matching `/(login|signup)`. Always stops immediately without retrying.

---

## 4. Cardmarket Pagination & Filter Quirks That Affect Request Volume

- **Logged-out cap:** Only the first **50 offers** are returned; "Show more" requires sign-in.
- **Logged-in pagination cap:** `Product_LoadMoreArticles` serves at most **300 articles** per filter combination (50 per page, sorted cheapest-first).
- **Card-page expansion truncation bug (`/Cards/<Card>`):**
  - With **no** `idExpansion` filter, Cardmarket only returns offers from the **~7 newest printings**, hiding cheaper older printings (e.g., *Swords to Plowshares* Dominaria Remastered at €0.75 was hidden behind €1.15 newer printings).
  - With **>20 expansions** selected in `idExpansion`, Cardmarket silently falls back to dropping older printings again.
  - With **≤20 expansions**, sorting across all selected printings works accurately. We use **`expansionGroupSize = 12`** (`collector.js`) as a safe margin.

---

## 5. How the Codebase Works Around These Limits

### A. Minimize Request Count and Avoid Throttled Endpoints (`collectBySellers`)

The default **By seller** method (`collector.js:collectBySellers`) cuts a ~114-card Wants List from **~900 `/Products` requests (~45–60 min)** down to **~280–310 `/Cards` + `/Users` requests (~2 min cold)** — keeping total volume safely below Cloudflare's high-volume `403` zone:

1. **Phase 1 — Card pages in expansion groups (`GET /Cards/...`, bucket `cards`):**
   - Groups a card's printings by expansion (`≤12` expansions per group), ordered cheapest guide price first.
   - Stops reading further groups once the next group's lowest guide price cannot beat the card's cutoff (`max(2 × target, target + €0.50)`, clamped by `maxPriceCents`).
   - Deduplicates concurrent identical cache keys in-flight (`inFlight` map in `cached()`).
   - In EU / multi-country mode, merges cached domestic pages at zero cost and only fetches an extra domestic page when page 1 is full (`≥45` rows) and fewer than `domesticMinOffers = 10` (`domesticProductMinOffers = 15` for products) domestic sellers survived crowding.
   - **Thorough mode** avoids `POST /AjaxAction/Product_LoadMoreArticles` completely by issuing 3 plain `GET /Cards/...` requests split by seller type (private / professional / powerseller = up to 3 × 50 = 150 non-overlapping offers per group).
2. **Phase 2 — Seller Wants-overlap pages (`GET /Users/<seller>/Offers/Singles?idWantslist=<id>&sortBy=price_asc`, bucket `users`):**
   - Ranks sellers by how many wanted cards they offer under cutoff.
   - Requests seller overlap **sorted cheapest-first (`sortBy=price_asc`)** and stops paging a seller early as soon as ascending row prices exceed the highest remaining `max(cutoff, target + €1.50)` ceiling among cards that seller has not yet supplied cheaply (falling back to full paging up to `maxSellerPages` if rows are unsorted or any card has no cutoff).
   - Fetches in smaller adaptive batches: **20 sellers initially**, then **+10 per batch** (Quick: `maxSellerPages = 8`; Thorough: `80 + 20`, `maxSellerPages = 15`), stopping as soon as a batch improves the basket by less than `improvementCents` (`€1.00` default; `€0.20` in Thorough) or hits `sellerLimit`.
   - In multi-game runs, skips querying a seller for another game where they had zero Phase-1 appearances across `≥5` wanted cards of that game.
3. **Bulk Cart Writes (`POST /AjaxAction/ShoppingCart_Add_AddArticlesFromUserOffers`, bucket `cart`):**
   - Sends **1 POST per seller** (~15 requests) instead of 1 POST per card (~118 requests), strictly sequential (`concurrency: 1`).
   - Falls back to per-item `ShoppingCart_Add_AddArticlesFromProductPage` only on deterministic XML business-logic rejections — **never** on `RetryableError`, `RefusedError`, or `TypeError`, where partial/duplicate cart state is ambiguous.

### B. Pacing, Buckets, Adaptive Backoff, and Cooldown Persistence (`createRunner` in `collector.js`, `app.js`, `background.js`)

- **Global & per-bucket pacing (`pacer`):**
  - Default `intervalMs = 400` (**Fast & adaptive**: ~2.5 req/s with ±15% jitter; user-selectable 400 / 600 / 1000 / 2000 ms), `concurrency = 4` for read buckets so 0.8–1.5 s network RTT does not stall pacing.
  - Strict per-bucket floors protect sensitive endpoints regardless of global speed:
    - **`products: 3000`** (`≤0.33 req/s` on `GET /Products/*`, staying inside the ~0.3 req/s empirical ceiling).
    - **`cart: 2000`** (at least 2 s between cart POSTs, with `concurrency: 1` and `intervalMs >= 1000` in `app.js`).
  - `pace.holds` tracks `Retry-After` holds **per bucket** (`products`, `cards`, `users`, `cart`) so a hold on one bucket does not needlessly stall unrelated buckets.
- **Adaptive AIMD backoff on reads (`createRunner.read`):**
  - On any rate-limit (`429`), Cloudflare challenge (`BlockedError`), or refusal (`RefusedError`), slows pacing multiplicatively (`1.75×`, debounced per failure wave, up to 10 s) on both the global pacer and the hit bucket.
  - After **25 consecutive clean `200 OK` responses** on a bucket, gently recovers pacing (`0.9×`) back toward the user's base `intervalMs` (never below per-bucket floors).
- **Read path retry schedule (`app.js` → `createRunner.read`):**
  - `readRetryDelays: [5000, 10000, 20000, 40000, 80000]` (5 retries = **2 min 35 s** total backoff) within `readRetryBudgetMs = 180000` (**3 min**).
  - Retries `RetryableError`, `RefusedError`, and non-login `BlockedError`; stops immediately on `login: true`.
  - Respects `Math.max(delay, Retry-After)`. If `until` exceeds the 3-minute budget and a `Retry-After` was sent, persists `collectionRetryAfter` in `chrome.storage.local` (`onDeferred`), stops cleanly, and prevents restarts until that timestamp passes (`app.js`).
  - After all 5 automatic retries fail, pauses via a single shared `pause` promise (`promptUser` / `waitForUser`) so concurrent slots never overwrite `Continue` handlers.
- **Cart path retry schedule (`createRunner.call`):**
  - First `BlockedError` auto-waits **10 s** (`app.js:waitForUser`), slows pacing by `1.5×` (up to 10 s), and retries once; subsequent failures pause for manual **Continue**.
  - Stops after **3 consecutive `RefusedError`s** or **10 consecutive pauses without success**.
  - Never retries cart `5xx` (only `429` with `cause === 'rate'`).
- **Cached bridge tab routing (`background.js`):**
  - Caches the active Cardmarket bridge tab ID (`cachedBridgeTabId`) for idempotent `GET`/`cm-token` requests, eliminating a `chrome.tabs.query` + `cm-ping` IPC roundtrip on every read. Non-idempotent `POST` requests still validate the bridge tab before sending.

### C. Caching to Avoid Repeat Fetches

- **Query cache (`q:*`) and collection cache (`bwCol:*`):** **8-hour TTL** (`CACHE_MAX_AGE_MS = 8 * 60 * 60 * 1000`). Compute Basket always reuses cached offers when fresh; price limits, cuts, region/shipping changes, and optimizer re-runs cost **0 Cardmarket requests**.
- **Product URL redirect cache (`bwPaths`):** Caches `?idProduct=<id>` → canonical slug URL so printing lookups don't pay 2 requests per redirect.
- **Shipping tables & S3 catalogues:** Cached **24 hours** in `background.js` / `chrome.storage.local`.

---

## 6. Rules for Future Agents

1. **Do not switch card collection back to `/Products/*` or `POST /AjaxAction/Product_LoadMoreArticles`.** Both are aggressively throttled by Cloudflare.
2. **Keep non-card product volume modest and preserve the `products >= 3000ms` bucket floor.** Accessories (sleeves, deck boxes) have no `/Cards/` equivalent and must hit `GET /Products/*` (bucket `products`), which is fine for a few items per run but will hit `429` if scaled or sped up past ~0.3 req/s.
3. **Do not make Thorough mode the default.** In live benchmarks, Thorough (~680 reqs) triggered a 30-minute `403` Cloudflare challenge while saving only €0.32 over Fast.
4. **Never exceed ~15–20 expansions per `/Cards` query** (keep `expansionGroupSize <= 12`) or Cardmarket will silently hide older cheap printings.
5. **Never bypass `createRunner` / `pacer` or add unpaced parallel requests** (especially for cart POSTs or `/AjaxAction/*`).
6. **Never auto-retry non-idempotent cart POSTs on `5xx` or network errors**, and never blindly fall back to per-item adds after an ambiguous bulk-add error.
7. **Never run automated live probes against `cardmarket.com` concurrently with the user's browser**, and prefer offline unit tests (`node --test test/*.test.js`) and saved benchmark snapshots (`benchmarks/bench.js`) for development.
