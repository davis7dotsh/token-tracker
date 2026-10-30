import { describe, expect, test } from 'bun:test';
import {
  dashboardUrlSchema,
  dashboardUrlSchemaFor,
  dashboardRanges,
  decodeFilter,
  encodeFilter,
  encodeHidden,
  filterKeys,
  normalizedDashboardParams,
  usageQueryFromParams,
} from '../../src/lib/client/dashboard-url';

const validate = (input: unknown) => {
  const result = dashboardUrlSchema['~standard'].validate(input);
  if (result instanceof Promise || !('value' in result))
    throw new Error('Dashboard URL validation must be synchronous.');
  return result.value;
};
const roundTripFilter = (values: readonly string[] | undefined) => {
  const query = new URLSearchParams({ models: encodeFilter(values) });
  const shared = new URL(`https://tracker.test/?${query.toString()}`);
  return decodeFilter(validate(Object.fromEntries(shared.searchParams)).models);
};

describe('dashboard URL state', () => {
  test('empty validation exposes every defaulted control key for Runed schema discovery', () => {
    const defaults = validate({});
    expect(Object.keys(defaults).sort()).toEqual(
      [
        ...filterKeys,
        'excludedProjects',
        'range',
        'metric',
        'chart',
        'breakdown',
        'chartBy',
        'expanded',
        'search',
        'sort',
        'page',
      ].sort(),
    );
    expect(defaults).toMatchObject({
      range: '30d',
      metric: 'tokens',
      chart: 'bar',
      breakdown: 'harnesses',
      chartBy: 'harnesses',
      expanded: false,
      search: '',
      sort: 'lastActiveAt',
      page: 1,
    });
    expect([...filterKeys, 'excludedProjects'].every((key) => Reflect.get(defaults, key) === '')).toBe(true);
    expect(usageQueryFromParams(defaults, 'America/Los_Angeles')).toMatchObject({
      range: '30d',
      timezone: 'America/Los_Angeles',
    });
    expect(filterKeys.every((key) => usageQueryFromParams(defaults, 'UTC')[key] === undefined)).toBe(true);
    expect(usageQueryFromParams(defaults, 'UTC').excludedProjects).toBeUndefined();
  });

  test('hidden projects come only from the URL, never a seeded default', () => {
    const read = (input: Record<string, string>) => usageQueryFromParams(validate(input), 'UTC').excludedProjects;
    expect(validate({}).excludedProjects).toBe('');
    expect(read({})).toBeUndefined();
    expect(read({ excludedProjects: 'github.com/ben/other' })).toEqual(['github.com/ben/other']);
    expect(read({ excludedProjects: encodeHidden(['github.com/ben/spike', 'name,with,commas']) })).toEqual([
      'github.com/ben/spike',
      'name,with,commas',
    ]);
    expect(read({ excludedProjects: '' })).toBeUndefined();
    expect(read({ excludedProjects: 'none' })).toBeUndefined();
    // An explicit `none` state survives validation untouched; the page's URL
    // cleanup turns a present-but-empty param into it (see round-trip test).
    expect(validate({ excludedProjects: 'none' }).excludedProjects).toBe('none');
  });

  test('hidden projects round-trip and canonicalize an empty list to no exclusions', () => {
    const state = validate({
      excludedProjects: encodeHidden(['github.com/ben/spike', 'none', 'name,with,commas', 'github.com/ben/spike']),
    });
    expect(usageQueryFromParams(state, 'UTC').excludedProjects).toEqual([
      'github.com/ben/spike',
      'none',
      'name,with,commas',
    ]);
    const normalized = normalizedDashboardParams(state);
    expect(usageQueryFromParams(normalized, 'UTC')).toEqual(usageQueryFromParams(state, 'UTC'));
    expect(normalizedDashboardParams(normalized)).toEqual(normalized);
    expect(encodeHidden([])).toBe('');
    const explicitNone = normalizedDashboardParams(validate({ excludedProjects: 'none' }));
    expect(explicitNone.excludedProjects).toBe('none');
    expect(normalizedDashboardParams(explicitNone)).toEqual(explicitNone);
    expect(normalizedDashboardParams(validate({})).excludedProjects).toBe('');
  });

  test.each(dashboardRanges.map(({ value }) => value))('browser default %s preserves explicit URL ranges', (value) => {
    const schema = dashboardUrlSchemaFor(value);
    const read = (input: Record<string, string>) => {
      const result = schema['~standard'].validate(input);
      if (result instanceof Promise || !('value' in result)) throw new Error('Expected synchronous validation.');
      return result.value.range;
    };
    expect(read({})).toBe(value);
    expect(read({ range: '30d' })).toBe('30d');
    expect(read({ range: 'today' })).toBe('today');
    expect(read({ range: 'invalid' })).toBe(value);
    expect(validate({}).range).toBe('30d');
  });

  test('legacy all, none, and comma links keep their distinct filtering behavior', () => {
    const shared = new URL('https://tracker.test/?harnesses=codex,grok&models=none&providers=xai');
    const state = validate(Object.fromEntries(shared.searchParams));
    const query = usageQueryFromParams(state, 'UTC');
    expect(query.harnesses).toEqual(['codex', 'grok']);
    expect(query.models).toEqual([]);
    expect(query.providers).toEqual(['xai']);
    expect(query.devices).toBeUndefined();
    expect(query.projects).toBeUndefined();
    expect(decodeFilter(' codex , grok,codex ')).toEqual(['codex', 'grok']);
  });

  test('all, none, and multi-select states survive sharing and reload', () => {
    expect(roundTripFilter(undefined)).toBeUndefined();
    expect(roundTripFilter([])).toEqual([]);
    expect(roundTripFilter([''])).toEqual(['']);
    expect(roundTripFilter(['', 'grok'])).toEqual(['', 'grok']);
    expect(roundTripFilter(['grok-4.7-build-fast'])).toEqual(['grok-4.7-build-fast']);
    expect(roundTripFilter(['grok-4.7-build-fast', 'gpt-6.1-sol'])).toEqual(['grok-4.7-build-fast', 'gpt-6.1-sol']);
  });

  test('JSON filter names preserve literal delimiters, sentinels, brackets, spacing, and Unicode', () => {
    const names = ['none', 'model,with,commas', '[1]', ' leading', 'trailing ', '{"x": 1}', 'true', 'false', 'μ-model'];
    expect(roundTripFilter(names)).toEqual(names);
    for (const name of names) expect(roundTripFilter([name])).toEqual([name]);
    const linked = validate({ models: '["none","name,with,commas","[brackets]"," whitespace "]' });
    expect(usageQueryFromParams(linked, 'UTC').models).toEqual([
      'none',
      'name,with,commas',
      '[brackets]',
      ' whitespace ',
    ]);
    expect(decodeFilter('[]')).toEqual([]);
  });

  test('duplicate selections are removed without changing selection order', () => {
    const names = ['none', 'codex', 'none', 'grok', 'codex'];
    expect(roundTripFilter(names)).toEqual(['none', 'codex', 'grok']);
    expect(decodeFilter('["codex","grok","codex"]')).toEqual(['codex', 'grok']);
  });

  test.each(['[broken', '[1]', '[null]', '["grok",false]'])(
    'malformed JSON filter %s defaults independently while preserving other valid filters',
    (invalid) => {
      const state = validate({ models: invalid, harnesses: 'grok', providers: 'xai', range: '7d' });
      const query = usageQueryFromParams(state, 'UTC');
      expect(query.models).toBeUndefined();
      expect(query.harnesses).toEqual(['grok']);
      expect(query.providers).toEqual(['xai']);
      expect(query.range).toBe('7d');
    },
  );

  test('invalid controls default individually and retain valid filters and search', () => {
    const state = validate({
      range: 'year',
      chart: 'pie',
      metric: 'money',
      breakdown: 'unknown',
      chartBy: 'devices',
      expanded: 'yes',
      sort: 'inputTokens',
      page: NaN,
      harnesses: 'grok',
      models: 'none',
      search: 'valid search',
    });
    expect(state).toMatchObject({
      range: '30d',
      chart: 'bar',
      metric: 'tokens',
      breakdown: 'harnesses',
      chartBy: 'harnesses',
      expanded: false,
      sort: 'lastActiveAt',
      page: 1,
      search: 'valid search',
    });
    expect(usageQueryFromParams(state, 'UTC').harnesses).toEqual(['grok']);
    expect(usageQueryFromParams(state, 'UTC').models).toEqual([]);
  });

  test.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 'bogus', null])(
    'invalid page %s cannot produce negative, fractional, or unsafe pagination',
    (page) => {
      expect(validate({ page, range: 'today', harnesses: 'grok' })).toMatchObject({
        page: 1,
        range: 'today',
        harnesses: 'grok',
      });
    },
  );

  test('valid human page numbers and controls retain their typed values', () => {
    expect(
      validate({
        page: 3,
        expanded: true,
        metric: 'cost',
        chart: 'line',
        chartBy: 'models',
        breakdown: 'projects',
        sort: 'tokens',
      }),
    ).toMatchObject({
      page: 3,
      expanded: true,
      metric: 'cost',
      chart: 'line',
      chartBy: 'models',
      breakdown: 'projects',
      sort: 'tokens',
    });
    expect(validate({ page: Number.MAX_SAFE_INTEGER }).page).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizedDashboardParams(validate({ chartBy: 'projects' })).chartBy).toBe('projects');
  });

  test.each(['true', 'false', '[]', '{}', '[1]', '{"x": 1}', '  exact spacing  ', 'none', 'a,b'])(
    'literal search %s survives schema validation and URL serialization',
    (search) => {
      const shared = new URL('https://tracker.test/');
      shared.searchParams.set('search', search);
      expect(validate(Object.fromEntries(shared.searchParams)).search).toBe(search);
    },
  );

  test('server query identity excludes all visualization, search, sorting, expansion, and pagination controls', () => {
    const state = validate({ range: '7d', harnesses: 'grok', models: '["none","model,comma"]' });
    const next = validate({
      ...state,
      metric: 'cost',
      chart: 'line',
      breakdown: 'projects',
      chartBy: 'models',
      expanded: true,
      search: 'anything',
      sort: 'tokens',
      page: 9,
    });
    const query = usageQueryFromParams(state, 'UTC');
    expect(usageQueryFromParams(next, 'UTC')).toEqual(query);
    expect(Object.keys(query).sort()).toEqual(['range', 'timezone', 'excludedProjects', ...filterKeys].sort());
    expect(JSON.stringify(usageQueryFromParams(next, 'UTC'))).toBe(JSON.stringify(query));
    expect(JSON.stringify(usageQueryFromParams(validate({ ...next, harnesses: 'codex' }), 'UTC'))).not.toBe(
      JSON.stringify(query),
    );
  });

  test('canonical URL cleanup is idempotent and preserves active queries, literal searches, and valid controls', () => {
    const original = validate({
      harnesses: ' codex , grok,codex ',
      models: '["none","name,with,commas"," whitespace "]',
      providers: '[broken',
      search: '{"x": 1}',
      page: 3,
      expanded: true,
      chart: 'line',
    });
    const normalized = normalizedDashboardParams(original);
    expect(usageQueryFromParams(normalized, 'UTC')).toEqual(usageQueryFromParams(original, 'UTC'));
    expect(normalizedDashboardParams(normalized)).toEqual(normalized);
    expect(validate(normalized)).toEqual(normalized);
    expect(normalized).toMatchObject({
      harnesses: 'codex,grok',
      providers: '',
      search: '{"x": 1}',
      page: 3,
      expanded: true,
      chart: 'line',
    });
  });
});
