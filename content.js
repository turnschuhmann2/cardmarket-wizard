// Adds the Better Wizard panel to a Cardmarket Wants List page.
(() => {
  const listId = /\/Magic\/Wants\/(\d+)/.exec(location.pathname)?.[1];
  if (!listId || !document.querySelector('td.name a')) return;
  const { collect, collectBySellers, createRunner, browserSite, parseWantsList, BlockedError } = globalThis.CardmarketCollector;
  const { createPlanner, parseShippingTable, STRATEGIES } = globalThis.CardmarketWizard;

  const euros = value => (value === null || value === undefined ? '–' : `${(value / 100).toFixed(2).replace('.', ',')} €`);
  const escape = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
  const panel = document.createElement('section');
  panel.style.cssText = 'border:1px solid #ccc;border-radius:6px;padding:12px;margin:12px 0;background:#fff;font-size:14px';
  // Cardmarket's country ids, from help.cardmarket.com/api/countries.
  const COUNTRIES = [[1, 'Austria'], [2, 'Belgium'], [3, 'Bulgaria'], [35, 'Croatia'], [5, 'Cyprus'], [6, 'Czech Republic'],
    [8, 'Denmark'], [9, 'Estonia'], [11, 'Finland'], [12, 'France'], [7, 'Germany'], [14, 'Greece'], [15, 'Hungary'],
    [37, 'Iceland'], [16, 'Ireland'], [17, 'Italy'], [36, 'Japan'], [21, 'Latvia'], [18, 'Liechtenstein'], [19, 'Lithuania'],
    [20, 'Luxembourg'], [22, 'Malta'], [23, 'Netherlands'], [24, 'Norway'], [25, 'Poland'], [26, 'Portugal'], [27, 'Romania'],
    [29, 'Singapore'], [31, 'Slovakia'], [30, 'Slovenia'], [10, 'Spain'], [28, 'Sweden'], [4, 'Switzerland'], [13, 'United Kingdom']];
  const countryOptions = COUNTRIES.map(([id, name]) => `<option value="${id}"${id === 7 ? ' selected' : ''}>${name}</option>`).join('');
  const PACES = [[2000, 'Very careful (1 request every 2 s)'], [1000, 'Careful (1 request per second)'], [500, 'Faster (2 per second, may trigger a check)']];
  const METHODS = [['sellers', 'Quick (~5 min)'], ['thorough', 'Thorough (~15 min)'], ['printings', 'Every printing (slow)']];
  // Thorough: each expansion group read once per seller type (up to 150 offers), groups up to
  // 3 x the cutoff, at least 80 sellers and more while a batch saves 0,20 EUR, up to 200.
  const THOROUGH = { splitBySellerType: true, groupSkipFactor: 3, minSellers: 80, sellerBatch: 20, sellerLimit: 200, improvementCents: 20 };
  panel.innerHTML = `
    <strong>Better Wizard</strong>
    <p style="margin:4px 0 8px">Builds a low-cost basket from captured offers, including estimated shipping. Some printings and offers may not be captured.
      Nothing goes into your cart until you confirm.</p>
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <label>Method <select data-bw="method">${METHODS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <button type="button" data-bw="start" class="btn btn-primary btn-sm">Collect offers</button>
      <button type="button" data-bw="fresh" class="btn btn-outline-primary btn-sm" title="Ignore pages saved in the last hours and fetch everything again">Collect fresh</button>
      <button type="button" data-bw="stop" class="btn btn-outline-danger btn-sm" disabled>Stop</button>
      <button type="button" data-bw="download" class="btn btn-outline-primary btn-sm" hidden>Download results and log (JSON)</button>
    </div>
    <details style="margin-top:8px"><summary>Settings</summary>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <label>Buy from sellers in <select data-bw="country">${countryOptions}</select></label>
        <label>Ship to <select data-bw="shipTo">${countryOptions}</select></label>
        <label>Speed <select data-bw="interval">${PACES.map(([ms, label]) => `<option value="${ms}"${ms === 1000 ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <label title="Cardmarket makes some sellers ship tracked only (3,95 € instead of 1,25 €). Learned from your cart; you can add names.">
          Sellers that ship tracked only <input data-bw="tracked" size="45" placeholder="e.g. Snirbs, SirFranticLight"></label>
      </div>
    </details>
    <div style="margin-top:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <label>Saved runs <select data-bw="runs"><option value="">None yet</option></select></label>
      <button type="button" data-bw="openRun" class="btn btn-outline-primary btn-sm">Open</button>
      <label class="btn btn-outline-primary btn-sm mb-0">Open file… <input type="file" data-bw="importFile" accept=".json,application/json" hidden></label>
    </div>
    <div data-bw="status" style="margin-top:8px"></div>
    <div data-bw="pause" hidden style="border:2px solid #b45309;border-radius:6px;padding:8px;margin-top:8px">
      <strong>Paused:</strong> <span data-bw="pauseText"></span>
      <button type="button" data-bw="continue" class="btn btn-primary btn-sm">Continue</button>
    </div>
    <details data-bw="coverage" style="margin-top:8px" hidden><summary>Coverage per card</summary><div data-bw="report" style="max-height:420px;overflow:auto"></div></details>
    <div data-bw="cartNotice" style="margin-top:8px"></div>
    <div data-bw="basket" style="margin-top:12px"></div>
    <div data-bw="topup" style="margin-top:12px"></div>`;
  (document.querySelector('main h1')?.closest('.row, div') || document.querySelector('main') || document.body).after(panel);

  const field = name => panel.querySelector(`[data-bw="${name}"]`);
  const storageKey = `collection:${listId}`;
  const logKey = `log:${listId}`;
  const cartKey = `cart:${listId}`;
  const runsKey = `runs:${listId}`;
  // Cards the user chose to leave out of this basket (to buy elsewhere).
  const cutsKey = `cuts:${listId}`;
  let cutSuggestions = [];
  // null while the seller search runs; the suggestions are worked out on the finished basket.
  let cutsReady = false;
  let leftOutKeys = [];
  const readHoldKey = 'collectionRetryAfter';
  const KEPT_RUNS = 10;
  const CART_MEMORY_MS = 12 * 60 * 60 * 1000;
  let collection = null;
  let runLog = [];
  let collecting = false;
  let exportCollection = null;

  // Run log: every request, printing, card verdict, pause and retry, kept with the results.
  const record = event => runLog.push({ t: new Date().toISOString(), ...event });
  const saveLog = () => chrome.storage.local.set({ [logKey]: runLog });

  // Product page paths learned from redirects, so later visits skip the redirect.
  const knownPaths = new Map();
  chrome.storage.local.get('productPaths').then(({ productPaths = {} }) => {
    for (const [id, path] of Object.entries(productPaths)) knownPaths.set(Number(id), path);
  });
  const paths = {
    get: id => knownPaths.get(id),
    set: (id, path) => {
      knownPaths.set(id, path);
      chrome.storage.local.set({ productPaths: Object.fromEntries(knownPaths) });
    },
  };
  const site = browserSite({ paths, onResponse: response => record({ type: 'http', ...response }) });
  let planner = null;
  let basket = null;
  let controller = null;

  const intervalMs = () => Number(field('interval').value);

  // Cardmarket's checks on background requests lift after a while. The first time, wait 10 s and
  // retry by itself; if it is refused again, show the message and retry only on Continue.
  function waitForUser(message, attempt) {
    const automatic = attempt === 1;
    const until = Date.now() + 10000;
    record({ type: automatic ? 'auto-wait' : 'asked-user', message, attempt });
    saveLog();
    field('pause').hidden = false;
    return new Promise((resolve, reject) => {
      let timer = null;
      const signal = controller.signal;
      const abort = () => finish(false);
      const finish = proceed => {
        clearInterval(timer);
        signal.removeEventListener('abort', abort);
        field('pause').hidden = true;
        field('continue').onclick = null;
        if (proceed) resolve(); else reject(new Error('Stopped'));
      };
      const tick = () => {
        const left = Math.max(0, Math.round((until - Date.now()) / 1000));
        field('pauseText').textContent = `${message} Trying again in ${left} s.`;
        if (left === 0) finish(true);
      };
      if (automatic) {
        timer = setInterval(tick, 1000);
        tick();
      } else {
        field('pauseText').textContent = `${message} Click Continue to try again, or Stop.`;
      }
      field('continue').onclick = () => finish(true);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  // Remembers the chosen countries and speed.
  chrome.storage.local.get('settings').then(({ settings = {} }) => {
    field('country').value = settings.country || 7;
    field('shipTo').value = settings.shipTo || 7;
    field('interval').value = settings.interval || 1000;
    field('method').value = settings.method || 'sellers';
  });
  panel.addEventListener('change', () => chrome.storage.local.set({ settings: {
    country: Number(field('country').value), shipTo: Number(field('shipTo').value), interval: Number(field('interval').value),
    method: field('method').value,
  } }));

  function busy(running) {
    for (const name of ['start', 'fresh', 'buy', 'copy']) {
      const button = panel.querySelector(`[data-bw="${name}"]`);
      if (button) button.disabled = running;
    }
    field('stop').disabled = !running;
    controller = running ? new AbortController() : null;
  }

  // Query snapshots survive a stopped or blocked run; "Collect offers" again resumes from them.
  async function offerCache() {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const stored = await chrome.storage.local.get(null);
    const cache = new Map();
    const expired = [];
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith('q:')) continue;
      if (Date.now() - value.at > maxAgeMs) expired.push(key);
      else cache.set(key.slice(2), value);
    }
    if (expired.length) await chrome.storage.local.remove(expired);
    return {
      get: key => cache.get(key),
      set: (key, value) => { cache.set(key, value); chrome.storage.local.set({ [`q:${key}`]: value }); },
    };
  }

  // Every finished or opened run is kept (the last 10 per Wants List), so its basket can be
  // reopened and put in the cart later.
  function renderRuns(runs) {
    field('runs').innerHTML = runs.length
      ? runs.map(run => `<option value="${run.id}">${new Date(run.at).toLocaleString()} · ${({ sellers: 'by seller', thorough: 'thorough', printings: 'every printing' })[run.method] || run.method} · ` +
        `${run.cards} cards${run.totalCents ? ` · ${euros(run.totalCents)} from ${run.sellers} sellers` : ''}</option>`).join('')
      : '<option value="">None yet</option>';
  }

  async function saveRun(saved) {
    const id = `run:${listId}:${saved.stats.finishedAt}`;
    const { [runsKey]: runs = [] } = await chrome.storage.local.get(runsKey);
    const summary = { id, at: saved.stats.finishedAt, method: saved.profile || saved.method || 'printings', cards: saved.results.length,
      totalCents: basket?.totalCents ?? null, sellers: basket?.parcels.length ?? null };
    const next = [summary, ...runs.filter(run => run.id !== id)].sort((a, b) => b.at - a.at);
    await chrome.storage.local.set({ [id]: saved, [runsKey]: next.slice(0, KEPT_RUNS) });
    const dropped = next.slice(KEPT_RUNS).map(run => run.id);
    if (dropped.length) await chrome.storage.local.remove(dropped);
    renderRuns(next.slice(0, KEPT_RUNS));
    field('runs').value = id;
  }

  async function openCollection(opened) {
    if (!Array.isArray(opened?.results) || !opened.stats?.finishedAt) throw new Error('This is not a saved Better Wizard run');
    collection = opened;
    await chrome.storage.local.set({ [storageKey]: collection });
    renderCoverage();
    await buildBasket();
    await saveRun(collection);
    const hours = (Date.now() - collection.stats.finishedAt) / 3600000;
    field('status').textContent = `Opened the run from ${new Date(collection.stats.finishedAt).toLocaleString()}` +
      (hours >= 1 ? ` (${Math.round(hours)} h old: some offers may have sold since; Add to cart lists the ones that are gone).` : '.');
  }

  function renderCoverage() {
    field('download').hidden = false;
    field('coverage').hidden = false;
    const counts = {};
    for (const result of collection.results) counts[result.verdict] = (counts[result.verdict] || 0) + 1;
    const minutes = ((collection.stats.finishedAt - collection.stats.startedAt) / 60000).toFixed(1);
    field('status').textContent = `${new Date(collection.stats.finishedAt).toLocaleString()}: ${collection.stats.requests} requests ` +
      `(${collection.stats.cachedQueries} pages from cache, ${collection.stats.waits || 0} waits asked by Cardmarket, ${collection.stats.pauses || 0} pauses for a check) in ${minutes} min. ` +
      Object.entries(counts).map(([verdict, count]) => `${count} ${verdict}`).join(', ') +
      `. Price guide of ${collection.priceGuideCreatedAt}.` + (collection.blocked ? ` Stopped early: ${collection.blocked}` : '');
    if (collection.method === 'sellers') {
      const cards = collection.results.map(result => `<tr><td>${escape(result.name)}</td><td>${result.verdict}${result.error ? `: ${escape(result.error)}` : ''}</td>` +
        `<td>${euros(result.targetCents)}</td><td>${euros(result.cutoffCents)}</td>` +
        `<td>${result.cardPages ?? 1}${result.groupsSkipped ? ` (${result.groupsSkipped} skipped)` : ''}</td><td>${result.cardOffers}</td><td>${result.sellerOffers}</td></tr>`).join('');
      const sellers = collection.sellers.map(seller => `<tr><td>${escape(seller.seller)}</td><td>${seller.cheapCards}</td><td>${seller.matched}</td>` +
        `<td>${seller.rows}/${seller.total ?? '?'}</td><td>${seller.status}${seller.error ? `: ${escape(seller.error)}` : ''}</td></tr>`).join('');
      field('report').innerHTML = `<table class="table table-sm"><thead><tr><th>Card</th><th>Status</th><th>Target</th><th>Cutoff</th>` +
        `<th>Card pages read</th><th>Offers from card pages</th><th>Offers from sellers</th></tr></thead><tbody>${cards}</tbody></table>` +
        `<strong>Sellers asked for your Wants List</strong><table class="table table-sm"><thead><tr><th>Seller</th><th>Cheap for cards</th>` +
        `<th>Offers matching your filters</th><th>Rows read / listed</th><th>Status</th></tr></thead><tbody>${sellers}</tbody></table>`;
      return;
    }
    const rows = collection.results.map(result => {
      const read = result.queries.filter(query => query.pages > 0 || query.cachedAt).length;
      const skipped = result.queries.filter(query => query.status === 'skipped').length;
      const gaps = result.queries.filter(query => query.status === 'error' || (query.status === 'capped' && query.lastPriceCents <= result.cutoffCents))
        .map(query => `${query.idProduct}: ${query.error || 'over 300 offers under the cutoff'}`).join('; ');
      return `<tr><td>${escape(result.name)}</td><td>${result.verdict}</td><td>${euros(result.targetCents)}</td><td>${euros(result.cutoffCents)}</td>` +
        `<td>${read}/${skipped}</td><td>${result.offers.length}</td><td>${escape(gaps)}</td></tr>`;
    });
    field('report').innerHTML = `<table class="table table-sm"><thead><tr><th>Card</th><th>Coverage</th><th>Target</th><th>Cutoff</th>` +
      `<th>Printings read/skipped</th><th>Offers kept</th><th>Gaps</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function renderBasket() {
    const curve = basket.curve.map((point, index) => `<tr><td>${point.sellers}</td><td>${point.cards}</td><td>${euros(point.totalCents)}</td>` +
      `<td>${euros(Math.round(point.totalCents / point.cards))}</td><td>${escape(basket.parcels[index].seller)}</td></tr>`).join('');
    const parcels = basket.parcels.map((parcel, index) => `<details><summary>${index + 1}. ${escape(parcel.seller)}: ${parcel.items.length} cards, ` +
      `${euros(parcel.itemsCents)} + ${euros(parcel.shippingCents)} ${escape(parcel.method || '')}</summary><ul>` +
      parcel.items.map(item => `<li>${escape(item.name)}: ${euros(item.priceCents)}` +
        (item.aboveMarket ? ` <strong style="color:#b45309">above market (${euros(item.targetCents)})</strong>` : '') + '</li>').join('') +
      '</ul></details>').join('');
    const reasons = { 'not collected': 'Not collected yet (the run stopped first)', 'not fully collected': 'Not fully collected (a page failed)',
      'no offer': 'Nobody offers these under your filters' };
    const missing = Object.entries(reasons).map(([reason, label]) => {
      const names = basket.missing.filter(unit => unit.reason === reason).map(unit => escape(unit.name));
      return names.length ? `<p><strong>${label} (${names.length}):</strong> ${names.join(', ')}</p>` : '';
    }).join('');
    const collected = collection.results.filter(result => !['blocked', 'incomplete'].includes(result.verdict)).length;
    const warning = collected < collection.results.length
      ? `<p style="background:#fff3cd;border-radius:6px;padding:8px"><strong>Only ${collected} of ${collection.results.length} cards were collected, ` +
        'so this basket is incomplete.</strong> Click <em>Collect offers</em> to continue; printings already read come from the cache.</p>'
      : '';
    const overlap = planner.overlap().map(row => `<tr><td>${escape(row.seller)}</td><td>${row.cards}</td><td>${row.atTarget}</td>` +
      `<td>${euros(row.cheapestCents)}</td></tr>`).join('');
    field('basket').innerHTML = `${warning}
      <details style="margin-bottom:8px"><summary>Sellers with the most of your cards</summary>
      <table class="table table-sm"><thead><tr><th>Seller</th><th>Your cards</th><th>At or below market</th>` +
      `<th>Those cards together</th></tr></thead><tbody>${overlap}</tbody></table></details>
      <strong>Basket: ${basket.curve.at(-1)?.cards || 0} cards from ${basket.parcels.length} sellers, ${euros(basket.totalCents)} ` +
      `including ${euros(basket.shippingCents)} shipping</strong>
      ${cutsSection()}
      <p style="margin:4px 0">Sellers in order of cost above market per card. Buying only from the first N gets the running totals below.</p>
      <div style="max-height:240px;overflow:auto"><table class="table table-sm"><thead><tr><th>First N sellers</th><th>Cards</th><th>Total</th>` +
      `<th>Per card</th><th>Seller added</th></tr></thead><tbody>${curve}</tbody></table></div>
      ${missing}${parcels}
      <div style="margin-top:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <label>Buy from first <input data-bw="buySellers" value="${basket.parcels.length}" size="3"> sellers</label>
        <button type="button" data-bw="buy" class="btn btn-primary btn-sm">Add to cart</button>
        <button type="button" data-bw="copy" class="btn btn-outline-primary btn-sm">Copy for Archidekt</button>
        <button type="button" data-bw="forgetCart" class="btn btn-link btn-sm">Forget what was already added</button>
      </div>
      <div data-bw="cartCheck" style="margin-top:8px"></div>`;
    field('buy').addEventListener('click', buy);
    panel.querySelector('[data-bw="leaveOut"]')?.addEventListener('click', async () => {
      const chosen = [...panel.querySelectorAll('[data-cut]:checked')].map(box => box.dataset.cut);
      if (!chosen.length) return;
      const { [cutsKey]: cut = [] } = await chrome.storage.local.get(cutsKey);
      await chrome.storage.local.set({ [cutsKey]: [...new Set([...cut, ...chosen])] });
      record({ type: 'left-out', keys: chosen });
      await buildBasket();
    });
    panel.querySelector('[data-bw="putBack"]')?.addEventListener('click', async () => {
      await chrome.storage.local.remove(cutsKey);
      record({ type: 'put-back' });
      await buildBasket();
    });
    field('copy').addEventListener('click', copyForArchidekt);
    field('forgetCart').addEventListener('click', async () => {
      await chrome.storage.local.remove(cartKey);
      field('status').textContent = 'Forgot which offers were added; Add to cart will add all of them again.';
    });
  }

  async function shippingTable(from) {
    const { methods, error } = await chrome.runtime.sendMessage({ type: 'shipping', from, to: Number(field('shipTo').value) });
    if (error) throw new Error(`Shipping costs: ${error}`);
    return parseShippingTable(methods);
  }

  // What the basket would cost, counting each card still missing at its market price in its own
  // letter, so that a batch of sellers that fills gaps also counts as an improvement.
  // Judges a batch of sellers by a short seller search (2 s), not only the quick basket: the quick
  // basket undervalued extra sellers (a batch "saved 0,02 EUR" that the search could use better).
  async function basketCost(results, table, trackedOnly) {
    const planner = createPlanner({ results }, table, { trackedOnly });
    const priced = await planner.optimise(planner.basket(), { timeMs: 2000, strategies: [STRATEGIES[0]] });
    const target = new Map(results.map(result => [result.key, result.targetCents]));
    return priced.totalCents + priced.missing.reduce((sum, unit) => sum + (target.get(unit.key) ?? 0) + (target.get(unit.key) ? 125 : 0), 0);
  }

  // Sellers the cart showed as tracked-only, remembered for 30 days.
  const TRACKED_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
  async function trackedSellers() {
    const { trackedSellers: known = {} } = await chrome.storage.local.get('trackedSellers');
    return Object.fromEntries(Object.entries(known).filter(([, at]) => Date.now() - at < TRACKED_MEMORY_MS));
  }

  async function rememberTracked(known) {
    await chrome.storage.local.set({ trackedSellers: known });
    field('tracked').value = Object.keys(known).sort().join(', ');
  }

  // The Settings list can be edited by hand: names typed there count as tracked-only.
  trackedSellers().then(known => { field('tracked').value = Object.keys(known).sort().join(', '); });
  field('tracked').addEventListener('change', async () => {
    const known = await trackedSellers();
    const names = field('tracked').value.split(/[,\s]+/).map(name => name.trim()).filter(Boolean);
    await rememberTracked(Object.fromEntries(names.map(name => [name, known[name] || Date.now()])));
    record({ type: 'tracked-edited', sellers: names });
    if (collection) await buildBasket();
  });

  // Reads the cart and compares each seller's shipping with the basket's prediction. Sellers who
  // can only ship tracked are remembered and priced that way in later baskets.
  async function checkCart(existingRunner = null) {
    const out = field('cartCheck');
    out.textContent = 'Reading the cart…';
    try {
      const runner = existingRunner || createRunner(site, { intervalMs: intervalMs(), log: record });
      const shipments = await runner.call('cartShipping');
      const known = await trackedSellers();
      const learned = shipments.filter(shipment => shipment.trackedOnly && !known[shipment.seller]).map(shipment => shipment.seller);
      for (const shipment of shipments) if (shipment.trackedOnly) known[shipment.seller] = Date.now();
      await rememberTracked(known);
      const predicted = new Map(basket.parcels.map(parcel => [parcel.seller, parcel]));
      const differences = shipments.filter(shipment => predicted.has(shipment.seller) && shipment.shippingCents !== predicted.get(shipment.seller).shippingCents);
      const sum = key => shipments.reduce((total, shipment) => total + (shipment[key] || 0), 0);
      record({ type: 'cart-check', removeControl: shipments[0]?.removeControl ?? null, shipments: shipments.length, itemsCents: sum('itemsCents'), shippingCents: sum('shippingCents'),
        trusteeCents: sum('trusteeCents'), trackedOnly: shipments.filter(shipment => shipment.trackedOnly).map(shipment => shipment.seller), learned,
        differences: differences.map(shipment => ({ seller: shipment.seller, cart: shipment.shippingCents, predicted: predicted.get(shipment.seller).shippingCents })) });
      saveLog();
      out.innerHTML = `<p><strong>Cart: ${shipments.length} sellers, articles ${euros(sum('itemsCents'))}, shipping ${euros(sum('shippingCents'))}` +
        `${sum('trusteeCents') ? `, trustee service ${euros(sum('trusteeCents'))}` : ''}.</strong></p>` +
        (differences.length
          ? `<p>Shipping differs from the prediction for: ${differences.map(shipment => `${escape(shipment.seller)} ${euros(shipment.shippingCents)} instead of ` +
            `${euros(predicted.get(shipment.seller).shippingCents)}${shipment.trackedOnly ? ' (ships tracked only)' : ''}`).join('; ')}.</p>`
          : '<p>Shipping matches the prediction for every seller in this basket.</p>') +
        (learned.length
          ? `<p>New tracked-only sellers, priced as tracked from now on: ${learned.map(escape).join(', ')}. ` +
            '<button type="button" data-bw="rebuild" class="btn btn-outline-primary btn-sm">Rebuild the basket with this</button></p>'
          : '');
      panel.querySelector('[data-bw="rebuild"]')?.addEventListener('click', () => buildBasket());
      if (learned.length) await offerSwitch(shipments);
    } catch (error) {
      out.textContent = `Could not read the cart: ${error.message}`;
    }
  }

  // The cart showed sellers who must ship tracked: rebuild the basket knowing that, and say which
  // sellers to remove from the cart. Add to cart then adds only the replacement cards, because
  // cards already added are skipped.
  async function offerSwitch(shipments) {
    const cartCents = shipments.reduce((sum, shipment) => sum + (shipment.itemsCents || 0) + (shipment.shippingCents || 0) + (shipment.trusteeCents || 0), 0);
    const tracked = shipments.filter(shipment => shipment.trackedOnly);
    await buildBasket();
    const kept = new Set(basket.parcels.map(parcel => parcel.seller));
    const remove = tracked.filter(shipment => !kept.has(shipment.seller));
    record({ type: 'switch-offered', cartCents, basketCents: basket.totalCents, remove: remove.map(shipment => shipment.seller) });
    if (!remove.length) {
      field('cartNotice').textContent = `Tracked-only sellers in your cart (${tracked.map(shipment => shipment.seller).join(', ')}) are still the best choice even at tracked rates.`;
      return;
    }
    field('cartNotice').innerHTML = `<div style="border:2px solid #b45309;border-radius:6px;padding:8px">
      <strong>Cardmarket requires tracked shipping from ${remove.map(shipment => escape(shipment.seller)).join(', ')}.</strong>
      The basket was rebuilt without them: ${euros(basket.totalCents)} instead of ${euros(cartCents)} for the current cart.
      To switch: 1. on your <a href="/en/Magic/ShoppingCart" target="_blank" rel="noopener">cart page</a>, click "Remove articles from this seller" for
      ${remove.map(shipment => escape(shipment.seller)).join(', ')}; 2. click <em>Add to cart</em> here: only the replacement cards are added.</div>`;
  }

  // Cards that cost this basket more than they are worth (they force a seller or a dearer parcel),
  // with running totals, and the cards already left out.
  function cutsSection() {
    const leftOut = collection.results.filter(result => leftOutKeys.includes(result.key));
    const putBack = leftOut.length
      ? `<p>Left out (buy elsewhere): ${leftOut.map(result => escape(result.name)).join(', ')}. ` +
        '<button type="button" data-bw="putBack" class="btn btn-link btn-sm">Put them back</button></p>'
      : '';
    const box = 'background:#f1f5ff;border-radius:6px;padding:8px;margin:8px 0';
    if (!cutsReady) return `${putBack}<p style="${box}"><strong>Cards worth buying elsewhere:</strong> shown when the seller search finishes.</p>`;
    if (!cutSuggestions.length) {
      return `${putBack}<p style="${box}"><strong>Cards worth buying elsewhere:</strong> none. No card costs this basket more than 0,20 € beyond its price.</p>`;
    }
    const best = cutSuggestions.at(-1);
    const rows = cutSuggestions.map(cutSuggestion => `<tr><td><input type="checkbox" data-cut="${escape(cutSuggestion.key)}"></td>` +
      `<td>${escape(cutSuggestion.name)}</td><td>${euros(cutSuggestion.marketCents)}</td><td>${euros(cutSuggestion.savedCents)}</td>` +
      `<td>${euros(cutSuggestion.extraCents)}</td><td>${euros(cutSuggestion.basketCents)}</td></tr>`).join('');
    return `${putBack}<details open style="${box}"><summary><strong>Cards worth buying elsewhere:</strong> leaving out ${cutSuggestions.length} ` +
      `saves ${euros(basket.totalCents - best.basketCents)}, ${euros(cutSuggestions.reduce((sum, c) => sum + c.extraCents, 0))} more than they are worth</summary>
      <p style="margin:4px 0">These cards force an extra seller or a dearer parcel, so they cost this basket more than their market price.
        Buy them elsewhere or in a later order. Savings add up from the top.</p>
      <table class="table table-sm"><thead><tr><th></th><th>Card</th><th>Market price</th><th>Leaving it out saves</th><th>Beyond its price</th>` +
      `<th>Basket after</th></tr></thead><tbody>${rows}</tbody></table>
      <button type="button" data-bw="leaveOut" class="btn btn-outline-primary btn-sm">Leave out the ticked cards</button></details>`;
  }

  // Shows the quick basket at once, then races the seller-search strategies for 20 s.
  // Reads the cart (one page) to learn which sellers may only ship tracked, at most every 10 minutes.
  // Whatever is in the cart teaches it, so later baskets price those sellers at tracked rates.
  let cartLearnedAt = 0;
  async function learnFromCart() {
    if (Date.now() - cartLearnedAt < 10 * 60 * 1000) return;
    cartLearnedAt = Date.now();
    try {
      const shipments = await site.cartShipping();
      const known = await trackedSellers();
      const learned = shipments.filter(shipment => shipment.trackedOnly && !known[shipment.seller]).map(shipment => shipment.seller);
      for (const seller of learned) known[seller] = Date.now();
      if (learned.length) await rememberTracked(known);
      if (learned.length) field('cartNotice').textContent = `Read your cart: ${learned.join(', ')} ship tracked only; this basket prices them that way.`;
      record({ type: 'cart-learned', removeControl: shipments[0]?.removeControl ?? null, sellers: shipments.length, trackedOnly: shipments.filter(shipment => shipment.trackedOnly).map(shipment => shipment.seller), learned });
    } catch (error) {
      record({ type: 'cart-learn-error', error: error.message });
    }
  }

  async function buildBasket(table = null, trackedOnly = null) {
    await learnFromCart();
    const { [cutsKey]: cut = [] } = await chrome.storage.local.get(cutsKey);
    const route = `${collection.sellerCountries[0]}:${Number(field('shipTo').value)}`;
    // The remembered best basket is kept per set of left-out cards.
    const bestKey = `best:${listId}:${route}${cut.length ? `:${[...cut].sort().join(',')}` : ''}`;
    const { [bestKey]: previous } = await chrome.storage.local.get(bestKey);
    const wanted = cut.length ? { ...collection, results: collection.results.filter(result => !cut.includes(result.key)) } : collection;
    cutSuggestions = [];
    cutsReady = false;
    leftOutKeys = cut;
    planner = createPlanner(wanted, table ?? await shippingTable(collection.sellerCountries[0]), {
      trackedOnly: trackedOnly ?? Object.keys(await trackedSellers()),
    });
    basket = planner.basket();
    field('topup').innerHTML = '';
    renderBasket();
    const quick = basket.totalCents;
    const note = document.createElement('p');
    note.textContent = 'Looking for a cheaper combination of sellers (about 20 s)…';
    field('basket').prepend(note);
    basket = await planner.optimise(basket, {
      timeMs: 20000,
      onProgress: ({ cents, done, of }) => { note.textContent = `Looking for a cheaper combination of sellers (strategy ${done} of ${of})… best so far ${euros(cents)}`; },
    });
    const fallback = previous ? planner.revalidate(previous.picks) : null;
    const kept = fallback && fallback.assignment.size >= basket.assignment.size &&
      (fallback.assignment.size > basket.assignment.size || fallback.totalCents < basket.totalCents);
    if (kept) basket = fallback;
    if (Number.isFinite(basket.totalCents) && (!previous || !fallback || basket.assignment.size >= fallback.assignment.size)) {
      await chrome.storage.local.set({ [bestKey]: {
        totalCents: basket.totalCents, copies: basket.assignment.size,
        picks: [...basket.assignment].map(([unitId, { seller, offer }]) => ({ unitId, seller, idArticle: offer.idArticle, idProduct: offer.idProduct })),
      } });
    }
    cutSuggestions = planner.recommendCuts(basket);
    cutsReady = true;
    renderBasket();
    record({ type: 'cuts', suggested: cutSuggestions.map(cutSuggestion => ({ name: cutSuggestion.name, savedCents: cutSuggestion.savedCents, extraCents: cutSuggestion.extraCents })), leftOut: cut.length });
    record({ type: 'optimised', quickCents: quick, totalCents: basket.totalCents, sellers: basket.parcels.length, search: basket.search, keptPrevious: Boolean(kept) });
    if (kept || previous && !fallback) {
      const note = document.createElement('p');
      note.textContent = kept ? 'Kept the better saved basket after checking it against these offers.'
        : `Older estimate: ${euros(previous.totalCents)} for ${previous.copies} copies. Some picks could not be confirmed in this snapshot.`;
      field('basket').prepend(note);
    } else if (basket.totalCents < quick) {
      const saved = document.createElement('p');
      saved.textContent = `Seller search saved ${euros(quick - basket.totalCents)} over the quick basket (${euros(quick)}).`;
      field('basket').prepend(saved);
    }
  }

  async function start({ fresh = false } = {}) {
    busy(true);
    collecting = true;
    exportCollection = null;
    field('download').hidden = false;
    runLog = [];
    record({ type: 'start', fresh, listId, country: Number(field('country').value), shipTo: Number(field('shipTo').value), intervalMs: intervalMs(),
      userAgent: navigator.userAgent });
    try {
      const { [readHoldKey]: holdUntil } = await chrome.storage.local.get(readHoldKey);
      if (Date.now() < holdUntil) throw new Error(`Cardmarket asked to wait until ${new Date(holdUntil).toLocaleTimeString()}.`);
      const sellerCountries = [Number(field('country').value)];
      field('status').textContent = 'Loading the Cardmarket catalogue and price guide…';
      const { plan, error } = await chrome.runtime.sendMessage({ type: 'plan', wants: parseWantsList(document) });
      if (error) throw new Error(error);
      const total = plan.entries.reduce((sum, entry) => sum + entry.printings.length, 0);
      field('status').textContent = `Reading ${plan.entries.length} cards…`;
      let waiting = '';
      let waitUntil = 0;
      const common = {
        sellerCountries, intervalMs: intervalMs(), signal: controller.signal, cache: await offerCache(), waitForUser, log: record,
        readRetryDelays: [5000, 10000, 20000, 40000, 80000],
        onDeferred: ({ until }) => chrome.storage.local.set({ [readHoldKey]: until }),
        // Cardmarket's Retry-After: requests of that page type wait, then carry on by themselves.
        onWait: ({ bucket, until, retry }) => {
          waitUntil = until;
          waiting = ` Cardmarket asked to slow down; retry ${retry} of 5 at ${new Date(until).toLocaleTimeString()}.`;
          field('status').textContent = field('status').textContent.replace(/ Cardmarket asked to slow down.*$/, '') + waiting;
        },
        onProgress: ({ phase, done, total: count, requests, retries }) => {
          if (Date.now() > waitUntil) waiting = '';
          const step = phase === 'sellers' ? `Sellers' Wants List offers: ${done}/${count}` : phase === 'cards' ? `Card pages: ${done}/${count}`
            : `${done}/${count} cards finished`;
          field('status').textContent = `${step}, ${requests} requests${retries ? `, ${retries} retries` : ''}.${waiting}`;
        },
      };
      record({ type: 'method', method: field('method').value, printings: total });
      const table = await shippingTable(sellerCountries[0]);
      const trackedOnly = Object.keys(await trackedSellers());
      const result = field('method').value === 'printings'
        ? await collect(plan, site, common)
        : await collectBySellers(plan, site, { ...common, listId, evaluate: results => basketCost(results, table, trackedOnly),
          ...(field('method').value === 'thorough' ? THOROUGH : {}) });
      result.profile = field('method').value;
      const wants = Object.fromEntries(plan.entries.map(entry => [entry.key, {
        name: entry.name, languages: entry.languages, minCondition: entry.minCondition, foil: entry.foil,
        printings: entry.printings.map(printing => printing.idProduct),
      }]));
      collection = Object.assign(result, { listId, priceGuideCreatedAt: plan.priceGuideCreatedAt, warnings: plan.warnings, wants });
      exportCollection = collection;
      collecting = false;
      await chrome.storage.local.set({ [storageKey]: collection });
      renderCoverage();
      await buildBasket(table, trackedOnly);
      await saveRun(collection);
      record({ type: 'basket', sellers: basket.parcels.length, cards: basket.curve.at(-1)?.cards || 0, totalCents: basket.totalCents,
        shippingCents: basket.shippingCents, missing: basket.missing.length });
    } catch (error) {
      record({ type: 'error', message: error.message, stack: error.stack });
      field('status').textContent = `Failed: ${error.message}`;
      field('download').hidden = false;
    } finally {
      collecting = false;
      saveLog();
      busy(false);
    }
  }

  // Copies the chosen printings as a deck list Archidekt imports, one category per seller:
  // "2x Sol Ring (pip) 359 *F* [MTGSPOT-DE]", grouped by seller in basket order. Covers the same
  // sellers as Add to cart (the first N). Set and collector number come from Scryfall; a printing
  // Scryfall does not know is copied by name only.
  async function copyForArchidekt() {
    const parcels = basket.parcels.slice(0, Math.max(1, Number(field('buySellers').value) || basket.parcels.length));
    const lines = new Map();
    for (const [order, parcel] of parcels.entries()) {
      for (const item of parcel.items) {
        const id = `${parcel.seller}|${item.idProduct}|${item.foil}`;
        const line = lines.get(id) || { ...item, seller: parcel.seller, order, quantity: 0 };
        line.quantity += 1;
        lines.set(id, line);
      }
    }
    field('status').textContent = 'Looking up set codes and collector numbers…';
    try {
      const { found, error } = await chrome.runtime.sendMessage({ type: 'printings', ids: [...new Set([...lines.values()].map(line => line.idProduct))] });
      if (error) throw new Error(error);
      const text = [...lines.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map(line => {
        const printing = found[line.idProduct];
        const card = printing ? `${printing.name} (${printing.set}) ${printing.number}` : line.name;
        // Archidekt reads [..] as the card's category; brackets in a seller name would end it early.
        return `${line.quantity}x ${card}${line.foil ? ' *F*' : ''} [${line.seller.replace(/[[\]]/g, '')}]`;
      }).join('\n');
      await navigator.clipboard.writeText(text);
      const unknown = [...lines.values()].filter(line => !found[line.idProduct]).length;
      field('status').textContent = `Copied ${lines.size} lines (${[...lines.values()].reduce((sum, line) => sum + line.quantity, 0)} cards from ${parcels.length} sellers, ` +
        'one category per seller) for Archidekt.' +
        (unknown ? ` ${unknown} printings are not on Scryfall and were copied by name only.` : '');
      record({ type: 'copied', lines: lines.size, unknown });
    } catch (error) {
      field('status').textContent = `Copy failed: ${error.message}`;
    }
  }

  // Offers added to the cart in the last 12 hours, from this record and from cart lines in the log.
  async function alreadyAdded() {
    const added = (await chrome.storage.local.get(cartKey))[cartKey] || {};
    for (const event of runLog) {
      if (event.type === 'cart') for (const id of event.idArticles || [event.idArticle]) added[id] ??= Date.parse(event.t);
    }
    for (const [id, at] of Object.entries(added)) if (Date.now() - at > CART_MEMORY_MS) delete added[id];
    return added;
  }

  // One request per seller, paced and waiting out Cardmarket's Retry-After like the collection.
  // If a seller's request fails, that seller's offers are tried one by one.
  async function buy() {
    const parcels = basket.parcels.slice(0, Math.max(1, Number(field('buySellers').value) || basket.parcels.length));
    const added = await alreadyAdded();
    let skipped = 0;
    const orders = parcels.map(parcel => {
      const items = new Map();
      for (const item of parcel.items) {
        if (added[item.idArticle]) { skipped += 1; continue; }
        const entry = items.get(item.idArticle) || { idArticle: item.idArticle, amount: 0, name: item.name };
        entry.amount += 1;
        items.set(item.idArticle, entry);
      }
      return { seller: parcel.seller, items: [...items.values()] };
    }).filter(order => order.items.length);
    const cards = orders.reduce((sum, order) => sum + order.items.reduce((n, item) => n + item.amount, 0), 0);
    if (!cards) { field('status').textContent = `All ${skipped} cards of these sellers were already added to the cart.`; return; }
    if (!confirm(`Add ${cards} cards from ${orders.length} sellers to your Cardmarket cart?` +
      (skipped ? `\n${skipped} cards added earlier are skipped.` : ''))) return;
    busy(true);
    const runner = createRunner(site, {
      intervalMs: intervalMs(), signal: controller.signal, waitForUser, log: record,
      onWait: ({ until }) => { field('status').textContent += ` Cardmarket asked to wait until ${new Date(until).toLocaleTimeString()}; continuing by itself.`; },
    });
    const failed = [];
    let done = 0;
    const mark = async items => {
      for (const item of items) added[item.idArticle] = Date.now();
      done += items.reduce((n, item) => n + item.amount, 0);
      await chrome.storage.local.set({ [cartKey]: added });
    };
    try {
      for (const [index, order] of orders.entries()) {
        field('status').textContent = `Adding to cart: seller ${index + 1}/${orders.length} (${order.seller}), ${done}/${cards} cards added…`;
        try {
          await runner.call('addSellerToCart', order.items);
          record({ type: 'cart', seller: order.seller, idArticles: order.items.map(item => item.idArticle) });
          await mark(order.items);
        } catch (error) {
          if (error instanceof BlockedError) throw error;
          record({ type: 'cart-error', seller: order.seller, idArticles: order.items.map(item => item.idArticle), error: error.message });
          for (const item of order.items) {
            try {
              await runner.call('addToCart', item.idArticle, item.amount);
              record({ type: 'cart', seller: order.seller, idArticle: item.idArticle, amount: item.amount });
              await mark([item]);
            } catch (itemError) {
              if (itemError instanceof BlockedError) throw itemError;
              record({ type: 'cart-error', seller: order.seller, idArticle: item.idArticle, error: itemError.message });
              failed.push(`${item.name} from ${order.seller}: ${itemError.message}`);
            }
          }
        }
      }
      field('status').textContent = `Added ${done} of ${cards} cards to the cart.` + (failed.length ? ` Not added (sold or changed since the collection?): ${failed.join('; ')}` : '');
      await checkCart(runner);
    } catch (error) {
      field('status').textContent = `Stopped after ${done} of ${cards} cards: ${error.message} Click Add to cart again to continue; added cards are skipped.`;
    } finally {
      saveLog();
      busy(false);
    }
  }

  field('start').addEventListener('click', () => start());
  // Collect fresh: forget saved pages (not the runs) so every page is fetched again.
  field('fresh').addEventListener('click', async () => {
    const stored = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(stored).filter(key => key.startsWith('q:')));
    start({ fresh: true });
  });
  field('stop').addEventListener('click', () => controller?.abort());
  field('download').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify({ collection: exportCollection, collecting, log: runLog })], { type: 'application/json' }));
    link.download = `cardmarket-wizard-${listId}-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`;
    link.click();
  });
  field('openRun').addEventListener('click', async () => {
    const id = field('runs').value;
    if (!id) return;
    try {
      await openCollection((await chrome.storage.local.get(id))[id]);
    } catch (error) {
      field('status').textContent = `Could not open that run: ${error.message}`;
    }
  });
  field('importFile').addEventListener('change', async () => {
    const file = field('importFile').files[0];
    field('importFile').value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      // Accepts the panel's download ({ collection, log }) or a bare collection.
      await openCollection(data.collection || data);
    } catch (error) {
      field('status').textContent = `Could not open ${file.name}: ${error.message}`;
    }
  });

  chrome.storage.local.get([storageKey, logKey, runsKey]).then(async stored => {
    runLog = stored[logKey] || [];
    renderRuns(stored[runsKey] || []);
    if (runLog.length) field('download').hidden = false;
    if (!stored[storageKey]) return;
    collection = stored[storageKey];
    exportCollection = collection;
    renderCoverage();
    try {
      await buildBasket();
      // Keep the current run in the saved list too (runs from before this feature were not saved).
      if (!(stored[runsKey] || []).some(run => run.at === collection.stats.finishedAt)) await saveRun(collection);
    } catch (error) {
      field('basket').textContent = `Basket failed: ${error.message}`;
    }
  });
})();
