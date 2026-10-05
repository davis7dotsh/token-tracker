import { Effect, Option, Schema } from 'effect';
import type { UsageQuery } from '../shared/domain';

export const filterKeys = ['harnesses', 'providers', 'models', 'devices', 'projects'] as const;
export const breakdownGroups = ['harnesses', 'models', 'providers', 'devices', 'projects'] as const;
export const chartGroups = ['harnesses', 'providers', 'models'] as const;

const defaulted = <Value extends string | number | boolean>(schema: Schema.Codec<Value>, value: Value) =>
  schema.pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(value))),
    Schema.withDecodingDefaultKey(Effect.succeed(value)),
  );

export const DashboardUrlState = Schema.Struct({
  range: defaulted(Schema.Literals(['6m', '30d', '7d', 'today']), '30d'),
  harnesses: defaulted(Schema.String, ''),
  providers: defaulted(Schema.String, ''),
  models: defaulted(Schema.String, ''),
  devices: defaulted(Schema.String, ''),
  projects: defaulted(Schema.String, ''),
  metric: defaulted(Schema.Literals(['tokens', 'cost']), 'tokens'),
  chart: defaulted(Schema.Literals(['bar', 'line']), 'bar'),
  breakdown: defaulted(Schema.Literals(breakdownGroups), 'harnesses'),
  chartBy: defaulted(Schema.Literals(chartGroups), 'harnesses'),
  expanded: defaulted(Schema.Boolean, false),
  search: defaulted(Schema.String, ''),
  sort: defaulted(Schema.Literals(['tokens', 'lastActiveAt']), 'lastActiveAt'),
  page: defaulted(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
    1,
  ),
});
export const dashboardUrlSchema = Schema.toStandardSchemaV1(DashboardUrlState);

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

export const usageQueryFromParams = (params: typeof DashboardUrlState.Type, timezone: string) =>
  ({
    range: params.range,
    timezone,
    harnesses: decodeFilter(params.harnesses),
    providers: decodeFilter(params.providers),
    models: decodeFilter(params.models),
    devices: decodeFilter(params.devices),
    projects: decodeFilter(params.projects),
  }) satisfies UsageQuery;

export const normalizedDashboardParams = (params: typeof DashboardUrlState.Type) => ({
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
