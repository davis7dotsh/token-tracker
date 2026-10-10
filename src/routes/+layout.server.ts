import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({ passcodeEnabled: locals.passcodeEnabled });
