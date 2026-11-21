# Cardmarket Better Wizard

An unofficial Chrome extension for Cardmarket (**Magic: The Gathering** and **Yu-Gi-Oh!**) with a full-page web-app interface. It compares captured offers including per-country shipping and commercial product shipping rates, combines sellers across multiple Wants Lists, games, and accessories (like sleeves or deck boxes), and runs all optimization off the main thread in a Web Worker.

## Install

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select this `cardmarket-wizard` folder (`manifest.json`).
3. Sign in to Cardmarket in a browser tab.
4. Click the **Cardmarket Better Wizard** extension icon in your toolbar, or click **Open Better Wizard** on any Magic / Yu-Gi-Oh! Wants List page.

After updating files, click **Reload** on the extension card in `chrome://extensions` and refresh open Cardmarket tabs.

## How it works

1. **Select Wants Lists & Extra Products:**
   - Add Magic and/or Yu-Gi-Oh! Wants Lists by pasting a Cardmarket Wants List URL or clicking **Open Better Wizard** on any Wants List page; check the lists to include or remove any list with **×**.
   - Add non-card products (sleeves, deck boxes, playmats, boosters, etc.) by pasting a Cardmarket product URL or clicking **+ Add to Better Wizard** directly on any Cardmarket non-single product page.
2. **Choose Seller Region:**
   - **Germany**, **All Europe**, or **Custom** (with a **DE + Neighbours** preset). Shipping tables are loaded per seller country automatically.
3. **Compute Basket & 8-hour Smart Cache:**
   - **Compute Basket** is the primary action.
   - If cached offers for your selection are **under 8 hours old**, it computes immediately from cache with zero requests.
   - If the cache is missing, incomplete, or **older than 8 hours**, an alert confirms that it will refetch all selected cards and products first (or lets you compute from the older cache if available).
   - Use **Refetch offers** at any time to force a fresh fetch.
4. **Scoped Price Limits (Per-game & Per-list):**
   - Open **Price Limits → Estimate limits** and pick a scope (**All cards**, **Magic only**, **Yu-Gi-Oh! only**, or any individual **Wants List**).
   - Estimates stream live from the Web Worker with loading skeletons. Applying or removing any limit immediately recomputes the **entire combined basket** from cache.
5. **Export or Add to Cart:**
   - **Copy list** exports plain text (grouped by game/products when combined).
   - **Copy for Archidekt** exports Magic cards with Scryfall set codes, collector numbers, foil flags, and seller categories.
   - **Add to Cardmarket cart** adds items per seller, then reads back actual cart shipping and remembers tracked-only sellers automatically.

## Development

No build step is required. Run unit tests with:

```sh
node --test test/*.test.js
```

Benchmark the optimizer against a saved export:

```sh
node benchmarks/bench.js benchmarks/2026-11-20-1541-by-seller-expansion-groups.json
```
