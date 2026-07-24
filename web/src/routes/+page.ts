import { error } from '@sveltejs/kit';
import type { ReportResponse } from '$lib/api';
import { reportDependency, reportSearch } from '$lib/report-query';
import type { PageLoad } from './$types';

let cachedReportSearch = '';
let cachedFullSearch = '';
let cachedReport: ReportResponse | undefined;

export const load: PageLoad = async ({ url, fetch, depends }) => {
	depends(reportDependency);
	const fullSearch = url.search;
	const search = reportSearch(
		url,
		Intl.DateTimeFormat().resolvedOptions().timeZone
	);

	if (
		cachedReport &&
		cachedReportSearch === search &&
		cachedFullSearch !== fullSearch
	) {
		cachedFullSearch = fullSearch;
		return cachedReport;
	}

	const response = await fetch(`/api/report${search}`);
	if (!response.ok) error(response.status, 'failed to load usage report');
	const report = (await response.json()) as ReportResponse;
	cachedReportSearch = search;
	cachedFullSearch = fullSearch;
	cachedReport = report;
	return report;
};
