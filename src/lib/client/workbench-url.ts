import type { StandardSchemaV1 } from 'runed/kit';
import type { UsageQuery } from '../shared/domain';
import { sessionSortKeys } from '../shared/session-sort';
import { dashboardRanges, decodeFilter } from './dashboard-url';
import { groups, type Group } from './usage-workbench';

const literal = <const Value extends string>(value: unknown, values: readonly Value[], fallback: Value) =>
  values.find((entry) => entry === value) ?? fallback;
const text = (value: unknown) => (typeof value === 'string' ? value : '');

// Every workbench control lives in the URL. Defaults are omitted, so `/` is
// the unfiltered overview and Back walks through scope changes.
// Filters stay encoded strings ('' = all, 'none' = nothing) so links round-trip exactly.
// An empty range follows this browser's saved default.
const validate = (input: object) => {
  const field = (key: string) => (key in input ? Reflect.get(input, key) : undefined);
  const page = Number(field('page'));
  return {
    view: literal(field('view'), ['overview', 'compare'], 'overview'),
    range: literal(
      field('range'),
      dashboardRanges.map((r) => r.value),
      '',
    ),
    split: literal(field('split'), groups, 'models'),
    // Links from the previous dashboard named the split `chartBy` or `breakdown`.
    chartBy: literal(field('chartBy'), groups, ''),
    breakdown: literal(field('breakdown'), groups, ''),
    metric: literal(field('metric'), ['tokens', 'cost'], 'tokens'),
    chart: literal(field('chart'), ['bar', 'line'], 'bar'),
    scale: literal(field('scale'), ['shared', 'series'], 'shared'),
    sort: literal(field('sort'), sessionSortKeys, 'active'),
    order: literal(field('order'), ['asc', 'desc'], 'desc'),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    devices: text(field('devices')),
    models: text(field('models')),
    projects: text(field('projects')),
    providers: text(field('providers')),
    harnesses: text(field('harnesses')),
    excludedProjects: text(field('excludedProjects')),
  };
};
export type WorkbenchParams = ReturnType<typeof validate>;

export const workbenchUrlSchema: StandardSchemaV1<unknown, WorkbenchParams> = {
  '~standard': {
    version: 1,
    vendor: 'token-tracker',
    validate: (input: unknown) =>
      typeof input !== 'object' || input === null || Array.isArray(input)
        ? { issues: [{ path: [], message: 'Expected object' }] }
        : { value: validate(input) },
  },
};

// An explicit `split` wins; otherwise honour a legacy key. Writing a split
// clears the legacy keys, so choosing the default later is not overridden.
export const splitOf = (params: Pick<WorkbenchParams, 'split' | 'chartBy' | 'breakdown'>, url: URLSearchParams) =>
  url.has('split') ? params.split : params.chartBy || params.breakdown || params.split;
export const splitTo = (split: Group) => ({ split, chartBy: '', breakdown: '' }) as const;

export const filtersOf = (params: Pick<WorkbenchParams, Group>) =>
  Object.fromEntries(
    groups.flatMap((g) => {
      const selected = decodeFilter(params[g]);
      return selected ? [[g, selected]] : [];
    }),
  ) as Pick<UsageQuery, Group>;

// Clicking into a series isolates it, then splits by the most useful remaining dimension.
const drillOrder = ['projects', 'models', 'devices', 'harnesses', 'providers'] as const satisfies readonly Group[];
export const nextSplit = (picked: Group, filters: Pick<UsageQuery, Group>, available: (g: Group) => number) =>
  drillOrder.find((g) => g !== picked && filters[g]?.length !== 1 && available(g) > 1) ?? picked;
