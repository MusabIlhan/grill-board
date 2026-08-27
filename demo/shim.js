// The demo's whole trick: answer the board's own fetches from a state baked
// into the page, so `board.html` runs unmodified on a static host.
//
// This must execute BEFORE the page's script, because the first thing that
// script does is poll /api/state. build.mjs injects it just above the closing
// </head>, which is the last point that is still early enough.
//
// Read-only on purpose. Writes are accepted and dropped: the page updates
// optimistically and its next poll sees an unchanged `rev`, so it never
// re-renders over what you just clicked — nothing looks broken, and nothing is
// recorded. The banner says so, because a demo that silently discards your
// answers has to admit it.
(() => {
  const STATE = window.__DEMO_STATE__;
  const ok = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url || '');
    const path = url.split('?')[0].replace(/^.*\/\//, '').replace(/^[^/]*/, '');
    if (!path.startsWith('/api/')) return real(input, init);
    if (path === '/api/state') return Promise.resolve(ok(STATE));
    // Everything else is a write. Say yes, change nothing.
    return Promise.resolve(ok({ ok: true, demo: true }));
  };

  // A ribbon rather than a modal: it has to be unmissable and it must not be
  // the thing you have to dismiss before you can look at the board.
  addEventListener('DOMContentLoaded', () => {
    // The reel renders frames through this same file, and a "nothing is saved"
    // ribbon in a README GIF is noise about a page nobody is clicking.
    if (document.documentElement.dataset.noRibbon) return;
    const b = document.createElement('div');
    b.id = 'demoRibbon';
    b.innerHTML = 'Static demo — a real board, frozen. Clicking works; nothing is saved. ' +
      '<a href="https://github.com/MusabIlhan/grill-board">grill-board on GitHub →</a>';
    document.body.appendChild(b);
  });
})();
