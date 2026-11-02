import { fail } from '@sveltejs/kit';
import { cursorKeyConfigured, saveCursorKey, supportsCursorKey } from '#hub';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, setHeaders, locals }) => {
  if (!locals.passcodeEnabled) setHeaders({ 'cache-control': 'private, no-store' });
  return { cursorKeySaved: supportsCursorKey(url) ? await cursorKeyConfigured() : null };
};

export const actions: Actions = {
  cursorKey: async ({ url, request }) => {
    if (!supportsCursorKey(url) || request.headers.get('origin') !== url.origin)
      return fail(403, { message: 'Use the configured HTTPS dashboard to save a key.' });
    const key = (await request.formData()).get('key');
    if (typeof key !== 'string') return fail(400, { message: 'Enter a Cursor API key.' });
    const message = await saveCursorKey(key.trim());
    return message ? fail(400, { message }) : { message: 'Key verified and saved.' };
  },
};
