# Benchmarks

Saved runs (the panel's **Download results and log**, collection part only) for testing the basket
optimiser on real card batches. They contain a Wants List and public offer data from Cardmarket;
keep them local.

```sh
node benchmarks/bench.js                 # every run here, 10 s per strategy
node benchmarks/bench.js --seconds 5 2026-11-20-1541-by-seller-expansion-groups.json
```

For each run it prints the quick basket, each search strategy on its own, and all strategies raced
(the panel races them for 20 s). Prices use the Germany-to-Germany shipping table in
`test/fixtures`.

| File | What it is |
| --- | --- |
| `2026-11-20-1335-every-printing-12-of-119-cards.json` | First per-printing run, stopped by Cloudflare: 12 of 119 cards read. Checks that a mostly empty run does not break anything. |
| `2026-11-20-1406-by-seller-unfiltered-card-pages.json` | By seller, 114 wants, card pages without expansion filter, 40 sellers asked. |
| `2026-11-20-1541-by-seller-expansion-groups.json` | By seller, 114 wants, card pages in expansion groups, 60 sellers asked. |

Results on 2026-11-20 (10 s per strategy):

| Run | Quick | steady | narrow | wide | from scratch |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1406 | 78,98 € | 76,36 € | 76,36 € | 76,09 € | 76,36 € |
| 1541 | 78,48 € | 76,09 € | 76,04 € | 76,72 € | 76,27 € |

Add new runs here, especially other Wants Lists, and compare before changing the optimiser.
