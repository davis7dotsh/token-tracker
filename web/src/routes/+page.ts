import { reportDependency, reportSearch } from '$lib/report-query';
import type { ReportResponse } from '$lib/api';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url, fetch, depends }) => {
	depends(reportDependency);
	const search = reportSearch(
		url,
		Intl.DateTimeFormat().resolvedOptions().timeZone
	);

	// The promise is returned rather than awaited so navigation completes
	// immediately and the page's `<svelte:boundary>` owns the pending and failed
	// states. A failure therefore surfaces as an inline notice with a retry
	// instead of replacing the dashboard with the error page.
	const report = (async (): Promise<ReportResponse> => {
		const response = await fetch(`/api/report${search}`);
		if (!response.ok) {
			throw new Error(`The report could not be loaded (${response.status}).`);
		}
		return response.json();
	})();

	return { report };
};
