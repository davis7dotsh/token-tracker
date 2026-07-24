import assert from 'node:assert/strict';
import test from 'node:test';
import { displaySeriesLabel } from './series-label.ts';

const claudeSeries = {
	label: 'claude',
	isOther: false,
	count: 1
};

test('applies friendly aliases only to agent series', () => {
	assert.equal(
		displaySeriesLabel(claudeSeries, 'fallback', 'agent'),
		'Claude Code'
	);
	assert.equal(
		displaySeriesLabel(claudeSeries, 'fallback', 'device'),
		'claude'
	);
	assert.equal(
		displaySeriesLabel(claudeSeries, 'fallback', 'project'),
		'claude'
	);
	assert.equal(displaySeriesLabel(claudeSeries, 'fallback', 'model'), 'claude');
});

test('formats overflow labels independently of the report view', () => {
	const overflow = { label: 'Other', isOther: true, count: 4 };
	assert.equal(displaySeriesLabel(overflow, 'fallback', 'model'), 'Other (4)');
});
