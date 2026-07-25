import type { Chart, Period, View } from './api';

const periods = new Set(['day', 'week', 'month']);
const views = new Set(['device', 'project', 'agent', 'model']);
const filterKeys = ['device', 'project', 'agent', 'model'] as const;

export const reportDependency = 'tracker:report';
export const maxFilterValues = 10;
export const maxFilterValueLength = 160;

/**
 * Resolves a parameter to the value the report will actually be built from.
 *
 * The controls and the request have to agree on this. A URL can carry anything,
 * and an unrecognised value is replaced with a default rather than rejected, so
 * if the two disagreed a hand-edited link would render one window while the
 * buttons claimed another. Both sides call these.
 */
export const effectivePeriod = (value: string | null): Period =>
	value && periods.has(value) ? (value as Period) : 'day';

export const effectiveView = (value: string | null): View =>
	value && views.has(value) ? (value as View) : 'agent';

export const effectiveChart = (value: string | null): Chart =>
	value === 'lines' ? 'lines' : 'bars';

const validTimeZone = (value: string) => {
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
};

/**
 * Decodes a filter parameter, which travels as a JSON array.
 *
 * The server's own limits are applied here too, so a hand-edited link cannot
 * select more values than the UI allows.
 */
export const filterValues = (value: string | null) => {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(item): item is string =>
					typeof item === 'string' &&
					item.length > 0 &&
					item.length <= maxFilterValueLength
			)
			.slice(0, maxFilterValues);
	} catch {
		return [];
	}
};

/**
 * Builds the query for the report endpoint from the page URL.
 *
 * Two properties matter and are covered by tests:
 *
 * - Every parameter is read by name. SvelteKit records a `load` dependency per
 *   parameter accessed through `get`, so reading only these keeps the load
 *   function from re-running on unrelated changes. Any other access to
 *   `searchParams` — iterating it, or stringifying it — would depend on the
 *   whole URL instead.
 * - `chart` is never read. It selects bars against lines and has no bearing on
 *   the data, so toggling it must not re-run `load` or issue a request.
 *
 * Values that are out of range are replaced with defaults rather than rejected,
 * so a hand-edited or stale link still renders a report.
 */
export function reportSearch(url: URL, browserTimeZone: string) {
	const source = url.searchParams;
	const params = new URLSearchParams();
	const requestedTimeZone = source.get('tz') ?? '';
	const fallbackTimeZone = validTimeZone(browserTimeZone)
		? browserTimeZone
		: 'UTC';

	params.set('period', effectivePeriod(source.get('period')));
	params.set('view', effectiveView(source.get('view')));
	params.set(
		'tz',
		validTimeZone(requestedTimeZone) ? requestedTimeZone : fallbackTimeZone
	);

	for (const key of filterKeys) {
		const values = filterValues(source.get(key));
		if (values.length) params.set(key, JSON.stringify(values));
	}

	return `?${params.toString()}`;
}
