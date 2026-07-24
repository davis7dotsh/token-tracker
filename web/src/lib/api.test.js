import assert from 'node:assert/strict';
import test from 'node:test';
import { money, number } from './api.ts';

test('formats compact token totals and currency', () => {
	assert.match(number(1_500_000), /1\.5M/);
	assert.match(money(12.5), /12\.50/);
});
