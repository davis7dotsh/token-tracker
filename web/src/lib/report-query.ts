const periods = new Set(['day', 'week', 'month']);
const views = new Set(['device', 'project', 'agent', 'model']);
const filterKeys = ['device', 'project', 'agent', 'model'] as const;
const reportDefaults = {
	period: 'day',
	view: 'agent',
	chart: 'bars'
} as const;

export const reportDependency = 'tracker:report';
export const maxFilterValues = 10;
export const maxFilterValueLength = 160;
/** Parameters that select which report is fetched. */
export type ReportParamKey = 'period' | 'view' | (typeof filterKeys)[number];
/** Every parameter carried in the URL, including presentation-only ones. */
export type UrlParamKey = ReportParamKey | 'chart';

const validTimeZone = (value: string) => {
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
};

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

export function reportSearch(url: URL, browserTimeZone: string) {
	const source = url.searchParams;
	const params = new URLSearchParams();
	const period = source.get('period') ?? 'day';
	const view = source.get('view') ?? 'agent';
	const requestedTimeZone = source.get('tz') ?? '';
	const fallbackTimeZone = validTimeZone(browserTimeZone)
		? browserTimeZone
		: 'UTC';

	params.set('period', periods.has(period) ? period : 'day');
	params.set('view', views.has(view) ? view : 'agent');
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

export function validChart(value: string | null) {
	return value === 'lines' ? 'lines' : 'bars';
}

export function reportTarget(
	current: URL,
	key: UrlParamKey,
	value: string | string[]
) {
	const target = new URL(current);
	const isDefault =
		key in reportDefaults &&
		reportDefaults[key as keyof typeof reportDefaults] === value;

	if ((Array.isArray(value) && value.length === 0) || isDefault) {
		target.searchParams.delete(key);
	} else {
		target.searchParams.set(
			key,
			Array.isArray(value) ? JSON.stringify(value) : value
		);
	}

	return target;
}

export async function updateReportParam(
	current: URL,
	key: ReportParamKey,
	value: string | string[],
	navigate: (target: URL) => Promise<void>
) {
	const target = reportTarget(current, key, value);
	if (target.href === current.href) return false;
	await navigate(target);
	return true;
}

/**
 * Decides what a component should do with a result from SvelteKit's load
 * function, given what it is currently showing.
 *
 * The effect that delivers these re-runs for two different reasons, and telling
 * them apart is the whole job:
 *
 * - `'ignore'` — the same data against a URL already recorded. This is the echo
 *   of a `replaceState` this app performed itself; the load function never re-ran.
 *   Adopting it would replace a newer report with a stale one.
 * - `'adopt'` — a genuinely new load result, or a restored history entry whose
 *   query is already cached. Either way a report for that query is in hand.
 * - `'fetch'` — the URL changed but no report for it is available, which happens
 *   when history restores an entry SvelteKit answers with an unchanged data
 *   object. The query must be requested or the report would keep describing the
 *   query the user just left.
 */
export function syncDecision({
	data,
	href,
	synced,
	currentHref,
	cached
}: {
	data: unknown;
	href: string;
	synced: unknown;
	currentHref: string;
	cached: boolean;
}): 'ignore' | 'adopt' | 'fetch' {
	if (data === synced && href === currentHref) return 'ignore';
	if (data !== synced) return 'adopt';
	return cached ? 'adopt' : 'fetch';
}

export function createLatestRequest() {
	let generation = 0;
	let controller: AbortController | null = null;

	return async <Value>(request: (signal: AbortSignal) => Promise<Value>) => {
		const requestGeneration = ++generation;
		controller?.abort();
		const requestController = new AbortController();
		controller = requestController;

		try {
			const value = await request(requestController.signal);
			if (requestGeneration !== generation) {
				return { current: false as const };
			}

			return { current: true as const, value };
		} catch (error) {
			if (
				requestController.signal.aborted ||
				requestGeneration !== generation
			) {
				return { current: false as const };
			}

			throw error;
		}
	};
}
