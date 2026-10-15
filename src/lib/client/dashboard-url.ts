import type { StandardSchemaV1 } from 'runed/kit';
import type { UsageQuery } from '../shared/domain';

export const filterKeys = ['harnesses', 'providers', 'models', 'devices', 'projects'] as const;
export const breakdownGroups = ['harnesses', 'models', 'providers', 'devices', 'projects'] as const;
export const chartGroups = ['harnesses', 'providers', 'models'] as const;
const rangeValues = ['6m', '30d', '7d', 'today'] as const;
export type DashboardRange = (typeof rangeValues)[number];
export const dashboardRanges = [
  { value: '6m', label: '6 months' },
  { value: '30d', label: '1 month' },
  { value: '7d', label: '1 week' },
  { value: 'today', label: '1 day' },
] as const satisfies readonly { value: DashboardRange; label: string }[];

const literal = <const Value extends string>(value: unknown, values: readonly Value[], fallback: Value) =>
  values.find((entry) => entry === value) ?? fallback;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const validateDashboardParams = (input: unknown, range: DashboardRange = '30d') => {
  const value = typeof input === 'object' && input !== null ? input : {};
  const field = (key: string) => (key in value ? Reflect.get(value, key) : undefined);
  const page = field('page');
  return {
    range: literal(field('range'), rangeValues, range),
    harnesses: text(field('harnesses')),
    providers: text(field('providers')),
    models: text(field('models')),
    devices: text(field('devices')),
    projects: text(field('projects')),
    metric: literal(field('metric'), ['tokens', 'cost'], 'tokens'),
    chart: literal(field('chart'), ['bar', 'line'], 'bar'),
    breakdown: literal(field('breakdown'), breakdownGroups, 'harnesses'),
    chartBy: literal(field('chartBy'), chartGroups, 'harnesses'),
    expanded: field('expanded') === true,
    search: text(field('search')),
    sort: literal(field('sort'), ['tokens', 'lastActiveAt'], 'lastActiveAt'),
    page: typeof page === 'number' && Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
};
type DashboardUrlState = ReturnType<typeof validateDashboardParams>;

// Runed only needs Standard Schema's synchronous validation interface. Keep
// URL parsing independent of the server's Effect schema/runtime bundle.
// Its defaults are omitted from the URL, so the browser's chosen default must
// be used by the schema while other selections stay explicit in shared links.
export const dashboardUrlSchemaFor = (range: DashboardRange): StandardSchemaV1<unknown, DashboardUrlState> => ({
  '~standard': {
    version: 1 as const,
    vendor: 'token-tracker',
    validate: (input: unknown) =>
      typeof input !== 'object' || input === null || Array.isArray(input)
        ? { issues: [{ path: [], message: 'Expected object' }] }
        : { value: validateDashboardParams(input, range) },
  },
});
export const dashboardUrlSchema = dashboardUrlSchemaFor('30d');

const defaultRangeKey = 'token-tracker-default-range';
export const readDefaultRange = (): DashboardRange => {
  if (typeof window === 'undefined') return '30d';
  try {
    const stored = localStorage.getItem(defaultRangeKey);
    return rangeValues.find((range) => range === stored) ?? '30d';
  } catch {
    return '30d';
  }
};
export const saveDefaultRange = (range: DashboardRange) => {
  try {
    localStorage.setItem(defaultRangeKey, range);
  } catch {
    /* The dashboard keeps its built-in default. */
  }
};

export const decodeFilter = (value: string) => {
  if (value === '') return undefined;
  if (value === 'none') return [];
  if (value.startsWith('[')) {
    try {
      const decoded: unknown = JSON.parse(value);
      if (!Array.isArray(decoded) || !decoded.every((item) => typeof item === 'string')) return undefined;
      return [...new Set(decoded)];
    } catch {
      return undefined;
    }
  }
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
};

export const encodeFilter = (values: readonly string[] | undefined) => {
  if (values === undefined) return '';
  if (!values.length) return 'none';
  const unique = [...new Set(values)];
  return unique.some(
    (value) =>
      value === '' || value.includes(',') || value === 'none' || value.startsWith('[') || value !== value.trim(),
  )
    ? JSON.stringify(unique)
    : unique.join(',');
};

export const usageQueryFromParams = (params: DashboardUrlState, timezone: string) =>
  ({
    range: params.range,
    timezone,
    harnesses: decodeFilter(params.harnesses),
    providers: decodeFilter(params.providers),
    models: decodeFilter(params.models),
    devices: decodeFilter(params.devices),
    projects: decodeFilter(params.projects),
  }) satisfies UsageQuery;

export const normalizedDashboardParams = (params: DashboardUrlState) => ({
  range: params.range,
  harnesses: encodeFilter(decodeFilter(params.harnesses)),
  providers: encodeFilter(decodeFilter(params.providers)),
  models: encodeFilter(decodeFilter(params.models)),
  devices: encodeFilter(decodeFilter(params.devices)),
  projects: encodeFilter(decodeFilter(params.projects)),
  metric: params.metric,
  chart: params.chart,
  breakdown: params.breakdown,
  chartBy: params.chartBy,
  expanded: params.expanded,
  search: params.search,
  sort: params.sort,
  page: params.page,
});
