import type { RequestEvent } from '@sveltejs/kit';
import { TOKEN_TRACKER_DASHBOARD_PASSCODE } from '$app/env/private';
import { handleRpcRequest } from '../rpc/server';

// Self-hosted hub: Bun serves RPC, health, and downloads in the SvelteKit process.
export const dashboardPasscode = (_event: RequestEvent) => TOKEN_TRACKER_DASHBOARD_PASSCODE ?? null;
export const handleHubRequest = ({ request, locals }: RequestEvent) =>
  handleRpcRequest(request, locals.passcodeEnabled && !locals.dashboardAuthenticated);
