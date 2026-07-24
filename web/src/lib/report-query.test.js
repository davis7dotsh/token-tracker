import assert from 'node:assert/strict';
import test from 'node:test';
import {
	reportSearch,
	reportTarget,
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
