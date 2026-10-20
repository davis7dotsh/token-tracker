// Standalone read-only JSON API over a ClickHouse usage database, for feeling
// out how agents and dashboards would query a hosted ClickHouse product.
// Needs `bun run ch:up` (and the bench dataset) first.
//   bun scripts/clickhouse-api.ts
import {
  makeClickHouseClient,
  text,
  type ClickHouseClient,
  type ClickHouseConfig,
  type ClickHouseParam,
  type ClickHouseRow,
} from '../src/lib/server/rpc/clickhouse';
import {
  eventColumns,
  formatTimestamp,
  latestEvents,
  parseTimestamp,
  rowToEvent,
} from '../src/lib/server/rpc/clickhouse-schema';

// --- Errors as values ---------------------------------------------------------
type ApiError = { readonly status: number; readonly code: string; readonly message: string };
type Result<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: ApiError };
const ok = <A>(value: A) => ({ ok: true, value }) as const;
const fail = (status: number, code: string, message: string) =>
  ({ ok: false, error: { status, code, message } }) as const;
const badRequest = (message: string) => fail(400, 'bad_request', message);

type Payload = {
  readonly data: unknown;
  readonly rows: number;
  readonly query?: string;
  readonly truncated?: boolean;
  // Extra meta fields: pagination, resolved range, timezone.
  readonly meta?: Record<string, unknown>;
};

// --- Read-only SQL guard ------------------------------------------------------
const maxSqlLength = 10_000;
const mutating =
  /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|OPTIMIZE|ATTACH|DETACH|RENAME|KILL|GRANT|REVOKE|USE|SET)\b|\bSYSTEM\b(?!\s*\.)|\bINTO\s+OUTFILE\b/i;
// Table functions that reach outside the database (files, URLs, other servers).
const external =
  /\b(url|file|s3|s3Cluster|remote|remoteSecure|cluster|executable|mysql|postgresql|jdbc|odbc|hdfs)\s*\(/i;

// Conservative by design: keywords and semicolons are rejected even inside
// string literals. `system.<table>` reads stay allowed.
export const checkReadOnlySql = (input: unknown): Result<string> => {
  if (typeof input !== 'string' || !input.trim()) return badRequest('Body field "query" must be a non-empty string.');
  if (input.length > maxSqlLength) return badRequest(`Query exceeds ${maxSqlLength} characters.`);
  const sql = input.trim().replace(/;\s*$/, '').trim();
  if (!/^(SELECT|WITH)\b/i.test(sql)) return badRequest('Query must start with SELECT or WITH.');
  if (sql.includes(';')) return badRequest('Only a single statement is allowed.');
  if (/\bFORMAT\s+[A-Za-z_]/i.test(sql)) return badRequest('Remove the FORMAT clause; the API always returns JSON.');
  const keyword = sql.match(mutating);
  if (keyword) return badRequest(`Read-only API: "${keyword[0].toUpperCase()}" is not allowed.`);
  const fn = sql.match(external);
  if (fn) return badRequest(`Table function ${fn[1]}() is not allowed.`);
  return ok(sql);
};

// --- Live view ----------------------------------------------------------------
// Raw usage_events holds every version and tombstone; this view is the
// canonical way to count from SQL. The API creates it on startup.
export const liveViewName = 'usage_events_live';
export const liveViewSql = (database: string) =>
  `CREATE OR REPLACE VIEW ${database}.${liveViewName} AS
  SELECT * FROM (${latestEvents(eventColumns)}) WHERE is_deleted = 0`;

// --- Numbers ------------------------------------------------------------------
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const ratio = (numerator: number, denominator: number, scale = 1) =>
  denominator ? round6((numerator / denominator) * scale) : null;

// JSONEachRow quotes 64-bit integers. Raw SQL cells that are plain numbers come
// back as numbers when a double holds them exactly; anything larger stays text.
const safeDecimalDigits = 15;
export const coerceCell = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(coerceCell);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, cell]) => [key, coerceCell(cell)]));
  if (typeof value !== 'string') return value;
  if (/^-?(0|[1-9]\d*)$/.test(value)) return Number.isSafeInteger(Number(value)) ? Number(value) : value;
  const digits = value.replace(/[-.]/g, '').replace(/^0+/, '');
  return /^-?(0|[1-9]\d*)\.\d+$/.test(value) && digits.length <= safeDecimalDigits ? Number(value) : value;
};

// --- Params -------------------------------------------------------------------
// Dynamic identifiers come only from these maps; user input is always a bound param.
const listFilters = ['device_id', 'harness', 'model', 'provider', 'project', 'repository', 'session_id'] as const;
const filterParams = ['from', 'to', 'range', ...listFilters, 'q'];
const dimensions = {
  harness: 'harness',
  provider: 'provider',
  model: 'model',
  device_id: 'device_id',
  project: 'project',
  repository: 'repository',
} as const;
const groupings = { none: null, ...dimensions } as const;
// Bucket starts in the requested zone, returned as UTC instants.
const buckets = {
  hour: 'toStartOfHour(timestamp, {tz:String})',
  day: 'toStartOfDay(timestamp, {tz:String})',
  week: 'toDateTime(toStartOfWeek(timestamp, 1, {tz:String}), {tz:String})',
  month: 'toDateTime(toStartOfMonth(timestamp, {tz:String}), {tz:String})',
} as const;
const breakdownSorts = { cost: 'costUsd DESC', tokens: 'tokens DESC', events: 'events DESC' } as const;
const ranges = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '180d': 180, all: 0 } as const;
const qColumns = ['project', "ifNull(repository, '')", 'session_id', "ifNull(session_title, '')"];
const maxOffset = 1_000_000_000;

const values = (url: URL, key: string) =>
  url.searchParams
    .getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

const choice = <M extends Record<string, unknown>>(url: URL, key: string, map: M, fallback: keyof M & string) => {
  const value = url.searchParams.get(key)?.trim() || fallback;
  const found = Object.keys(map).find((option): option is keyof M & string => option === value);
  return found ? ok(found) : badRequest(`Invalid ${key} "${value}". Valid values: ${Object.keys(map).join(', ')}.`);
};

const integer = (url: URL, key: string, min: number, max: number, fallback: number) => {
  const raw = url.searchParams.get(key)?.trim();
  if (!raw) return ok(fallback);
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? ok(value)
    : badRequest(`Invalid ${key} "${raw}". Use an integer from ${min} to ${max} (default ${fallback}).`);
};

type Page = { readonly limit: number; readonly offset: number };
const pageParams = (url: URL, max: number, fallback: number, prefix = ''): Result<Page> => {
  const limit = integer(url, `${prefix}limit`, 1, max, fallback);
  if (!limit.ok) return limit;
  const offset = integer(url, `${prefix}offset`, 0, maxOffset, 0);
  if (!offset.ok) return offset;
  return ok({ limit: limit.value, offset: offset.value });
};
const pageMeta = ({ limit, offset }: Page, returned: number, total: number) => ({
  total,
  hasMore: offset + returned < total,
  offset,
  limit,
});

const isoParam = (url: URL, key: string) => {
  const raw = url.searchParams.get(key)?.trim();
  if (!raw) return ok(undefined);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) && Number.isFinite(Date.parse(raw))
    ? ok(formatTimestamp(raw))
    : badRequest(`Invalid ${key} "${raw}". Use an ISO date or timestamp, e.g. 2026-10-01 or 2026-10-01T12:00:00Z.`);
};

// IANA names only; Intl canonicalizes case and rejects unknown zones.
const timeZone = (url: URL): Result<string> => {
  const raw = url.searchParams.get('tz')?.trim() || 'UTC';
  const invalid = badRequest(`Invalid tz "${raw}". Use an IANA time zone, e.g. UTC or America/Chicago.`);
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(raw)) return invalid;
  try {
    return ok(new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone);
  } catch {
    return invalid;
  }
};

// --- Filters ------------------------------------------------------------------
type Filter = {
  // Applied to raw rows; device_id is part of the dedupe key, so this is exact.
  readonly raw: string;
  // Applied to each record's latest version.
  readonly where: readonly string[];
  readonly columns: readonly string[];
  readonly params: Record<string, ClickHouseParam>;
  // The resolved window when `range` was used.
  readonly meta: Record<string, unknown>;
};
const everything: Filter = { raw: '1', where: [], columns: [], params: {}, meta: {} };

export const parseFilters = (url: URL, window?: { readonly from?: string; readonly to?: string }): Result<Filter> => {
  const from = window ? ok(window.from && formatTimestamp(window.from)) : isoParam(url, 'from');
  if (!from.ok) return from;
  const to = window ? ok(window.to && formatTimestamp(window.to)) : isoParam(url, 'to');
  if (!to.ok) return to;
  const lists = listFilters.map((key) => [key, values(url, key)] as const).filter(([, list]) => list.length);
  const q = url.searchParams.get('q')?.trim();
  const devices = lists.find(([key]) => key === 'device_id');
  const conditions = [
    ...(from.value ? ["timestamp >= {from:DateTime64(3, 'UTC')}"] : []),
    ...(to.value ? ["timestamp < {to:DateTime64(3, 'UTC')}"] : []),
    ...lists.filter(([key]) => key !== 'device_id').map(([key]) => `${key} IN {${key}:Array(String)}`),
    ...(q
      ? [`(${qColumns.map((column) => `positionCaseInsensitiveUTF8(${column}, {q:String}) > 0`).join(' OR ')})`]
      : []),
  ];
  const device = devices ? 'device_id IN {device_id:Array(String)}' : '1';
  return ok({
    // A record whose latest version matches has at least one raw version that
    // matches, so narrowing to those keys first is safe and lets the time
    // projection and bloom indexes skip most rows.
    raw: conditions.length
      ? `${device} AND (device_id, id) IN (SELECT device_id, id FROM usage_events WHERE ${device} AND ${conditions.join(' AND ')})`
      : device,
    where: conditions,
    columns: [
      ...(from.value || to.value ? ['timestamp'] : []),
      ...lists.map(([key]) => key).filter((key) => key !== 'device_id'),
      ...(q ? ['project', 'repository', 'session_id', 'session_title'] : []),
    ],
    params: {
      ...(from.value ? { from: from.value } : {}),
      ...(to.value ? { to: to.value } : {}),
      ...Object.fromEntries(lists),
      ...(q ? { q } : {}),
    },
    meta: {},
  });
};

// `range` ends at the newest stored event, so fixed datasets stay queryable.
const filtersFor = async ({ url, anchor }: Context): Promise<Result<Filter>> => {
  if (!url.searchParams.has('range')) return parseFilters(url);
  if (url.searchParams.has('from') || url.searchParams.has('to'))
    return badRequest('Use either range or from/to, not both.');
  const range = choice(url, 'range', ranges, 'all');
  if (!range.ok) return range;
  const days = ranges[range.value];
  if (!days) {
    const filter = parseFilters(url, {});
    return filter.ok ? ok({ ...filter.value, meta: { range: range.value, from: null, to: null } }) : filter;
  }
  const end = await anchor();
  if (!end.ok) return end;
  const from = new Date(end.value - days * 86_400_000).toISOString();
  const to = new Date(end.value + 1).toISOString();
  const filter = parseFilters(url, { from, to });
  return filter.ok ? ok({ ...filter.value, meta: { range: range.value, from, to } }) : filter;
};

// Latest live version of every matching record, with only the needed columns.
const live = (columns: readonly string[], filter: Filter) => {
  const needed = [...new Set([...columns, ...filter.columns, 'is_deleted'])].filter(
    (column) => column !== 'device_id' && column !== 'id',
  );
  return `SELECT * FROM (${latestEvents(needed, filter.raw)})
  WHERE ${['is_deleted = 0', ...filter.where].join(' AND ')}`;
};

// Narrows a filter to records whose versions match `condition` (a session page).
const within = (filter: Filter, condition: string, columns: readonly string[], params: Filter['params']) => ({
  ...filter,
  raw: `${filter.raw} AND (device_id, id) IN (SELECT device_id, id FROM usage_events WHERE ${condition})`,
  where: [...filter.where, condition],
  columns: [...filter.columns, ...columns],
  params: { ...filter.params, ...params },
});

// --- Aggregates ---------------------------------------------------------------
const tokenColumns = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
const tokenSum = tokenColumns.join(' + ');
const totalsColumns = [
  'timestamp',
  'session_id',
  ...tokenColumns,
  'reasoning_tokens',
  'requests',
  'cost_usd',
  'cost_known',
];
const totalsSelect = `count() AS events,
  uniqExact(device_id, session_id) AS sessions,
  sum(ifNull(requests, 1)) AS requests,
  sum(${tokenSum}) AS tokens,
  sum(input_tokens) AS inputTokens,
  sum(output_tokens) AS outputTokens,
  sum(cache_read_tokens) AS cacheReadTokens,
  sum(cache_write_tokens) AS cacheWriteTokens,
  sum(reasoning_tokens) AS reasoningTokens,
  sumIf(cost_usd, cost_known = 1) AS costUsd,
  sumIf(${tokenSum}, cost_known = 0) AS unpricedTokens`;
// Typed endpoints ask for unquoted 64-bit integers; the raw SQL endpoint does not.
const typed = `SETTINGS output_format_json_quote_64bit_integers = 0`;
const liveCountSql = `SELECT count() AS events FROM (${live([], everything)}) ${typed}`;

const iso = (value: unknown) => (text(value) ? parseTimestamp(text(value)) : null);
const totals = (row: ClickHouseRow | undefined) => {
  const field = (name: string) => Number(row?.[name] ?? 0);
  return {
    events: field('events'),
    sessions: field('sessions'),
    requests: field('requests'),
    tokens: field('tokens'),
    inputTokens: field('inputTokens'),
    outputTokens: field('outputTokens'),
    cacheReadTokens: field('cacheReadTokens'),
    cacheWriteTokens: field('cacheWriteTokens'),
    reasoningTokens: field('reasoningTokens'),
    costUsd: round6(field('costUsd')),
    unpricedTokens: field('unpricedTokens'),
  };
};
const summaryRow = (row: ClickHouseRow | undefined) => {
  const base = totals(row);
  return {
    ...base,
    devices: Number(row?.devices ?? 0),
    firstEventAt: base.events ? iso(row?.firstEventAt) : null,
    lastEventAt: base.events ? iso(row?.lastEventAt) : null,
    distinct: {
      projects: Number(row?.projects ?? 0),
      repositories: Number(row?.repositories ?? 0),
      models: Number(row?.models ?? 0),
    },
  };
};
// uniqExact skips NULL, so repositories counts known repositories only.
const summarySql = (filter: Filter) => `SELECT ${totalsSelect},
  uniqExact(device_id) AS devices, min(timestamp) AS firstEventAt, max(timestamp) AS lastEventAt,
  uniqExact(project) AS projects, uniqExact(repository) AS repositories, uniqExact(model) AS models
  FROM (${live([...totalsColumns, 'project', 'repository', 'model'], filter)}) ${typed}`;

// --- Handler ------------------------------------------------------------------
type QueryClient = Pick<ClickHouseClient, 'query'>;
type Run = (sql: string, params?: Record<string, ClickHouseParam>) => Promise<Result<ClickHouseRow[]>>;
type Context = {
  readonly url: URL;
  readonly path: string;
  readonly request: Request;
  readonly run: Run;
  readonly database: string;
  // Newest stored event time (ms), cached briefly per handler.
  readonly anchor: () => Promise<Result<number>>;
};
type Route = (context: Context) => Promise<Result<Payload>>;

const requestTimeoutMs = 15_000;

// Window totals ride along with each row. A page past the end has no rows to
// carry them, so it asks for the first row instead.
const pagedRows = async (
  run: Run,
  build: (limit: number, offset: number) => string,
  params: Filter['params'],
  { limit, offset }: Page,
) => {
  const rows = await run(build(limit, offset), params);
  if (!rows.ok || rows.value.length || !offset) return rows.ok ? ok({ rows: rows.value, head: rows.value[0] }) : rows;
  const probe = await run(build(1, 0), params);
  return probe.ok ? ok({ rows: rows.value, head: probe.value[0] }) : probe;
};

const concepts = {
  counting: `A record is (device_id, id). Every write appends a version; a record counts once, at its latest version, unless that version is a tombstone (is_deleted = 1). Typed endpoints count this way. For SQL, query the ${liveViewName} view, which applies the same rule. Raw usage_events double-counts versions and tombstones. FINAL only merges rows sharing the full sorting key (device_id, harness, timestamp, id), so it misses corrections that change timestamp; the view is the canonical path.`,
  tokens:
    'tokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens. reasoningTokens is reported separately and may overlap outputTokens; do not add it.',
  cost: 'costUsd sums known-cost events only, rounded to 6 decimals; unpricedTokens counts tokens without a known price.',
  derived:
    'Breakdown rows: costShare = costUsd / filtered total costUsd (0..1). costPerMillionTokens = costUsd / priced tokens * 1e6. costPerMillionOutputTokens = total costUsd (input and cache included) / priced output tokens * 1e6: a blended rate, not an output price. Null when the denominator is 0.',
  projects:
    'project is a per-device filesystem path, so one repo on two machines is two projects. Group by repository for cross-device totals (null when unknown).',
  requests:
    "events are usage records. requests sums each event's request count (1 when unrecorded), so a session's requests can exceed its events.",
  pagination:
    'List endpoints take limit and offset; meta.total is the full filtered count and meta.hasMore says whether another page exists. Session detail pages its events with events_limit/events_offset; include_events=false skips them.',
  time: 'from/to are ISO, [from, to), UTC unless the value has an offset. range=24h|7d|30d|90d|180d|all replaces from/to and ends at the newest stored event; meta shows the resolved window. Timeseries tz=<IANA zone> buckets in that zone (default UTC); bucketStart is always an ISO instant.',
  params: 'Unknown query parameters return 400 with the valid list. debug=1 adds the generated SQL to meta.',
  sql: 'POST /v1/sql cells: integer strings within ±2^53 and decimal strings up to 15 significant digits come back as numbers; larger values stay strings.',
};

const discovery: Route = async ({ database }) =>
  ok({
    data: {
      name: 'token-tracker ClickHouse API',
      database,
      filters:
        'from, to (ISO, [from, to)) or range, device_id, harness, model, provider, project, repository, session_id (comma-separated or repeated), q (case-insensitive contains over project/repository/session_id/session_title). Add debug=1 to see the generated SQL.',
      concepts,
      endpoints: endpoints.map(({ method, path, description, example, params }) => ({
        route: `${method} ${path}`,
        description,
        example,
        params,
      })),
    },
    rows: endpoints.length,
  });

const health: Route = async ({ run }) => {
  const [version, count] = await Promise.all([run('SELECT version() AS version'), run(liveCountSql)]);
  if (!version.ok) return version;
  if (!count.ok) return count;
  return ok({
    data: { ok: true, version: text(version.value[0]?.version), liveEvents: Number(count.value[0]?.events ?? 0) },
    rows: 1,
  });
};

const schema: Route = async ({ run, database }) => {
  const tables = ['usage_events', 'devices'];
  const [columns, info] = await Promise.all([
    run(
      `SELECT table, name, type, compression_codec AS codec FROM system.columns
      WHERE database = {database:String} AND table IN {tables:Array(String)} ORDER BY table, position`,
      { database, tables },
    ),
    run(
      `SELECT name, engine, partition_key, sorting_key, primary_key FROM system.tables
      WHERE database = {database:String} AND name IN {tables:Array(String)}`,
      { database, tables },
    ),
  ]);
  if (!columns.ok) return columns;
  if (!info.ok) return info;
  const data = info.value.map((table) => ({
    name: text(table.name),
    engine: text(table.engine),
    partitionKey: text(table.partition_key),
    sortingKey: text(table.sorting_key),
    primaryKey: text(table.primary_key),
    columns: columns.value
      .filter((column) => column.table === table.name)
      .map((column) => ({ name: text(column.name), type: text(column.type), codec: text(column.codec) || null })),
  }));
  return ok({ data, rows: data.length });
};

const storageStats = (row: ClickHouseRow) => {
  const compressed = Number(row.compressed);
  const uncompressed = Number(row.uncompressed);
  return {
    parts: Number(row.parts),
    rows: Number(row.rows),
    compressedBytes: compressed,
    uncompressedBytes: uncompressed,
    ratio: compressed ? Math.round((uncompressed / compressed) * 100) / 100 : null,
  };
};

const storage: Route = async ({ run, database }) => {
  const sums = `count() AS parts, sum(rows) AS rows, sum(data_compressed_bytes) AS compressed,
    sum(data_uncompressed_bytes) AS uncompressed`;
  const [tables, projections, count] = await Promise.all([
    run(
      `SELECT table, ${sums}, sum(bytes_on_disk) AS disk FROM system.parts
      WHERE database = {database:String} AND active GROUP BY table ORDER BY table ${typed}`,
      { database },
    ),
    run(
      `SELECT table, name, ${sums} FROM system.projection_parts
      WHERE database = {database:String} AND active GROUP BY table, name ORDER BY table, name ${typed}`,
      { database },
    ),
    run(liveCountSql),
  ]);
  if (!tables.ok) return tables;
  if (!projections.ok) return projections;
  if (!count.ok) return count;
  const data = tables.value.map((table) => {
    const own = projections.value.filter((projection) => projection.table === table.table);
    const base = storageStats(table);
    return {
      table: text(table.table),
      ...base,
      ...(table.table === 'usage_events'
        ? {
            liveEvents: Number(count.value[0]?.events ?? 0),
            note: `rows counts physical rows: superseded versions and tombstones until merges drop them. liveEvents counts the latest live version per (device_id, id), as ${liveViewName} does.`,
          }
        : {}),
      // Includes projection parts, which live inside the table's parts.
      bytesOnDisk: Number(table.disk),
      projections: own.map((projection) => ({ name: text(projection.name), ...storageStats(projection) })),
      totalCompressedBytes:
        base.compressedBytes + own.reduce((sum, projection) => sum + Number(projection.compressed), 0),
    };
  });
  return ok({ data, rows: data.length });
};

const summary: Route = async (context) => {
  const filter = await filtersFor(context);
  if (!filter.ok) return filter;
  const sql = summarySql(filter.value);
  const rows = await context.run(sql, filter.value.params);
  if (!rows.ok) return rows;
  return ok({ data: summaryRow(rows.value[0]), rows: 1, query: sql, meta: filter.value.meta });
};

const maxSeriesRows = 5_000;
const timeseries: Route = async (context) => {
  const { url, run } = context;
  const tz = timeZone(url);
  if (!tz.ok) return tz;
  const bucket = choice(url, 'bucket', buckets, 'day');
  if (!bucket.ok) return bucket;
  const groupBy = choice(url, 'group_by', groupings, 'none');
  if (!groupBy.ok) return groupBy;
  const filter = await filtersFor(context);
  if (!filter.ok) return filter;
  const group = groupings[groupBy.value];
  const sql = `SELECT toTimeZone(${buckets[bucket.value]}, 'UTC') AS bucketStart${group ? `, ${group} AS grp` : ''},
    count() AS events, sum(${tokenSum}) AS tokens, sumIf(cost_usd, cost_known = 1) AS costUsd,
    uniqExact(device_id, session_id) AS sessions
    FROM (${live(['timestamp', 'session_id', ...tokenColumns, 'cost_usd', 'cost_known', ...(group ? [group] : [])], filter.value)})
    GROUP BY bucketStart${group ? ', grp' : ''} ORDER BY bucketStart${group ? ', grp' : ''}
    LIMIT ${maxSeriesRows + 1} ${typed}`;
  const rows = await run(sql, { ...filter.value.params, tz: tz.value });
  if (!rows.ok) return rows;
  const data = rows.value.slice(0, maxSeriesRows).map((row) => ({
    bucketStart: iso(row.bucketStart),
    ...(group ? { group: row.grp ?? null } : {}),
    events: Number(row.events),
    tokens: Number(row.tokens),
    costUsd: round6(Number(row.costUsd)),
    sessions: Number(row.sessions),
  }));
  return ok({
    data,
    rows: data.length,
    query: sql,
    truncated: rows.value.length > maxSeriesRows,
    meta: { ...filter.value.meta, tz: tz.value, bucketStart: `ISO instant of each bucket's start in ${tz.value}` },
  });
};

const breakdown: Route = async (context) => {
  const { url, run } = context;
  const dimension = choice(url, 'dimension', dimensions, 'model');
  if (!dimension.ok) return dimension;
  const sort = choice(url, 'sort', breakdownSorts, 'cost');
  if (!sort.ok) return sort;
  const page = pageParams(url, 500, 20);
  if (!page.ok) return page;
  const filter = await filtersFor(context);
  if (!filter.ok) return filter;
  const column = dimensions[dimension.value];
  const build = (limit: number, offset: number) => `SELECT ${column} AS name, ${totalsSelect},
    sumIf(output_tokens, cost_known = 1) AS pricedOutputTokens,
    count() OVER () AS total, sum(costUsd) OVER () AS totalCostUsd
    FROM (${live([...totalsColumns, column], filter.value)})
    GROUP BY name ORDER BY ${breakdownSorts[sort.value]}, name LIMIT ${limit} OFFSET ${offset} ${typed}`;
  const result = await pagedRows(run, build, filter.value.params, page.value);
  if (!result.ok) return result;
  const totalCost = Number(result.value.head?.totalCostUsd ?? 0);
  const data = result.value.rows.map((row) => {
    const base = totals(row);
    const cost = Number(row.costUsd);
    return {
      name: row.name ?? null,
      ...base,
      costShare: ratio(cost, totalCost),
      costPerMillionTokens: ratio(cost, base.tokens - base.unpricedTokens, 1e6),
      costPerMillionOutputTokens: ratio(cost, Number(row.pricedOutputTokens), 1e6),
    };
  });
  return ok({
    data,
    rows: data.length,
    query: build(page.value.limit, page.value.offset),
    meta: { ...filter.value.meta, ...pageMeta(page.value, data.length, Number(result.value.head?.total ?? 0)) },
  });
};

// Ranking reads only the sort column; display columns are read for the page only.
const sessionRanks = {
  cost: {
    select: 'sumIf(cost_usd, cost_known = 1) AS costUsd',
    order: 'costUsd DESC',
    columns: ['cost_usd', 'cost_known'],
  },
  tokens: { select: `sum(${tokenSum}) AS tokens`, order: 'tokens DESC', columns: tokenColumns },
  last_active: { select: 'max(timestamp) AS lastActiveAt', order: 'lastActiveAt DESC', columns: ['timestamp'] },
} as const;
const sessionsSelect = `device_id AS deviceId, session_id AS sessionId,
  min(timestamp) AS startedAt, max(timestamp) AS lastActiveAt,
  count() AS events, sum(${tokenSum}) AS tokens, sumIf(cost_usd, cost_known = 1) AS costUsd,
  arraySort(groupUniqArray(harness)) AS harnesses, arraySort(groupUniqArray(model)) AS models,
  argMax(project, timestamp) AS project, argMax(repository, timestamp) AS repository,
  argMax(session_title, timestamp) AS sessionTitle`;
const sessionsColumns = [
  'timestamp',
  'session_id',
  ...tokenColumns,
  'cost_usd',
  'cost_known',
  'harness',
  'model',
  'project',
  'repository',
  'session_title',
];
const sessionKey = (deviceId: unknown, sessionId: unknown) => JSON.stringify([text(deviceId), text(sessionId)]);

const sessions: Route = async (context) => {
  const { url, run } = context;
  const sort = choice(url, 'sort', sessionRanks, 'last_active');
  if (!sort.ok) return sort;
  const page = pageParams(url, 200, 50);
  if (!page.ok) return page;
  const filter = await filtersFor(context);
  if (!filter.ok) return filter;
  const rank = sessionRanks[sort.value];
  const build = (limit: number, offset: number) => `SELECT device_id, session_id, ${rank.select},
    count() OVER () AS total
    FROM (${live(['session_id', ...rank.columns], filter.value)})
    GROUP BY device_id, session_id ORDER BY ${rank.order}, device_id, session_id
    LIMIT ${limit} OFFSET ${offset} ${typed}`;
  const rankSql = build(page.value.limit, page.value.offset);
  const ranked = await pagedRows(run, build, filter.value.params, page.value);
  if (!ranked.ok) return ranked;
  const keys = ranked.value.rows;
  const meta = { ...filter.value.meta, ...pageMeta(page.value, keys.length, Number(ranked.value.head?.total ?? 0)) };
  if (!keys.length) return ok({ data: [], rows: 0, query: rankSql, meta });
  const scoped = within(
    filter.value,
    'device_id IN {page_devices:Array(String)} AND session_id IN {page_sessions:Array(String)}',
    ['session_id'],
    {
      page_devices: [...new Set(keys.map((row) => text(row.device_id)))],
      page_sessions: [...new Set(keys.map((row) => text(row.session_id)))],
    },
  );
  const detailSql = `SELECT ${sessionsSelect} FROM (${live(sessionsColumns, scoped)})
    GROUP BY device_id, session_id ${typed}`;
  const details = await run(detailSql, scoped.params);
  if (!details.ok) return details;
  // The device × session cross product can match extra sessions; keep the page's.
  const byKey = new Map(details.value.map((row) => [sessionKey(row.deviceId, row.sessionId), row]));
  const data = keys.flatMap((key) => {
    const row = byKey.get(sessionKey(key.device_id, key.session_id));
    return row
      ? [
          {
            ...row,
            startedAt: iso(row.startedAt),
            lastActiveAt: iso(row.lastActiveAt),
            events: Number(row.events),
            tokens: Number(row.tokens),
            costUsd: round6(Number(row.costUsd)),
          },
        ]
      : [];
  });
  return ok({ data, rows: data.length, query: `${rankSql};\n${detailSql}`, meta });
};

const decodeEvents = (rows: readonly ClickHouseRow[]): Result<unknown[]> => {
  try {
    return ok(rows.map((row) => ({ ...rowToEvent(row), provider: text(row.provider) })));
  } catch (error) {
    return fail(502, 'decode_failed', error instanceof Error ? error.message : String(error));
  }
};

const flag = (url: URL, key: string, fallback: boolean): Result<boolean> => {
  const raw = url.searchParams.get(key)?.trim();
  if (!raw) return ok(fallback);
  if (['true', '1'].includes(raw)) return ok(true);
  if (['false', '0'].includes(raw)) return ok(false);
  return badRequest(`Invalid ${key} "${raw}". Use true or false.`);
};

const sessionDetail: Route = async ({ url, path, run }) => {
  const sessionId = decodeURIComponent(path.slice('/v1/sessions/'.length));
  const page = pageParams(url, 1_000, 1_000, 'events_');
  if (!page.ok) return page;
  const include = flag(url, 'include_events', true);
  if (!include.ok) return include;
  const scoped = new URL(url);
  scoped.search = '';
  scoped.searchParams.set('session_id', sessionId);
  for (const device of values(url, 'device_id')) scoped.searchParams.append('device_id', device);
  const filter = parseFilters(scoped);
  if (!filter.ok) return filter;
  const eventsSql = `${live(eventColumns, filter.value)} ORDER BY timestamp, device_id, id
    LIMIT ${page.value.limit} OFFSET ${page.value.offset}`;
  const [totalsRows, eventRows] = await Promise.all([
    run(summarySql(filter.value), filter.value.params),
    include.value ? run(eventsSql, filter.value.params) : Promise.resolve(ok([])),
  ]);
  if (!totalsRows.ok) return totalsRows;
  if (!eventRows.ok) return eventRows;
  const head = summaryRow(totalsRows.value[0]);
  if (!head.events) return fail(404, 'not_found', `No live events for session "${sessionId}".`);
  const events = decodeEvents(eventRows.value);
  if (!events.ok) return events;
  const paging = pageMeta(page.value, events.value.length, head.events);
  return ok({
    data: { summary: head, eventsTotal: head.events, ...(include.value ? { events: events.value } : {}) },
    rows: events.value.length,
    query: include.value ? eventsSql : undefined,
    ...(include.value ? { truncated: paging.hasMore, meta: paging } : { meta: { total: head.events } }),
  });
};

const events: Route = async (context) => {
  const { url, run } = context;
  const page = pageParams(url, 1_000, 100);
  if (!page.ok) return page;
  const order = choice(url, 'order', { desc: 'DESC', asc: 'ASC' }, 'desc');
  if (!order.ok) return order;
  const filter = await filtersFor(context);
  if (!filter.ok) return filter;
  const direction = order.value === 'asc' ? 'ASC' : 'DESC';
  const sort = `ORDER BY timestamp ${direction}, device_id ${direction}, id ${direction}`;
  // Pick the page's keys from a narrow dedupe, then read full rows for just
  // those keys: deduping every column across all records is the slow part.
  const keys = `SELECT device_id, id FROM (${live(['timestamp'], filter.value)}) ${sort}
    LIMIT ${page.value.limit} OFFSET ${page.value.offset}`;
  const sql = `SELECT * FROM (${latestEvents(eventColumns, `${filter.value.raw} AND (device_id, id) IN (${keys})`)})
    ${sort}`;
  const [rows, count] = await Promise.all([
    run(sql, filter.value.params),
    run(`SELECT count() AS total FROM (${live([], filter.value)}) ${typed}`, filter.value.params),
  ]);
  if (!rows.ok) return rows;
  if (!count.ok) return count;
  const data = decodeEvents(rows.value);
  if (!data.ok) return data;
  return ok({
    data: data.value,
    rows: data.value.length,
    query: sql,
    meta: { ...filter.value.meta, ...pageMeta(page.value, data.value.length, Number(count.value[0]?.total ?? 0)) },
  });
};

const devices: Route = async ({ run }) => {
  const [registered, counts] = await Promise.all([
    run(`SELECT id, name, platform, last_seen, revoked_at, pricing_updated_at FROM devices FINAL ORDER BY name`),
    run(
      `SELECT device_id, count() AS events, max(timestamp) AS lastEventAt
      FROM (${live(['timestamp'], everything)}) GROUP BY device_id ${typed}`,
    ),
  ]);
  if (!registered.ok) return registered;
  if (!counts.ok) return counts;
  const byDevice = new Map(counts.value.map((row) => [text(row.device_id), row]));
  const data = registered.value.map((device) => {
    const stats = byDevice.get(text(device.id));
    return {
      id: text(device.id),
      name: text(device.name),
      platform: text(device.platform),
      lastSeen: iso(device.last_seen),
      revokedAt: iso(device.revoked_at),
      pricingUpdatedAt: text(device.pricing_updated_at) || null,
      events: Number(stats?.events ?? 0),
      lastEventAt: iso(stats?.lastEventAt),
    };
  });
  return ok({ data, rows: data.length });
};

const maxSqlRows = 10_000;
const sql: Route = async ({ request, run }) => {
  const body: unknown = await request.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null)
    return badRequest('Body must be JSON: { "query": "SELECT ...", "limit"?: number }.');
  const checked = checkReadOnlySql('query' in body ? body.query : undefined);
  if (!checked.ok) return checked;
  const requested = 'limit' in body ? body.limit : undefined;
  const rowLimit = requested === undefined ? 1_000 : Number(requested);
  if (
    !Number.isInteger(rowLimit) ||
    typeof (requested ?? rowLimit) !== 'number' ||
    rowLimit < 1 ||
    rowLimit > maxSqlRows
  )
    return badRequest(`Invalid limit. Use an integer from 1 to ${maxSqlRows} (default 1000).`);
  // Newlines keep a trailing `--` comment from swallowing the wrapper; readonly
  // makes ClickHouse itself refuse writes and setting changes.
  const wrapped = `SELECT * FROM (\n${checked.value}\n) LIMIT ${rowLimit} SETTINGS readonly = 1`;
  const rows = await run(wrapped);
  if (!rows.ok) return rows;
  return ok({ data: rows.value.map(coerceCell), rows: rows.value.length, query: wrapped });
};

type Endpoint = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly pattern?: RegExp;
  readonly description: string;
  readonly example: string;
  // Accepted query parameters, besides debug.
  readonly params: readonly string[];
  readonly handler: Route;
};

const endpoints: readonly Endpoint[] = [
  { method: 'GET', path: '/', description: 'This document', example: '/', params: [], handler: discovery },
  {
    method: 'GET',
    path: '/health',
    description: 'ClickHouse version and live event count',
    example: '/health',
    params: [],
    handler: health,
  },
  {
    method: 'GET',
    path: '/v1/schema',
    description: 'usage_events and devices columns, codecs, engine, keys',
    example: '/v1/schema',
    params: [],
    handler: schema,
  },
  {
    method: 'GET',
    path: '/v1/storage',
    description: 'Physical rows, live events, and compressed/uncompressed bytes per table and projection',
    example: '/v1/storage',
    params: [],
    handler: storage,
  },
  {
    method: 'GET',
    path: '/v1/summary',
    description: 'Totals and distinct projects/repositories/models over filters',
    example: '/v1/summary?range=30d&harness=claude',
    params: filterParams,
    handler: summary,
  },
  {
    method: 'GET',
    path: '/v1/timeseries',
    description:
      'bucket=hour|day|week|month, group_by=none|harness|provider|model|device_id|project|repository, tz=<IANA zone>',
    example: '/v1/timeseries?bucket=day&group_by=harness&from=2026-10-01&tz=America/Chicago',
    params: [...filterParams, 'bucket', 'group_by', 'tz'],
    handler: timeseries,
  },
  {
    method: 'GET',
    path: '/v1/breakdown',
    description:
      'dimension=harness|provider|model|device_id|project|repository, sort=cost|tokens|events, limit<=500, offset',
    example: '/v1/breakdown?dimension=model&sort=cost&limit=10',
    params: [...filterParams, 'dimension', 'sort', 'limit', 'offset'],
    handler: breakdown,
  },
  {
    method: 'GET',
    path: '/v1/sessions',
    description: 'Sessions by (device_id, session_id), sort=cost|tokens|last_active, limit<=200, offset',
    example: '/v1/sessions?sort=cost&limit=20',
    params: [...filterParams, 'sort', 'limit', 'offset'],
    handler: sessions,
  },
  {
    method: 'GET',
    path: '/v1/sessions/:sessionId',
    pattern: /^\/v1\/sessions\/[^/]+$/,
    description:
      'One session: summary, eventsTotal, and its events (optional device_id, events_limit<=1000, events_offset, include_events=false)',
    example: '/v1/sessions/<session_id>?device_id=<device_id>',
    params: ['device_id', 'events_limit', 'events_offset', 'include_events'],
    handler: sessionDetail,
  },
  {
    method: 'GET',
    path: '/v1/events',
    description: 'Decoded events over filters, limit<=1000, offset, order=desc|asc',
    example: '/v1/events?limit=10&order=desc',
    params: [...filterParams, 'limit', 'offset', 'order'],
    handler: events,
  },
  {
    method: 'GET',
    path: '/v1/devices',
    description: 'Devices with live event counts and last event time',
    example: '/v1/devices',
    params: [],
    handler: devices,
  },
  {
    method: 'POST',
    path: '/v1/sql',
    description: `Read-only SELECT/WITH, body { query, limit<=10000 }. Count from ${liveViewName}, not usage_events`,
    example: '/v1/sql',
    params: [],
    handler: sql,
  },
];

const route = (method: string, path: string, url: URL): Result<Route> => {
  const matching = endpoints.filter((endpoint) =>
    endpoint.pattern ? endpoint.pattern.test(path) : endpoint.path === path,
  );
  const found = matching.find((endpoint) => endpoint.method === method);
  if (!found)
    return matching.length
      ? fail(405, 'method_not_allowed', `${method} is not supported on ${path}.`)
      : fail(404, 'not_found', `No endpoint at ${path}. See GET / for the list.`);
  const valid = [...found.params, 'debug'];
  const unknown = [...new Set(url.searchParams.keys())].filter((key) => !valid.includes(key));
  return unknown.length
    ? badRequest(
        `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Valid parameters for ${found.method} ${found.path}: ${valid.join(', ')}.`,
      )
    : ok(found.handler);
};

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

const anchorTtlMs = 60_000;

export const createClickHouseApiHandler = (
  config: ClickHouseConfig,
  client: QueryClient = makeClickHouseClient(config),
) => {
  // ClickHouse error text is useful; credentials never are.
  const redact = (message: string) => {
    const scrubbed = message.replace(/\/\/[^/@\s]*@/g, '//***@');
    return config.password ? scrubbed.replaceAll(config.password, '***') : scrubbed;
  };
  let anchorCache: { readonly expires: number; readonly value: number } | undefined;

  return async (request: Request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const started = performance.now();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const run = (sql: string, params: Record<string, ClickHouseParam> = {}) =>
      client.query(sql, params, signal).then(
        (rows) => ok(rows),
        (error: unknown) =>
          signal.aborted
            ? fail(502, 'clickhouse_timeout', `ClickHouse did not answer within ${requestTimeoutMs / 1000}s.`)
            : fail(502, 'clickhouse_error', redact(error instanceof Error ? error.message : String(error))),
      );
    const anchor = async (): Promise<Result<number>> => {
      if (anchorCache && anchorCache.expires > Date.now()) return ok(anchorCache.value);
      const rows = await run('SELECT max(timestamp) AS anchor FROM usage_events WHERE is_deleted = 0');
      if (!rows.ok) return rows;
      const value = Date.parse(iso(rows.value[0]?.anchor) ?? '') || Date.now();
      anchorCache = { expires: Date.now() + anchorTtlMs, value };
      return ok(value);
    };
    const handler = route(request.method, path, url);
    const result = handler.ok
      ? await handler.value({ url, path, request, run, database: config.database, anchor })
      : handler;
    if (!result.ok)
      return json(result.error.status, { error: { code: result.error.code, message: result.error.message } });
    const { data, rows, query, truncated, meta } = result.value;
    const debug = url.searchParams.get('debug') === '1' || request.method === 'POST';
    return json(200, {
      data,
      meta: {
        database: config.database,
        rows,
        ...meta,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
        generatedAt: new Date().toISOString(),
        ...(truncated !== undefined ? { truncated } : {}),
        ...(debug && query ? { query } : {}),
      },
    });
  };
};

export const clickHouseApiConfigFromEnv = () => ({
  url: process.env.CLICKHOUSE_URL?.trim() || 'http://localhost:8123',
  database: process.env.CLICKHOUSE_DATABASE?.trim() || 'token_tracker_bench',
  username: process.env.CLICKHOUSE_USERNAME?.trim() || 'token_tracker',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'token_tracker_dev',
});

if (import.meta.main) {
  const config = clickHouseApiConfigFromEnv();
  const client = makeClickHouseClient(config);
  // Best effort: SQL users still get raw tables when the view cannot be made.
  await client
    .command(liveViewSql(config.database))
    .catch((error: unknown) =>
      console.warn(
        `Could not create ${config.database}.${liveViewName}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  const server = Bun.serve({
    hostname: process.env.HOST?.trim() || '0.0.0.0',
    port: Number(process.env.PORT ?? 8791),
    fetch: createClickHouseApiHandler(config, client),
  });
  console.log(`ClickHouse API (${config.database}) listening on http://${server.hostname}:${server.port}/`);
}
