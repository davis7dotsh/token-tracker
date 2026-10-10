import { handleHubRequest } from '#hub';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) => handleHubRequest(event);
