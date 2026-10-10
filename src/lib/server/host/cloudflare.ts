import type { RequestEvent } from '@sveltejs/kit';

export const dashboardPasscode = ({ platform }: { platform?: Pick<App.Platform, 'env'> }) =>
  platform?.env.TOKEN_TRACKER_DASHBOARD_PASSCODE ?? '';

// Cloudflare hub: the dashboard Worker forwards RPC, health, and downloads to
// the Hub Worker, whose Durable Object owns the SQLite database.
export const handleHubRequest = async ({
  request,
  platform,
  locals,
}: Pick<RequestEvent, 'request' | 'locals'> & { platform?: Pick<App.Platform, 'env'> }) => {
  if (request.signal.aborted) return new Response(null, { status: 499 });
  if (!platform) return new Response('The token tracker hub is not bound.', { status: 503 });
  const url = new URL(request.url);
  // POST handlers are RPC. Canonicalize the path so encoded spellings cannot
  // bypass the collector-only route for a request without a session.
  if (request.method === 'POST') url.pathname = locals.dashboardAuthenticated ? '/rpc' : '/collector';
  const response = await platform.env.HUB.fetch(new Request(url, request));
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
