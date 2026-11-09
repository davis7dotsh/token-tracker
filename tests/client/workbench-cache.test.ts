import { expect, test } from 'bun:test';
import { makeWorkbenchCache, usageScopeKey } from '../../src/lib/client/workbench-cache';

test('scope keys ignore filter order but keep empty selections, hidden projects and zones distinct', () => {
  expect(usageScopeKey({ models: ['a', 'b'] })).toBe(usageScopeKey({ models: ['b', 'a'] }));
  expect(new Set([{}, { models: [] }, { excludedProjects: ['a'] }, { timezone: 'UTC' }].map(usageScopeKey)).size).toBe(
    4,
  );
});

test('recent page cache bounds retained bytes and entries and never serves yesterday or an expired read', () => {
  const cache = makeWorkbenchCache<number>((n) => n * 1024 * 1024);
  const at = new Date(2026, 10, 8, 23, 59, 50);
  cache.put('a', 3, at);
  cache.put('b', 3, at);
  expect(cache.get('a', at)).toBe(3);
  cache.put('c', 4, at);
  expect(cache.get('b', at)).toBeUndefined();
  cache.put('huge', 9, at);
  expect(cache.get('c', at)).toBe(4);
  expect(cache.get('huge', at)).toBeUndefined();
  expect(cache.get('a', new Date(+at + 10_000))).toBeUndefined();
  const today = new Date(2026, 10, 9, 8);
  for (let i = 0; i < 9; i++) cache.put(String(i), 0.1, today);
  expect(cache.get('0', today)).toBeUndefined();
  expect(cache.get('1', new Date(+today + 60_000))).toBeUndefined();
  cache.clear();
  expect(cache.get('8', today)).toBeUndefined();
});
