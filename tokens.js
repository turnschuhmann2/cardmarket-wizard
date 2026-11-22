/*
 * Magic Token parser, S3 catalogue matcher, and deck-scoped shipping-aware optimizer.
 * Pure, DOM-free UMD module loaded by app.html and unit-tested directly in Node.
 */
(function (root) {
  'use strict';

  const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
  const COLOR_WORDS = {
    white: 'W',
    blue: 'U',
    black: 'B',
    red: 'R',
    green: 'G',
  };
  const KNOWN_TRAITS = [
    'first strike',
    'double strike',
    "can't block",
    'cant block',
    'flying',
    'lifelink',
    'deathtouch',
    'trample',
    'haste',
    'vigilance',
    'menace',
    'reach',
    'defender',
    'hexproof',
    'indestructible',
    'infect',
    'enchantment',
    'decayed',
    'prowess',
    'skulk',
    'ward',
    'toxic',
    'counter',
    'death',
  ];

  function canonicalColors(set) {
    return COLOR_ORDER.filter(c => set.has(c)).join('');
  }

  function normalizeTrait(t) {
    const lower = t.toLowerCase().trim();
    if (lower === 'death') return 'deathtouch';
    if (lower === 'cant block') return "can't block";
    return lower;
  }

  function parseSpecTokens(specText) {
    let text = String(specText || '').trim();
    let pt = null;
    const colors = new Set();
    let isColorless = false;
    let isArtifact = false;
    const traits = new Set();

    // Extract power/toughness like 1/1, 2/2, 0/1, */*, X/X
    text = text.replace(/\b(\d+|\*|X)\s*\/\s*(\d+|\*|X)\b/gi, (_, p, t) => {
      if (!pt) pt = `${p.toUpperCase()}/${t.toUpperCase()}`;
      return ' ';
    });

    // Extract multi-word traits first
    for (const trait of KNOWN_TRAITS) {
      if (!trait.includes(' ')) continue;
      const rx = new RegExp(`\\b${trait.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (rx.test(text)) {
        traits.add(normalizeTrait(trait));
        text = text.replace(rx, ' ');
      }
    }

    // Extract full color words & colorless/artifact
    text = text.replace(/\b(white|blue|black|red|green)\b/gi, m => {
      colors.add(COLOR_WORDS[m.toLowerCase()]);
      return ' ';
    });
    text = text.replace(/\bcolorless\b/gi, () => {
      isColorless = true;
      return ' ';
    });
    text = text.replace(/\bartifact\b/gi, () => {
      isArtifact = true;
      isColorless = true;
      return ' ';
    });

    // Extract slash-separated single-letter colors like W/B, R/W, B/G
    text = text.replace(/\b([WUBRGCA](?:\/[WUBRGCA])+)\b/g, m => {
      for (const ch of m.split('/')) {
        if (ch === 'C') isColorless = true;
        else if (ch === 'A') { isArtifact = true; isColorless = true; }
        else colors.add(ch);
      }
      return ' ';
    });

    // Extract compact uppercase color codes in Cardmarket specs (W, U, B, R, G, C, A, RW, WB, UR, WUBRG...)
    text = text.replace(/(?:^|[\s,(])([WUBRG]{1,5}|C|A)(?=$|[\s,)])/g, (full, code) => {
      if (code === 'C') isColorless = true;
      else if (code === 'A') { isArtifact = true; isColorless = true; }
      else for (const ch of code) colors.add(ch);
      return full.slice(0, full.length - code.length);
    });

    // Extract single-word traits
    for (const trait of KNOWN_TRAITS) {
      if (trait.includes(' ')) continue;
      const rx = new RegExp(`\\b${trait.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (rx.test(text)) {
        traits.add(normalizeTrait(trait));
        text = text.replace(rx, ' ');
      }
    }

    return {
      colors: canonicalColors(colors),
      isColorless: colors.size === 0 && isColorless,
      isArtifact,
      pt,
      traits: [...traits].sort(),
      remainder: text.replace(/\b(?:and|or)\b/gi, ' ').replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim(),
    };
  }

  function cleanFaceName(text) {
    return String(text || '')
      .replace(/\s*\(V\.\d+\)\s*$/i, '')
      .replace(/\bTokens?\b/gi, ' ')
      .replace(/[,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function parseCatalogFace(rawFace) {
    const cleaned = String(rawFace || '').replace(/\s*\(V\.\d+\)\s*$/i, '').trim();
    const parenParts = [];
    const withoutParens = cleaned.replace(/\(([^)]+)\)/g, (_, inner) => {
      parenParts.push(inner);
      return ' ';
    });
    const spec = parseSpecTokens(parenParts.join(' '));
    const isEmblem = /\bemblem\b/i.test(withoutParens);
    const baseName = cleanFaceName(withoutParens);
    return {
      raw: cleaned,
      baseName,
      isEmblem,
      colors: spec.colors,
      isColorless: spec.isColorless,
      isArtifact: spec.isArtifact,
      pt: spec.pt,
      traits: spec.traits,
    };
  }

  function buildTokenCatalog(rawTokens) {
    const all = [];
    const byId = new Map();
    const byFaceName = new Map();
    for (const row of rawTokens || []) {
      const [idProduct, name, lowCents, lowFoilCents, idExpansion, idMetacard] = Array.isArray(row)
        ? row
        : [row.idProduct, row.name, row.lowCents ?? null, row.lowFoilCents ?? null, row.idExpansion ?? null, row.idMetacard ?? null];
      if (!idProduct || !name) continue;
      const rawFaces = String(name).split(/\s+\/\/?\s+/).map(s => s.trim()).filter(Boolean);
      const faces = rawFaces.map(parseCatalogFace);
      const entry = {
        idProduct: Number(idProduct),
        name: String(name),
        lowCents: typeof lowCents === 'number' ? lowCents : null,
        lowFoilCents: typeof lowFoilCents === 'number' ? lowFoilCents : null,
        idExpansion: idExpansion ?? null,
        idMetacard: idMetacard ?? null,
        faces,
        isDoubleSided: faces.length > 1,
      };
      all.push(entry);
      byId.set(entry.idProduct, entry);
      const seenNames = new Set();
      for (const face of faces) {
        if (!face.baseName || seenNames.has(face.baseName)) continue;
        seenNames.add(face.baseName);
        if (!byFaceName.has(face.baseName)) byFaceName.set(face.baseName, []);
        byFaceName.get(face.baseName).push(entry);
      }
    }
    return { all, byId, byFaceName };
  }

  function parseUserTokenLine(rawLine) {
    let line = String(rawLine || '').trim();
    if (!line || /^\/\/\s*/.test(line)) return null;
    // Strip bullet markers like "- " or "* "
    line = line.replace(/^[-*•]\s+/, '').trim();
    if (!line) return null;

    // Strip trailing Archidekt/Moxfield tags like "(TCMM) 12 *F* [Tokens]"
    line = line
      .replace(/\s*\[[^\]]*\]\s*$/g, '')
      .replace(/\s*\*F\*\s*$/gi, '')
      .replace(/\s*\([A-Z0-9]{2,6}\)\s*\d+[a-z★]?\s*$/i, '')
      .trim();

    // Parse quantity: leading "4x ", "4 ", "x4 ", or trailing " x4"
    let qty = 1;
    let m = /^(?:(\d+)\s*x?|x(\d+))\s+(.+)$/i.exec(line);
    if (m) {
      qty = Math.max(1, parseInt(m[1] || m[2], 10));
      line = m[3].trim();
    } else {
      m = /^(.+?)\s+x(\d+)$/i.exec(line);
      if (m) {
        qty = Math.max(1, parseInt(m[2], 10));
        line = m[1].trim();
      }
    }

    // Parse specs from the whole line (colors, P/T, traits)
    const spec = parseSpecTokens(line);
    // For user input, only treat single-letter color codes if uppercase OR paired with P/T/slashes,
    // which parseSpecTokens already enforces (case-sensitive uppercase W/U/B/R/G/C/A).
    let nameText = spec.remainder
      .replace(/\b(?:Tokens?|Creature|Creatures)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // If user wrote "White 1/1 Soldier" or "1/1 W/B Spirit flying", nameText is now "Soldier" or "Spirit".
    const baseName = nameText.toLowerCase();
    if (!baseName) return null;

    const isEmblem = /\bemblem\b/i.test(baseName);
    const words = nameText.split(/\s+/).filter(Boolean);
    const searchTerm = isEmblem
      ? words.filter(w => w.toLowerCase() !== 'emblem').slice(0, 2).join(' ') || 'Emblem'
      : words.slice(0, 2).join(' ');

    return {
      raw: String(rawLine).trim(),
      qty,
      name: nameText,
      baseName,
      isEmblem,
      colors: spec.colors,
      isColorless: spec.isColorless,
      pt: spec.pt,
      traits: spec.traits,
      searchTerm,
    };
  }

  function requestSignature(req) {
    return `${req.baseName}|${req.colors}|${req.isColorless ? 'C' : ''}|${req.pt || ''}|${req.traits.join(',')}`;
  }

  function formatRequestLabel(req) {
    const parts = [];
    if (req.pt) parts.push(req.pt);
    if (req.colors) parts.push(req.colors);
    else if (req.isColorless) parts.push('Colorless');
    parts.push(req.name);
    if (req.traits.length) parts.push(`(${req.traits.join(', ')})`);
    return parts.join(' ');
  }

  function parseTokenListText(text, options = {}) {
    const deckOptions = options && typeof options.deckOptions === "object" ? options.deckOptions : (options || {});
    const decks = [];
    const deckMap = new Map();

    const ensureDeck = (rawName, headerAllowsCombos = null) => {
      const cleanName = String(rawName || 'Default').trim() || 'Default';
      const key = cleanName.toLowerCase();
      let deck = deckMap.get(key);
      if (!deck) {
        const opt = deckOptions[cleanName];
        const allowCombos = opt && typeof opt.allowCombos === 'boolean'
          ? opt.allowCombos
          : headerAllowsCombos !== null ? headerAllowsCombos : true;
        deck = {
          deckName: cleanName,
          allowCombos,
          requests: [],
          _reqBySig: new Map(),
        };
        deckMap.set(key, deck);
        decks.push(deck);
      }
      return deck;
    };

    let currentDeck = null;
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      // Deck heading: "# Korvold" or "## Wilhelt (no combos)" or "[Korvold]"
      const bracketMatch = /^\[([^\]]+)\](?:\s*(\([^)]+\)))?$/.exec(trimmed);
      const headerMatch = /^#{1,3}\s+(.+)$/.exec(trimmed) || (bracketMatch ? [bracketMatch[0], `${bracketMatch[1]}${bracketMatch[2] ? ` ${bracketMatch[2]}` : ""}`] : null);
      if (headerMatch) {
        let heading = headerMatch[1].trim();
        let headerAllows = null;
        if (/\((?:no\s*dfc|no\s*combos?|simultaneous)\)\s*$/i.test(heading)) {
          headerAllows = false;
          heading = heading.replace(/\s*\((?:no\s*dfc|no\s*combos?|simultaneous)\)\s*$/i, '').trim();
        }
        currentDeck = ensureDeck(heading, headerAllows);
        continue;
      }

      const parsed = parseUserTokenLine(trimmed);
      if (!parsed) continue;
      if (!currentDeck) currentDeck = ensureDeck('Default');

      const sig = requestSignature(parsed);
      const existing = currentDeck._reqBySig.get(sig);
      if (existing) {
        existing.qty += parsed.qty;
      } else {
        const req = {
          ...parsed,
          id: `${currentDeck.deckName}::${sig}`,
          deckName: currentDeck.deckName,
          label: formatRequestLabel(parsed),
        };
        currentDeck._reqBySig.set(sig, req);
        currentDeck.requests.push(req);
      }
    }

    return decks
      .filter(d => d.requests.length > 0)
      .map(({ deckName, allowCombos, requests }) => ({ deckName, allowCombos, requests }));
  }

  function faceMatchesSpec(req, face, { checkTraits = true } = {}) {
    if (req.pt && face.pt !== req.pt) return false;
    if (req.colors && face.colors !== req.colors) return false;
    if (!req.colors && req.isColorless && face.colors !== '') return false;
    if (checkTraits && req.traits.length) {
      for (const t of req.traits) {
        if (!face.traits.includes(t)) return false;
      }
    }
    return true;
  }

  function faceMatchesNameFuzzy(req, face) {
    if (req.isEmblem && !face.isEmblem) return false;
    const reqWords = req.baseName.split(/\s+/).filter(w => w !== 'emblem' && w.length > 1);
    if (!reqWords.length) return false;
    const faceWords = new Set(face.baseName.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
    return reqWords.every(w => faceWords.has(w));
  }

  function guidePriceFor(entry, foil) {
    if (foil === 'Y') return entry.lowFoilCents;
    if (foil === 'N') return entry.lowCents;
    if (entry.lowCents == null) return entry.lowFoilCents;
    if (entry.lowFoilCents == null) return entry.lowCents;
    return Math.min(entry.lowCents, entry.lowFoilCents);
  }

  function matchSingleRequest(req, catalog, { maxPriceCents = 20, foil = 'N' } = {}) {
    const exactCandidates = catalog.byFaceName.get(req.baseName) || [];
    let fuzzy = false;

    const filterCandidates = (pool, nameCheck, checkTraits) => {
      const matched = [];
      for (const entry of pool) {
        const matchedFaceIndexes = [];
        for (let i = 0; i < entry.faces.length; i += 1) {
          const face = entry.faces[i];
          if (nameCheck(face) && faceMatchesSpec(req, face, { checkTraits })) {
            matchedFaceIndexes.push(i);
          }
        }
        if (matchedFaceIndexes.length) {
          matched.push({ entry, matchedFaceIndexes });
        }
      }
      return matched;
    };

    let hits = filterCandidates(exactCandidates, f => f.baseName === req.baseName, true);
    let relaxedTraits = false;
    if (!hits.length && req.traits.length && exactCandidates.length) {
      hits = filterCandidates(exactCandidates, f => f.baseName === req.baseName, false);
      if (hits.length) relaxedTraits = true;
    }
    if (!hits.length) {
      fuzzy = true;
      hits = filterCandidates(catalog.all, f => faceMatchesNameFuzzy(req, f), true);
      if (!hits.length && req.traits.length) {
        hits = filterCandidates(catalog.all, f => faceMatchesNameFuzzy(req, f), false);
        if (hits.length) relaxedTraits = true;
      }
    }

    const productIds = new Set();
    const faceIndexByProduct = new Map();
    let singleCount = 0;
    let doubleCount = 0;
    let cheapestGuideCents = null;
    let cheapCount = 0;

    for (const { entry, matchedFaceIndexes } of hits) {
      productIds.add(entry.idProduct);
      faceIndexByProduct.set(entry.idProduct, matchedFaceIndexes);
      if (entry.isDoubleSided) doubleCount += 1;
      else singleCount += 1;
      const g = guidePriceFor(entry, foil);
      if (g !== null) {
        if (cheapestGuideCents === null || g < cheapestGuideCents) cheapestGuideCents = g;
        if (g <= maxPriceCents) cheapCount += 1;
      }
    }

    const sortedSamples = [...hits]
      .sort((a, b) => (guidePriceFor(a.entry, foil) ?? 1e9) - (guidePriceFor(b.entry, foil) ?? 1e9))
      .slice(0, 4)
      .map(h => h.entry.name);

    return {
      ...req,
      productIds,
      faceIndexByProduct,
      matchCount: productIds.size,
      singleCount,
      doubleCount,
      cheapCount,
      cheapestGuideCents,
      likelyProxy: productIds.size === 0 || (cheapestGuideCents !== null && cheapestGuideCents > maxPriceCents),
      fuzzy,
      relaxedTraits,
      sampleNames: sortedSamples,
    };
  }

  function matchTokenDecks(decks, catalog, { maxPriceCents = 20, foil = 'N' } = {}) {
    const wantedProductIds = new Set();
    const searchTermSet = new Set();

    const matchedDecks = (decks || []).map(deck => {
      const requests = deck.requests.map(req => {
        const m = matchSingleRequest(req, catalog, { maxPriceCents, foil });
        for (const id of m.productIds) wantedProductIds.add(id);
        if (m.searchTerm) searchTermSet.add(m.searchTerm);
        return m;
      });

      // Find within-deck double-sided combos (A // B covering two different requests in THIS deck)
      const comboByName = new Map();
      if (deck.allowCombos && requests.length >= 2) {
        const deckProductIds = new Set();
        for (const r of requests) for (const id of r.productIds) deckProductIds.add(id);
        for (const id of deckProductIds) {
          const entry = catalog.byId.get(id);
          if (!entry || entry.faces.length < 2) continue;
          const face0Reqs = requests.filter(r => r.faceIndexByProduct.get(id)?.includes(0));
          const face1Reqs = requests.filter(r => r.faceIndexByProduct.get(id)?.includes(1));
          if (!face0Reqs.length || !face1Reqs.length) continue;
          let pair = null;
          for (const r0 of face0Reqs) {
            for (const r1 of face1Reqs) {
              if (r0.id !== r1.id) { pair = [r0, r1]; break; }
            }
            if (pair) break;
          }
          if (!pair) continue;
          const g = guidePriceFor(entry, foil);
          const key = entry.name;
          const existing = comboByName.get(key);
          if (!existing) {
            comboByName.set(key, {
              name: entry.name,
              covers: [pair[0].label, pair[1].label],
              printingCount: 1,
              cheapestGuideCents: g,
            });
          } else {
            existing.printingCount += 1;
            if (g !== null && (existing.cheapestGuideCents === null || g < existing.cheapestGuideCents)) {
              existing.cheapestGuideCents = g;
            }
          }
        }
      }

      const combos = [...comboByName.values()]
        .sort((a, b) => (a.cheapestGuideCents ?? 1e9) - (b.cheapestGuideCents ?? 1e9) || a.name.localeCompare(b.name));

      return {
        deckName: deck.deckName,
        allowCombos: deck.allowCombos,
        requests,
        combos,
      };
    });

    return {
      decks: matchedDecks,
      wantedProductIds,
      searchTerms: [...searchTermSet],
    };
  }

  function resolveSellerTable(location, tables, trackedSet, seller) {
    let base = [];
    if (Array.isArray(tables)) {
      base = tables;
    } else if (tables && typeof tables === 'object') {
      const byLocation = tables.byLocation || tables;
      base = (location && byLocation[location]) || tables.default || Object.values(byLocation).find(Array.isArray) || [];
    }
    return trackedSet.has(seller) ? base.filter(m => m.tracked) : base;
  }

  function optimizeTokens(matchedPlan, parcels, sellerTokenOffers, catalog, options = {}) {
    const {
      tables = [],
      trackedOnly = [],
      maxPriceCents = 20,
      targetPriceCents = 10,
      minCondition = 5,
      language = null,
      foil = 'N',
      parcelShippingFn = root.CardmarketWizard?.parcelShipping,
    } = options;

    if (typeof parcelShippingFn !== 'function') {
      throw new Error('optimizeTokens requires CardmarketWizard.parcelShipping');
    }

    const decks = matchedPlan?.decks || [];
    const trackedSet = new Set(trackedOnly || []);

    // Build live parcel states for existing basket sellers ONLY (never opens a new seller).
    const sellerStates = new Map();
    for (const parcel of parcels || []) {
      const table = resolveSellerTable(parcel.location, tables, trackedSet, parcel.seller);
      const baseItems = (parcel.items || []).map(item => ({
        kind: item.kind || 'card',
        offer: { shippingCents: item.offerShippingCents ?? null },
      }));
      const baseItemsCents = parcel.itemsCents ?? (parcel.items || []).reduce((s, i) => s + (i.priceCents || 0), 0);
      const baseMethod = parcelShippingFn(table, baseItems, baseItemsCents);
      const baseShippingCents = Number.isFinite(parcel.shippingCents)
        ? parcel.shippingCents
        : (baseMethod ? baseMethod.priceCents : Infinity);

      sellerStates.set(parcel.seller, {
        seller: parcel.seller,
        location: parcel.location || null,
        table,
        baseItems,
        baseItemsCents,
        baseShippingCents,
        baseMethod: parcel.method || baseMethod?.name || null,
        items: [...baseItems],
        itemsCents: baseItemsCents,
        shippingCents: baseShippingCents,
        method: parcel.method || baseMethod?.name || null,
        addedTokens: [],
      });
    }

    const calcShipping = (st, extraCards, extraCents) => {
      const trialItems = extraCards > 0
        ? [...st.items, ...Array.from({ length: extraCards }, () => ({ kind: 'card', offer: {} }))]
        : st.items;
      const m = parcelShippingFn(st.table, trialItems, st.itemsCents + extraCents);
      return m ? { priceCents: m.priceCents, name: m.name } : { priceCents: Infinity, name: null };
    };

    // Remaining free headroom at current shipping tier (used as tie-breaker).
    const freeHeadroom = st => {
      if (!Number.isFinite(st.shippingCents)) return 0;
      let count = 0;
      for (let k = 1; k <= 20; k += 1) {
        const next = calcShipping(st, k, 0);
        if (next.priceCents > st.shippingCents) break;
        count = k;
      }
      return count;
    };

    // Remaining demand per request id
    const remaining = new Map();
    const reqById = new Map();
    const deckByName = new Map();
    for (const deck of decks) {
      deckByName.set(deck.deckName, deck);
      for (const req of deck.requests) {
        remaining.set(req.id, req.qty);
        reqById.set(req.id, req);
      }
    }

    const totalRemaining = () => {
      let s = 0;
      for (const v of remaining.values()) s += v;
      return s;
    };

    // Index eligible offers per existing basket seller + track stock left per idArticle
    const offerLeft = new Map();
    const rawOffersBySeller = new Map();
    const eligibleOffersBySeller = new Map();

    const getSellerOffers = seller => {
      if (!sellerTokenOffers) return [];
      if (sellerTokenOffers instanceof Map) return sellerTokenOffers.get(seller) || [];
      return sellerTokenOffers[seller] || [];
    };

    for (const seller of sellerStates.keys()) {
      const all = getSellerOffers(seller);
      rawOffersBySeller.set(seller, all);
      const eligible = [];
      for (const offer of all) {
        if (!offer || !offer.idProduct || !offer.idArticle || !(offer.quantity > 0)) continue;
        if (!catalog.byId.has(offer.idProduct)) continue;
        if (offer.priceCents > maxPriceCents) continue;
        if (minCondition != null && offer.condition != null && offer.condition > minCondition) continue;
        if (language != null && offer.language != null && offer.language !== language) continue;
        if (foil === 'Y' && !offer.foil) continue;
        if (foil === 'N' && offer.foil) continue;
        offerLeft.set(offer.idArticle, (offerLeft.get(offer.idArticle) || 0) + offer.quantity);
        eligible.push(offer);
      }
      eligible.sort((a, b) => a.priceCents - b.priceCents || a.idArticle - b.idArticle);
      eligibleOffersBySeller.set(seller, eligible);
    }

    // For a given offer and deck, find the best covering option (2-for-1 DFC within this deck, or 1-for-1).
    function bestCoverForOfferInDeck(offer, deck) {
      const entry = catalog.byId.get(offer.idProduct);
      if (!entry) return null;

      // Check 2-for-1 DFC within the SAME deck only!
      if (deck.allowCombos && entry.faces.length >= 2) {
        const f0 = deck.requests.filter(r => (remaining.get(r.id) || 0) > 0 && r.faceIndexByProduct.get(offer.idProduct)?.includes(0));
        const f1 = deck.requests.filter(r => (remaining.get(r.id) || 0) > 0 && r.faceIndexByProduct.get(offer.idProduct)?.includes(1));
        for (const r0 of f0) {
          for (const r1 of f1) {
            if (r0.id !== r1.id) {
              return { coveredReqs: [r0, r1], isCombo: true, entry };
            }
          }
        }
        // Same request on both faces only if remaining >= 2
        for (const r0 of f0) {
          if (f1.some(r1 => r1.id === r0.id) && (remaining.get(r0.id) || 0) >= 2) {
            return { coveredReqs: [r0, r0], isCombo: true, entry };
          }
        }
      }

      // Single-face cover (works for both single-sided and DFC tokens)
      for (const req of deck.requests) {
        if ((remaining.get(req.id) || 0) > 0 && req.productIds.has(offer.idProduct)) {
          return { coveredReqs: [req], isCombo: false, entry };
        }
      }
      return null;
    }

    const assignments = [];

    function commitPick(st, offer, deck, coveredReqs, isCombo, entry, shipDelta, newShip) {
      offerLeft.set(offer.idArticle, (offerLeft.get(offer.idArticle) || 1) - 1);
      for (const req of coveredReqs) {
        remaining.set(req.id, (remaining.get(req.id) || 1) - 1);
      }
      st.items.push({ kind: 'card', offer: {} });
      st.itemsCents += offer.priceCents;
      st.shippingCents = newShip.priceCents;
      st.method = newShip.name || st.method;

      const pick = {
        seller: st.seller,
        deckName: deck.deckName,
        idArticle: offer.idArticle,
        idProduct: offer.idProduct,
        name: entry.name,
        faces: entry.faces.map(f => f.raw),
        coveredIds: coveredReqs.map(r => r.id),
        coveredLabels: coveredReqs.map(r => r.label),
        isCombo,
        priceCents: offer.priceCents,
        shippingDeltaCents: shipDelta,
        effectivePerFaceCents: Math.round((offer.priceCents + shipDelta) / coveredReqs.length),
        condition: offer.condition ?? null,
        language: offer.language ?? null,
        foil: !!offer.foil,
      };
      st.addedTokens.push(pick);
      assignments.push(pick);
    }

    // Pass 1 & Pass 2 loop:
    // Pass 1 picks best single card (1-for-1 or 2-for-1 DFC) with effectivePerFace <= maxPriceCents.
    // Pass 2 (only when Pass 1 stalls on a shipping tier jump) checks if bundling multiple tokens
    // from one existing seller amortizes the shipping jump to <= maxPriceCents per covered face.
    while (totalRemaining() > 0) {
      let best = null;
      const headroomCache = new Map();

      for (const [seller, st] of sellerStates) {
        if (!Number.isFinite(st.shippingCents)) continue;
        const offers = eligibleOffersBySeller.get(seller) || [];
        if (!offers.length) continue;

        for (const offer of offers) {
          if ((offerLeft.get(offer.idArticle) || 0) <= 0) continue;
          const newShip = calcShipping(st, 1, offer.priceCents);
          if (!Number.isFinite(newShip.priceCents)) continue;
          const shipDelta = Math.max(0, newShip.priceCents - st.shippingCents);
          const marginal = offer.priceCents + shipDelta;

          for (const deck of decks) {
            const cover = bestCoverForOfferInDeck(offer, deck);
            if (!cover) continue;
            const effectivePerFace = marginal / cover.coveredReqs.length;
            if (effectivePerFace > maxPriceCents) continue;

            if (!headroomCache.has(seller)) headroomCache.set(seller, freeHeadroom(st));
            const headroom = headroomCache.get(seller);
            const aboveTarget = effectivePerFace > targetPriceCents ? 1 : 0;

            const better = !best
              || effectivePerFace < best.effectivePerFace - 1e-9
              || (Math.abs(effectivePerFace - best.effectivePerFace) <= 1e-9 && (
                (cover.isCombo ? 1 : 0) > (best.cover.isCombo ? 1 : 0)
                || (cover.isCombo === best.cover.isCombo && (
                  shipDelta < best.shipDelta
                  || (shipDelta === best.shipDelta && (
                    aboveTarget < best.aboveTarget
                    || (aboveTarget === best.aboveTarget && headroom > best.headroom)
                  ))
                ))
              ));

            if (better) {
              best = { st, offer, deck, cover, shipDelta, newShip, effectivePerFace, aboveTarget, headroom };
            }
          }
        }
      }

      if (best) {
        commitPick(best.st, best.offer, best.deck, best.cover.coveredReqs, best.cover.isCombo, best.cover.entry, best.shipDelta, best.newShip);
        continue;
      }

      // Pass 2: Check amortized shipping-tier-jump bundles on each existing seller
      let bestBundle = null;
      for (const [seller, st] of sellerStates) {
        if (!Number.isFinite(st.shippingCents)) continue;
        const offers = eligibleOffersBySeller.get(seller) || [];
        if (!offers.length) continue;

        // Simulate greedily taking cheapest matching offers at this seller up to next shipping tier
        const simOfferLeft = new Map(offerLeft);
        const simRemaining = new Map(remaining);
        const picks = [];
        let bundleTokenCents = 0;
        let bundleFaces = 0;

        for (let step = 0; step < 30; step += 1) {
          let nextPick = null;
          for (const offer of offers) {
            if ((simOfferLeft.get(offer.idArticle) || 0) <= 0) continue;
            const entry = catalog.byId.get(offer.idProduct);
            for (const deck of decks) {
              // Find cover against simRemaining
              let coveredReqs = null;
              let isCombo = false;
              if (deck.allowCombos && entry.faces.length >= 2) {
                const f0 = deck.requests.filter(r => (simRemaining.get(r.id) || 0) > 0 && r.faceIndexByProduct.get(offer.idProduct)?.includes(0));
                const f1 = deck.requests.filter(r => (simRemaining.get(r.id) || 0) > 0 && r.faceIndexByProduct.get(offer.idProduct)?.includes(1));
                for (const r0 of f0) {
                  for (const r1 of f1) {
                    if (r0.id !== r1.id) { coveredReqs = [r0, r1]; isCombo = true; break; }
                  }
                  if (coveredReqs) break;
                }
                if (!coveredReqs) {
                  for (const r0 of f0) {
                    if (f1.some(r1 => r1.id === r0.id) && (simRemaining.get(r0.id) || 0) >= 2) {
                      coveredReqs = [r0, r0]; isCombo = true; break;
                    }
                  }
                }
              }
              if (!coveredReqs) {
                for (const req of deck.requests) {
                  if ((simRemaining.get(req.id) || 0) > 0 && req.productIds.has(offer.idProduct)) {
                    coveredReqs = [req]; break;
                  }
                }
              }
              if (!coveredReqs) continue;
              const perFace = offer.priceCents / coveredReqs.length;
              if (!nextPick || perFace < nextPick.perFace || (perFace === nextPick.perFace && isCombo && !nextPick.isCombo)) {
                nextPick = { offer, deck, coveredReqs, isCombo, entry, perFace };
              }
            }
          }
          if (!nextPick) break;

          simOfferLeft.set(nextPick.offer.idArticle, (simOfferLeft.get(nextPick.offer.idArticle) || 1) - 1);
          for (const r of nextPick.coveredReqs) simRemaining.set(r.id, (simRemaining.get(r.id) || 1) - 1);
          picks.push(nextPick);
          bundleTokenCents += nextPick.offer.priceCents;
          bundleFaces += nextPick.coveredReqs.length;

          const newShip = calcShipping(st, picks.length, bundleTokenCents);
          if (!Number.isFinite(newShip.priceCents)) break;
          const shipDelta = Math.max(0, newShip.priceCents - st.shippingCents);
          const avgPerFace = (bundleTokenCents + shipDelta) / bundleFaces;

          if (avgPerFace <= maxPriceCents) {
            if (!bestBundle || avgPerFace < bestBundle.avgPerFace) {
              bestBundle = { st, picks: [...picks], avgPerFace };
            }
            break; // Once the shipping jump is amortized, Pass 1 can pick remaining headroom cards cleanly!
          }
        }
      }

      if (bestBundle) {
        for (const p of bestBundle.picks) {
          const newShip = calcShipping(bestBundle.st, 1, p.offer.priceCents);
          const shipDelta = Math.max(0, newShip.priceCents - bestBundle.st.shippingCents);
          commitPick(bestBundle.st, p.offer, p.deck, p.coveredReqs, p.isCombo, p.entry, shipDelta, newShip);
        }
        continue;
      }

      break;
    }

    // Diagnose Proxy / Skip list with concrete human-readable reasons
    const proxyList = [];
    for (const deck of decks) {
      for (const req of deck.requests) {
        const rem = remaining.get(req.id) || 0;
        if (rem <= 0) continue;

        let reason = 'Not in stock at basket sellers';
        if (req.productIds.size === 0) {
          reason = 'No matching token in Cardmarket catalogue';
        } else {
          let cheapestAnyCents = null;
          let foundUnderCapAnyFilter = false;
          let foundEligible = false;
          let minShipJumpCents = null;

          for (const [seller, st] of sellerStates) {
            for (const offer of rawOffersBySeller.get(seller) || []) {
              if (!req.productIds.has(offer.idProduct) || !(offer.quantity > 0)) continue;
              if (cheapestAnyCents === null || offer.priceCents < cheapestAnyCents) cheapestAnyCents = offer.priceCents;
              if (offer.priceCents <= maxPriceCents) {
                foundUnderCapAnyFilter = true;
                const condOk = minCondition == null || offer.condition == null || offer.condition <= minCondition;
                const langOk = language == null || offer.language == null || offer.language === language;
                const foilOk = foil === 'any' || (foil === 'Y' ? !!offer.foil : !offer.foil);
                if (condOk && langOk && foilOk && (offerLeft.get(offer.idArticle) || 0) > 0) {
                  foundEligible = true;
                  const nextShip = calcShipping(st, 1, offer.priceCents);
                  if (Number.isFinite(nextShip.priceCents) && Number.isFinite(st.shippingCents)) {
                    const jump = Math.max(0, nextShip.priceCents - st.shippingCents);
                    if (minShipJumpCents === null || jump < minShipJumpCents) minShipJumpCents = jump;
                  }
                }
              }
            }
          }

          if (foundEligible && minShipJumpCents !== null && minShipJumpCents > 0) {
            reason = `Would trigger +${(minShipJumpCents / 100).toFixed(2).replace('.', ',')} € shipping jump`;
          } else if (foundUnderCapAnyFilter && !foundEligible) {
            reason = 'Only available in another condition/language/foil (or stock already used)';
          } else if (cheapestAnyCents !== null && cheapestAnyCents > maxPriceCents) {
            reason = `Cheapest at basket sellers is ${(cheapestAnyCents / 100).toFixed(2).replace('.', ',')} € (> ${(maxPriceCents / 100).toFixed(2).replace('.', ',')} € cap)`;
          }
        }

        proxyList.push({
          deckName: deck.deckName,
          reqId: req.id,
          raw: req.raw,
          label: req.label,
          remainingQty: rem,
          requestedQty: req.qty,
          reason,
        });
      }
    }

    const bySeller = new Map();
    let tokensCents = 0;
    let shippingDeltaCents = 0;
    for (const [seller, st] of sellerStates) {
      if (!st.addedTokens.length) continue;
      const sellerTokensCents = st.addedTokens.reduce((s, t) => s + t.priceCents, 0);
      const sellerShipDelta = Number.isFinite(st.shippingCents) && Number.isFinite(st.baseShippingCents)
        ? Math.max(0, st.shippingCents - st.baseShippingCents)
        : 0;
      tokensCents += sellerTokensCents;
      shippingDeltaCents += sellerShipDelta;
      bySeller.set(seller, {
        seller,
        addedTokens: st.addedTokens,
        tokensCents: sellerTokensCents,
        baseShippingCents: st.baseShippingCents,
        newShippingCents: st.shippingCents,
        shippingDeltaCents: sellerShipDelta,
        newMethod: st.method,
      });
    }

    const totalRequestedFaces = decks.reduce((s, d) => s + d.requests.reduce((r, x) => r + x.qty, 0), 0);
    const coveredFaces = assignments.reduce((s, a) => s + a.coveredLabels.length, 0);
    const comboCardsUsed = assignments.filter(a => a.isCombo).length;
    const totalAddedCents = tokensCents + shippingDeltaCents;

    return {
      assignments,
      bySeller,
      proxyList,
      stats: {
        totalRequestedFaces,
        coveredFaces,
        physicalTokensBought: assignments.length,
        comboCardsUsed,
        tokensCents,
        shippingDeltaCents,
        totalAddedCents,
        avgPerFaceCents: coveredFaces ? Math.round(totalAddedCents / coveredFaces) : 0,
        proxyFaces: Math.max(0, totalRequestedFaces - coveredFaces),
      },
    };
  }

  // Non-destructively merges matched tokens into a copy of the basket (for UI, KPIs, and cart add).
  function mergeTokensIntoBasket(basket, tokenResult) {
    if (!basket || !tokenResult || !tokenResult.assignments?.length) return basket;
    const bySeller = tokenResult.bySeller || new Map();

    const parcels = basket.parcels.map(parcel => {
      const add = bySeller.get(parcel.seller);
      if (!add || !add.addedTokens.length) return parcel;

      const tokenItems = add.addedTokens.map(t => ({
        key: `token:${t.deckName}:${t.idProduct}:${t.idArticle}`,
        name: t.name,
        kind: 'token',
        game: 'Magic',
        listId: `token:${t.deckName}`,
        listName: t.deckName,
        idArticle: t.idArticle,
        idProduct: t.idProduct,
        foil: !!t.foil,
        priceCents: t.priceCents,
        targetCents: null,
        aboveMarket: false,
        offerShippingCents: null,
        tokenCovers: t.coveredLabels,
        tokenCombo: t.isCombo,
      }));

      const items = [...parcel.items, ...tokenItems];
      const games = [...new Set([...(parcel.games || []), 'Magic'])];
      return {
        ...parcel,
        games,
        hasTokens: true,
        tokenCount: tokenItems.length,
        itemsCents: parcel.itemsCents + add.tokensCents,
        shippingCents: Number.isFinite(add.newShippingCents) ? add.newShippingCents : parcel.shippingCents,
        method: add.newMethod || parcel.method,
        items,
      };
    });

    let cards = 0;
    let running = 0;
    const curve = parcels.map((parcel, index) => {
      cards += parcel.items.length;
      running += parcel.itemsCents + parcel.shippingCents;
      return { sellers: index + 1, cards, totalCents: running };
    });

    return {
      ...basket,
      parcels,
      curve,
      totalCents: running,
      shippingCents: parcels.reduce((s, p) => s + p.shippingCents, 0),
      tokenStats: tokenResult.stats,
    };
  }

  function formatProxyListText(proxyList) {
    const groups = new Map();
    for (const item of proxyList || []) {
      const k = item.deckName || 'Default';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    }
    const multi = groups.size > 1;
    return [...groups].map(([deck, items]) => {
      const lines = items.map(i => `${i.remainingQty}x ${i.label}`).join('\n');
      return multi ? `# ${deck}\n${lines}` : lines;
    }).join('\n\n');
  }

  root.CardmarketTokens = {
    parseCatalogFace,
    buildTokenCatalog,
    parseUserTokenLine,
    parseTokenListText,
    matchTokenDecks,
    optimizeTokens,
    mergeTokensIntoBasket,
    formatProxyListText,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
