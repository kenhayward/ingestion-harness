/**
 * The page's only script (`/connections/page.js`): when CT Studio frames the page, it tells
 * CT Studio that connections changed or that the session ended, posting to the one origin the
 * page names (`data-app-origin`, BRIDGE_APP_ORIGIN). Nothing secret is ever in a message.
 */
export const PAGE_JS = `(() => {
  const b = document.body, origin = b.dataset.appOrigin, ev = b.dataset.event;
  if (!origin || !ev || window.parent === window) return;
  const type = ev === 'changed' ? 'connections-changed' : 'session-ended';
  window.parent.postMessage({ source: 'ct-bridge', type }, origin);
})();
`;
