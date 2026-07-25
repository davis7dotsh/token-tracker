const periods = new Set(['day', 'week', 'month']);
const views = new Set(['device', 'project', 'agent', 'model']);
const filterKeys = ['device', 'project', 'agent', 'model'] as const;
const reportDefaults = {
	period: 'day',
	view: 'agent'
} as const;

export const reportDependency = 'tracker:report';
export const maxFilterValues = 10;
export const maxFilterValueLength = 160;
export type ReportParamKey = 'period' | 'view' | (typeof filterKeys)[number];

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
	key: ReportParamKey,
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
