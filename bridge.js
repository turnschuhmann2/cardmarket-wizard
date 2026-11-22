// Lightweight Cardmarket bridge: executes same-origin authenticated fetch requests on behalf of
// the Better Wizard app tab so requests use the user's logged-in session and Cloudflare clearance.
(() => {
  'use strict';

  const readCsrfToken = () => {
    for (const el of document.querySelectorAll('[name="__cmtkn"]')) {
      if (el.value) return el.value;
    }
    return null;
  };

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message || typeof message !== 'object') return false;
    if (sender?.id !== chrome.runtime.id) return false;

    if (message.type === 'cm-ping') {
      reply({
        ok: true,
        url: location.href,
        hasToken: Boolean(readCsrfToken()),
      });
      return false;
    }

    if (message.type === 'cm-token') {
      reply({ token: readCsrfToken() });
      return false;
    }

    if (message.type === 'cm-fetch') {
      (async () => {
        try {
          let target;
          try {
            target = new URL(message.url, location.href);
          } catch {
            target = null;
          }
          if (target?.origin !== 'https://www.cardmarket.com') {
            reply({ error: 'Blocked non-Cardmarket URL' });
            return;
          }
          const method = String(message.method || 'GET').toUpperCase();
          if (method !== 'GET' && method !== 'POST') {
            reply({ error: `Blocked HTTP method ${method}` });
            return;
          }
          const init = {
            method,
            credentials: 'include',
          };
          if (Array.isArray(message.formEntries)) {
            const body = new FormData();
            for (const [k, v] of message.formEntries) body.append(k, v);
            init.body = body;
          }
          const t0 = Date.now();
          const response = await fetch(target.href, init);
          const tHeaders = Date.now();
          const text = await response.text();
          const tBody = Date.now();
          reply({
            ok: response.ok,
            status: response.status,
            url: response.url,
            redirected: response.redirected,
            headers: {
              'cf-mitigated': response.headers.get('cf-mitigated'),
              'retry-after': response.headers.get('retry-after'),
            },
            timing: {
              fetchMs: tBody - t0,
              headersMs: tHeaders - t0,
              bodyMs: tBody - tHeaders,
            },
            text,
          });
        } catch (error) {
          reply({
            networkError: error instanceof TypeError,
            error: error?.message || String(error),
          });
        }
      })();
      return true;
    }

    return false;
  });
})();
