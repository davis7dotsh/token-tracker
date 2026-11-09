import type { ChartSeries, DashboardResponse, UsageQuery } from '../shared/domain';
import { dashboardRanges, decodeFilter, encodeFilter, type DashboardRange } from './dashboard-url';

export const groups = ['devices', 'models', 'projects', 'providers', 'harnesses'] as const;
export type Group = (typeof groups)[number];
export type Metric = 'tokens' | 'costUSD';
export const groupNames = {
  devices: 'Device',
  models: 'Model',
  projects: 'Project',
  providers: 'Provider',
  harnesses: 'Harness',
};
export type Picked = { group: Group; name: string; bucket?: number };
export const splitFrom = (v: string | null) => groups.find((g) => g === v) ?? 'models';
export const rangeFrom = (v: string | null, fallback: DashboardRange) =>
  dashboardRanges.find((r) => r.value === v)?.value ?? fallback;
export const filtersFrom = (p: URLSearchParams) =>
  Object.fromEntries(
    groups.flatMap((k) => {
      const selected = decodeFilter(p.get(k) ?? '');
      return selected ? [[k, selected]] : [];
    }),
  ) as Pick<UsageQuery, Group>;
export function setSelection(p: URLSearchParams, group: Group, names: readonly string[] | undefined) {
  if (names === undefined) p.delete(group);
  else p.set(group, encodeFilter(names));
}
const short = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export const formatValue = (n: number, metric: Metric) => (metric === 'tokens' ? short.format(n) : usd.format(n));
export const axisValue = (n: number, metric: Metric) => (metric === 'costUSD' ? '$' : '') + short.format(n);
export const valueOf = (x: Pick<ChartSeries, 'tokens' | 'costUSD' | 'unpricedTokens'>, metric: Metric) =>
  metric === 'costUSD' && x.tokens > 0 && (x.unpricedTokens ?? 0) >= x.tokens
    ? 'Unpriced'
    : formatValue(x[metric], metric);
const calendar = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const dayLabel = (day: string) => calendar.format(new Date(day.slice(0, 10) + 'T12:00:00Z'));
export const periodOf = (d: DashboardResponse) =>
  d.period.start === d.period.end
    ? dayLabel(d.period.start)
    : `${dayLabel(d.period.start)} – ${dayLabel(d.period.end)}`;
function buildBuckets(data: DashboardResponse, group: Group) {
  const byHour = data.range === 'today';
  const hour = byHour
    ? new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: data.timezone,
        ...(data.hourly.length > 24 ? { timeZoneName: 'shortOffset' } : {}),
      })
    : undefined;
  const source = byHour ? data.hourly : data.daily;
  const size = data.range === '6m' ? 6 : 1;
  const buckets = [];
  for (let i = 0; i < source.length; i += size) {
    const span = source.slice(i, i + size);
    const rows = new Map<string, { tokens: number; costUSD: number; unpricedTokens: number }>();
    let tokens = 0,
      costUSD = 0,
      unpricedTokens = 0;
    for (const b of span) {
      tokens += b.tokens;
      costUSD += b.costUSD;
      for (const r of b[group] ?? []) {
        const x = rows.get(r.name) ?? { tokens: 0, costUSD: 0, unpricedTokens: 0 };
        x.tokens += r.tokens;
        x.costUSD += r.costUSD;
        x.unpricedTokens += r.unpricedTokens ?? 0;
        unpricedTokens += r.unpricedTokens ?? 0;
        rows.set(r.name, x);
      }
    }
    const first = span[0],
      last = span[span.length - 1];
    const label = 'start' in first ? hour!.format(new Date(first.start)) : dayLabel(first.date);
    buckets.push({
      label: span.length > 1 && 'date' in last ? `${label} – ${dayLabel(last.date)}` : label,
      short: label,
      rows,
      tokens,
      costUSD,
      unpricedTokens,
    });
  }
  return buckets;
}
// A response is immutable; metric, scale, view and inspector changes reuse the
// same series buckets. Evicting the response also releases its derived charts.
const byResponse = new WeakMap<DashboardResponse, Map<Group, ReturnType<typeof buildBuckets>>>();
export function timeBuckets(data: DashboardResponse, group: Group) {
  let byGroup = byResponse.get(data);
  if (!byGroup) byResponse.set(data, (byGroup = new Map()));
  let buckets = byGroup.get(group);
  if (!buckets) byGroup.set(group, (buckets = buildBuckets(data, group)));
  return buckets;
}
export function nicePeak(value: number) {
  if (value <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(value / 4));
  return 4 * p * ([1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((x) => x >= value / (4 * p)) ?? 10);
}
