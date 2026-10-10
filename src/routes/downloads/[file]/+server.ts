import { handleHubRequest } from '#hub';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => handleHubRequest(event);
