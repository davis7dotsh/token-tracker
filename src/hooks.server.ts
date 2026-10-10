import { json, redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { dashboardPasscode } from '#hub';
import { sessionCookie, validSession } from '#lib/server/auth';

export const handle: Handle = async ({ event, resolve }) => {
  const passcode = dashboardPasscode(event);
  event.locals.passcodeEnabled = passcode !== null;
  event.locals.dashboardAuthenticated = false;
  if (passcode === null) return resolve(event);
  event.setHeaders({ 'cache-control': 'private, no-store' });
  // Cloudflare is never public by accident, even with a missing runtime binding.
  if (passcode.length < 16 || passcode.length > 1024)
    return new Response('Dashboard passcode is not configured.', { status: 503 });
  event.locals.dashboardAuthenticated = await validSession(event.cookies.get(sessionCookie), passcode);
  if (event.url.pathname.startsWith('/_app/')) return resolve(event);
  if (event.route.id === '/login' || event.route.id === '/logout') {
    if (event.request.method === 'POST' && event.request.headers.get('origin') !== event.url.origin)
      return new Response('Cross-origin requests are not allowed.', { status: 403 });
    return resolve(event);
  }
  // The host sends requests without a session to a separate collector RPC
  // group. It exposes authenticated uploads, never dashboard reads.
  if (event.route.id === '/rpc') return resolve(event);
  // Package installers cannot send a dashboard session. The hub restricts
  // downloads to its explicit CLI artifact allowlist.
  if (event.route.id === '/downloads/[file]' && ['GET', 'HEAD'].includes(event.request.method)) return resolve(event);
  if (!event.locals.dashboardAuthenticated) {
    if (event.url.pathname === '/api/health') {
      const response = await resolve(event);
      return json({ status: response.ok ? 'ok' : 'unavailable' }, { status: response.status });
    }
    if (event.request.method !== 'GET' || event.url.pathname.startsWith('/api/'))
      return new Response('Sign in to access the dashboard.', { status: 401 });
    redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
  }
  return resolve(event);
};
