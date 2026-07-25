import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createLatestRequest,
	reportSearch,
	reportTarget,
	syncDecision,
	updateReportParam,
	validChart
} from './report-query.ts';

test('sanitizes invalid deep links before requesting the API', () => {
	const url = new URL(
		'https://tracker.test/?period=forever&view=secret&chart=unknown&tz=Not/AZone&device=%5B%22one%22%2C%22two%22%5D'
	);
	const search = reportSearch(url, 'America/Los_Angeles');
	const params = new URLSearchParams(search);

	assert.equal(params.get('period'), 'day');
	assert.equal(params.get('view'), 'agent');
	assert.equal(params.get('tz'), 'America/Los_Angeles');
	assert.equal(params.get('device'), '["one","two"]');
	assert.equal(params.has('chart'), false);
	assert.equal(validChart('unknown'), 'bars');

	const bars = new URL('https://tracker.test/?chart=bars');
	const lines = new URL('https://tracker.test/?chart=lines');
	assert.equal(reportSearch(bars, 'UTC'), reportSearch(lines, 'UTC'));
});

test('caps filter values at the server limit', () => {
	const values = [
		...Array.from({ length: 12 }, (_, index) => `device-${index}`),
		'x'.repeat(161)
	];
	const url = new URL(
		`https://tracker.test/?device=${encodeURIComponent(JSON.stringify(values))}`
	);
	const params = new URLSearchParams(reportSearch(url, 'UTC'));
	const device = params.get('device');
	assert.ok(device);
	/** @type {string[]} */
	const parsed = JSON.parse(device);
	assert.equal(parsed.length, 10);
	assert.ok(parsed.every((value) => value.length <= 160));
});

test('builds report URLs without changing client-only chart state', () => {
	const current = new URL(
		'https://tracker.test/?chart=lines&project=%5B%22one%22%5D'
	);
	const week = reportTarget(current, 'period', 'week');
	assert.equal(week.searchParams.get('period'), 'week');
	assert.equal(week.searchParams.get('chart'), 'lines');
	assert.equal(week.searchParams.get('project'), '["one"]');

	const defaultPeriod = reportTarget(week, 'period', 'day');
	assert.equal(defaultPeriod.searchParams.has('period'), false);

	const filtered = reportTarget(current, 'device', ['operator', 'siva']);
	assert.equal(filtered.searchParams.get('device'), '["operator","siva"]');
});

test('runs one report navigation for a changed value and none for a no-op', async () => {
	const current = new URL('https://tracker.test/?period=day');
	/** @type {string[]} */
	const destinations = [];
	const navigate = async (/** @type {URL} */ target) => {
		destinations.push(target.href);
	};

	assert.equal(
		await updateReportParam(current, 'period', 'week', navigate),
		true
	);
	assert.deepEqual(destinations, ['https://tracker.test/?period=week']);

	assert.equal(
		await updateReportParam(
			new URL('https://tracker.test/?period=week'),
			'period',
			'week',
			navigate
		),
		false
	);
	assert.equal(destinations.length, 1);
});

test('only accepts the newest report response', async () => {
	const latestRequest = createLatestRequest();
	/** @type {(value: string) => void} */
	let resolveFirst = () => {};
	/** @type {(value: string) => void} */
	let resolveSecond = () => {};
	/** @type {AbortSignal | undefined} */
	let firstSignal;

	const first = latestRequest(
		(signal) =>
			new Promise((resolve) => {
				firstSignal = signal;
				resolveFirst = resolve;
			})
	);
	const second = latestRequest(
		() =>
			new Promise((resolve) => {
				resolveSecond = resolve;
			})
	);

	assert.equal(firstSignal?.aborted, true);
	resolveSecond('month');
	assert.deepEqual(await second, { current: true, value: 'month' });

	resolveFirst('week');
	assert.deepEqual(await first, { current: false });
});

test('ignores a load result echoed back by an in-app URL rewrite', () => {
	const data = { report: {} };

	// Selecting a control rewrites the URL via replaceState, which re-runs the
	// effect without re-running load. Adopting `data` again would replace whatever
	// is now displayed with the entry the page was first loaded with.
	assert.equal(
		syncDecision({
			data,
			href: 'https://tracker.test/?period=week',
			synced: data,
			currentHref: 'https://tracker.test/?period=week',
			cached: true
		}),
		'ignore'
	);
});

test('adopts a genuinely new load result', () => {
	assert.equal(
		syncDecision({
			data: { report: {} },
			href: 'https://tracker.test/?period=month',
			synced: { report: {} },
			currentHref: 'https://tracker.test/?period=week',
			cached: false
		}),
		'adopt'
	);
});

test('follows history back to a restored URL that reuses the same load result', () => {
	const data = { report: {} };

	// SvelteKit can restore a history entry without building a new data object. The
	// URL still moved, so the report has to follow it: from cache when possible,
	// otherwise by fetching. Returning 'ignore' here would leave the report
	// describing the query the user just left.
	assert.equal(
		syncDecision({
			data,
			href: 'https://tracker.test/?period=day',
			synced: data,
			currentHref: 'https://tracker.test/?period=week',
			cached: true
		}),
		'adopt'
	);

	assert.equal(
		syncDecision({
			data,
			href: 'https://tracker.test/?period=day',
			synced: data,
			currentHref: 'https://tracker.test/?period=week',
			cached: false
		}),
		'fetch'
	);
});
