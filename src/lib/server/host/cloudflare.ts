import type { RequestEvent } from '@sveltejs/kit';

// Cloudflare hub: the dashboard Worker forwards RPC, health, and downloads to
// the Hub Worker, whose Durable Object owns the SQLite database.
export const handleHubRequest = async ({ request, platform }: RequestEvent) => {
  if (request.signal.aborted) return new Response(null, { status: 499 });
  if (!platform) return new Response('The token tracker hub is not bound.', { status: 503 });
  const response = await platform.env.HUB.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
