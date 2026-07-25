import assert from 'node:assert/strict';
import test from 'node:test';
import {
	effectiveChart,
	effectivePeriod,
	effectiveView,
	filterValues,
	maxFilterValueLength,
	maxFilterValues,
	reportSearch
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
});

test('falls back to UTC when neither the link nor the browser has a usable zone', () => {
	const url = new URL('https://tracker.test/');
	const params = new URLSearchParams(reportSearch(url, 'Also/Invalid'));

	assert.equal(params.get('tz'), 'UTC');
});

test('caps filter values at the server limit', () => {
	const devices = Array.from({ length: 12 }, (_, index) => `device-${index}`);
	const tooLong = 'x'.repeat(maxFilterValueLength + 1);
	const url = new URL('https://tracker.test/');
	url.searchParams.set('device', JSON.stringify([...devices, tooLong]));

	const params = new URLSearchParams(reportSearch(url, 'UTC'));
	/** @type {string[]} */
	const selected = JSON.parse(params.get('device') ?? '[]');

	assert.equal(selected.length, maxFilterValues);
	assert.ok(selected.every((value) => value.length <= maxFilterValueLength));

	// The same caps apply when decoding straight from a parameter.
	assert.equal(
		filterValues(JSON.stringify([...devices, tooLong])).length,
		maxFilterValues
	);
	assert.deepEqual(filterValues('not json'), []);
	assert.deepEqual(filterValues(null), []);
});

test('chart style never reaches the API or the load dependency', () => {
	// Two URLs differing only by chart style must produce the same request, so
	// toggling bars against lines cannot cause a refetch.
	const bars = new URL('https://tracker.test/?period=week&chart=bars');
	const lines = new URL('https://tracker.test/?period=week&chart=lines');

	assert.equal(reportSearch(bars, 'UTC'), reportSearch(lines, 'UTC'));

	// SvelteKit records a `load` dependency for each parameter read through `get`,
	// so reading `chart` at all would make every toggle re-run the load function.
	// This stand-in records which parameters are touched, mirroring how SvelteKit
	// tracks them.
	/** @type {string[]} */
	const read = [];
	const tracked = new URL('https://tracker.test/?period=week&chart=lines');
	const spy = /** @type {URL} */ ({
		searchParams: {
			/** @param {string} param */
			get(param) {
				read.push(param);
				return tracked.searchParams.get(param);
			}
		}
	});

	reportSearch(spy, 'UTC');

	assert.ok(read.includes('period'), 'expected period to be read');
	assert.ok(!read.includes('chart'), 'chart must never be read');
});

test('controls and the request resolve a parameter the same way', () => {
	// If these ever disagreed, a hand-edited or stale link would render one window
	// while the buttons claimed another. Both sides call the same helpers, so this
	// asserts the property directly rather than the duplication that once caused it.
	for (const value of ['forever', '', 'DAY', 'week', 'month', 'day']) {
		const url = new URL('https://tracker.test/');
		if (value) url.searchParams.set('period', value);
		const requested = new URLSearchParams(reportSearch(url, 'UTC')).get(
			'period'
		);

		assert.equal(effectivePeriod(value || null), requested);
	}

	for (const value of ['secret', '', 'AGENT', 'device', 'model', 'agent']) {
		const url = new URL('https://tracker.test/');
		if (value) url.searchParams.set('view', value);
		const requested = new URLSearchParams(reportSearch(url, 'UTC')).get('view');

		assert.equal(effectiveView(value || null), requested);
	}

	// Chart is presentation-only, so it has no counterpart in the request.
	assert.equal(effectiveChart('lines'), 'lines');
	assert.equal(effectiveChart('bars'), 'bars');
	assert.equal(effectiveChart('nonsense'), 'bars');
	assert.equal(effectiveChart(null), 'bars');
});
