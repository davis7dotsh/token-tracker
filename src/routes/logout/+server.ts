import { redirect, type RequestHandler } from '@sveltejs/kit';
import { sessionCookie } from '#lib/server/auth';

export const POST: RequestHandler = ({ cookies }) => {
  cookies.delete(sessionCookie, { path: '/' });
  redirect(303, '/login');
};
