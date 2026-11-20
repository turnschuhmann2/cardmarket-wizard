// Runs the basket optimiser on saved runs and prints what each strategy reaches.
// Usage: node benchmarks/bench.js [--seconds 10] [run.json ...]   (default: every .json here)
'use strict';
const fs = require('fs');
const path = require('path');
require('../wizard.js');
const { createPlanner, parseShippingTable, STRATEGIES } = globalThis.CardmarketWizard;

const args = process.argv.slice(2);
const secondsAt = args.indexOf('--seconds');
const seconds = secondsAt >= 0 ? Number(args.splice(secondsAt, 2)[1]) : 10;
const files = args.length ? args : fs.readdirSync(__dirname).filter(name => name.endsWith('.json')).map(name => path.join(__dirname, name));
// Germany to Germany; runs from other countries need their own table.
const table = parseShippingTable(require('../test/fixtures/shipping-de-de.json'));
const euros = cents => (cents / 100).toFixed(2).padStart(7);

(async () => {
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const collection = data.collection || data;
    const planner = createPlanner(collection, table);
    const quick = planner.basket();
    const cards = quick.curve.at(-1)?.cards || 0;
    console.log(`\n${path.basename(file)}: ${collection.results.length} wants, ${cards} cards placed, ${quick.missing.length} missing`);
    console.log(`  quick basket          ${euros(quick.totalCents)} €  ${quick.parcels.length} sellers`);
    for (const strategy of STRATEGIES) {
      const started = Date.now();
      const found = await planner.optimise(planner.basket(), { timeMs: seconds * 1000, strategies: [strategy] });
      console.log(`  ${strategy.name.padEnd(20)}  ${euros(found.totalCents)} €  ${String(found.parcels.length).padStart(2)} sellers  ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    const raced = await planner.optimise(planner.basket(), { timeMs: seconds * 1000 });
    console.log(`  raced (${seconds} s total)    ${euros(raced.totalCents)} €  ${String(raced.parcels.length).padStart(2)} sellers  winner: ${raced.search.winner}`);
  }
})();
