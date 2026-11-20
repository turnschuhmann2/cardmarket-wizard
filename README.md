# Cardmarket Better Wizard

An unofficial Chrome extension for Magic: The Gathering Wants Lists on Cardmarket. It compares captured offers, including estimated shipping, to build a basket and show how much of the list you can buy from just a few sellers. It uses your signed-in Cardmarket tab; there is no separate API key or backend to set up.

## Install

1. Clone or download this repository and unzip it if needed.
2. In Chrome, open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Sign in to Cardmarket and open or refresh a **Magic Wants List**. The **Better Wizard** panel appears on that page.

After updating the source, click **Reload** on the extension card in `chrome://extensions`, then refresh the Wants List.

## Build a basket

1. Select the seller country. Germany is the default for sellers and shipping; open **Settings** to change the destination or enter known tracked-only sellers.
2. Start with **Quick**, then click **Collect offers**. Quick uses card pages and selected sellers' inventories. **Thorough** reads more offers and sellers; **Every printing** checks eligible product pages individually and is the slowest option.
3. Review the estimated total, the **Coverage per card** report, and the seller table. Use **Buy from first N sellers** for a smaller basket. Optional exclusions let you leave out cards that add disproportionate shipping costs.
4. Click **Copy for Archidekt** to copy the selected cards for text import. It includes quantities, set codes and collector numbers where Scryfall can identify the printing, and flags foil copies. Review cards exported by name only before importing.
5. Click **Add to cart** only when ready and confirm the prompt. Check the actual items and shipping in Cardmarket before placing an order. The wizard does not complete checkout.

## Resume or revisit a run

- **Stop** ends collection and keeps successful reads cached. Use **Collect offers** to reuse eligible cached results; **Collect fresh** starts without those cached reads.
- Use **Saved runs** to reopen a basket or **Open file…** to load a previous JSON export. Saved prices are snapshots, not live quotes.
- **Download results and log (JSON)** is useful for troubleshooting. Keep exports private: they can contain Wants Lists, seller and article identifiers, and cart activity.

## Limits

Prices are **the best found among captured offers**, not a guarantee of the global minimum. Some views are capped or skipped, and Cardmarket can interrupt or block requests. Stop if verification keeps appearing or access is refused. A stopped run can still produce a partial result. Shipping is estimated from the selected route and known tracked-only restrictions; the cart or checkout may show different shipping or fees. Use the extension only where permitted by Cardmarket.

## Development

No build step is required. With Node.js installed, run `node --test test/*.test.js` from this folder. To benchmark the optimizer against a local Germany-to-Germany export, run `node benchmarks/bench.js /path/to/export.json`. Personal exports and captured HTML are not included in the repository.
