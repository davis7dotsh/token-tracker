import { error } from '@sveltejs/kit';
import { reportDependency, reportSearch } from '$lib/report-query';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch, depends }) => {
	depends(reportDependency);
	const search = reportSearch(
		url,
		Intl.DateTimeFormat().resolvedOptions().timeZone
	);

	const response = await fetch(`/api/report${search}`);
	if (!response.ok) error(response.status, 'failed to load usage report');
	return response.json();
};
