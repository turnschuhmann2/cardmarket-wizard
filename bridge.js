// Lightweight Cardmarket bridge: executes same-origin authenticated fetch requests on behalf of
// the Better Wizard app tab so requests use the user's logged-in session and Cloudflare clearance.
(() => {
  'use strict';

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message || typeof message !== 'object') return false;
    if (sender?.id !== chrome.runtime.id) return false;

    if (message.type === 'cm-ping') {
      reply({
        ok: true,
        url: location.href,
        hasToken: Boolean(document.querySelector('[name="__cmtkn"]')?.value),
      });
      return false;
    }

    if (message.type === 'cm-token') {
      reply({ token: document.querySelector('[name="__cmtkn"]')?.value || null });
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
          const response = await fetch(target.href, init);
          const text = await response.text();
          reply({
            ok: response.ok,
            status: response.status,
            url: response.url,
            redirected: response.redirected,
            headers: {
              'cf-mitigated': response.headers.get('cf-mitigated'),
              'retry-after': response.headers.get('retry-after'),
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
