import { fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { dashboardPasscode } from '#hub';
import { createSession, loginDestination, matchesPasscode, sessionCookie, sessionMaxAge } from '#lib/server/auth';

export const load: ServerLoad = ({ locals, url }) => {
  if (!locals.passcodeEnabled || locals.dashboardAuthenticated)
    redirect(303, loginDestination(url.searchParams.get('next')));
};

export const actions: Actions = {
  default: async (event) => {
    const passcode = dashboardPasscode(event);
    if (!passcode || passcode.length < 16) return fail(503, { message: 'Dashboard passcode is not configured.' });
    // adapter-node also provides platform (its raw IncomingMessage), but only
    // the Cloudflare platform has Worker environment bindings.
    if (event.platform?.env) {
      const limiter = event.platform.env.LOGIN_RATE_LIMITER;
      if (!limiter) return fail(503, { message: 'Sign in is temporarily unavailable.' });
      const { success } = await limiter.limit({ key: event.getClientAddress() });
      if (!success) return fail(429, { message: 'Too many attempts. Try again in a minute.' });
    }
    const data = await event.request.formData();
    const candidate = data.get('passcode');
    if (typeof candidate !== 'string' || candidate.length > 1024 || !(await matchesPasscode(candidate, passcode)))
      return fail(400, { message: 'Incorrect passcode.' });
    event.cookies.set(sessionCookie, await createSession(passcode), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: event.url.protocol === 'https:',
      maxAge: sessionMaxAge,
    });
    redirect(303, loginDestination(event.url.searchParams.get('next')));
  },
};
