import { handleRpcRequest } from '#lib/server/rpc/server.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => handleRpcRequest(request);
