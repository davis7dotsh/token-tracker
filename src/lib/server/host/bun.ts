import type { RequestEvent } from '@sveltejs/kit';
import { TOKEN_TRACKER_DASHBOARD_PASSCODE } from '$app/env/private';
import { handleRpcRequest } from '../rpc/server';

// Self-hosted hub: Bun serves RPC, health, and downloads in the SvelteKit process.
export const dashboardPasscode = (_event: RequestEvent) => TOKEN_TRACKER_DASHBOARD_PASSCODE ?? null;
export const handleHubRequest = ({ request, locals }: RequestEvent) =>
  handleRpcRequest(request, locals.passcodeEnabled && !locals.dashboardAuthenticated);

// Only offer credential management on the configured HTTPS origin. The tailnet
// (and the dashboard session when enabled) is the self-hosted admin boundary.
export const supportsCursorKey = (url: URL) =>
  url.protocol === 'https:' && url.origin === process.env.ORIGIN?.replace(/\/$/, '');
export { cursorKeyConfigured, saveCursorKey } from '../usage/cursor-settings';
