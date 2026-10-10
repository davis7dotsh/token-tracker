import type { RequestEvent } from '@sveltejs/kit';
import { handleRpcRequest } from '../rpc/server';

// Self-hosted hub: Bun serves RPC, health, and downloads in the SvelteKit process.
export const handleHubRequest = ({ request }: RequestEvent) => handleRpcRequest(request);
