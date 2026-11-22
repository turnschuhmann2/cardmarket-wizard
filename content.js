// Compact Cardmarket entry bar:
// - On Wants List pages: shows last saved basket summary + "Open Better Wizard" button.
// - On Non-single Product pages (sleeves, deck boxes, etc.): shows "+ Add to Better Wizard" button.
(() => {
  'use strict';

  const euros = value => (value === null || value === undefined ? '–' : `${(value / 100).toFixed(2).replace('.', ',')} €`);
  const ageText = ts => {
    const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  };

  const WANTS_GENERIC = /^(view(\s*\/\s*edit)?(\s+list)?|edit(\s+list)?|delete|remove|shopping wizard|wizard|open|show|details?|(my\s+)?wants(\s+lists?)?|edit\s+wants(\s+list)?)$/i;

  function cleanHeading(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('small, span.h4, .subtitle, .badge, button, a.btn, .visually-hidden, .sr-only').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractWantsListName(listId) {
    const candidates = [
      cleanHeading(document.querySelector('main h1') || document.querySelector('h1')),
      document.querySelector('input[name="name"], input[name="wantslistName"], input[name="title"]')?.value,
      cleanHeading(document.querySelector('.page-title-container h2, main h2')),
      cleanHeading(document.querySelector('.breadcrumb-item.active, nav[aria-label="breadcrumb"] .active')),
      (document.title || '')
        .replace(/\s*[|–-]\s*Cardmarket.*$/i, '')
        .replace(/^(my\s+)?wants(\s+list)?\s*[:–-]\s*/i, ''),
    ];
    for (const raw of candidates) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim();
      if (text && !WANTS_GENERIC.test(text)) return text;
    }
    return `Wants List ${listId}`;
  }

  function makeBar(html) {
    const bar = document.createElement('section');
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:12px', 'flex-wrap:wrap',
      'padding:10px 14px', 'margin:12px 0', 'border-radius:10px',
      'background:linear-gradient(135deg,#f8fafc 0%,#eef2ff 100%)',
      'border:1px solid #c7d2fe', 'box-shadow:0 1px 3px rgba(15,23,42,0.06)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif', 'font-size:13.5px', 'color:#0f172a',
    ].join(';');
    bar.innerHTML = html;
    return bar;
  }

  const normaliseProductPath = path => String(path || '').replace(/^\/[^/]+\//, '/en/');

  // 1. Wants List page
  const wantsMatch = /\/(Magic|YuGiOh)\/Wants\/(\d+)/.exec(location.pathname);
  if (wantsMatch && document.querySelector('td.name a')) {
    const [, game, listId] = wantsMatch;
    const listName = extractWantsListName(listId);
    const count = document.querySelectorAll('tbody tr td.name a').length || null;
    const bar = makeBar(`
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;background:#4f46e5;color:#fff;font-weight:700;font-size:13px">BW</span>
        <div>
          <strong style="font-size:14px">Cardmarket Better Wizard</strong>
          <div data-bw-summary style="font-size:12.5px;color:#475569">Multi-list, cross-game & Europe basket optimiser</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" data-bw-open style="background:#4f46e5;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-weight:600;font-size:13px;cursor:pointer">
          Open Better Wizard →
        </button>
      </div>
    `);
    (document.querySelector('main h1')?.closest('.row, div') || document.querySelector('main') || document.body).after(bar);

    // Load last run summary if available (supports both legacy per-list runs and new app runs).
    chrome.storage.local.get([`runs:${listId}`, 'bwRuns']).then(data => {
      const appRuns = (data.bwRuns || []).filter(r => r.lists?.some(l => l.game === game && String(l.listId) === String(listId)));
      const legacyRuns = data[`runs:${listId}`] || [];
      const latest = [appRuns[0], legacyRuns[0]].filter(Boolean).sort((a, b) => b.at - a.at)[0];
      if (!latest) return;
      const summary = bar.querySelector('[data-bw-summary]');
      if (latest.totalCents) {
        summary.textContent = `Last basket: ${euros(latest.totalCents)} · ${latest.cards} items · ${latest.sellers} sellers (${ageText(latest.at)})`;
      } else {
        summary.textContent = `Last fetched ${ageText(latest.at)} (${latest.cards} items)`;
      }
    });

    bar.querySelector('[data-bw-open]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'open-app', params: { game, listId, listName, count } });
    });
    return;
  }

  // 2. Non-single Product page (sleeves, deck boxes, binders, playmats, boosters, etc.)
  const prodMatch = /^\/[^/]+\/(Magic|YuGiOh)\/Products\/([^/]+)\/(.+)$/.exec(location.pathname);
  if (prodMatch && prodMatch[2].toLowerCase() !== 'singles') {
    const [, game, rawCategory] = prodMatch;
    const category = decodeURIComponent(rawCategory).replace(/-/g, ' ');
    const idProduct = Number(document.querySelector('input[name="idProduct"]')?.value || 0) || null;
    const h1 = document.querySelector('main h1') || document.querySelector('h1');
    const titleClone = h1 ? h1.cloneNode(true) : null;
    if (titleClone) {
      for (const small of titleClone.querySelectorAll('small, span.h4, .subtitle')) small.remove();
    }
    const name = (titleClone?.textContent || document.title || 'Product').replace(/\s*\|.*$/, '').replace(/\s+/g, ' ').trim();
    const productPath = normaliseProductPath(location.pathname);

    const bar = makeBar(`
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;background:#4f46e5;color:#fff;font-weight:700;font-size:13px">BW</span>
        <div>
          <strong style="font-size:14px">Better Wizard · Extra Product</strong>
          <div data-bw-prod-status style="font-size:12.5px;color:#475569"></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" data-bw-add style="background:#4f46e5;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-weight:600;font-size:13px;cursor:pointer">
          + Add to Better Wizard
        </button>
        <button type="button" data-bw-open style="background:#fff;color:#4f46e5;border:1px solid #c7d2fe;border-radius:8px;padding:7px 12px;font-weight:600;font-size:13px;cursor:pointer">
          Open App
        </button>
      </div>
    `);
    (document.querySelector('main h1')?.closest('.row, div') || document.querySelector('main') || document.body).after(bar);

    const statusEl = bar.querySelector('[data-bw-prod-status]');
    statusEl.textContent = `Bundle this ${category.toLowerCase()} with your card orders to save shipping.`;
    const addBtn = bar.querySelector('[data-bw-add]');

    const refreshState = async () => {
      const { extraProducts = [] } = await chrome.storage.local.get('extraProducts');
      const existing = extraProducts.find(p => normaliseProductPath(p.productPath) === productPath);
      if (existing) {
        statusEl.textContent = `In Better Wizard (qty ${existing.amount}) — will be optimised alongside your cards.`;
        addBtn.textContent = `+ Add another (qty ${existing.amount})`;
      }
    };
    refreshState();

    addBtn.addEventListener('click', async () => {
      const { extraProducts = [] } = await chrome.storage.local.get('extraProducts');
      const existing = extraProducts.find(p => normaliseProductPath(p.productPath) === productPath);
      if (existing) {
        existing.amount = (existing.amount || 1) + 1;
        existing.enabled = true;
        existing.productPath = productPath;
        existing.url = location.origin + productPath;
      } else {
        extraProducts.push({
          id: `prod:${idProduct || productPath}`,
          idProduct,
          name,
          game,
          category,
          productPath,
          url: location.origin + productPath,
          amount: 1,
          enabled: true,
          addedAt: Date.now(),
        });
      }
      await chrome.storage.local.set({ extraProducts });
      await refreshState();
    });

    bar.querySelector('[data-bw-open]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'open-app', params: { addedProduct: productPath } });
    });
  }
})();
