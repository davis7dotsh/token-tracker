import type { RequestEvent } from '@sveltejs/kit';
import { TOKEN_TRACKER_DASHBOARD_PASSCODE } from '$app/env/private';

export const dashboardPasscode = (_event: RequestEvent) => TOKEN_TRACKER_DASHBOARD_PASSCODE ?? null;

// Hooks import this module on every route. Opening settings or signing in must
// not start the accounting hub (SQLite migrations, collectors, or view warmer).
export const handleHubRequest = async ({ request, locals }: RequestEvent) => {
  const { handleRpcRequest } = await import('../rpc/server');
  return handleRpcRequest(request, locals.passcodeEnabled && !locals.dashboardAuthenticated);
};

// The Bun hub's GetPricingCatalog reads this same validated, revision-aware
// file. Rendering the editor does not need a device identity or a usage DB.
export const readPricingCatalog = async ({ request, locals }: RequestEvent) => {
  if (locals.passcodeEnabled && !locals.dashboardAuthenticated) throw new Error('Sign in to access the dashboard.');
  request.signal.throwIfAborted();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  const read = async () => {
    const [Effect, { loadPricing }] = await Promise.all([import('effect/Effect'), import('../usage/pricing-runtime')]);
    signal.throwIfAborted();
    const { info } = await Effect.runPromise(loadPricing(), { signal });
    return { info, secretRequired: false };
  };
  // Bound the cold import as well as storage, without cancelling a catalog
  // read that may also serve other requests.
  const interrupted = Promise.withResolvers<never>();
  const abort = () =>
    interrupted.reject(
      request.signal.aborted ? request.signal.reason : new Error('The dashboard took too long to respond. Try again.'),
    );
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([read(), interrupted.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

// Only offer credential management on the configured HTTPS origin. The tailnet
// (and the dashboard session when enabled) is the self-hosted admin boundary.
export const supportsCursorKey = (url: URL) =>
  url.protocol === 'https:' && url.origin === process.env.ORIGIN?.replace(/\/$/, '');
export const cursorKeyConfigured = async () => (await import('../usage/cursor-settings')).cursorKeyConfigured();
export const saveCursorKey = async (key: string) => (await import('../usage/cursor-settings')).saveCursorKey(key);
