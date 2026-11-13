import type { ChartSeries, DashboardResponse } from '../shared/domain';
import { dashboardRanges, type DashboardRange } from './dashboard-url';

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
export const rangeFrom = (v: string | null, fallback: DashboardRange) =>
  dashboardRanges.find((r) => r.value === v)?.value ?? fallback;
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
export const deltaOf = (current: number, previous: number | undefined) => {
  if (previous === undefined) return undefined;
  const direction = current > previous ? ('up' as const) : current < previous ? ('down' as const) : ('flat' as const);
  const text =
    previous > 0 ? `${Math.round((100 * Math.abs(current - previous)) / previous)}%` : current > 0 ? 'new' : '0%';
  return { text, direction };
};

// Calendar dates are already in the query timezone. Jan 5, 1970 was a Monday.
const weekOf = (day: string) => Math.floor((Date.parse(day) / 86_400_000 - 4) / 7);
function buildBuckets(data: DashboardResponse, group: Group) {
  const byHour = data.range === 'today';
  const byWeek = data.range === '90d' || data.range === '6m';
  const hour = byHour
    ? new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: data.timezone,
        ...(data.hourly.length > 24 ? { timeZoneName: 'shortOffset' } : {}),
      })
    : undefined;
  const source = byHour ? data.hourly : data.daily;
  const now = Date.parse(data.generatedAt);
  const buckets = [];
  for (let i = 0; i < source.length;) {
    const first = source[i];
    let end = i + 1;
    if (byWeek) {
      const week = weekOf(data.daily[i].date);
      while (end < source.length && weekOf(data.daily[end].date) === week) end++;
    }
    const last = source[end - 1];
    const key = 'start' in first ? first.start : first.date;
    const short = hour ? hour.format(new Date(key)) : dayLabel(key);
    const rows = new Map<string, { tokens: number; costUSD: number; unpricedTokens: number }>();
    let tokens = 0,
      costUSD = 0,
      unpricedTokens = 0,
      hasHistory = true;
    for (; i < end; i++) {
      const b = source[i];
      tokens += b.tokens;
      costUSD += b.costUSD;
      // Harness history is mandatory, even on older hubs lacking another dimension.
      for (const h of b.harnesses) unpricedTokens += h.unpricedTokens;
      if (!b[group]) hasHistory = false;
      for (const r of b[group] ?? []) {
        const x = rows.get(r.name) ?? { tokens: 0, costUSD: 0, unpricedTokens: 0 };
        x.tokens += r.tokens;
        x.costUSD += r.costUSD;
        x.unpricedTokens += r.unpricedTokens ?? 0;
        rows.set(r.name, x);
      }
    }
    buckets.push({
      key,
      short,
      label: byWeek && first !== last && 'date' in last ? `${short} – ${dayLabel(last.date)}` : short,
      partial:
        'start' in first
          ? Date.parse(first.start) <= now && now < Date.parse(first.end)
          : 'date' in last && last.date === data.period.end,
      rows,
      tokens,
      costUSD,
      unpricedTokens,
      hasHistory,
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

// Only duplicate device labels need an ID; keep the suffix short but unique even for similar IDs.
export function deviceSuffixes(devices: readonly { name: string }[], label: (g: Group, id: string) => string) {
  const byLabel = new Map<string, Set<string>>();
  for (const { name } of devices) {
    const text = label('devices', name);
    const ids = byLabel.get(text);
    if (ids) ids.add(name);
    else byLabel.set(text, new Set([name]));
  }
  const suffixes = new Map<string, string>();
  for (const unique of byLabel.values()) {
    if (unique.size < 2) continue;
    const ids = [...unique];
    let length = 4;
    while (new Set(ids.map((id) => id.slice(-length))).size < ids.length) length++;
    for (const id of ids) suffixes.set(id, id.slice(-length));
  }
  return suffixes;
}

// An unknown URL key is the range view, not an empty bucket. From the range,
// previous enters at the last bucket and next enters at the first.
export function bucketSelection<T extends { key: string }>(buckets: readonly T[], key: string | undefined) {
  const index = buckets.findIndex((b) => b.key === key);
  return {
    index,
    bucket: index < 0 ? undefined : buckets[index],
    previous: buckets[index < 0 ? buckets.length - 1 : index - 1]?.key,
    next: buckets[index + 1]?.key,
  };
}
