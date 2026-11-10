import { readPricingCatalog } from '#hub';
import type { PageServerLoad } from './$types';

// Only the cheap catalog read belongs on the navigation/SSR path. Use the
// current request's authenticated locals and platform binding; an internal
// read must not invent a browser Origin from a reverse proxy's URL.
export const load: PageServerLoad = async (event) => {
  if (!event.locals.passcodeEnabled) event.setHeaders({ 'cache-control': 'private, no-store' });
  try {
    const catalog = await readPricingCatalog(event);
    return { catalog, catalogError: '' };
  } catch (failure) {
    return { catalog: null, catalogError: failure instanceof Error ? failure.message : 'Could not load model prices.' };
  }
};
