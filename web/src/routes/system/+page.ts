import { error } from '@sveltejs/kit';
import type { SystemResponse } from '$lib/api';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const response = await fetch('/api/system');
	if (!response.ok) error(response.status, 'failed to load system status');
	return (await response.json()) as SystemResponse;
};
