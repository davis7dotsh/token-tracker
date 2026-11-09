import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Keep shared workbench URLs, including their split, range, and filters, working.
export const GET: RequestHandler = ({ url }) => redirect(308, `/${url.search}`);
