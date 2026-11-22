/*
 * Basket & left-out export formatting helpers (Plain text and Archidekt).
 * Pure, DOM-free module loaded by app.html and unit-tested directly in Node.
 */
(function (root) {
  'use strict';

  function gameLabel(game) {
    return game === 'YuGiOh' ? 'Yu-Gi-Oh!' : 'Magic';
  }

  function groupKeyFor(entry) {
    if (entry.kind === 'product') return 'products';
    if (entry.kind === 'token') return `token:${entry.listName || 'Default'}`;
    const game = entry.game || 'Magic';
    if (entry.listId != null && entry.listId !== '') return `list:${game}:${entry.listId}`;
    if (entry.listName) return `name:${game}:${entry.listName}`;
    return `game:${game}`;
  }

  function baseGroupLabel(entry) {
    if (entry.kind === 'product') return 'Extra Products';
    if (entry.kind === 'token') {
      return entry.listName && entry.listName !== 'Default' ? `Tokens: ${entry.listName}` : 'Magic Tokens';
    }
    const game = entry.game || 'Magic';
    if (entry.listName) return entry.listName;
    if (entry.listId != null && entry.listId !== '') return `${gameLabel(game)} Wants #${entry.listId}`;
    return gameLabel(game);
  }

  // Preserves listId/listName per item so identical cards across different Wants Lists stay separable.
  function collectBasketEntries(parcels) {
    const map = new Map();
    for (const [order, parcel] of (parcels || []).entries()) {
      for (const item of parcel.items || []) {
        const game = item.game || 'Magic';
        const kind = item.kind || 'card';
        const listId = item.listId ?? null;
        const listName = item.listName ?? null;
        const id = `${parcel.seller}|${game}|${kind}|${listId ?? ''}|${listName ?? ''}|${item.idProduct ?? ''}|${item.name}|${!!item.foil}`;
        const entry = map.get(id) || {
          name: item.name,
          game,
          kind,
          listId,
          listName,
          idProduct: item.idProduct ?? null,
          foil: !!item.foil,
          seller: parcel.seller,
          order,
          quantity: 0,
        };
        entry.quantity += 1;
        map.set(id, entry);
      }
    }
    return [...map.values()];
  }

  function collectLeftOutEntries(leftOut) {
    return (leftOut || []).map((r, order) => ({
      name: r.name,
      game: r.game || 'Magic',
      kind: r.kind || 'card',
      listId: r.listId ?? null,
      listName: r.listName ?? null,
      idProduct: r.idProduct ?? null,
      foil: false,
      seller: null,
      order,
      quantity: r.amount || 1,
    }));
  }

  function isArchidektEligible(entry) {
    return (entry.game || 'Magic') === 'Magic' && entry.kind !== 'product' && entry.kind !== 'token';
  }

  // Groups entries by Wants List (and Extra Products / Tokens for plain export).
  // For 'archidekt', only Magic non-product, non-token cards are included.
  function groupExportEntries(entries, format = 'archidekt') {
    const eligible = format === 'archidekt'
      ? (entries || []).filter(isArchidektEligible)
      : (entries || []);

    const groups = new Map();
    for (const entry of eligible) {
      const key = groupKeyFor(entry);
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          game: entry.kind === 'product' ? null : (entry.game || 'Magic'),
          kind: entry.kind || 'card',
          listId: entry.listId ?? null,
          listName: entry.listName ?? null,
          label: baseGroupLabel(entry),
          entries: [],
          quantity: 0,
          sellers: new Set(),
        };
        groups.set(key, group);
      }
      group.entries.push(entry);
      group.quantity += entry.quantity || 1;
      if (entry.seller) group.sellers.add(entry.seller);
    }

    const list = [...groups.values()];
    // Disambiguate duplicate list names if two different Wants Lists share the same display name.
    const labelCounts = new Map();
    for (const g of list) labelCounts.set(g.label, (labelCounts.get(g.label) || 0) + 1);
    return list.map(g => ({
      key: g.key,
      game: g.game,
      kind: g.kind,
      listId: g.listId,
      listName: g.listName,
      label: labelCounts.get(g.label) > 1 && g.listId != null ? `${g.label} (#${g.listId})` : g.label,
      entries: g.entries,
      quantity: g.quantity,
      sellerCount: g.sellers.size,
    }));
  }

  function sanitizeCategory(text) {
    return String(text || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
  }

  function formatArchidektExport(entries, foundPrintings = {}, { categoryBy = 'seller' } = {}) {
    const magicOnly = (entries || []).filter(isArchidektEligible);
    const labelByKey = categoryBy === 'list'
      ? new Map(groupExportEntries(magicOnly, 'archidekt').map(g => [g.key, g.label]))
      : null;

    const merged = new Map();
    for (const entry of magicOnly) {
      let category = '';
      if (categoryBy === 'list') {
        category = sanitizeCategory(labelByKey.get(groupKeyFor(entry)) || baseGroupLabel(entry));
      } else if (categoryBy === 'seller') {
        category = sanitizeCategory(entry.seller);
      }
      const key = `${category}|${entry.idProduct ?? ''}|${entry.name}|${!!entry.foil}`;
      const existing = merged.get(key);
      if (existing) {
        existing.quantity += entry.quantity || 1;
        existing.order = Math.min(existing.order, entry.order ?? 0);
      } else {
        merged.set(key, {
          name: entry.name,
          idProduct: entry.idProduct ?? null,
          foil: !!entry.foil,
          category,
          order: entry.order ?? 0,
          quantity: entry.quantity || 1,
        });
      }
    }

    const lines = [...merged.values()]
      .sort((a, b) => a.order - b.order || a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
      .map(entry => {
        const printing = entry.idProduct != null ? foundPrintings[entry.idProduct] : null;
        const card = printing ? `${printing.name} (${printing.set}) ${printing.number}` : entry.name;
        return `${entry.quantity}x ${card}${entry.foil ? ' *F*' : ''}${entry.category ? ` [${entry.category}]` : ''}`;
      });

    return {
      text: lines.join('\n'),
      count: magicOnly.reduce((sum, e) => sum + (e.quantity || 1), 0),
    };
  }

  function formatPlainExport(entries, { groupBy = 'auto' } = {}) {
    const list = entries || [];
    const groups = new Map();
    const byList = groupBy === 'list' || (groupBy === 'auto' && groupExportEntries(list, 'plain').length > 1);

    if (byList) {
      for (const g of groupExportEntries(list, 'plain')) {
        const counts = new Map();
        for (const e of g.entries) counts.set(e.name, (counts.get(e.name) || 0) + (e.quantity || 1));
        const prefix = (g.kind === 'product' || g.kind === 'token')
          ? g.label
          : `${g.label}${g.game ? ` (${gameLabel(g.game)})` : ''}`;
        groups.set(prefix, counts);
      }
    } else {
      for (const e of list) {
        const g = e.kind === 'product'
          ? 'Extra Products'
          : e.kind === 'token'
            ? baseGroupLabel(e)
            : gameLabel(e.game || 'Magic');
        if (!groups.has(g)) groups.set(g, new Map());
        const m = groups.get(g);
        m.set(e.name, (m.get(e.name) || 0) + (e.quantity || 1));
      }
    }

    const multi = groups.size > 1;
    const text = [...groups].map(([heading, map]) => {
      const lines = [...map].map(([name, qty]) => `${qty} ${name}`).join('\n');
      return multi ? `# ${heading}\n${lines}` : lines;
    }).join('\n\n');

    return {
      text,
      count: list.reduce((sum, e) => sum + (e.quantity || 1), 0),
    };
  }

  function safeExportFilename(label, suffix = 'export') {
    const cleaned = String(label || '')
      .normalize('NFKD')
      .replace(/[^\w\s-]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 64);
    return `${cleaned || 'cardmarket-list'}-${suffix}.txt`;
  }

  // ---- Basket snapshots (exact basket after removals, saved in JSON exports and on cart add) ----
  const SNAPSHOT_VERSION = 1;

  const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));

  // tokenResult.bySeller is a Map, which JSON (and chrome.storage) would silently turn into {}.
  function serializeTokenResult(tokenResult) {
    if (!tokenResult) return null;
    const bySeller = tokenResult.bySeller instanceof Map ? [...tokenResult.bySeller.entries()] : tokenResult.bySeller;
    return clone({ ...tokenResult, bySeller });
  }

  function reviveTokenResult(raw) {
    if (!raw || !Array.isArray(raw.assignments)) return null;
    const bySeller = raw.bySeller instanceof Map
      ? raw.bySeller
      : Array.isArray(raw.bySeller)
        ? new Map(raw.bySeller.filter(entry => Array.isArray(entry) && entry.length === 2))
        : new Map(Object.entries(raw.bySeller || {}));
    return { ...raw, bySeller };
  }

  // Magic card idProducts that Archidekt exports need Scryfall set codes for.
  function snapshotPrintingIds(basket) {
    const ids = new Set();
    for (const parcel of basket?.parcels || []) {
      for (const item of parcel.items || []) {
        if (isArchidektEligible({ game: item.game, kind: item.kind || 'card' }) && item.idProduct) ids.add(item.idProduct);
      }
    }
    return [...ids];
  }

  // `basket`, `tokenResult` and `removedItems` reproduce the live state (so removals stay undoable);
  // `finalBasket` is the rendered result and the fallback when the live inputs no longer reproduce it.
  function createBasketSnapshot({
    basket, finalBasket, tokenResult = null, includeTokensInBasket = true, removedItems = [], tables = null,
    leftOut = [], cuts = [], overlap = [], countsByScope = {}, buySellers = null, activeLimits = [], manualCuts = [],
    shipTo = null, selectionSig = null, collectionFinishedAt = null, printings = {}, orderedAt = null, createdAt = Date.now(),
  } = {}) {
    if (!finalBasket?.parcels) throw new Error('No basket to snapshot.');
    const parcelCount = finalBasket.parcels.length;
    const n = Number(buySellers);
    return {
      version: SNAPSHOT_VERSION,
      createdAt,
      orderedAt,
      selectionSig,
      collectionFinishedAt,
      shipTo,
      buySellers: parcelCount ? Math.min(parcelCount, Math.max(1, Number.isFinite(n) && n > 0 ? Math.round(n) : parcelCount)) : 0,
      includeTokensInBasket: !!includeTokensInBasket,
      basket: clone(basket || finalBasket),
      finalBasket: clone(finalBasket),
      tokenResult: serializeTokenResult(tokenResult),
      removedItems: clone(removedItems || []),
      tables: clone(tables),
      leftOut: clone(leftOut || []),
      cuts: clone(cuts || []),
      overlap: clone(overlap || []),
      countsByScope: clone(countsByScope || {}),
      activeLimits: clone(activeLimits || []),
      manualCuts: clone(manualCuts || []),
      printings: Object.fromEntries(
        snapshotPrintingIds(finalBasket)
          .filter(id => printings && printings[id])
          .map(id => [id, { ...printings[id] }])
      ),
    };
  }

  const validBasket = b => !!b && Array.isArray(b.parcels) && b.parcels.every(p => p && typeof p.seller === 'string' && Array.isArray(p.items));

  // Returns a normalized snapshot or null when the payload is missing / malformed / from a newer version.
  function readBasketSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version !== SNAPSHOT_VERSION) return null;
    if (!validBasket(raw.finalBasket)) return null;
    const basket = validBasket(raw.basket) ? raw.basket : raw.finalBasket;
    const parcelCount = raw.finalBasket.parcels.length;
    const n = Number(raw.buySellers);
    return {
      ...raw,
      basket,
      tokenResult: reviveTokenResult(raw.tokenResult),
      removedItems: Array.isArray(raw.removedItems) ? raw.removedItems.filter(r => r && r.item && typeof r.seller === 'string') : [],
      leftOut: Array.isArray(raw.leftOut) ? raw.leftOut : [],
      cuts: Array.isArray(raw.cuts) ? raw.cuts : [],
      overlap: Array.isArray(raw.overlap) ? raw.overlap : [],
      countsByScope: raw.countsByScope && typeof raw.countsByScope === 'object' ? raw.countsByScope : {},
      activeLimits: Array.isArray(raw.activeLimits) ? raw.activeLimits : [],
      manualCuts: Array.isArray(raw.manualCuts) ? raw.manualCuts : [],
      printings: raw.printings && typeof raw.printings === 'object' ? raw.printings : {},
      buySellers: parcelCount ? Math.min(parcelCount, Math.max(1, Number.isFinite(n) && n > 0 ? Math.round(n) : parcelCount)) : 0,
    };
  }

  // Cheap fingerprint to check a rebuilt basket matches the saved one exactly.
  function basketFingerprint(basket) {
    if (!basket?.parcels) return '';
    const parcels = basket.parcels.map(p => `${p.seller}:${p.shippingCents ?? ''}:${(p.items || [])
      .map(i => `${i.kind || 'card'}/${i.idArticle ?? ''}/${i.idProduct ?? ''}/${i.listId ?? ''}/${i.priceCents ?? ''}`)
      .sort()
      .join(',')}`);
    return `${basket.totalCents ?? ''}|${parcels.join(';')}`;
  }

  root.CardmarketExport = {
    SNAPSHOT_VERSION,
    createBasketSnapshot,
    readBasketSnapshot,
    basketFingerprint,
    snapshotPrintingIds,
    collectBasketEntries,
    collectLeftOutEntries,
    groupExportEntries,
    formatArchidektExport,
    formatPlainExport,
    safeExportFilename,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
