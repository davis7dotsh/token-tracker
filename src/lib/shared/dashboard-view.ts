import type {
  ChartSeries,
  DashboardBucketBreakdown,
  DashboardPage,
  DashboardResponse,
  DashboardView,
  Session,
  UsageQuery,
  ViewBucket,
  ViewDimension,
  ViewDimensions,
  ViewProjectLabel,
  ViewSeriesRow,
  ViewSession,
} from './domain';
import { projectLabel, projectLabels } from './project-label';

export const viewGroups = ['devices', 'models', 'projects', 'providers', 'harnesses'] as const;
export type ViewGroup = (typeof viewGroups)[number];
export const viewRankedLimit = 10;

export const roundCost = (value: number) =>
  !Number.isFinite(value) || value === 0
    ? 0
    : Math.abs(value) >= 0.001
      ? Math.round(value * 1e6) / 1e6
      : Number(value.toPrecision(6));

// Calendar dates are already in the query timezone. Jan 5, 1970 was a Monday.
const weekOf = (day: string) => Math.floor((Date.parse(day) / 86_400_000 - 4) / 7);

type BucketSeriesTotals = { tokens: number; costUSD: number; unpricedTokens: number };
export type GroupedBucket = {
  key: string;
  end?: string;
  tokens: number;
  costUSD: number;
  unpricedTokens: number;
  rows: Record<ViewGroup, Map<string, BucketSeriesTotals>>;
};

export const groupDashboardBuckets = (data: DashboardResponse): GroupedBucket[] => {
  const byHour = data.range === 'today';
  const byWeek = data.range === '90d' || data.range === '6m';
  const source = byHour ? data.hourly : data.daily;
  const buckets: GroupedBucket[] = [];
  for (let i = 0; i < source.length;) {
    const first = source[i];
    let end = i + 1;
    if (byWeek) {
      const week = weekOf(data.daily[i].date);
      while (end < source.length && weekOf(data.daily[end].date) === week) end++;
    }
    const last = source[end - 1];
    const key = 'start' in first ? first.start : first.date;
    const endKey = 'end' in last ? last.end : byWeek && first !== last && 'date' in last ? last.date : undefined;
    const rows: Record<ViewGroup, Map<string, BucketSeriesTotals>> = {
      devices: new Map(),
      models: new Map(),
      projects: new Map(),
      providers: new Map(),
      harnesses: new Map(),
    };
    let tokens = 0;
    let costUSD = 0;
    let unpricedTokens = 0;
    for (; i < end; i++) {
      const entry = source[i];
      tokens += entry.tokens;
      costUSD += entry.costUSD;
      for (const harness of entry.harnesses) unpricedTokens += harness.unpricedTokens;
      for (const group of viewGroups) {
        const items = entry[group];
        if (!items) continue;
        const map = rows[group];
        for (const item of items) {
          const current = map.get(item.name);
          if (current) {
            current.tokens += item.tokens;
            current.costUSD += item.costUSD;
            current.unpricedTokens += item.unpricedTokens ?? 0;
          } else {
            map.set(item.name, {
              tokens: item.tokens,
              costUSD: item.costUSD,
              unpricedTokens: item.unpricedTokens ?? 0,
            });
          }
        }
      }
    }
    buckets.push({ key, ...(endKey ? { end: endKey } : {}), tokens, costUSD, unpricedTokens, rows });
  }
  return buckets;
};

const selectRankedItems = <T extends Pick<ChartSeries, 'name' | 'tokens' | 'costUSD' | 'unpricedTokens'>>(
  group: ViewGroup,
  items: readonly T[],
) => {
  const byTokens = [...items].sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
  if (group === 'providers' || group === 'harnesses' || byTokens.length <= viewRankedLimit) return byTokens;
  const byCost = [...items]
    .sort((left, right) => roundCost(right.costUSD) - roundCost(left.costUSD) || left.name.localeCompare(right.name))
    .slice(0, viewRankedLimit);
  const kept = new Set(byTokens.slice(0, viewRankedLimit).map((item) => item.name));
  for (const item of byCost) kept.add(item.name);
  return byTokens.filter((item) => kept.has(item.name));
};

const toSeriesRow = (
  item: Pick<ChartSeries, 'name' | 'tokens' | 'costUSD' | 'unpricedTokens'>,
  buckets: readonly GroupedBucket[],
  group: ViewGroup,
  includeSeries: boolean,
): ViewSeriesRow => {
  const unpriced = item.unpricedTokens ?? 0;
  if (!includeSeries) {
    return {
      name: item.name,
      tokens: item.tokens,
      costUSD: roundCost(item.costUSD),
      ...(unpriced > 0 ? { unpricedTokens: unpriced } : {}),
    };
  }
  const t: number[] = [];
  const c: number[] = [];
  let hasUnpriced = false;
  const u: number[] = [];
  for (const bucket of buckets) {
    const cell = bucket.rows[group].get(item.name);
    const cellTokens = cell?.tokens ?? 0;
    const cellCost = cell ? roundCost(cell.costUSD) : 0;
    const cellUnpriced = cell?.unpricedTokens ?? 0;
    t.push(cellTokens);
    c.push(cellCost);
    u.push(cellUnpriced);
    if (cellUnpriced > 0) hasUnpriced = true;
  }
  return {
    name: item.name,
    tokens: item.tokens,
    costUSD: roundCost(item.costUSD),
    ...(unpriced > 0 ? { unpricedTokens: unpriced } : {}),
    t,
    c,
    ...(hasUnpriced ? { u } : {}),
  };
};

export const projectProjectLabels = (
  keys: Iterable<string>,
  resolvedLabels: ReadonlyMap<string, string>,
): ViewProjectLabel[] => {
  const seen = new Set<string>();
  const overrides: ViewProjectLabel[] = [];
  for (const key of keys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = resolvedLabels.get(key);
    if (label && label !== projectLabel(key)) overrides.push({ key, label });
  }
  return overrides;
};

export const projectViewSession = (session: Session, knownModels: ReadonlySet<string>): ViewSession => ({
  ...(session.sessionTitle !== undefined ? { sessionTitle: session.sessionTitle } : {}),
  ...(session.projectName !== undefined ? { projectName: session.projectName } : {}),
  ...(session.t3ThreadId !== undefined ? { t3ThreadId: session.t3ThreadId } : {}),
  ...(session.t3ThreadUrl !== undefined ? { t3ThreadUrl: session.t3ThreadUrl } : {}),
  id: session.id,
  harness: session.harness,
  model: session.model,
  ...(!knownModels.has(session.model) ? { multiModel: true } : {}),
  project: session.repository ?? session.project,
  deviceId: session.deviceId,
  startedAt: session.startedAt,
  lastActiveAt: session.lastActiveAt,
  tokens: session.tokens,
  costUSD: roundCost(session.costUSD),
  ...(session.unpricedTokens > 0 ? { unpricedTokens: session.unpricedTokens } : {}),
});

export type ProjectedViewBase = {
  readonly machine: string;
  readonly timezone: string;
  readonly range: DashboardView['range'];
  readonly period: DashboardView['period'];
  readonly totals: DashboardView['totals'];
  readonly previous: DashboardView['previous'];
  readonly buckets: readonly ViewBucket[];
  readonly breakdown: ViewDimensions;
  readonly filterCounts: DashboardView['filterCounts'];
  readonly groupedBuckets: readonly GroupedBucket[];
  readonly knownModels: ReadonlySet<string>;
  readonly visibleProjects: readonly string[];
};

export const projectViewBase = (dashboard: DashboardResponse): ProjectedViewBase => {
  const groupedBuckets = groupDashboardBuckets(dashboard);
  const buckets: ViewBucket[] = groupedBuckets.map((bucket) => ({
    key: bucket.key,
    ...(bucket.end ? { end: bucket.end } : {}),
    tokens: bucket.tokens,
    costUSD: roundCost(bucket.costUSD),
    ...(bucket.unpricedTokens > 0 ? { unpricedTokens: bucket.unpricedTokens } : {}),
  }));
  const buildDimension = (group: ViewGroup): ViewDimension => {
    const items = dashboard[group];
    const selected = selectRankedItems(group, items);
    return {
      totalCount: items.length,
      rows: selected.map((item) => toSeriesRow(item, groupedBuckets, group, true)),
    };
  };
  const breakdown: ViewDimensions = {
    devices: buildDimension('devices'),
    models: buildDimension('models'),
    projects: buildDimension('projects'),
    providers: buildDimension('providers'),
    harnesses: buildDimension('harnesses'),
  };
  return {
    machine: dashboard.machine,
    timezone: dashboard.timezone,
    range: dashboard.range,
    period: dashboard.period,
    totals: {
      tokens: dashboard.totals.tokens,
      costUSD: roundCost(dashboard.totals.costUSD),
      unpricedTokens: dashboard.totals.unpricedTokens,
      sessions: dashboard.totals.sessions,
    },
    previous: dashboard.previous
      ? {
          tokens: dashboard.previous.tokens,
          costUSD: roundCost(dashboard.previous.costUSD),
          sessions: dashboard.previous.sessions,
        }
      : null,
    buckets,
    breakdown,
    filterCounts: {
      devices: dashboard.filters.devices.length,
      models: dashboard.filters.models.length,
      projects: dashboard.filters.projects.length,
      providers: dashboard.filters.providers.length,
      harnesses: dashboard.filters.harnesses.length,
    },
    groupedBuckets,
    knownModels: new Set(dashboard.filters.models),
    visibleProjects: breakdown.projects.rows.map((row) => row.name),
  };
};

export const projectBucketBreakdown = (
  groupedBuckets: readonly GroupedBucket[],
  bucketKey: string,
  viewRevision: string,
  resolvedLabels: ReadonlyMap<string, string>,
): DashboardBucketBreakdown | null => {
  const target = groupedBuckets.find((bucket) => bucket.key === bucketKey);
  if (!target) return null;
  const buildDimension = (group: ViewGroup): ViewDimension => {
    const items = [...target.rows[group].entries()].map(([name, values]) => ({ name, ...values }));
    const selected = selectRankedItems(group, items);
    const includeSparkline = group !== 'providers' && group !== 'harnesses';
    const hasOtherHistory = includeSparkline && items.length > viewRankedLimit;
    let otherT: number[] | undefined;
    let otherC: number[] | undefined;
    if (hasOtherHistory) {
      const tokenTail = [...items]
        .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name))
        .slice(viewRankedLimit);
      const costTail = [...items]
        .sort(
          (left, right) => roundCost(right.costUSD) - roundCost(left.costUSD) || left.name.localeCompare(right.name),
        )
        .slice(viewRankedLimit);
      otherT = groupedBuckets.map((bucket) =>
        tokenTail.reduce((sum, item) => sum + (bucket.rows[group].get(item.name)?.tokens ?? 0), 0),
      );
      otherC = groupedBuckets.map((bucket) =>
        roundCost(costTail.reduce((sum, item) => sum + (bucket.rows[group].get(item.name)?.costUSD ?? 0), 0)),
      );
    }
    return {
      totalCount: items.length,
      rows: selected.map((item) => toSeriesRow(item, groupedBuckets, group, includeSparkline)),
      ...(otherT ? { otherT } : {}),
      ...(otherC ? { otherC } : {}),
    };
  };
  const breakdown: ViewDimensions = {
    devices: buildDimension('devices'),
    models: buildDimension('models'),
    projects: buildDimension('projects'),
    providers: buildDimension('providers'),
    harnesses: buildDimension('harnesses'),
  };
  return {
    key: target.key,
    viewRevision,
    breakdown,
    projectLabels: projectProjectLabels(
      breakdown.projects.rows.map((row) => row.name),
      resolvedLabels,
    ),
  };
};

export const legacyViewRevision = (page: Pick<DashboardPage, 'viewRevision' | 'generatedAt'>) =>
  page.viewRevision || `legacy:${page.generatedAt}`;

// Fallback adapter when a newer browser talks to an older hub that only exposes GetUsagePage.
export const projectDashboardViewFromPage = (
  page: DashboardPage,
  query: UsageQuery,
  bucket?: string,
): DashboardView => {
  const resolvedLabels = projectLabels(page.filters.projects);
  const base = projectViewBase(page);
  const viewRevision = legacyViewRevision(page);
  const selectedBucket = bucket
    ? (projectBucketBreakdown(base.groupedBuckets, bucket, viewRevision, resolvedLabels) ?? undefined)
    : undefined;
  const sessions = page.sessions.map((session) => projectViewSession(session, base.knownModels));
  const labelKeys = [...base.visibleProjects, ...sessions.map((session) => session.project), ...(query.projects ?? [])];
  return {
    machine: base.machine,
    generatedAt: page.generatedAt,
    timezone: base.timezone,
    range: base.range,
    period: base.period,
    totals: base.totals,
    previous: base.previous,
    buckets: [...base.buckets],
    breakdown: base.breakdown,
    filterCounts: base.filterCounts,
    filterRevision: viewRevision,
    projectLabels: projectProjectLabels(labelKeys, resolvedLabels),
    ...(selectedBucket ? { selectedBucket } : {}),
    sessions,
    sessionCount: page.sessionCount,
    sessionOffset: page.sessionOffset,
    viewRevision,
  };
};
