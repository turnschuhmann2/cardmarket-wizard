/*
 * Cardmarket offer collector.
 *
 * Cardmarket lists the offers of one printing cheapest-first, 50 per page, and serves at most
 * 300 per filter combination. For each wanted card we set a target price, the realistic
 * cheapest price: the price of the 5th cheapest copy across all printings, once those copies
 * come from at least 3 sellers. Unlike the minimum, one outlier cannot set it; unlike a median,
 * the expensive tail cannot skew it. We keep every offer up to the cutoff,
 * max(2 x target, target + 0,50 EUR).
 *
 * Supports:
 * - Single or multiple Wants Lists across games (Magic, Yu-Gi-Oh!) combined in one run.
 * - Non-card products (sleeves, deck boxes, etc.), reading per-seller shipping directly from
 *   the product page's offer rows.
 * - Seller-country filtering (single country, custom set, or all of Europe).
 */
(function (root) {
  'use strict';

  const LANGUAGES = {
    English: 1, French: 2, German: 3, Spanish: 4, Italian: 5, 'S-Chinese': 6,
    Japanese: 7, Portuguese: 8, Russian: 9, Korean: 10, 'T-Chinese': 11,
  };
  const CONDITIONS = {
    Mint: 1, 'Near Mint': 2, Excellent: 3, Good: 4, 'Light Played': 5, Played: 6, Poor: 7,
  };
  const CONDITION_CODES = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
  // Private, professional, powerseller. Verified: the three filters partition a printing's offers.
  const SELLER_TYPES = [0, 1, 2];
  // Cardmarket seller reputation thresholds (URL param `sellerReputation`):
  // 1 = Outstanding (>=36 evals, >=97% very good)
  // 2 = Very good   (>=36 evals, >=92% very good)
  // 3 = Good        (>=6 evals, <=4% neutral, <=2% bad)
  // 4 = Average     (excludes Bad & unrated/new sellers)
  // 5 = Bad         (unfiltered / any seller, including unrated)
  const SELLER_REPUTATIONS = {
    outstanding: 1,
    'very-good': 2,
    good: 3,
    average: 4,
    bad: 5,
  };
  const SELLER_REPUTATION_LABELS = {
    1: 'Outstanding',
    2: 'Very good',
    3: 'Good',
    4: 'Average',
    5: 'Bad',
  };
  const SELLER_TYPE_LABELS = {
    0: 'Private',
    1: 'Professional',
    2: 'Powerseller',
  };
  const CACHE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

  function normalizeSellerReputation(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
      const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
      if (key === 'verygood') return 2;
      if (key in SELLER_REPUTATIONS) return SELLER_REPUTATIONS[key] < 5 ? SELLER_REPUTATIONS[key] : null;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n >= 5) return null;
    return n;
  }

  function normalizeSellerTypes(value) {
    if (value == null || value === '') return null;
    const raw = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [value];
    const valid = [...new Set(raw.map(Number).filter(n => SELLER_TYPES.includes(n)))].sort((a, b) => a - b);
    if (!valid.length || valid.length === SELLER_TYPES.length) return null;
    return valid;
  }

  function offerReputationRank(offer) {
    if (!offer) return null;
    if (typeof offer.reputation === 'number' && Number.isInteger(offer.reputation) && offer.reputation >= 1 && offer.reputation <= 5) {
      return offer.reputation;
    }
    if (typeof offer.rating === 'string' && offer.rating) {
      const key = offer.rating.trim().toLowerCase().replace(/[\s_]+/g, '-');
      if (key === 'verygood') return 2;
      if (key in SELLER_REPUTATIONS) return SELLER_REPUTATIONS[key];
    }
    return null;
  }

  function offerSellerType(offer) {
    if (!offer) return null;
    if (typeof offer.sellerType === 'number' && SELLER_TYPES.includes(offer.sellerType)) return offer.sellerType;
    return null;
  }

  function matchesSellerFilter(offer, filter = {}) {
    if (!filter) return true;
    const minRep = normalizeSellerReputation(filter.sellerReputation ?? filter.minReputation);
    if (minRep != null) {
      const rank = offerReputationRank(offer);
      if (rank === null || rank > minRep) return false;
    }
    const allowedTypes = filter.sellerTypes != null
      ? normalizeSellerTypes(filter.sellerTypes)
      : (filter.sellerType !== undefined && filter.sellerType !== null ? normalizeSellerTypes(filter.sellerType) : null);
    if (allowedTypes) {
      const st = offerSellerType(offer);
      if (st !== null) {
        if (!allowedTypes.includes(st)) return false;
      } else if (typeof offer?.professional === 'boolean') {
        if (!offer.professional && !allowedTypes.includes(0)) return false;
        if (offer.professional && !allowedTypes.includes(1) && !allowedTypes.includes(2)) return false;
      }
    }
    return true;
  }

  function parseSellerRating(row, sellerTips = []) {
    const icon = row.querySelector?.('[class*="fonticon-seller-rating-"]');
    const clsMatch = /fonticon-seller-rating-([a-z0-9-]+)/i.exec(icon?.className || '');
    if (clsMatch) {
      const raw = clsMatch[1].toLowerCase();
      if (raw === 'verygood' || raw === 'very-good') return 'very-good';
      if (raw in SELLER_REPUTATIONS) return raw;
      if (/not|none|unrated|unknown|new/.test(raw)) return null;
    }
    for (const text of sellerTips) {
      const t = String(text || '').trim();
      if (!t) continue;
      if (/\boutstanding\b/i.test(t)) return 'outstanding';
      if (/\bvery[\s-]+good\b/i.test(t)) return 'very-good';
      if (/\bgood\s+seller\b|^good$/i.test(t)) return 'good';
      if (/\baverage\s+seller\b|^average$/i.test(t)) return 'average';
      if (/\bbad\s+seller\b|^bad$/i.test(t)) return 'bad';
    }
    return null;
  }

  function parseSellerType(sellerTips = []) {
    for (const text of sellerTips) {
      const t = String(text || '').trim();
      if (/\bpowerseller\b/i.test(t)) return 2;
    }
    for (const text of sellerTips) {
      const t = String(text || '').trim();
      if (/\bprofessional\b/i.test(t)) return 1;
    }
    return 0;
  }

  class RetryableError extends Error {}
  class BlockedError extends Error {}
  class StoppedError extends BlockedError {}
  // Cardmarket or Cloudflare said no outright (HTTP 403, "Access denied", a block page): there is
  // no check to complete, so it is neither retried nor a reason to pause.
  class RefusedError extends Error {}
  // Cardmarket returned a deterministic XML rejection for a cart POST (e.g. article sold out or
  // insufficient stock), distinct from rate limits, refusals, network errors, or HTML responses.
  class CartRejectError extends Error {
    constructor(message, { code = null, detail = "" } = {}) {
      super(message);
      this.code = code;
      this.detail = detail;
    }
  }
  // Cardmarket rejected a cart POST because the CSRF/session token expired; callers should
  // perform a paced refreshToken call and retry once rather than retrying unpaced inside cartRequest.
  class TokenExpiredError extends Error {}

  function cents(text) {
    const match = /(\d[\d.]*),(\d{2})/.exec(text || '');
    if (!match) throw new Error(`Unreadable price "${text}"`);
    return parseInt(match[1].replace(/\./g, ''), 10) * 100 + parseInt(match[2], 10);
  }

  function allCents(text) {
    const out = [];
    const regex = /(\d[\d.]*),(\d{2})\s*€/g;
    let match;
    while ((match = regex.exec(text || '')) !== null) {
      out.push(parseInt(match[1].replace(/\./g, ''), 10) * 100 + parseInt(match[2], 10));
    }
    return out;
  }

  function tip(element) {
    return element.getAttribute('title') || element.getAttribute('data-bs-original-title') ||
      element.getAttribute('aria-label') || '';
  }

  function tips(row, selector) {
    return [...row.querySelectorAll(`${selector} [title], ${selector} [data-bs-original-title], ${selector} [aria-label]`)].map(tip);
  }

  function parseOfferRow(row) {
    const sellerLink = row.querySelector('.seller-name a[href*="/Users/"]');
    const sellerTips = tips(row, '.col-seller');
    const location = sellerTips.find(text => text.startsWith('Item location: '));
    const attributes = tips(row, '.product-attributes');
    const condition = attributes.find(text => text in CONDITIONS);
    const language = attributes.find(text => text in LANGUAGES);
    const price = row.querySelector('.price-container .color-primary');
    const quantity = row.querySelector('.amount-container .item-count') || row.querySelector('.item-count');
    if (!sellerLink || !location || !condition || !language || !price || !quantity) {
      throw new Error(`Unreadable offer row ${row.id}`);
    }
    const rating = parseSellerRating(row, sellerTips);
    const sellerType = parseSellerType(sellerTips);
    return {
      idArticle: Number(row.id.replace('articleRow', '')),
      seller: sellerLink.textContent.trim(),
      location: location.slice('Item location: '.length).trim(),
      professional: sellerType >= 1,
      sellerType,
      rating,
      reputation: offerReputationRank({ rating }),
      condition: CONDITIONS[condition],
      language: LANGUAGES[language],
      foil: attributes.includes('Foil'),
      signed: attributes.includes('Signed'),
      altered: attributes.includes('Altered'),
      priceCents: cents(price.textContent),
      quantity: parseInt(quantity.textContent, 10),
    };
  }

  // Non-card product offer rows (sleeves, deck boxes, sealed items):
  // - Condition is optional (sealed accessories have no condition icon).
  // - Language is optional.
  // - Cardmarket renders per-seller shipping directly in the offer cell (including commercial
  //   sellers' custom Personal Shipping Methods).
  function parseProductOfferRow(row) {
    const sellerLink = row.querySelector('.seller-name a[href*="/Users/"]');
    const sellerTips = tips(row, '.col-seller');
    const location = sellerTips.find(text => text.startsWith('Item location: '));
    const attributes = tips(row, '.product-attributes');
    const condition = attributes.find(text => text in CONDITIONS);
    const language = attributes.find(text => text in LANGUAGES);
    const priceEl = row.querySelector('.price-container .color-primary') || row.querySelector('.col-offer .color-primary');
    const quantity = row.querySelector('.amount-container .item-count') || row.querySelector('.item-count');
    if (!sellerLink || !location || !priceEl || !quantity) {
      throw new Error(`Unreadable product offer row ${row.id}`);
    }
    const priceCents = cents(priceEl.textContent);

    // Try explicit shipping icon / container first, then fall back to the 2nd euro amount in the offer cell.
    let shippingCents = null;
    const priceBox = row.querySelector('.price-container') || row.querySelector('.col-offer') || row;
    const shipIcon = priceBox.querySelector('[class*="shipping"], [class*="delivery"], [class*="package"], [title*="Shipping"], [data-bs-original-title*="Shipping"]');
    if (shipIcon) {
      const candidate = shipIcon.closest('div, span, p')?.textContent || shipIcon.parentElement?.textContent || '';
      const found = allCents(candidate);
      if (found.length) shippingCents = found.at(-1);
    }
    if (shippingCents === null) {
      const amounts = allCents(priceBox.textContent);
      if (amounts.length >= 2) shippingCents = amounts[1];
    }

    const rating = parseSellerRating(row, sellerTips);
    const sellerType = parseSellerType(sellerTips);
    return {
      idArticle: Number(row.id.replace('articleRow', '')),
      seller: sellerLink.textContent.trim(),
      location: location.slice('Item location: '.length).trim(),
      professional: sellerType >= 1,
      sellerType,
      rating,
      reputation: offerReputationRank({ rating }),
      condition: condition ? CONDITIONS[condition] : 2,
      language: language ? LANGUAGES[language] : null,
      foil: false,
      signed: false,
      altered: false,
      priceCents,
      shippingCents,
      quantity: parseInt(quantity.textContent, 10),
    };
  }

  // Product id of a row, from its thumbnail image URL (.../<idProduct>/<idProduct>.jpg).
  function productOf(row) {
    const image = /\/(\d+)\/\d+\.\w+/.exec(row.querySelector('[data-bs-title*="product-images"]')?.getAttribute('data-bs-title') || '');
    return image ? Number(image[1]) : null;
  }

  function hidden(element) {
    return !element || !!element.closest('.d-none');
  }

  function queryString(query, withProduct = true) {
    const params = new URLSearchParams();
    if (withProduct && query.idProduct != null) params.set('idProduct', query.idProduct);
    if (query.language != null) params.set('language', query.language);
    if (query.sellerCountries?.length) params.set('sellerCountry', query.sellerCountries.join(','));
    if (query.minCondition != null && query.minCondition < 7) params.set('minCondition', query.minCondition);
    for (const [name, value] of [['isFoil', query.foil], ['isSigned', query.signed], ['isAltered', query.altered]]) {
      if (value && value !== 'any') params.set(name, value);
    }
    if (query.sellerType !== undefined && query.sellerType !== null) {
      const st = Array.isArray(query.sellerType) ? query.sellerType : [query.sellerType];
      if (st.length) params.set('sellerType', st.join(','));
    }
    const minRep = normalizeSellerReputation(query.sellerReputation ?? query.minReputation);
    if (minRep != null) params.set('sellerReputation', String(minRep));
    if (query.expansions?.length) params.set('idExpansion', query.expansions.join(','));
    return params.toString();
  }

  // Cardmarket echoes the filters it applied in the load-more form. Refuse to use a page whose
  // echo disagrees with the request, so a silently ignored filter cannot leak wrong offers in.
  function checkFilterEcho(raw, query) {
    const echo = JSON.parse(raw.replace(/\\+,/g, ','));
    const languages = Object.keys(echo.idLanguage || {}).map(Number);
    const problems = [];
    if (query.language != null && (languages.length !== 1 || languages[0] !== query.language)) problems.push('language');
    const echoCountries = Array.isArray(echo.idCountries)
      ? echo.idCountries.map(Number)
      : Object.keys(echo.idCountries || {}).map(Number);
    if (query.sellerCountries?.length &&
        echoCountries.sort((a, b) => a - b).join() !== [...query.sellerCountries].map(Number).sort((a, b) => a - b).join()) {
      problems.push('seller country');
    }
    const conditions = echo.condition || CONDITION_CODES;
    if (query.minCondition != null && conditions.join() !== CONDITION_CODES.slice(0, query.minCondition).join()) problems.push('condition');
    if (query.sellerType !== undefined && query.sellerType !== null) {
      const wantTypes = (Array.isArray(query.sellerType) ? query.sellerType : String(query.sellerType).split(','))
        .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const echoTypes = (Array.isArray(echo.sellerStatus)
        ? echo.sellerStatus
        : echo.sellerStatus && typeof echo.sellerStatus === 'object'
          ? Object.keys(echo.sellerStatus)
          : echo.sellerStatus != null && echo.sellerStatus !== ''
            ? String(echo.sellerStatus).split(',')
            : [])
        .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      if (wantTypes.length && echoTypes.join() !== wantTypes.join()) problems.push('seller type');
    }
    if (query.expansions?.length &&
        Object.keys(echo.idExpansions || {}).map(Number).sort((a, b) => a - b).join() !== [...query.expansions].sort((a, b) => a - b).join()) {
      problems.push('expansion');
    }
    if (problems.length) throw new Error(`Cardmarket did not apply the ${problems.join(', ')} filter`);
  }

  function checkOffer(offer, query) {
    if ((query.language != null && offer.language !== query.language) ||
        (query.minCondition != null && offer.condition > query.minCondition) ||
        (query.foil && query.foil !== 'any' && offer.foil !== (query.foil === 'Y')) ||
        (query.signed && query.signed !== 'any' && offer.signed !== (query.signed === 'Y')) ||
        (query.altered && query.altered !== 'any' && offer.altered !== (query.altered === 'Y'))) {
      throw new Error(`Offer ${offer.idArticle} does not match the requested filters`);
    }
  }

  function decodeBase64(text) {
    const bytes = Uint8Array.from(atob(text.replace(/\s/g, '')), char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function safeDecodeBase64(text) {
    if (!text) return null;
    try {
      return decodeBase64(text);
    } catch {
      return String(text).trim() || null;
    }
  }

  const WANTS_ACTION_OR_GENERIC = /^(view(\s*\/\s*edit)?(\s+list)?|edit(\s+list)?|delete|remove|shopping wizard|wizard|open|show|details?|(my\s+)?wants(\s+lists?)?|edit\s+wants(\s+list)?)$/i;

  function cleanHeadingText(el) {
    if (!el) return '';
    let node = el;
    if (typeof el.cloneNode === 'function') {
      node = el.cloneNode(true);
      if (typeof node.querySelectorAll === 'function') {
        for (const extra of node.querySelectorAll('small, span.h4, .subtitle, .badge, button, a.btn, .visually-hidden, .sr-only')) {
          extra.remove?.();
        }
      }
    }
    return (node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Extracts the human-readable Wants List name from a Wants List detail page (/en/<Game>/Wants/<id>).
  function parseWantsListName(page, listId) {
    const candidates = [
      cleanHeadingText(page.querySelector?.('main h1') || page.querySelector?.('h1')),
      page.querySelector?.('input[name="name"], input[name="wantslistName"], input[name="title"]')?.value,
      cleanHeadingText(page.querySelector?.('.page-title-container h2, main h2')),
      cleanHeadingText(page.querySelector?.('.breadcrumb-item.active, nav[aria-label="breadcrumb"] .active')),
      (page.title || page.querySelector?.('title')?.textContent || '')
        .replace(/\s*[|–-]\s*Cardmarket.*$/i, '')
        .replace(/^(my\s+)?wants(\s+list)?\s*[:–-]\s*/i, ''),
    ];
    for (const raw of candidates) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim();
      if (text && !WANTS_ACTION_OR_GENERIC.test(text)) return text;
    }
    return `Wants List ${listId}`;
  }

  // Reads a Wants List overview page (/en/Magic/Wants or /en/YuGiOh/Wants).
  function parseWantsOverview(page, game = 'Magic') {
    const pattern = new RegExp(`/${game}/Wants/(\\d+)(?:[/?#]|$)`);
    const seen = new Map();
    for (const link of page.querySelectorAll('a[href*="/Wants/"]')) {
      const href = link.getAttribute('href') || '';
      const match = pattern.exec(href);
      if (!match) continue;
      const listId = match[1];
      if (seen.has(listId)) continue;

      const linkText = (link.textContent || '').replace(/\s+/g, ' ').trim();
      const row = link.closest?.('tr') || null;
      const card = link.closest?.('.card') || link.closest?.('.card-body') || link.closest?.('article, li') || null;

      let name = '';
      if (linkText && !WANTS_ACTION_OR_GENERIC.test(linkText)) {
        name = linkText;
      } else if (card) {
        const headings = [
          card.querySelector?.('.card-title'),
          card.querySelector?.('h2, h3, h4, h5, h6'),
          card.querySelector?.('.card-header'),
        ];
        for (const el of headings) {
          const text = cleanHeadingText(el);
          if (text && !WANTS_ACTION_OR_GENERIC.test(text)) { name = text; break; }
        }
      } else if (row) {
        const linkTd = link.closest?.('td');
        const cells = [...(row.querySelectorAll?.('th, td') || [])];
        const nameCell = cells.find(cell => {
          if (cell === linkTd) return false;
          const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
          return text && !/^\d+$/.test(text) && !WANTS_ACTION_OR_GENERIC.test(text);
        });
        if (nameCell) name = nameCell.textContent.replace(/\s+/g, ' ').trim();
      }
      if (!name) continue;

      let count = null;
      if (row) {
        const linkTd = link.closest?.('td');
        const countCell = [...(row.querySelectorAll?.('td') || [])]
          .find(td => td !== linkTd && /^\d+$/.test((td.textContent || '').trim()));
        if (countCell) count = parseInt(countCell.textContent.trim(), 10);
      } else if (card) {
        const badge = card.querySelector?.('.badge');
        const badgeText = (badge?.textContent || '').trim();
        if (/^\d+$/.test(badgeText)) {
          count = parseInt(badgeText, 10);
        } else {
          const countMatch = /\b(\d+)\s*(?:cards?|items?|articles?|wants?|entries?)\b/i.exec(card.textContent || '');
          if (countMatch) count = parseInt(countMatch[1], 10);
        }
      }
      const path = new URL(href, 'https://www.cardmarket.com').pathname;
      seen.set(listId, { game, listId, name, count, path });
    }
    return [...seen.values()];
  }

  // Extracts metadata from a Cardmarket non-single product page.
  function parseProductPageMeta(page, url) {
    const parsed = new URL(url, 'https://www.cardmarket.com');
    const pathMatch = /^\/[^/]+\/(Magic|YuGiOh|Pokemon|OnePiece|Lorcana)\/Products\/([^/]+)\/(.+)$/i.exec(parsed.pathname);
    const game = pathMatch ? pathMatch[1] : 'Magic';
    const category = pathMatch ? decodeURIComponent(pathMatch[2]).replace(/-/g, ' ') : 'Product';
    const idInput = page.querySelector('input[name="idProduct"]');
    const idProduct = idInput ? Number(idInput.value) : null;
    const h1 = page.querySelector('main h1') || page.querySelector('h1');
    const titleClone = h1 ? h1.cloneNode(true) : null;
    if (titleClone) {
      for (const small of titleClone.querySelectorAll('small, span.h4, .subtitle')) small.remove();
    }
    const name = (titleClone?.textContent || page.title || parsed.pathname.split('/').pop() || 'Product')
      .replace(/\s*\|.*$/, '').replace(/\s+/g, ' ').trim();
    return {
      game,
      category,
      idProduct: Number.isFinite(idProduct) ? idProduct : null,
      name,
      path: parsed.pathname,
    };
  }

  function parseUserOffersPage(page, seller, pageNumber, originRef = 'https://www.cardmarket.com', { requireAttributes = true, allowEmpty = false } = {}) {
    const table = page.querySelector('#UserOffersTable');
    if (!table) {
      if (allowEmpty) {
        const bodyText = page.body?.textContent || page.documentElement?.textContent || '';
        if (page.querySelector('.noResults, .no-results, #UserOffers, .total-count') ||
            /sorry,\s*no\s+matches|no\s+(results|offers|articles)\s+found|0\s+hits/i.test(bodyText)) {
          return { offers: [], skipped: 0, total: 0, hasNext: false };
        }
      }
      throw new Error(`Offers of ${seller} did not load as expected`);
    }
    const offers = [];
    let skipped = 0;
    for (const row of page.querySelectorAll('#UserOffersTable [id^="stockRow"]')) {
      try {
        const attributes = tips(row, '.product-attributes');
        const price = row.querySelector('.price-container .color-primary');
        const quantity = row.querySelector('.amount-container .item-count') || row.querySelector('.item-count');
        const condition = attributes.find(text => text in CONDITIONS);
        const language = attributes.find(text => text in LANGUAGES);
        if (!price || !quantity || (requireAttributes && (!condition || !language))) { skipped += 1; continue; }
        const idArticle = Number(row.id.replace('stockRow', ''));
        const priceCents = cents(price.textContent);
        const qty = parseInt(quantity.textContent, 10);
        if (!Number.isFinite(idArticle) || idArticle <= 0 || !Number.isFinite(qty) || qty <= 0) {
          skipped += 1;
          continue;
        }
        offers.push({
          idArticle,
          seller,
          idProduct: productOf(row),
          condition: condition ? CONDITIONS[condition] : null,
          language: language ? LANGUAGES[language] : null,
          foil: attributes.includes('Foil'),
          signed: attributes.includes('Signed'),
          altered: attributes.includes('Altered'),
          priceCents,
          quantity: qty,
        });
      } catch {
        skipped += 1;
      }
    }
    const total = parseInt((page.querySelector('.total-count')?.textContent || '').replace(/\D/g, ''), 10);
    const hasNext = [...page.querySelectorAll('a[href*="site="]')]
      .some(link => new URL(link.getAttribute('href'), originRef).searchParams.get('site') === String(pageNumber + 1));
    return { offers, skipped, total: Number.isFinite(total) ? total : null, hasNext };
  }

  // Reads Cardmarket pages through fetch in a logged-in cardmarket.com tab (or via bridgeFetch).
  function browserSite({ fetchImpl = root.fetch.bind(root), paths = null, onResponse = () => {}, game = 'Magic', getToken = null, baseOrigin = '' } = {}) {
    const baseFor = g => `${baseOrigin}/en/${g || game}`;
    const resolveUrl = path => (path.startsWith('http') ? path : `${baseOrigin}${path}`);
    const originRef = baseOrigin || (typeof location !== 'undefined' ? location.href : 'https://www.cardmarket.com');
    let cachedToken = null;

    function inferUrlBucket(targetUrl, method) {
      if (root.CardmarketTelemetry?.classifyUrlBucket) {
        return root.CardmarketTelemetry.classifyUrlBucket(targetUrl, method);
      }
      let path = String(targetUrl || '');
      try { path = new URL(path, originRef).pathname; } catch {}
      if (/\/AjaxAction\/ShoppingCart_/i.test(path)) return 'cart';
      if (/\/AjaxAction\/Product_LoadMore/i.test(path)) return 'products';
      if (/\/ShoppingCart(?:\/|$)/i.test(path)) return 'cart-read';
      if (/\/Wants(?:\/|$)/i.test(path)) return 'wants';
      if (/\/Cards\//i.test(path)) return 'cards';
      if (/\/Users\/[^/]+\/Offers/i.test(path)) return 'users';
      if (/\/Products(?:\/|$)/i.test(path)) return 'products';
      return String(method || 'GET').toUpperCase() === 'POST' ? 'cart' : 'other';
    }

    async function request(url, init) {
      const started = Date.now();
      let response, text;
      try {
        response = await fetchImpl(url, { credentials: 'include', ...init });
        text = await response.text();
      } catch (error) {
        if (init?.method && init.method !== 'GET' || !(error instanceof TypeError)) throw error;
        throw new RetryableError('Network error while reading Cardmarket', { cause: error });
      }
      const totalMs = Date.now() - started;
      const method = init?.method || 'GET';
      const t = response?._timing || null;
      const extraTiming = t ? {
        ...(Number.isFinite(t.fetchMs) ? { fetchMs: t.fetchMs, bridgeOverheadMs: Math.max(0, totalMs - t.fetchMs) } : {}),
        ...(Number.isFinite(t.headersMs) ? { headersMs: t.headersMs } : {}),
        ...(Number.isFinite(t.bodyMs) ? { bodyMs: t.bodyMs } : {}),
        ...(Number.isFinite(t.tabResolveMs) ? { tabResolveMs: t.tabResolveMs } : {}),
        ...(typeof t.tabCacheHit === 'boolean' ? { tabCacheHit: t.tabCacheHit } : {}),
      } : {};
      const title = (/<title>([^<]{0,120})/i.exec(text.slice(0, 3000))?.[1] || '').trim();
      onResponse({
        method, bucket: inferUrlBucket(url, method), url, status: response.status, ms: totalMs, bytes: text.length,
        ...extraTiming,
        redirectedTo: response.redirected ? new URL(response.url, originRef).pathname : null,
        cfMitigated: response.headers.get('cf-mitigated'), retryAfter: response.headers.get('retry-after'), title: title || null,
        snippet: response.ok ? null : text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
      });
      if (response.headers.get('cf-mitigated') === 'challenge' || /^just a moment/i.test(title)) {
        throw new BlockedError('Cardmarket is refusing this kind of request for now (verification check).');
      }
      if (response.status === 403 || /attention required|access denied/i.test(title) && !response.ok && response.status !== 429) {
        throw new RefusedError(`Cardmarket refused the request (HTTP ${response.status}${title ? `: ${title}` : ''}). This is not a check you can complete.`);
      }
      if (response.status === 429 || response.status >= 500) {
        const error = new RetryableError(`HTTP ${response.status}`, { cause: response.status === 429 ? 'rate' : undefined });
        error.accessDenied = /attention required|access denied/i.test(title);
        const header = response.headers.get('retry-after');
        const seconds = Number(header);
        const parsedMs = /^\d+$/.test(header || '') ? seconds * 1000 : Math.max(0, Date.parse(header) - Date.now()) || 0;
        if (response.status === 429 && parsedMs > 0) error.retryAfterMs = Math.min(parsedMs, 1800 * 1000);
        error.readRetryAfterMs = parsedMs;
        throw error;
      }
      if (/\/(login|signup)\b/i.test(new URL(response.url, originRef).pathname)) {
        throw Object.assign(new BlockedError('Cardmarket asked for a login. Log in, then resume.'), { login: true });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { text, url: response.url };
    }

    function extractTokenFromHtml(html) {
      const match = /name=["']__cmtkn["'][^>]*value=["']([^"']+)["']/i.exec(html)
        || /value=["']([^"']+)["'][^>]*name=["']__cmtkn["']/i.exec(html);
      return match ? match[1] : null;
    }

    async function fetchFreshToken(gameOverride) {
      for (const pagePath of ['ShoppingCart', 'Wants']) {
        const { text } = await request(`${baseFor(gameOverride)}/${pagePath}`);
        const found = extractTokenFromHtml(text);
        if (found) {
          cachedToken = found;
          return found;
        }
      }
      throw new Error('No Cardmarket session token on this page');
    }

    async function resolveToken(gameOverride, { forceFresh = false } = {}) {
      if (forceFresh) {
        cachedToken = null;
        return fetchFreshToken(gameOverride);
      }
      if (cachedToken) return cachedToken;
      if (getToken) {
        const t = await getToken(gameOverride || game);
        if (t) return t;
      }
      if (typeof document !== 'undefined') {
        const local = document.querySelector('[name="__cmtkn"]')?.value;
        if (local) return local;
      }
      return fetchFreshToken(gameOverride);
    }

    async function cartRequest(action, items, gameOverride) {
      const token = await resolveToken(gameOverride);
      const body = new FormData();
      body.append('__cmtkn', token);
      for (const { idArticle, amount } of items) {
        body.append(`idArticle[${idArticle}]`, String(idArticle));
        body.append(`amount[${idArticle}]`, String(amount));
      }
      const { text } = await request(`${baseFor(gameOverride)}/AjaxAction/${action}`, { method: 'POST', body });
      const xml = new DOMParser().parseFromString(text, 'text/xml');
      const value = name => xml.getElementsByTagName(name)[0]?.textContent;
      const code = safeDecodeBase64(value('resultsCode'));
      if (code === 'generalOK') return;
      const said = safeDecodeBase64(value('resultsMessage')) || text;
      const clean = said.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (code !== null) {
        if (/token|csrf|__cmtkn|session/i.test(`${code} ${clean}`)) {
          cachedToken = null;
          throw new TokenExpiredError(`Cardmarket rejected session token (${code}): ${clean}`);
        }
        throw new CartRejectError(`Cardmarket answered ${code}: ${clean}`, { code, detail: clean });
      }
      cachedToken = null;
      throw new Error(`Cardmarket answered without a result code: ${clean}`);
    }

    // Card-page rows; unreadable or filtered-out ones are skipped and counted rather than failing the card.
    function cardRows(rows, query) {
      const offers = [];
      let skipped = 0;
      for (const row of rows) {
        try {
          const offer = { ...parseOfferRow(row), idProduct: productOf(row) };
          checkOffer(offer, query);
          if (!matchesSellerFilter(offer, query)) { skipped += 1; continue; }
          offers.push(offer);
        } catch (error) {
          skipped += 1;
        }
      }
      return { offers, skipped };
    }

    function rowsFrom(container, query) {
      const out = [];
      for (const row of container.querySelectorAll('.article-row[id^="articleRow"]')) {
        const offer = parseOfferRow(row);
        checkOffer(offer, query);
        if (!matchesSellerFilter(offer, query)) continue;
        out.push(offer);
      }
      return out;
    }

    return {
      async wantsOverview(gameOverride) {
        const g = gameOverride || game;
        const { text: html } = await request(`${baseFor(g)}/Wants`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        return parseWantsOverview(page, g);
      },

      async wantsList(gameOverride, listId) {
        const g = gameOverride || game;
        const { text: html } = await request(`${baseFor(g)}/Wants/${listId}`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        const name = parseWantsListName(page, listId);
        return { game: g, listId: String(listId), name, wants: parseWantsList(page, g) };
      },

      async wantsListInfo(gameOverride, listId) {
        const g = gameOverride || game;
        const { text: html } = await request(`${baseFor(g)}/Wants/${listId}`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        const name = parseWantsListName(page, listId);
        let count = null;
        try { count = parseWantsList(page, g).length; } catch { count = 0; }
        return { game: g, listId: String(listId), name, count, path: `/en/${g}/Wants/${listId}` };
      },

      async firstPage(query) {
        const g = query.game || game;
        const known = paths?.get(query.idProduct);
        const qs = queryString(query, !known);
        const { text: html, url } = await request(known ? `${resolveUrl(known)}${qs ? `?${qs}` : ''}` : `${baseFor(g)}/Products?${qs}`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        const table = page.querySelector('#table');
        const ids = new Set([...page.querySelectorAll('input[name="idProduct"]')].map(input => Number(input.value)));
        if (!table || ids.size !== 1 || !ids.has(query.idProduct)) {
          throw new Error(`Product ${query.idProduct} did not load as expected`);
        }
        if (!known) paths?.set(query.idProduct, new URL(url, originRef).pathname);
        const offers = rowsFrom(table, query);
        const button = page.getElementById('loadMoreButton');
        const form = button?.closest('form');
        let cursor = null;
        if (form && !hidden(button)) {
          const field = name => form.querySelector(`[name="${name}"]`)?.value;
          checkFilterEcho(field('filterSettings'), query);
          cursor = { token: field('__cmtkn'), filterSettings: field('filterSettings'), page: Number(field('page')) };
        } else if (offers.length >= 50) {
          throw new Error(`Product ${query.idProduct} showed a full page without a way to load more`);
        }
        return { offers, cursor, capped: false };
      },

      async nextPage(query, cursor) {
        const g = query.game || game;
        const body = new FormData();
        body.append('__cmtkn', cursor.token);
        body.append('page', String(cursor.page));
        body.append('filterSettings', cursor.filterSettings);
        body.append('idProduct', String(query.idProduct));
        const xml = new DOMParser().parseFromString(
          (await request(`${baseFor(g)}/AjaxAction/Product_LoadMoreArticles`, { method: 'POST', body })).text, 'text/xml');
        const value = name => xml.getElementsByTagName(name)[0]?.textContent;
        if (value('newPage') === undefined) throw new Error('Unexpected load-more response');
        const container = new DOMParser().parseFromString(`<div>${value('rows') ? decodeBase64(value('rows')) : ''}</div>`, 'text/html');
        const offers = rowsFrom(container, query);
        const capped = Number(value('maxPaginatedResultsReached')) > 0;
        const next = Number(value('newPage'));
        return { offers, cursor: next > 0 && !capped ? { ...cursor, page: next } : null, capped };
      },

      // A card's page lists offers across all its printings, cheapest first (50 per page).
      async cardPage(entry, query) {
        const qs = queryString(query, false);
        const { text: html } = await request(`${resolveUrl(entry.cardPath)}${qs ? `?${qs}` : ''}`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        if (!page.querySelector('#table')) throw new Error(`${entry.name} did not load as expected`);
        const form = page.getElementById('loadMoreButton')?.closest('form');
        const echo = form?.querySelector('[name="filterSettings"]')?.value;
        if (echo) checkFilterEcho(echo, query);
        const { offers, skipped } = cardRows(page.querySelectorAll('#table .article-row[id^="articleRow"]'), query);
        return { offers, skipped };
      },

      // A non-card product page (sleeves, deck boxes, etc.): 1 plain GET, reading both price and
      // per-seller shipping from each row.
      async productPage(entry, query) {
        const qs = queryString(query, false);
        const rawTarget = entry.productPath || entry.url;
        const localeRe = /^\/[a-z]{2}(?:-[a-z]{2})?\/(?=(?:Magic|YuGiOh|Pokemon|OnePiece|Lorcana)\/)/i;
        let target = rawTarget;
        if (typeof rawTarget === 'string' && rawTarget) {
          if (/^https?:\/\//i.test(rawTarget)) {
            const u = new URL(rawTarget);
            u.pathname = u.pathname.replace(localeRe, '/en/');
            target = u.toString();
          } else {
            target = rawTarget.replace(localeRe, '/en/');
          }
        }
        const { text: html, url } = await request(`${resolveUrl(target)}${qs ? `?${qs}` : ''}`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        const table = page.querySelector('#table');
        if (!table) throw new Error(`${entry.name || target} did not load as expected`);
        const meta = parseProductPageMeta(page, url);
        const offers = [];
        let skipped = 0;
        for (const row of table.querySelectorAll('.article-row[id^="articleRow"]')) {
          try {
            const offer = { ...parseProductOfferRow(row), idProduct: meta.idProduct };
            if (query.language != null && offer.language !== null && offer.language !== query.language) continue;
            if (query.minCondition != null && query.minCondition < 7 && offer.condition > query.minCondition) continue;
            if (!matchesSellerFilter(offer, query)) { skipped += 1; continue; }
            offers.push(offer);
          } catch (error) {
            skipped += 1;
          }
        }
        return { offers, skipped, meta };
      },

      // A seller's offers filtered by "Is in my Wants List?": 20 per page, cheapest-first so
      // pagination can stop once prices pass every remaining wanted card's ceiling.
      async sellerWants(seller, listId, pageNumber, gameOverride, { sortBy = 'price_asc' } = {}) {
        const params = new URLSearchParams({ idWantslist: listId });
        if (sortBy) params.set('sortBy', sortBy);
        if (pageNumber > 1) params.set('site', pageNumber);
        const { text: html } = await request(`${baseFor(gameOverride)}/Users/${encodeURIComponent(seller)}/Offers/Singles?${params}`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        return parseUserOffersPage(page, seller, pageNumber, originRef, { requireAttributes: true, allowEmpty: true });
      },

      // A seller's cheap Magic token offers (idRarity=24, sorted cheapest-first, 20 per page).
      async sellerTokens(seller, { maxPriceEur = 0.20, name = null, rarity = 24, pageNumber = 1, sortBy = 'price_asc' } = {}) {
        const params = new URLSearchParams();
        if (rarity != null) params.set('idRarity', String(rarity));
        if (maxPriceEur != null) params.set('maxPrice', Number(maxPriceEur).toFixed(2));
        if (name) params.set('name', name);
        if (sortBy) params.set('sortBy', sortBy);
        if (pageNumber > 1) params.set('site', String(pageNumber));
        const { text: html } = await request(`${baseFor('Magic')}/Users/${encodeURIComponent(seller)}/Offers/Singles?${params}`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        return parseUserOffersPage(page, seller, pageNumber, originRef, { requireAttributes: false, allowEmpty: true });
      },

      async refreshToken(gameOverride) {
        cachedToken = null;
        return fetchFreshToken(gameOverride);
      },

      async addToCart(idArticle, amount, gameOverride) {
        await cartRequest('ShoppingCart_Add_AddArticlesFromProductPage', [{ idArticle, amount }], gameOverride);
      },

      // What the cart says per seller: article value, shipping, and the shipping methods offered.
      async cartShipping(gameOverride) {
        const { text: html } = await request(`${baseFor(gameOverride)}/ShoppingCart`);
        const page = new DOMParser().parseFromString(html, 'text/html');
        return [...page.querySelectorAll('section.shipment-block')].map(section => {
          const text = section.textContent.replace(/\s+/g, ' ');
          const amount = label => {
            const match = new RegExp(`${label}\\s*(\\d[\\d.]*,\\d{2})\\s*€`).exec(text);
            return match ? cents(match[1]) : null;
          };
          const methods = [...new Set([...section.querySelectorAll('select[name="idShippingMethod"] option')].map(option => option.textContent.trim()))];
          const remove = [...section.querySelectorAll('a, button')].find(element => /remove articles from this seller/i.test(element.textContent));
          return {
            removeControl: remove ? (remove.closest('form') || remove).outerHTML.replace(/\s+/g, ' ').slice(0, 600) : null,
            seller: section.querySelector('a[href*="/Users/"]')?.textContent.trim() || null,
            itemsCents: amount('Article Value'), shippingCents: amount('Shipping'), trusteeCents: amount('Trustee Service'),
            methods, trackedOnly: methods.length > 0 && methods.every(method => /tracked/i.test(method)),
          };
        }).filter(shipment => shipment.seller);
      },

      async addSellerToCart(items, gameOverride) {
        await cartRequest('ShoppingCart_Add_AddArticlesFromUserOffers', items, gameOverride);
      },
    };
  }

  function limiter(size) {
    let active = 0;
    const waiting = [];
    const pump = () => {
      while (active < size && waiting.length) {
        const { task, resolve, reject } = waiting.shift();
        active += 1;
        task().then(resolve, reject).finally(() => { active -= 1; pump(); });
      }
    };
    return task => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); pump(); });
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function sleepUntil(until, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new StoppedError('Stopped.')); return; }
      const abort = () => {
        clearTimeout(timer);
        reject(new StoppedError('Stopped.'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, Math.max(0, until - Date.now()));
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  function pacer(intervalMs, bucketIntervals = {}, signal = null, { jitter = false } = {}) {
    let nextAt = 0;
    const holds = new Map();
    const bucketNext = new Map();
    const bucketFloors = new Map(Object.entries(bucketIntervals || {}).filter(([, ms]) => ms > 0));
    const bucketExtra = new Map();
    return {
      intervalMs,
      baseIntervalMs: intervalMs,
      holds,
      bucketFloors,
      bucketExtra,
      effectiveInterval(bucket) {
        return Math.max(this.intervalMs, bucketFloors.get(bucket) || 0, bucketExtra.get(bucket) || 0);
      },
      slowDown(bucket, { globalFactor = 1.5, bucketFactor = 1.75, maxMs = 10000 } = {}) {
        const prevGlobal = this.intervalMs;
        if (prevGlobal > 0) {
          this.intervalMs = Math.min(maxMs, Math.max(prevGlobal + 1, Math.round(prevGlobal * globalFactor)));
        }
        if (bucket) {
          const prevBucket = Math.max(prevGlobal, bucketFloors.get(bucket) || 0, bucketExtra.get(bucket) || 0);
          if (prevBucket > 0) {
            const nextBucket = Math.min(maxMs, Math.max(prevBucket + 1, Math.round(prevBucket * bucketFactor)));
            bucketExtra.set(bucket, nextBucket);
          }
        }
        return this.intervalMs;
      },
      recover(bucket, { stepFactor = 0.9, minStepMs = 50 } = {}) {
        let changed = false;
        if (this.intervalMs > this.baseIntervalMs) {
          const next = Math.max(this.baseIntervalMs, Math.min(this.intervalMs - minStepMs, Math.round(this.intervalMs * stepFactor)));
          if (next !== this.intervalMs) { this.intervalMs = next; changed = true; }
        }
        if (bucket && bucketExtra.has(bucket)) {
          const floor = Math.max(this.baseIntervalMs, bucketFloors.get(bucket) || 0);
          const cur = bucketExtra.get(bucket);
          if (cur > floor) {
            const next = Math.max(floor, Math.min(cur - minStepMs, Math.round(cur * stepFactor)));
            if (next <= floor) bucketExtra.delete(bucket);
            else bucketExtra.set(bucket, next);
            changed = true;
          } else {
            bucketExtra.delete(bucket);
          }
        }
        return changed;
      },
      async wait(bucket) {
        let holdMs = 0;
        let paceWaitMs = 0;
        for (;;) {
          for (let until = holds.get(bucket) || 0; until > Date.now(); until = holds.get(bucket) || 0) {
            const h0 = Date.now();
            await sleepUntil(until, signal);
            holdMs += Date.now() - h0;
          }
          const now = Date.now();
          const at = Math.max(now, nextAt, bucketNext.get(bucket) || 0);
          const useJitter = Boolean(jitter) && this.intervalMs > 0;
          const globalGap = useJitter ? Math.round(this.intervalMs * (0.85 + Math.random() * 0.3)) : this.intervalMs;
          nextAt = at + globalGap;
          const bGapBase = Math.max(bucketFloors.get(bucket) || 0, bucketExtra.get(bucket) || 0);
          if (bGapBase > 0) {
            // Never jitter below a bucket floor (e.g. cart >= 2000ms, products >= 3000ms).
            const bGap = useJitter ? Math.round(bGapBase * (1 + Math.random() * 0.15)) : bGapBase;
            bucketNext.set(bucket, at + bGap);
          }
          if (at > now) {
            const w0 = Date.now();
            await sleepUntil(at, signal);
            paceWaitMs += Date.now() - w0;
          }
          if ((holds.get(bucket) || 0) <= Date.now()) return { paceWaitMs, holdMs };
        }
      },
    };
  }

  const BUCKETS = {
    firstPage: 'products', nextPage: 'products', productPage: 'products',
    cardPage: 'cards', sellerWants: 'users', sellerTokens: 'users',
    addToCart: 'cart', addSellerToCart: 'cart',
  };

  function createRunner(site, options = {}) {
    const {
      concurrency = 4, intervalMs = 400, bucketIntervals, maxRetries = 4, maxWaits = 6, retryDelayMs = 2000,
      maxPausesWithoutSuccess = 10, maxWaitMs = null,
      jitter = true, adaptiveBackoff = true, recoverEvery = 25,
      signal = null, waitForUser = null, log = () => {}, onWait = () => {}, onDeferred = async () => {},
      readRetryDelays = null, readRetryBudgetMs = 180000,
    } = options;
    const defaultBuckets = intervalMs >= 100 ? { cart: 2000, products: 3000 } : { cart: 2000 };
    const resolvedBuckets = bucketIntervals !== undefined ? bucketIntervals : defaultBuckets;
    const run = limiter(concurrency);
    const internalAbort = new AbortController();
    const onExternalAbort = () => internalAbort.abort();
    if (signal) {
      if (signal.aborted) internalAbort.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const paceSignal = internalAbort.signal;
    const pace = pacer(intervalMs, resolvedBuckets, paceSignal, { jitter });
    const stats = {
      requests: 0, retries: 0, waits: 0, pauses: 0, cachedQueries: 0, startedAt: Date.now(), finishedAt: null,
      timings: { paceWaitMs: 0, holdMs: 0, execMs: 0, slowdowns: 0, recoveries: 0, initialIntervalMs: intervalMs, byBucket: {} },
    };
    function recordTiming(bucket, method, { paceWaitMs = 0, holdMs = 0, execMs = 0, ok = true, retries = 0 }) {
      const t = stats.timings;
      t.paceWaitMs += paceWaitMs;
      t.holdMs += holdMs;
      t.execMs += execMs;
      const b = t.byBucket[bucket] || (t.byBucket[bucket] = { calls: 0, paceWaitMs: 0, holdMs: 0, execMs: 0, retries: 0 });
      b.calls += 1;
      b.paceWaitMs += paceWaitMs;
      b.holdMs += holdMs;
      b.execMs += execMs;
      b.retries += retries;
      log({ type: 'runner-call', bucket, method, paceWaitMs, holdMs, execMs, ok, retries });
    }
    const cleanStreak = new Map();
    let blocked = null;
    let pause = null;
    let refusals = 0;
    let pausesWithoutSuccess = 0;

    function setBlocked(err) {
      if (!blocked) blocked = err;
      if (!internalAbort.signal.aborted) internalAbort.abort();
      return blocked;
    }

    // One shared prompt however many concurrent slots hit a check at the same time.
    function promptUser(message, attempt) {
      if (!pause) {
        pause = waitForUser(message, attempt).then(
          () => { log({ type: 'resume' }); },
          () => { setBlocked(new StoppedError('Stopped.')); },
        ).finally(() => { pause = null; });
      }
      return pause;
    }

    function read(method, args, bucket) {
      return run(async () => {
        let firstFailure, retries = 0, prompted = false;
        try {
          for (;;) {
            if (pause) await pause;
            if (signal?.aborted) throw setBlocked(new StoppedError('Stopped.'));
            if (blocked) throw blocked;
            const waitTiming = await pace.wait(bucket);
            if (blocked) throw blocked;
            if (signal?.aborted) throw setBlocked(new StoppedError('Stopped.'));
            stats.requests += 1;
            const execStart = Date.now();
            try {
              const res = await site[method](...args);
              recordTiming(bucket, method, {
                paceWaitMs: waitTiming?.paceWaitMs || 0,
                holdMs: waitTiming?.holdMs || 0,
                execMs: Date.now() - execStart,
                ok: true,
                retries,
              });
              if (adaptiveBackoff && recoverEvery > 0) {
                const nextStreak = (cleanStreak.get(bucket) || 0) + 1;
                if (nextStreak >= recoverEvery) {
                  cleanStreak.set(bucket, 0);
                  if (pace.recover(bucket)) {
                    stats.timings.recoveries += 1;
                    log({ type: 'pace-recover', bucket, intervalMs: pace.intervalMs, bucketIntervalMs: pace.effectiveInterval(bucket) });
                  }
                } else {
                  cleanStreak.set(bucket, nextStreak);
                }
              }
              return res;
            } catch (error) {
              recordTiming(bucket, method, {
                paceWaitMs: waitTiming?.paceWaitMs || 0,
                holdMs: waitTiming?.holdMs || 0,
                execMs: Date.now() - execStart,
                ok: false,
                retries,
              });
              const check = error instanceof BlockedError && !(error instanceof StoppedError) && !error.login;
              if (!(error instanceof RetryableError) && !(error instanceof RefusedError) && !check) throw error;
              const now = Date.now();
              firstFailure ??= now;
              const isRateSignal = error.cause === 'rate' || check || error instanceof RefusedError || error.accessDenied;
              const newWave = now >= (pace.holds.get(bucket) || 0);
              if (isRateSignal) {
                cleanStreak.set(bucket, 0);
                if (adaptiveBackoff && newWave && (pace.intervalMs > 0 || pace.bucketFloors.has(bucket))) {
                  pace.slowDown(bucket);
                  stats.timings.slowdowns += 1;
                  log({ type: 'pace-slowdown', bucket, intervalMs: pace.intervalMs, bucketIntervalMs: pace.effectiveInterval(bucket) });
                }
              }
              const delay = readRetryDelays[retries];
              const until = now + Math.max(delay ?? 0, error.readRetryAfterMs ?? error.retryAfterMs ?? 0);
              if (until > firstFailure + readRetryBudgetMs) {
                const retryAfterMs = error.readRetryAfterMs ?? error.retryAfterMs ?? 0;
                const err = setBlocked(new BlockedError(`Cardmarket asked to wait until ${new Date(until).toLocaleTimeString()}. Collection paused; resume later.`));
                if (retryAfterMs > 0) await onDeferred({ until });
                throw err;
              }
              if (delay === undefined) {
                if (prompted || !waitForUser) throw setBlocked(new BlockedError(`${error.message} after ${retries} retries.`));
                pace.holds.set(bucket, Math.max(pace.holds.get(bucket) || 0, until));
                prompted = true;
                stats.pauses += 1;
                await sleepUntil(until, paceSignal);
                await promptUser(`${error.message} after ${retries} retries.`, -1);
              } else {
                pace.holds.set(bucket, Math.max(pace.holds.get(bucket) || 0, until));
                retries += 1;
                stats.retries += 1;
                log({ type: 'retry', method, kind: check ? 'check' : error instanceof RefusedError ? 'refused' : 'rate', error: error.message, attempt: retries, until, intervalMs: pace.intervalMs });
                onWait({ bucket, until, retry: retries, intervalMs: pace.intervalMs });
                await sleepUntil(until, paceSignal);
              }
            }
          }
        } catch (error) {
          if (signal?.aborted) setBlocked(new StoppedError('Stopped.'));
          else if (error instanceof BlockedError) setBlocked(error);
          throw blocked || error;
        }
      });
    }

    async function call(method, ...args) {
      const bucket = BUCKETS[method] || method;
      if (readRetryDelays && bucket !== 'cart') return read(method, args, bucket);
      let waits = 0;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await run(async () => {
            if (pause) await pause;
            if (blocked) throw blocked;
            if (signal?.aborted) throw setBlocked(new StoppedError('Stopped.'));
            const waitTiming = await pace.wait(bucket);
            if (blocked) throw blocked;
            if (signal?.aborted) throw setBlocked(new StoppedError('Stopped.'));
            stats.requests += 1;
            const execStart = Date.now();
            try {
              const result = await site[method](...args);
              recordTiming(bucket, method, {
                paceWaitMs: waitTiming?.paceWaitMs || 0,
                holdMs: waitTiming?.holdMs || 0,
                execMs: Date.now() - execStart,
                ok: true,
                retries: attempt,
              });
              refusals = 0;
              pausesWithoutSuccess = 0;
              return result;
            } catch (execErr) {
              recordTiming(bucket, method, {
                paceWaitMs: waitTiming?.paceWaitMs || 0,
                holdMs: waitTiming?.holdMs || 0,
                execMs: Date.now() - execStart,
                ok: false,
                retries: attempt,
              });
              throw execErr;
            }
          });
        } catch (error) {
          if (blocked) throw blocked;
          if (error instanceof RefusedError) {
            refusals += 1;
            log({ type: 'refused', method, error: error.message, inARow: refusals });
            if (refusals >= 3) setBlocked(new StoppedError(`${error.message} Stopped after ${refusals} refusals in a row; try again later.`));
            throw error;
          }
          if (error instanceof BlockedError && !(error instanceof StoppedError) && !error.login && waitForUser && !blocked) {
            if (!pause && pausesWithoutSuccess >= maxPausesWithoutSuccess) {
              throw setBlocked(new StoppedError(`Cardmarket still refused after ${pausesWithoutSuccess} waits in a row. Stopped; try again later.`));
            }
            if (!pause) {
              pausesWithoutSuccess += 1;
              stats.pauses += 1;
              pace.intervalMs = Math.min(Math.round(pace.intervalMs * 1.5), 10000);
              log({ type: 'pause', reason: error.message, requests: stats.requests, intervalMs: pace.intervalMs });
              promptUser(error.message, pausesWithoutSuccess);
            }
            await pause;
            attempt -= 1;
            continue;
          }
          if (error instanceof BlockedError) {
            throw setBlocked(signal?.aborted ? new StoppedError('Stopped.') : error);
          }
          if (!(error instanceof RetryableError)) throw error;
          // A 5xx on a cart POST may already have added the items; only rate limits are safe to retry.
          if (bucket === 'cart' && error.cause !== 'rate') throw error;
          if (error.retryAfterMs && waits < maxWaits) {
            if (maxWaitMs != null && error.retryAfterMs > maxWaitMs) {
              const until = Date.now() + error.retryAfterMs;
              const mins = Math.max(1, Math.ceil(error.retryAfterMs / 60000));
              throw setBlocked(new BlockedError(`Cardmarket rate-limited this action until ${new Date(until).toLocaleTimeString()} (~${mins} min). Try again later.`));
            }
            waits += 1;
            stats.waits += 1;
            const until = Math.max(pace.holds.get(bucket) || 0, Date.now() + error.retryAfterMs);
            if (until > (pace.holds.get(bucket) || 0)) {
              pace.holds.set(bucket, until);
              log({ type: 'wait', bucket, seconds: Math.round(error.retryAfterMs / 1000), requests: stats.requests });
              onWait({ bucket, until });
            }
            attempt -= 1;
            continue;
          }
          if (attempt >= maxRetries) throw error;
          stats.retries += 1;
          if (error.cause === 'rate') pace.intervalMs = Math.min(pace.intervalMs * 2, 10000);
          log({ type: 'retry', method, error: error.message, attempt, intervalMs: pace.intervalMs });
          await sleepUntil(Date.now() + retryDelayMs * 2 ** attempt, paceSignal);
        }
      }
    }

    return {
      call, stats, pace,
      blocked: () => blocked,
      finish() {
        if (signal) signal.removeEventListener('abort', onExternalAbort);
        stats.finishedAt = Date.now();
        stats.intervalMs = pace.intervalMs;
      },
    };
  }

  const cacheKey = query => {
    const st = Array.isArray(query.sellerType) ? query.sellerType.join('.') : (query.sellerType ?? '');
    const rep = normalizeSellerReputation(query.sellerReputation ?? query.minReputation);
    const base = [query.game || 'Magic', query.idProduct, query.language ?? '', [...(query.sellerCountries || [])].sort().join('.'), query.minCondition ?? '',
      query.foil ?? 'any', query.signed ?? 'any', query.altered ?? 'any', st].join('|');
    return rep != null ? `${base}|r${rep}` : base;
  };

  const productCacheKey = (pathOrUrl, language, countriesStr, minCondition, sellerReputation, sellerTypes) => {
    const base = ['product', pathOrUrl, language ?? '', countriesStr, minCondition].join('|');
    const rep = normalizeSellerReputation(sellerReputation);
    const st = normalizeSellerTypes(sellerTypes);
    if (rep == null && !st) return base;
    return `${base}|r${rep ?? ''}|t${st ? st.join('.') : ''}`;
  };

  async function collect(plan, site, options = {}) {
    const {
      targetCopies = 5, targetSellers = 3, cutoffFactor = 2, cutoffMarginCents = 50, sellerCountries = [7],
      minReputation = null, sellerReputation = null, sellerTypes = null,
      concurrency = 4, entryConcurrency = 4, intervalMs = 400, wave = 4,
      onProgress = () => {}, log = () => {}, cache = null, cacheMaxAgeMs = CACHE_MAX_AGE_MS,
    } = options;
    const minRep = normalizeSellerReputation(minReputation ?? sellerReputation);
    const allowedSellerTypes = normalizeSellerTypes(sellerTypes);
    const initialSellerType = allowedSellerTypes
      ? (allowedSellerTypes.length === 1 ? allowedSellerTypes[0] : allowedSellerTypes)
      : undefined;
    const sellerFilter = { sellerReputation: minRep, sellerTypes: allowedSellerTypes };
    const runner = createRunner(site, options);
    const { call, stats } = runner;
    log({ type: 'run-start', cards: plan.entries.length, printings: plan.entries.reduce((sum, entry) => sum + (entry.printings?.length || 0), 0),
      sellerCountries, minReputation: minRep, sellerTypes: allowedSellerTypes,
      intervalMs, concurrency, entryConcurrency, targetCopies, targetSellers, cutoffFactor, cutoffMarginCents });

    async function collectEntry(entry) {
      if (entry.kind === 'product') {
        const query = {
          game: entry.game || 'Magic', language: entry.languages?.length === 1 ? entry.languages[0] : null,
          sellerCountries, minCondition: entry.minCondition ?? 7,
          ...(minRep != null ? { sellerReputation: minRep } : {}),
          ...(initialSellerType !== undefined ? { sellerType: initialSellerType } : {}),
        };
        const pKey = productCacheKey(entry.productPath || entry.url, query.language, [...sellerCountries].sort().join('.'), query.minCondition, minRep, allowedSellerTypes);
        const hit = cache?.get(pKey);
        let page;
        if (hit && Date.now() - hit.at < cacheMaxAgeMs) {
          stats.cachedQueries += 1;
          page = hit.value;
        } else {
          try {
            page = await call('productPage', entry, query);
            cache?.set(pKey, { at: Date.now(), value: page });
          } catch (error) {
            if (error instanceof BlockedError) throw error;
            log({ type: 'product-error', product: entry.name, error: error.message });
            return {
              key: entry.key, name: entry.name, amount: entry.amount,
              kind: 'product', game: entry.game || 'Magic',
              category: entry.category || 'Product', productPath: entry.productPath || entry.url || null,
              listId: entry.listId ?? null, listName: entry.listName ?? null,
              targetCents: null, cutoffCents: null,
              verdict: 'incomplete', error: error.message,
              printings: 1, requests: 1, queries: [], offers: [],
            };
          }
        }
        const sorted = [...page.offers]
          .filter(offer => matchesSellerFilter(offer, sellerFilter))
          .sort((a, b) => (a.priceCents + (a.shippingCents || 0)) - (b.priceCents + (b.shippingCents || 0)));
        const target = targetPrice(sorted, entry.amount, targetCopies, targetSellers) ?? sorted[0]?.priceCents ?? null;
        return {
          key: entry.key, name: page.meta?.name || entry.name, amount: entry.amount,
          kind: 'product', game: entry.game || page.meta?.game || 'Magic',
          category: entry.category || page.meta?.category || 'Product', productPath: entry.productPath || page.meta?.path || null,
          listId: entry.listId ?? null, listName: entry.listName ?? null,
          targetCents: target, cutoffCents: null,
          verdict: sorted.length ? 'complete' : 'unavailable',
          printings: 1, requests: hit ? 0 : 1, queries: [], offers: sorted,
        };
      }

      const offers = new Map();
      const queries = [];
      for (const printing of entry.printings) {
        for (const language of queryLanguagesFor(entry)) {
          queries.push({
            game: entry.game || 'Magic', idProduct: printing.idProduct, guideLowCents: printing.guideLowCents ?? null, language,
            sellerCountries, minCondition: entry.minCondition, foil: entry.foil, signed: entry.signed,
            altered: entry.altered,
            ...(minRep != null ? { sellerReputation: minRep } : {}),
            ...(initialSellerType !== undefined ? { sellerType: initialSellerType } : {}),
            status: 'pending', pages: 0, lastPriceCents: null, cursor: null, error: null,
          });
        }
      }
      const order = query => query.guideLowCents ?? Number.MAX_SAFE_INTEGER;
      queries.sort((a, b) => order(a) - order(b));

      const target = () => {
        const needed = Math.max(targetCopies, entry.amount);
        const sellers = new Set();
        let copies = 0;
        for (const offer of [...offers.values()].sort((a, b) => a.priceCents - b.priceCents)) {
          copies += offer.quantity;
          sellers.add(offer.seller);
          if (copies >= needed && sellers.size >= targetSellers) return offer.priceCents;
        }
        return null;
      };
      const cutoff = () => {
        const price = target();
        const limit = price === null ? Infinity : Math.max(price * cutoffFactor, price + cutoffMarginCents);
        return entry.maxPriceCents != null ? Math.min(limit, entry.maxPriceCents) : limit;
      };

      function keep(query, list) {
        for (const offer of list) {
          if (entry.maxPriceCents != null && offer.priceCents > entry.maxPriceCents) continue;
          if (!matchesSellerFilter(offer, sellerFilter)) continue;
          offers.set(offer.idArticle, { ...offer, idProduct: query.idProduct });
        }
      }

      async function read(query, method) {
        if (method === 'firstPage') {
          const cached = cache?.get(cacheKey(query));
          if (cached && !query.refetch && Date.now() - cached.at < cacheMaxAgeMs &&
              (cached.status !== 'open' || cached.lastPriceCents > cutoff())) {
            Object.assign(query, { status: cached.status, lastPriceCents: cached.lastPriceCents, cachedAt: cached.at });
            keep(query, cached.offers);
            stats.cachedQueries += 1;
            log({ type: 'printing', card: entry.name, idProduct: query.idProduct, language: query.language, sellerType: query.sellerType,
              from: 'cache', status: query.status, offers: cached.offers.length, lastPriceCents: query.lastPriceCents });
            return;
          }
          Object.assign(query, { offers: [], pages: 0, cachedAt: null });
        }
        try {
          const result = await call(method, query, query.cursor);
          query.pages += 1;
          query.offers.push(...result.offers);
          keep(query, result.offers);
          if (result.offers.length) query.lastPriceCents = result.offers.at(-1).priceCents;
          query.cursor = result.cursor;
          query.status = result.cursor ? 'open' : result.capped ? 'capped' : 'complete';
          cache?.set(cacheKey(query), { at: Date.now(), status: query.status, lastPriceCents: query.lastPriceCents, offers: query.offers });
          log({ type: 'printing', card: entry.name, idProduct: query.idProduct, language: query.language, sellerType: query.sellerType,
            from: method, page: query.pages, status: query.status, offers: result.offers.length, lastPriceCents: query.lastPriceCents,
            cutoffCents: Number.isFinite(cutoff()) ? cutoff() : null });
        } catch (error) {
          if (error instanceof BlockedError) throw error;
          query.status = 'error';
          query.error = error.message;
          query.cursor = null;
          log({ type: 'printing-error', card: entry.name, idProduct: query.idProduct, language: query.language, error: error.message });
        }
      }

      let next = 0;
      while (next < queries.length) {
        const limit = cutoff();
        const batch = [];
        const size = Number.isFinite(limit) ? wave : 1;
        while (next < queries.length && batch.length < size && !((queries[next].guideLowCents ?? -1) > limit)) {
          batch.push(queries[next++]);
        }
        if (!batch.length) break;
        await Promise.all(batch.map(query => read(query, 'firstPage')));
      }
      for (const query of queries.slice(next)) query.status = query.guideLowCents === null ? 'pending' : 'skipped';

      for (;;) {
        const limit = cutoff();
        for (const query of queries) {
          const canSplitSellerType = query.sellerType === undefined || (Array.isArray(query.sellerType) && query.sellerType.length > 1);
          if (query.status === 'capped' && query.lastPriceCents <= limit && canSplitSellerType) {
            const splitTypes = Array.isArray(query.sellerType) ? query.sellerType : SELLER_TYPES;
            query.status = 'split';
            for (const sellerType of splitTypes) {
              queries.push({ ...query, sellerType, status: 'pending', pages: 0, lastPriceCents: null, cursor: null, cachedAt: null });
            }
          }
          if (query.status === 'open' && !query.cursor && query.lastPriceCents <= limit) {
            Object.assign(query, { status: 'pending', refetch: true });
          }
        }
        const pending = queries.filter(query => query.status === 'pending');
        const open = queries.filter(query => query.status === 'open' && query.lastPriceCents <= limit);
        if (!pending.length && !open.length) break;
        await Promise.all([
          ...pending.map(query => read(query, 'firstPage')),
          ...open.map(query => read(query, 'nextPage')),
        ]);
      }

      const limit = cutoff();
      const gaps = [];
      for (const query of queries) {
        const covered = query.status === 'complete' || query.status === 'split' ||
          (query.status === 'skipped' && query.guideLowCents > limit) ||
          ((query.status === 'open' || query.status === 'capped') && query.lastPriceCents > limit);
        if (!covered) gaps.push(query);
        delete query.cursor;
        delete query.offers;
        delete query.refetch;
      }
      const sorted = [...offers.values()].sort((a, b) => a.priceCents - b.priceCents);
      const copies = sorted.reduce((sum, offer) => sum + offer.quantity, 0);
      let fallback = null;
      for (let i = 0, seen = 0; i < sorted.length && fallback === null; i += 1) {
        seen += sorted[i].quantity;
        if (seen >= entry.amount) fallback = sorted[i].priceCents;
      }
      const result = {
        key: entry.key, name: entry.name, amount: entry.amount,
        kind: 'card', game: entry.game || 'Magic', listId: entry.listId ?? null, listName: entry.listName ?? null,
        maxPriceCents: entry.maxPriceCents ?? null,
        targetCents: target() ?? fallback,
        cutoffCents: Number.isFinite(limit) ? limit : null,
        verdict: gaps.some(query => query.status === 'error') ? 'incomplete'
          : gaps.length ? 'capped' : copies >= entry.amount ? 'complete' : copies ? 'short' : 'unavailable',
        printings: entry.printings.length,
        requests: queries.reduce((sum, query) => sum + query.pages, 0),
        queries,
        offers: sorted.filter(offer => offer.priceCents <= limit),
      };
      log({ type: 'card', card: entry.name, verdict: result.verdict, targetCents: result.targetCents, cutoffCents: result.cutoffCents,
        offers: result.offers.length, sellers: new Set(result.offers.map(offer => offer.seller)).size,
        read: queries.filter(query => query.pages > 0 || query.cachedAt).length, skipped: queries.filter(query => query.status === 'skipped').length,
        gaps: gaps.map(query => `${query.idProduct}:${query.status}${query.error ? `:${query.error}` : ''}`) });
      return result;
    }

    const results = [];
    let done = 0;
    const cardSlot = limiter(entryConcurrency);
    await Promise.all(plan.entries.map(entry => cardSlot(async () => {
      try {
        results.push(await collectEntry(entry));
      } catch (error) {
        if (!(error instanceof BlockedError)) throw error;
        results.push({
          key: entry.key, name: entry.name, amount: entry.amount,
          kind: entry.kind || 'card', game: entry.game || 'Magic', listId: entry.listId ?? null, listName: entry.listName ?? null,
          verdict: 'blocked', queries: [], offers: [],
        });
      }
      done += 1;
      onProgress({ done, total: plan.entries.length, requests: stats.requests, retries: stats.retries, intervalMs: runner.pace.intervalMs, paused: false });
    })));
    runner.finish();
    log({ type: 'run-end', ...stats, blocked: runner.blocked()?.message ?? null });
    const order = new Map(plan.entries.map((entry, index) => [entry.key, index]));
    results.sort((a, b) => order.get(a.key) - order.get(b.key));
    return { results, stats, blocked: runner.blocked()?.message ?? null, sellerCountries,
      sellerFilter: { minReputation: minRep, sellerTypes: allowedSellerTypes },
      rule: { targetCopies, targetSellers, cutoffFactor, cutoffMarginCents } };
  }

  function expansionGroups(printings, size) {
    if (!printings.some(printing => printing.idExpansion)) return [{ expansions: null, products: null, minGuideCents: 0 }];
    const order = printing => printing.guideLowCents ?? -1;
    const groups = [];
    const placed = new Map();
    for (const printing of [...printings].filter(p => p.idExpansion).sort((a, b) => order(a) - order(b))) {
      const existing = placed.get(printing.idExpansion);
      if (existing) { existing.products.add(printing.idProduct); continue; }
      let group = groups.at(-1);
      if (!group || group.expansions.length >= size) {
        group = { expansions: [], products: new Set(), minGuideCents: printing.guideLowCents ?? 0 };
        groups.push(group);
      }
      group.expansions.push(printing.idExpansion);
      group.products.add(printing.idProduct);
      placed.set(printing.idExpansion, group);
    }
    return groups;
  }

  function targetPrice(sorted, amount, targetCopies, targetSellers) {
    const sellers = new Set();
    let copies = 0;
    for (const offer of sorted) {
      copies += offer.quantity;
      sellers.add(offer.seller);
      if (copies >= Math.max(targetCopies, amount) && sellers.size >= targetSellers) return offer.priceCents;
    }
    return null;
  }

  const ALL_LANGUAGE_IDS = Object.values(LANGUAGES);
  function queryLanguagesFor(entry) {
    const langs = [...new Set((entry.languages || []).filter(Boolean))];
    if (!langs.length || ALL_LANGUAGE_IDS.every(id => langs.includes(id))) return [null];
    return langs;
  }

  function matchesWant(entry, offer) {
    if (entry.maxPriceCents != null && offer.priceCents > entry.maxPriceCents) return false;
    if (entry.kind === 'product') {
      return (!entry.languages?.length || offer.language === null || entry.languages.includes(offer.language)) &&
        (entry.minCondition == null || offer.condition <= entry.minCondition);
    }
    return (!entry.languages?.length || entry.languages.includes(offer.language)) && offer.condition <= entry.minCondition &&
      (entry.foil === 'any' || offer.foil === (entry.foil === 'Y')) &&
      (entry.signed === 'any' || offer.signed === (entry.signed === 'Y')) &&
      (entry.altered === 'any' || offer.altered === (entry.altered === 'Y'));
  }

  /*
   * Seller-first collection across one or many Wants Lists (same or different games) plus optional
   * non-card products (sleeves, deck boxes, etc.):
   * 1. Each card's page sets its target price and discovers cheap sellers; each non-card product
   *    reads 1 plain GET to its product page (including per-seller shipping rates).
   * 2. The sellers cheap for the most total items across ALL lists/games/products are asked for
   *    every offer they have from each selected Wants List ("Is in my Wants List?").
   */
  async function collectBySellers(plan, site, options = {}) {
    const {
      listId = null, lists = null,
      targetCopies = 5, targetSellers = 3, cutoffFactor = 2, cutoffMarginCents = 50, sellerCountries = [7],
      minReputation = null, sellerReputation = null, sellerTypes = null,
      domesticCountry = null, domesticLocation = null,
      domesticMinOffers = 10, domesticProductMinOffers = 15, domesticPageFullThreshold = 45,
      domesticSellerShare = 0.6,
      loadShippingTables = null, shippingTables = null,
      minSellers = 20, sellerBatch = 10, sellerLimit = 150, improvementCents = 100, evaluate = null, expansionGroupSize = 12,
      splitBySellerType = false, groupSkipFactor = 1,
      minSellerCards = 2, maxSellerPages = 8, sellerCeilingMarginCents = 150,
      concurrency = 4,
      onProgress = () => {}, log = () => {}, cache = null, cacheMaxAgeMs = CACHE_MAX_AGE_MS,
    } = options;
    const runner = createRunner(site, options);
    const { call, stats } = runner;
    const slotSize = Math.max(2, concurrency);

    // Normalise selected Wants Lists (backwards-compatible with single listId).
    const activeLists = Array.isArray(lists) && lists.length
      ? lists
      : listId
        ? [{ game: plan.entries.find(e => e.kind !== 'product')?.game || 'Magic', listId }]
        : [];

    const minRep = normalizeSellerReputation(minReputation ?? sellerReputation);
    const allowedSellerTypes = normalizeSellerTypes(sellerTypes);
    const sellerFilter = { sellerReputation: minRep, sellerTypes: allowedSellerTypes };
    const productSellerType = allowedSellerTypes
      ? (allowedSellerTypes.length === 1 ? allowedSellerTypes[0] : allowedSellerTypes)
      : undefined;
    const sellerTypeQueries = splitBySellerType
      ? (allowedSellerTypes || SELLER_TYPES)
      : (allowedSellerTypes ? [productSellerType] : [undefined]);
    const repKeySuffix = minRep != null ? `|r${minRep}` : '';

    log({ type: 'run-start', method: 'sellers', cards: plan.entries.length, lists: activeLists.length, sellerCountries,
      minReputation: minRep, sellerTypes: allowedSellerTypes,
      minSellers, sellerBatch, sellerLimit, improvementCents, minSellerCards, maxSellerPages, concurrency: slotSize,
      intervalMs: runner.pace.intervalMs, targetCopies, targetSellers, cutoffFactor, cutoffMarginCents, splitBySellerType, groupSkipFactor, expansionGroupSize });

    const inFlight = new Map();
    async function cached(key, fetch) {
      const hit = cache?.get(key);
      if (hit && Date.now() - hit.at < cacheMaxAgeMs) { stats.cachedQueries += 1; return { ...hit.value, fromCache: true }; }
      if (inFlight.has(key)) {
        const shared = await inFlight.get(key);
        return { ...shared, fromCache: true };
      }
      const pending = (async () => {
        const value = await fetch();
        cache?.set(key, { at: Date.now(), value });
        return value;
      })();
      inFlight.set(key, pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(key);
      }
    }

    const entries = plan.entries;
    const byProduct = new Map();
    for (const entry of entries) {
      if (entry.kind === 'product') continue;
      for (const printing of entry.printings || []) {
        const key = `${entry.game || 'Magic'}:${printing.idProduct}`;
        if (!byProduct.has(key)) byProduct.set(key, []);
        byProduct.get(key).push(entry);
      }
      if (!(entry.printings || []).length && !entry.anyPrinting && entry.idProduct != null) {
        const key = `${entry.game || 'Magic'}:${entry.idProduct}`;
        if (!byProduct.has(key)) byProduct.set(key, []);
        byProduct.get(key).push(entry);
      }
    }
    const offers = new Map(entries.map(entry => [entry.key, new Map()]));
    const sellerLocations = new Map();
    const sellerMeta = new Map();
    const rememberSellerMeta = offer => {
      if (!offer?.seller) return;
      let meta = sellerMeta.get(offer.seller);
      if (!meta) {
        meta = { location: null, rating: null, reputation: null, sellerType: null, professional: null };
        sellerMeta.set(offer.seller, meta);
      }
      if (offer.location && !meta.location) meta.location = offer.location;
      if (offer.location && !sellerLocations.has(offer.seller)) sellerLocations.set(offer.seller, offer.location);
      const rank = offerReputationRank(offer);
      if (rank != null && meta.reputation == null) {
        meta.reputation = rank;
        meta.rating = offer.rating || Object.entries(SELLER_REPUTATIONS).find(([, r]) => r === rank)?.[0] || null;
      }
      const st = offerSellerType(offer);
      if (st != null && meta.sellerType == null) {
        meta.sellerType = st;
        meta.professional = st >= 1;
      } else if (typeof offer.professional === 'boolean' && meta.professional == null) {
        meta.professional = offer.professional;
      }
    };
    const cardState = new Map(entries.map(entry => [entry.key,
      { status: 'pending', cardOffers: 0, skipped: 0, pages: 0, groups: 0, groupsSkipped: 0, error: null, resolvedName: null, resolvedMeta: null }]));

    const keep = (entry, offer) => {
      if (!matchesSellerFilter(offer, sellerFilter)) return false;
      rememberSellerMeta(offer);
      if (entry.kind === 'product') {
        if (!matchesWant(entry, offer)) return false;
        offers.get(entry.key).set(offer.idArticle, offer);
        return true;
      }
      const printings = new Set((entry.printings || []).map(printing => printing.idProduct));
      if (printings.size === 0) {
        // A want whose printing is missing from the catalogue: any printing accepts any identified offer, a specific one only its own id.
        if (offer.idProduct === null ? !entry.anyPrinting
          : !(entry.anyPrinting || (entry.idProduct != null && offer.idProduct === entry.idProduct))) return false;
      } else if (offer.idProduct !== null ? !printings.has(offer.idProduct) : !entry.anyPrinting) return false;
      if (!matchesWant(entry, offer)) return false;
      offers.get(entry.key).set(offer.idArticle, offer);
      return true;
    };
    const progress = (phase, done, total) => onProgress({ phase, done, total, requests: stats.requests, retries: stats.retries, intervalMs: runner.pace.intervalMs });

    const capPrice = (entry, cents) => (entry.maxPriceCents != null ? Math.min(cents, entry.maxPriceCents) : cents);
    const cutoffOf = entry => {
      const sorted = [...offers.get(entry.key).values()].sort((a, b) => a.priceCents - b.priceCents);
      const target = targetPrice(sorted, entry.amount, targetCopies, targetSellers);
      return capPrice(entry, target === null ? Infinity : Math.max(target * cutoffFactor, target + cutoffMarginCents));
    };

    const hasFreshCache = key => {
      const hit = cache?.get(key);
      return Boolean(hit && Date.now() - hit.at < cacheMaxAgeMs);
    };
    const seedDomestic = domesticCountry != null && (
      sellerCountries.length === 0 ||
      (sellerCountries.length > 1 && sellerCountries.includes(domesticCountry))
    );
    const domesticKeyPart = seedDomestic ? String(domesticCountry) : null;

    let done = 0;
    const cardSlot = limiter(slotSize);
    const countriesKey = [...sellerCountries].map(Number).sort((a, b) => a - b).join('.');
    const phase1Start = Date.now();
    const phase1StartReqs = stats.requests;
    const phase1StartCached = stats.cachedQueries;
    log({ type: 'phase-start', phase: 'cards', items: entries.length });
    await Promise.all(entries.map(entry => cardSlot(async () => {
      const state = cardState.get(entry.key);
      if (entry.kind === 'product') {
        try {
          const query = {
            game: entry.game || 'Magic',
            language: entry.languages?.length === 1 ? entry.languages[0] : null,
            sellerCountries,
            minCondition: entry.minCondition ?? 7,
            ...(minRep != null ? { sellerReputation: minRep } : {}),
            ...(productSellerType !== undefined ? { sellerType: productSellerType } : {}),
          };
          const key = productCacheKey(entry.productPath || entry.url, query.language, countriesKey, query.minCondition, minRep, allowedSellerTypes);
          const page = await cached(key, () => call('productPage', entry, query));
          let kept = 0;
          for (const offer of page.offers) if (keep(entry, offer)) kept += 1;
          state.skipped += page.skipped || 0;
          state.pages += 1;
          state.resolvedName = page.meta?.name || entry.name;
          state.resolvedMeta = page.meta || null;
          log({ type: 'product-page', product: state.resolvedName, offers: page.offers.length, kept,
            cheapestCents: page.offers[0]?.priceCents ?? null, cached: !!page.fromCache });

          // Multi-country page 1 is sorted by raw item price (excluding shipping), so foreign shops
          // can crowd domestic sellers off page 1. Merge domestic offers when cached or crowded.
          if (seedDomestic && !runner.blocked()) {
            const domKey = productCacheKey(entry.productPath || entry.url, query.language, domesticKeyPart, query.minCondition, minRep, allowedSellerTypes);
            const rawRows = page.offers.length + (page.skipped || 0);
            const domCount = domesticLocation ? page.offers.filter(o => o.location === domesticLocation).length : 0;
            if (hasFreshCache(domKey) || (rawRows >= domesticPageFullThreshold && domCount < domesticProductMinOffers)) {
              try {
                const domQuery = { ...query, sellerCountries: [domesticCountry] };
                const domPage = await cached(domKey, () => call('productPage', entry, domQuery));
                let domKept = 0;
                for (const offer of domPage.offers) if (keep(entry, offer)) domKept += 1;
                state.skipped += domPage.skipped || 0;
                state.pages += 1;
                log({ type: 'product-page', product: state.resolvedName, offers: domPage.offers.length, kept: domKept,
                  cheapestCents: domPage.offers[0]?.priceCents ?? null, cached: !!domPage.fromCache, domesticSeed: true });
              } catch (seedError) {
                if (seedError instanceof BlockedError) throw seedError;
                log({ type: 'product-error', product: entry.name, error: seedError.message, domesticSeed: true });
              }
            }
          }
          state.cardOffers = offers.get(entry.key).size;
          state.status = 'read';
        } catch (error) {
          if (error instanceof BlockedError) { state.status = 'blocked'; return; }
          state.status = 'error';
          state.error = error.message;
          log({ type: 'product-error', product: entry.name, error: error.message });
        } finally {
          done += 1;
          progress('cards', done, entries.length);
        }
        return;
      }

      if (!entry.cardPath) {
        state.status = 'no card page';
        done += 1;
        progress('cards', done, entries.length);
        return;
      }
      try {
        const groups = expansionGroups(entry.printings, expansionGroupSize);
        state.groups = groups.length;
        for (const language of queryLanguagesFor(entry)) {
          const langKey = language ?? 'any';
          for (const [index, group] of groups.entries()) {
            if (index > 0 && group.minGuideCents > cutoffOf(entry) * groupSkipFactor) {
              state.groupsSkipped += groups.length - index;
              break;
            }
            for (const sellerType of sellerTypeQueries) {
              const query = {
                language, sellerCountries, minCondition: entry.minCondition, foil: entry.foil, signed: entry.signed, altered: entry.altered,
                expansions: group.expansions, sellerType,
                ...(minRep != null ? { sellerReputation: minRep } : {}),
              };
              const sellerTypeKey = Array.isArray(sellerType) ? sellerType.join('.') : (sellerType ?? '');
              const key = ['card', entry.cardPath, langKey, countriesKey, entry.minCondition, entry.foil, entry.signed, entry.altered,
                (group.expansions || []).join('.'), sellerTypeKey].join('|') + repKeySuffix;
              const page = await cached(key, () => call('cardPage', entry, query));
              let kept = 0;
              for (const offer of page.offers) if (keep(entry, offer)) kept += 1;
              const outside = group.products ? page.offers.filter(offer => offer.idProduct !== null && !group.products.has(offer.idProduct)).length : 0;
              state.skipped += page.skipped;
              state.pages += 1;
              log({ type: 'card-page', card: entry.name, game: entry.game || 'Magic', language, group: index + 1, groups: groups.length,
                expansions: group.expansions?.length ?? null, sellerType: sellerType ?? null, offers: page.offers.length, kept,
                cheapestCents: page.offers[0]?.priceCents ?? null, outsideGroup: outside, skipped: page.skipped, cached: !!page.fromCache });

              // Keep multi-country Phase 1 a superset of domestic sellers on crowded cards (and reuse
              // any fresh domestic query cache at zero network cost).
              if (seedDomestic && !runner.blocked()) {
                const domKey = ['card', entry.cardPath, langKey, domesticKeyPart, entry.minCondition, entry.foil, entry.signed, entry.altered,
                  (group.expansions || []).join('.'), sellerTypeKey].join('|') + repKeySuffix;
                const rawRows = page.offers.length + (page.skipped || 0);
                const domCount = domesticLocation ? page.offers.filter(o => o.location === domesticLocation).length : 0;
                if (hasFreshCache(domKey) || (rawRows >= domesticPageFullThreshold && domCount < domesticMinOffers)) {
                  try {
                    const domQuery = { ...query, sellerCountries: [domesticCountry] };
                    const domPage = await cached(domKey, () => call('cardPage', entry, domQuery));
                    let domKept = 0;
                    for (const offer of domPage.offers) if (keep(entry, offer)) domKept += 1;
                    state.skipped += domPage.skipped;
                    state.pages += 1;
                    log({ type: 'card-page', card: entry.name, game: entry.game || 'Magic', language, group: index + 1, groups: groups.length,
                      expansions: group.expansions?.length ?? null, sellerType: sellerType ?? null, offers: domPage.offers.length, kept: domKept,
                      cheapestCents: domPage.offers[0]?.priceCents ?? null, skipped: domPage.skipped, cached: !!domPage.fromCache, domesticSeed: true });
                  } catch (seedError) {
                    if (seedError instanceof BlockedError) throw seedError;
                    log({ type: 'card-error', card: entry.name, error: seedError.message, domesticSeed: true });
                  }
                }
              }
            }
          }
        }
        state.cardOffers = offers.get(entry.key).size;
        state.status = 'read';
      } catch (error) {
        if (error instanceof BlockedError) { state.status = 'blocked'; return; }
        state.status = 'error';
        state.error = error.message;
        log({ type: 'card-error', card: entry.name, error: error.message });
      } finally {
        done += 1;
        progress('cards', done, entries.length);
      }
    })));

    log({
      type: 'phase-end', phase: 'cards', ms: Date.now() - phase1Start, items: entries.length,
      requests: stats.requests - phase1StartReqs, cachedQueries: stats.cachedQueries - phase1StartCached,
    });

    const observedLocations = [...new Set(sellerLocations.values())];
    const isMultiCountry = observedLocations.length > 1 ||
      Boolean(domesticLocation && observedLocations.some(loc => loc !== domesticLocation));

    let resolvedTables = shippingTables;
    if (isMultiCountry && !resolvedTables && typeof loadShippingTables === 'function') {
      const shipStart = Date.now();
      log({ type: 'phase-start', phase: 'shipping-tables', locations: observedLocations.length });
      try {
        resolvedTables = await loadShippingTables(observedLocations);
      } catch (error) {
        log({ type: 'shipping-tables-error', error: error.message });
        resolvedTables = null;
      } finally {
        log({ type: 'phase-end', phase: 'shipping-tables', ms: Date.now() - shipStart, locations: observedLocations.length });
      }
    }

    const minMethodCents = (table, weightGrams, valueCents) => {
      if (!Array.isArray(table) || !table.length) return Infinity;
      let best = Infinity;
      for (const method of table) {
        if (method.maxWeight >= weightGrams && method.maxValueCents >= valueCents && method.priceCents < best) {
          best = method.priceCents;
        }
      }
      return best;
    };

    const excessShippingCents = location => {
      if (!resolvedTables) return 0;
      const byLocation = resolvedTables.byLocation || resolvedTables;
      const domTable = (domesticLocation && byLocation[domesticLocation]) || resolvedTables.default || [];
      if (location && Object.prototype.hasOwnProperty.call(byLocation, location)) {
        const table = byLocation[location];
        if (!Array.isArray(table) || !table.length) return Infinity;
        const small = minMethodCents(table, 20, 1000);
        if (!Number.isFinite(small)) return Infinity;
        const bulkRaw = minMethodCents(table, 50, 3000);
        const bulk = Number.isFinite(bulkRaw) ? bulkRaw : small * 4;
        const domSmall = minMethodCents(domTable, 20, 1000);
        const domBulk = minMethodCents(domTable, 50, 3000);
        const refSmall = Number.isFinite(domSmall) ? domSmall : 125;
        const refBulk = Number.isFinite(domBulk) ? domBulk : 395;
        return Math.max(0, (small - refSmall) * 0.5 + (bulk - refBulk) * 0.5);
      }
      return 0;
    };

    const targets = new Map();
    for (const entry of entries) {
      const sorted = [...offers.get(entry.key).values()].sort((a, b) => a.priceCents - b.priceCents);
      const target = targetPrice(sorted, entry.amount, targetCopies, targetSellers);
      let domesticCutoffCents = null;
      if (isMultiCountry && domesticLocation) {
        const domSorted = sorted.filter(o => o.location === domesticLocation);
        const domTarget = targetPrice(domSorted, entry.amount, targetCopies, targetSellers);
        domesticCutoffCents = domTarget === null ? null : capPrice(entry, Math.max(domTarget * cutoffFactor, domTarget + cutoffMarginCents));
      }
      targets.set(entry.key, {
        targetCents: target,
        cutoffCents: target === null ? null : capPrice(entry, Math.max(target * cutoffFactor, target + cutoffMarginCents)),
        domesticCutoffCents,
      });
    }

    // 2. Sellers that are cheap (up to the cutoff) for the most items across all lists & games.
    //    In multi-country mode, also allow fair domestic offers up to the domestic cutoff and
    //    rank foreign sellers using a shipping penalty while reserving domestic slots per batch.
    const cheapCards = new Map();
    for (const entry of entries) {
      const { cutoffCents, domesticCutoffCents } = targets.get(entry.key);
      for (const offer of offers.get(entry.key).values()) {
        const effectiveCutoff = domesticLocation && offer.location === domesticLocation && domesticCutoffCents !== null
          ? Math.max(cutoffCents ?? 0, domesticCutoffCents)
          : cutoffCents;
        if (entry.kind !== 'product' && effectiveCutoff !== null && offer.priceCents > effectiveCutoff) continue;
        if (!cheapCards.has(offer.seller)) cheapCards.set(offer.seller, new Set());
        cheapCards.get(offer.seller).add(entry.key);
      }
    }
    const candidateRows = [...cheapCards]
      .map(([seller, keys]) => {
        const location = sellerLocations.get(seller) || null;
        const excessShip = isMultiCountry ? excessShippingCents(location) : 0;
        const score = Number.isFinite(excessShip) ? keys.size - excessShip / 150 : -Infinity;
        return { seller, cheapCards: keys.size, ...(location ? { location } : {}), ...(isMultiCountry ? { score: Math.round(score * 100) / 100 } : {}) };
      })
      .filter(row => row.cheapCards >= minSellerCards && (row.score === undefined || Number.isFinite(row.score)));

    let chosen;
    if (isMultiCountry && domesticLocation) {
      const domQueue = candidateRows.filter(row => row.location === domesticLocation)
        .sort((a, b) => b.cheapCards - a.cheapCards);
      const forQueue = candidateRows.filter(row => row.location !== domesticLocation)
        .sort((a, b) => (b.score ?? b.cheapCards) - (a.score ?? a.cheapCards) || b.cheapCards - a.cheapCards);
      chosen = [];
      let d = 0;
      let f = 0;
      while (chosen.length < sellerLimit && (d < domQueue.length || f < forQueue.length)) {
        const wantDomestic = Math.ceil((chosen.length + 1) * domesticSellerShare);
        if (d < domQueue.length && (d < wantDomestic || f >= forQueue.length)) {
          chosen.push(domQueue[d++]);
        } else {
          chosen.push(forQueue[f++]);
        }
      }
    } else {
      chosen = candidateRows
        .sort((a, b) => (b.score ?? b.cheapCards) - (a.score ?? a.cheapCards) || b.cheapCards - a.cheapCards)
        .slice(0, sellerLimit);
    }
    log({ type: 'sellers-chosen', sellers: chosen, candidates: cheapCards.size });

    const buildResults = () => entries.map(entry => {
      const state = cardState.get(entry.key);
      const sorted = [...offers.get(entry.key).values()].sort((a, b) => a.priceCents - b.priceCents);
      const { targetCents, cutoffCents } = targets.get(entry.key);
      let fallback = null;
      for (let i = 0, seen = 0; i < sorted.length && fallback === null; i += 1) {
        seen += sorted[i].quantity;
        if (seen >= entry.amount) fallback = sorted[i].priceCents;
      }
      return {
        key: entry.key, name: state.resolvedName || entry.name, amount: entry.amount,
        kind: entry.kind || 'card', game: entry.game || state.resolvedMeta?.game || 'Magic',
        listId: entry.listId ?? null, listName: entry.listName ?? null,
        maxPriceCents: entry.maxPriceCents ?? null,
        category: entry.category || state.resolvedMeta?.category || null,
        productPath: entry.productPath || state.resolvedMeta?.path || null,
        targetCents: targetCents ?? fallback, cutoffCents,
        verdict: state.status === 'blocked' ? 'blocked' : state.status === 'error' ? 'incomplete' : sorted.length ? 'read' : 'unavailable',
        cardOffers: state.cardOffers, sellerOffers: sorted.length - state.cardOffers, skippedRows: state.skipped, error: state.error,
        cardPages: state.pages, groups: state.groups, groupsSkipped: state.groupsSkipped,
        printings: (entry.printings || []).length, queries: [], offers: sorted,
      };
    });

    // Track which games each seller appeared in during Phase 1 so multi-game runs can skip
    // querying a Magic-only seller on a large Yu-Gi-Oh! list (and vice versa).
    const sellerGames = new Map();
    const cardEntriesPerGame = new Map();
    for (const entry of entries) {
      if (entry.kind === 'product') continue;
      const g = entry.game || 'Magic';
      cardEntriesPerGame.set(g, (cardEntriesPerGame.get(g) || 0) + 1);
      for (const offer of offers.get(entry.key).values()) {
        if (!sellerGames.has(offer.seller)) sellerGames.set(offer.seller, new Set());
        sellerGames.get(offer.seller).add(g);
      }
    }

    const entryCeilingFor = (entry, loc) => {
      const t = targets.get(entry.key);
      if (!t || t.cutoffCents === null) return Infinity;
      let base = t.cutoffCents;
      if (domesticLocation && loc === domesticLocation && t.domesticCutoffCents !== null) {
        base = Math.max(base, t.domesticCutoffCents);
      }
      const withMargin = t.targetCents !== null ? Math.max(base, t.targetCents + sellerCeilingMarginCents) : base;
      return capPrice(entry, withMargin);
    };

    const sellers = [];
    async function askSeller(row) {
      const sellerStart = Date.now();
      const loc = sellerLocations.get(row.seller) || null;
      const state = { ...row, location: loc, pages: 0, rows: 0, total: null, matched: 0, ceilingStopped: false, crossGameSkips: 0, ms: 0, status: 'pending', error: null };
      sellers.push(state);
      try {
        let totalSum = 0;
        let hasTotal = false;
        let allComplete = true;
        const listErrors = [];
        for (const list of activeLists) {
          if (runner.blocked()) break;
          const listGame = list.game || 'Magic';
          // In multi-game runs, skip querying a seller for a game where they had zero Phase-1
          // appearances across >= 5 wanted cards of that game.
          if (activeLists.length > 1 && (cardEntriesPerGame.get(listGame) || 0) >= 5 && !sellerGames.get(row.seller)?.has(listGame)) {
            state.crossGameSkips += 1;
            continue;
          }
          const listEntries = entries.filter(e =>
            e.kind !== 'product' &&
            (e.game || 'Magic') === listGame &&
            (e.listId == null || String(e.listId) === String(list.listId))
          );

          // Track this seller's best known offers per entry (seeded from Phase 1) to compute the
          // dynamic remaining price ceiling for price_asc early stopping.
          const sellerEntryOffers = new Map();
          for (const entry of listEntries) {
            const known = new Map();
            for (const o of offers.get(entry.key).values()) {
              if (o.seller === row.seller) known.set(o.idArticle, o);
            }
            sellerEntryOffers.set(entry.key, known);
          }

          const remainingCeiling = () => {
            if (!listEntries.length) return Infinity;
            let maxNeed = 0;
            for (const entry of listEntries) {
              const ceil = entryCeilingFor(entry, loc);
              const known = sellerEntryOffers.get(entry.key);
              let need = ceil;
              if (known && known.size > 0) {
                const sorted = [...known.values()].sort((a, b) => a.priceCents - b.priceCents);
                let qty = 0;
                let nthPrice = null;
                for (const o of sorted) {
                  qty += o.quantity || 1;
                  if (qty >= entry.amount) { nthPrice = o.priceCents; break; }
                }
                if (nthPrice !== null) need = Math.min(ceil, nthPrice - 1);
              }
              if (need > maxNeed) maxNeed = need;
              if (maxNeed === Infinity) return Infinity;
            }
            return maxNeed;
          };

          let listRows = 0;
          let listTotal = null;
          let stillAscending = true;
          let prevPageLastPrice = -Infinity;
          let stoppedByCeiling = false;

          try {
            for (let pageNumber = 1; pageNumber <= maxSellerPages; pageNumber += 1) {
              const cacheId = activeLists.length === 1 && listGame === 'Magic'
                ? ['seller2', row.seller, list.listId, pageNumber].join('|')
                : ['seller2', listGame, row.seller, list.listId, pageNumber].join('|');
              const page = await cached(cacheId, () =>
                activeLists.length === 1 && !lists
                  ? call('sellerWants', row.seller, list.listId, pageNumber)
                  : call('sellerWants', row.seller, list.listId, pageNumber, listGame));
              state.pages += 1;
              state.rows += page.offers.length;
              listRows += page.offers.length;
              if (page.total !== null) listTotal = page.total;

              // Verify ascending price order before trusting price-based early stopping.
              if (stillAscending && page.offers.length) {
                if (page.offers[0].priceCents < prevPageLastPrice) stillAscending = false;
                for (let i = 1; stillAscending && i < page.offers.length; i += 1) {
                  if (page.offers[i].priceCents < page.offers[i - 1].priceCents) stillAscending = false;
                }
                prevPageLastPrice = page.offers[page.offers.length - 1].priceCents;
              }

              const meta = sellerMeta.get(row.seller);
              for (const offer of page.offers) {
                const enriched = {
                  ...offer,
                  seller: row.seller,
                  ...(loc && !offer.location ? { location: loc } : {}),
                  ...(meta?.rating && offer.rating == null ? { rating: meta.rating } : {}),
                  ...(meta?.reputation != null && offer.reputation == null ? { reputation: meta.reputation } : {}),
                  ...(meta?.sellerType != null && offer.sellerType == null ? { sellerType: meta.sellerType } : {}),
                  ...(meta?.professional != null && offer.professional == null ? { professional: meta.professional } : {}),
                };
                const targetsForProduct = byProduct.get(`${listGame}:${offer.idProduct}`) || [];
                for (const entry of targetsForProduct) {
                  if (entry.listId != null && String(entry.listId) !== String(list.listId)) continue;
                  if (keep(entry, enriched)) {
                    state.matched += 1;
                    sellerEntryOffers.get(entry.key)?.set(enriched.idArticle, enriched);
                  }
                }
              }
              if (!page.hasNext) break;
              if (stillAscending && page.offers.length > 0 && prevPageLastPrice > remainingCeiling()) {
                stoppedByCeiling = true;
                state.ceilingStopped = true;
                break;
              }
            }
            if (listTotal !== null) {
              totalSum += listTotal;
              hasTotal = true;
              if (!stoppedByCeiling && listRows < listTotal) allComplete = false;
            }
          } catch (listErr) {
            if (listErr instanceof BlockedError) throw listErr;
            allComplete = false;
            listErrors.push(listErr.message);
          }
        }
        state.total = hasTotal ? totalSum : null;
        if (listErrors.length) state.error = listErrors.join('; ');
        state.status = runner.blocked()
          ? 'blocked'
          : (listErrors.length && state.pages === 0)
            ? 'error'
            : allComplete ? 'complete' : 'partial';
      } catch (error) {
        state.status = error instanceof BlockedError ? 'blocked' : 'error';
        state.error = error.message;
      }
      state.ms = Date.now() - sellerStart;
      log({ type: 'seller', ...state });
      progress('sellers', sellers.length, Math.min(chosen.length, sellerLimit));
    }

    if (activeLists.length) {
      const phase2Start = Date.now();
      const phase2StartReqs = stats.requests;
      const phase2StartCached = stats.cachedQueries;
      log({ type: 'phase-start', phase: 'sellers', sellers: Math.min(chosen.length, sellerLimit) });
      const sellerSlot = limiter(slotSize);
      let next = 0;
      let lastCents = null;
      const batches = [];
      while (next < chosen.length && next < sellerLimit && !runner.blocked()) {
        const size = next === 0 ? minSellers : sellerBatch;
        const batch = chosen.slice(next, Math.min(next + size, sellerLimit));
        next += batch.length;
        const batchStart = Date.now();
        const batchSellerStart = sellers.length;
        await Promise.all(batch.map(row => sellerSlot(() => askSeller(row))));
        const sellersMs = Date.now() - batchStart;
        const batchSlice = sellers.slice(batchSellerStart);
        const batchPages = batchSlice.reduce((s, r) => s + (r.pages || 0), 0);
        const batchCeilingStops = batchSlice.filter(r => r.ceilingStopped).length;
        if (runner.blocked() || !evaluate) break;
        const evalStart = Date.now();
        const centsVal = await evaluate(buildResults());
        const evalMs = Date.now() - evalStart;
        const batchMs = Date.now() - batchStart;
        const saved = lastCents === null ? null : lastCents - centsVal;
        const batchInfo = { asked: next, basketCents: centsVal, savedCents: saved, sellersMs, evalMs, batchMs, pages: batchPages, ceilingStops: batchCeilingStops };
        batches.push(batchInfo);
        log({ type: 'seller-batch', ...batchInfo });
        if (saved !== null && !(saved >= improvementCents)) break;
        lastCents = centsVal;
      }
      stats.sellerBatches = batches;
      log({
        type: 'phase-end', phase: 'sellers', ms: Date.now() - phase2Start, sellers: sellers.length,
        requests: stats.requests - phase2StartReqs, cachedQueries: stats.cachedQueries - phase2StartCached,
      });
    }

    runner.finish();
    const results = buildResults();
    log({ type: 'run-end', ...stats, blocked: runner.blocked()?.message ?? null });
    return { method: 'sellers', results, sellers, stats, blocked: runner.blocked()?.message ?? null, sellerCountries,
      sellerFilter: { minReputation: minRep, sellerTypes: allowedSellerTypes },
      rule: { targetCopies, targetSellers, cutoffFactor, cutoffMarginCents, minSellers, sellerBatch, sellerLimit, improvementCents, minSellerCards } };
  }

  /*
   * Fetches cheap Magic token offers strictly from existing basket sellers (users bucket, 8h cache).
   * - Normal sellers (<= maxFullPages * 20 cheap tokens): fetches & caches ALL cheap tokens so
   *   editing token lists/settings later costs zero requests.
   * - Mega-powersellers (> maxFullPages * 20 cheap tokens) or if idRarity=24 is not applied:
   *   falls back to targeted ?name=<term>&maxPrice=... queries per wanted token type.
   */
  async function collectSellerTokens(sellers, tokenPlan, site, options = {}) {
    const {
      maxPriceCents = 20,
      tokenIds = null,
      maxFullPages = 6,
      maxSearchPages = 3,
      cache = null,
      cacheMaxAgeMs = CACHE_MAX_AGE_MS,
      onProgress = () => {},
      log = () => {},
    } = options;

    const uniqueSellers = [...new Set((sellers || []).filter(Boolean))];
    const searchTerms = [...new Set((tokenPlan?.searchTerms || []).filter(Boolean))];
    const maxPriceEur = maxPriceCents / 100;
    const runner = createRunner(site, options);
    const { call, stats } = runner;

    log({ type: 'tokens-start', sellers: uniqueSellers.length, searchTerms: searchTerms.length, maxPriceCents });

    const offersBySeller = {};
    const sellerSummaries = [];
    let done = 0;

    async function fetchOneSeller(seller) {
      const sellerStart = Date.now();
      const summary = { seller, mode: 'full', pages: 0, offers: 0, total: null, fromCache: false, ms: 0, status: 'ok', error: null };
      const byArticle = new Map();
      const addOffers = list => {
        for (const offer of list || []) {
          if (offer && offer.idArticle != null) byArticle.set(offer.idArticle, offer);
        }
      };

      const fullCacheKey = `tokens|${seller}|${maxPriceCents}`;
      const fullHit = cache?.get(fullCacheKey);
      if (fullHit && Date.now() - fullHit.at < cacheMaxAgeMs && fullHit.value?.mode === 'full') {
        stats.cachedQueries += 1;
        addOffers(fullHit.value.offers);
        summary.fromCache = true;
        summary.total = fullHit.value.total ?? byArticle.size;
        summary.offers = byArticle.size;
        summary.ms = Date.now() - sellerStart;
        offersBySeller[seller] = [...byArticle.values()];
        sellerSummaries.push(summary);
        done += 1;
        onProgress({ done, total: uniqueSellers.length, seller, requests: stats.requests, retries: stats.retries, intervalMs: runner.pace.intervalMs, fromCache: true });
        log({ type: 'seller-tokens', ...summary });
        return;
      }

      try {
        const page1 = await call('sellerTokens', seller, { maxPriceEur, rarity: 24, pageNumber: 1, sortBy: 'price_asc' });
        summary.pages += 1;
        summary.total = page1.total;

        let rarityIgnored = false;
        if (tokenIds && tokenIds.size > 0) {
          const identified = page1.offers.filter(o => o.idProduct != null);
          if (identified.length >= 4) {
            const matchedTokens = identified.filter(o => tokenIds.has(o.idProduct)).length;
            if (matchedTokens / identified.length < 0.5) rarityIgnored = true;
          }
        }

        const smallEnough = !rarityIgnored && (
          page1.total !== null ? page1.total <= maxFullPages * 20 : !page1.hasNext
        );

        if (smallEnough) {
          summary.mode = 'full';
          addOffers(page1.offers);
          let hasNext = page1.hasNext;
          let lastPrice = page1.offers.at(-1)?.priceCents ?? 0;
          let interrupted = false;
          for (let pageNumber = 2; hasNext && pageNumber <= maxFullPages && lastPrice <= maxPriceCents; pageNumber += 1) {
            if (runner.blocked()) { interrupted = true; break; }
            const page = await call('sellerTokens', seller, { maxPriceEur, rarity: 24, pageNumber, sortBy: 'price_asc' });
            summary.pages += 1;
            addOffers(page.offers);
            hasNext = page.hasNext;
            if (page.offers.length) lastPrice = page.offers.at(-1).priceCents;
            else break;
          }
          if (interrupted || runner.blocked()) {
            summary.status = 'blocked';
            summary.error = runner.blocked()?.message || 'Blocked';
          } else {
            const list = [...byArticle.values()];
            cache?.set(fullCacheKey, { at: Date.now(), value: { mode: 'full', total: page1.total, offers: list } });
          }
        } else {
          summary.mode = rarityIgnored ? 'targeted-fallback' : 'targeted';
          for (const o of page1.offers) {
            if (!tokenIds || (o.idProduct != null && tokenIds.has(o.idProduct))) addOffers([o]);
          }
          for (const term of searchTerms) {
            if (runner.blocked()) {
              summary.status = 'blocked';
              summary.error = runner.blocked()?.message || 'Blocked';
              break;
            }
            const termKey = `tokens-q|${seller}|${maxPriceCents}|${term.toLowerCase()}`;
            const termHit = cache?.get(termKey);
            if (termHit && Date.now() - termHit.at < cacheMaxAgeMs) {
              stats.cachedQueries += 1;
              addOffers(termHit.value?.offers || []);
              continue;
            }
            const termOffers = [];
            let hasNext = true;
            let termInterrupted = false;
            for (let pageNumber = 1; hasNext && pageNumber <= maxSearchPages; pageNumber += 1) {
              if (runner.blocked()) { termInterrupted = true; break; }
              const page = await call('sellerTokens', seller, {
                maxPriceEur,
                rarity: rarityIgnored ? null : 24,
                name: term,
                pageNumber,
                sortBy: 'price_asc',
              });
              summary.pages += 1;
              termOffers.push(...page.offers);
              hasNext = page.hasNext && (!page.offers.length ? false : page.offers.at(-1).priceCents <= maxPriceCents);
            }
            addOffers(termOffers);
            if (termInterrupted || runner.blocked()) {
              summary.status = 'blocked';
              summary.error = runner.blocked()?.message || 'Blocked';
              break;
            }
            cache?.set(termKey, { at: Date.now(), value: { mode: 'term', offers: termOffers } });
          }
        }
        summary.offers = byArticle.size;
      } catch (error) {
        summary.status = error instanceof BlockedError ? 'blocked' : 'error';
        summary.error = error.message;
      }

      summary.ms = Date.now() - sellerStart;
      offersBySeller[seller] = [...byArticle.values()];
      sellerSummaries.push(summary);
      done += 1;
      onProgress({ done, total: uniqueSellers.length, seller, requests: stats.requests, retries: stats.retries, intervalMs: runner.pace.intervalMs, fromCache: false });
      log({ type: 'seller-tokens', ...summary });
    }

    const slot = limiter(Math.max(2, options.concurrency ?? 4));
    await Promise.all(uniqueSellers.map(seller => slot(() => {
      if (runner.blocked()) return;
      return fetchOneSeller(seller);
    })));

    runner.finish();
    log({ type: 'tokens-end', ...stats, blocked: runner.blocked()?.message ?? null });
    return { offersBySeller, sellerSummaries, stats, blocked: runner.blocked()?.message ?? null };
  }

  // Reads a Wants List page. Every entry keeps its own filters.
  function parseWantsList(page, game = 'Magic') {
    const cards = new RegExp(`/${game}/Cards/`);
    const rows = [...page.querySelectorAll('tbody tr')].filter(row => row.querySelector('td.name a'));
    if (!rows.length) throw new Error('No Wants List entries found on this page');
    const hiddenText = cell => cell?.querySelector('.visually-hidden')?.textContent.trim();
    const ternary = text => ({ Yes: 'Y', No: 'N' })[text] || 'any';
    return rows.map(row => {
      const link = row.querySelector('td.name a');
      const path = new URL(link.getAttribute('href'), 'https://www.cardmarket.com').pathname;
      const image = /\/(\d+)\/\d+\.\w+/.exec(row.querySelector('td.preview [data-bs-title]')?.getAttribute('data-bs-title') || '');
      const [first, signed, altered] = [...row.querySelectorAll('td.ternary-header')].map(cell => ternary(hiddenText(cell)));
      const foil = game === 'Magic' ? first : 'any';
      const languages = [...row.querySelectorAll('td.languages [title], td.languages [data-bs-original-title]')]
        .map(tip).map(name => LANGUAGES[name]).filter(Boolean);
      const expansion = hiddenText(row.querySelector('td.expansion')) || row.querySelector('td.expansion')?.textContent.trim();
      return {
        key: row.querySelector('[data-id-want]')?.dataset.idWant || path,
        game,
        kind: 'card',
        name: link.textContent.trim(),
        amount: Number(row.querySelector('td.amount').dataset.amount),
        anyPrinting: cards.test(path),
        cardPath: cards.test(path) ? path : null,
        expansion,
        idProduct: image ? Number(image[1]) : null,
        languages: languages.length ? languages : Object.values(LANGUAGES),
        minCondition: CONDITIONS[hiddenText(row.querySelector('td.condition'))] || 7,
        foil: foil || 'any', signed: signed || 'any', altered: altered || 'any',
        maxPriceCents: Math.round(Number(row.querySelector('td.buyPrice')?.dataset.text || 0) * 100) || null,
      };
    });
  }

  root.CardmarketCollector = {
    collect, collectBySellers, collectSellerTokens, createRunner, expansionGroups, browserSite, RefusedError, CartRejectError, TokenExpiredError,
    parseUserOffersPage,
    parseWantsList, parseWantsListName, parseWantsOverview, parseProductPageMeta, parseOfferRow, parseProductOfferRow,
    cents, allCents, RetryableError, BlockedError, StoppedError, LANGUAGES, CONDITIONS, CACHE_MAX_AGE_MS,
    SELLER_TYPES, SELLER_REPUTATIONS, SELLER_REPUTATION_LABELS, SELLER_TYPE_LABELS,
    normalizeSellerReputation, normalizeSellerTypes, offerReputationRank, offerSellerType, matchesSellerFilter,
    queryString, checkFilterEcho, checkOffer,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
