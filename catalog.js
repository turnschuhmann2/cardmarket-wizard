/*
 * Builds the printing list for each Wants List entry from Cardmarket's public exports:
 * the singles catalogue of a game (idProduct -> idMetacard) and the daily price guide (lowest
 * listed price per printing, over every language, condition and seller country).
 */
(function (root) {
  'use strict';

  // Bump when the index layout changes, so a cached index from an older version is rebuilt.
  const INDEX_VERSION = 2;
  const toCents = value => (typeof value === 'number' && value > 0 ? Math.round(value * 100) : null);

  function indexCatalogue(catalogue, priceGuide) {
    const guide = new Map(priceGuide.priceGuides.map(row => [row.idProduct, row]));
    const metacards = {};
    const productMetacard = {};
    for (const product of catalogue.products) {
      const row = guide.get(product.idProduct) || {};
      productMetacard[product.idProduct] = product.idMetacard;
      (metacards[product.idMetacard] ||= []).push([product.idProduct, toCents(row.low), toCents(row['low-foil']), product.idExpansion]);
    }
    return {
      version: INDEX_VERSION, catalogueCreatedAt: catalogue.createdAt, priceGuideCreatedAt: priceGuide.createdAt,
      metacards, productMetacard,
    };
  }

  function guideLow(foil, low, lowFoil) {
    if (foil === 'Y') return lowFoil;
    if (foil === 'N') return low;
    return low === null ? lowFoil : lowFoil === null ? low : Math.min(low, lowFoil);
  }

  function planEntries(wants, index) {
    const warnings = [];
    const entries = wants.map(want => {
      const idMetacard = index.productMetacard[want.idProduct];
      const all = idMetacard ? index.metacards[idMetacard] : null;
      if (!all) {
        warnings.push(`${want.name}: printing ${want.idProduct} is not in the catalogue`);
        // A specific printing missing from the catalogue can still be matched by its own id.
        const printings = !want.anyPrinting && want.idProduct != null
          ? [{ idProduct: want.idProduct, idExpansion: null, guideLowCents: null }]
          : [];
        return { ...want, printings };
      }
      let printings = all;
      if (!want.anyPrinting) {
        printings = all.filter(([idProduct]) => idProduct === want.idProduct);
      } else if (want.expansion && want.expansion !== 'Any') {
        // The exports carry no expansion names. Read every printing rather than guess.
        warnings.push(`${want.name}: expansion restriction "${want.expansion}" not applied; all printings read`);
      }
      return {
        ...want, idMetacard,
        printings: printings.map(([idProduct, low, lowFoil, idExpansion]) => ({
          idProduct, idExpansion: idExpansion ?? null, guideLowCents: guideLow(want.foil, low, lowFoil),
        })),
      };
    });
    return { entries, warnings, priceGuideCreatedAt: index.priceGuideCreatedAt, catalogueCreatedAt: index.catalogueCreatedAt };
  }

  root.CardmarketCatalog = { indexCatalogue, planEntries, INDEX_VERSION };
})(typeof globalThis !== 'undefined' ? globalThis : this);
