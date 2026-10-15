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

// --- Filters ------------------------------------------------------------------
// Dynamic identifiers come only from these maps; user input is always a bound param.
const listFilters = ['device_id', 'harness', 'model', 'provider', 'project', 'repository', 'session_id'] as const;
const dimensions = {
  harness: 'harness',
  provider: 'provider',
  model: 'model',
  device_id: 'device_id',
  project: 'project',
  repository: 'repository',
} as const;
const groupings = { none: null, ...dimensions } as const;
const buckets = {
  hour: 'toStartOfHour(timestamp)',
  day: 'toStartOfDay(timestamp)',
  week: "toDateTime(toStartOfWeek(timestamp, 1), 'UTC')",
  month: "toDateTime(toStartOfMonth(timestamp), 'UTC')",
} as const;
const breakdownSorts = { cost: 'costUsd DESC', tokens: 'tokens DESC', events: 'events DESC' } as const;
const sessionSorts = { cost: 'costUsd DESC', tokens: 'tokens DESC', last_active: 'lastActiveAt DESC' } as const;
const qColumns = ['project', "ifNull(repository, '')", 'session_id', "ifNull(session_title, '')"];

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

const limit = (url: URL, max: number, fallback: number) => {
  const raw = url.searchParams.get('limit')?.trim();
  if (!raw) return ok(fallback);
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= max
    ? ok(value)
    : badRequest(`Invalid limit "${raw}". Use an integer from 1 to ${max} (default ${fallback}).`);
};

const isoParam = (url: URL, key: string) => {
  const raw = url.searchParams.get(key)?.trim();
  if (!raw) return ok(undefined);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) && Number.isFinite(Date.parse(raw))
    ? ok(formatTimestamp(raw))
    : badRequest(`Invalid ${key} "${raw}". Use an ISO date or timestamp, e.g. 2026-10-01 or 2026-10-01T12:00:00Z.`);
};

type Filter = {
  // Applied to raw rows; device_id is part of the dedupe key, so this is exact.
  readonly raw: string;
  // Applied to each record's latest version.
  readonly where: readonly string[];
  readonly columns: readonly string[];
  readonly params: Record<string, ClickHouseParam>;
};

export const parseFilters = (url: URL): Result<Filter> => {
  const from = isoParam(url, 'from');
  if (!from.ok) return from;
  const to = isoParam(url, 'to');
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
  });
};

// Latest live version of every matching record, with only the needed columns.
const live = (columns: readonly string[], filter: Filter) => {
  const needed = [...new Set([...columns, ...filter.columns, 'is_deleted'])].filter(
    (column) => column !== 'device_id' && column !== 'id',
  );
  return `SELECT * FROM (${latestEvents(needed, filter.raw)})
  WHERE ${['is_deleted = 0', ...filter.where].join(' AND ')}`;
};

// --- Aggregates ---------------------------------------------------------------
const tokenSum = 'input_tokens + output_tokens + cache_read_tokens + cache_write_tokens';
const totalsColumns = [
  'timestamp',
  'session_id',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
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
    costUsd: field('costUsd'),
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
  };
};
const summarySql = (filter: Filter) => `SELECT ${totalsSelect},
  uniqExact(device_id) AS devices, min(timestamp) AS firstEventAt, max(timestamp) AS lastEventAt
  FROM (${live(totalsColumns, filter)}) ${typed}`;

// --- Handler ------------------------------------------------------------------
type QueryClient = Pick<ClickHouseClient, 'query'>;
type Context = {
  readonly url: URL;
  readonly request: Request;
  readonly run: (sql: string, params?: Record<string, ClickHouseParam>) => Promise<Result<ClickHouseRow[]>>;
  readonly database: string;
};
type Route = (context: Context) => Promise<Result<Payload>>;

const requestTimeoutMs = 15_000;

const endpoints = [
  ['GET /health', 'ClickHouse version and live event count', '/health'],
  ['GET /v1/schema', 'usage_events and devices columns, codecs, engine, keys', '/v1/schema'],
  ['GET /v1/storage', 'Rows and compressed/uncompressed bytes per table and projection', '/v1/storage'],
  ['GET /v1/summary', 'Totals over filters', '/v1/summary?from=2026-09-15&harness=claude'],
  [
    'GET /v1/timeseries',
    'bucket=hour|day|week|month, group_by=none|harness|provider|model|device_id|project|repository',
    '/v1/timeseries?bucket=day&group_by=harness&from=2026-10-01',
  ],
  [
    'GET /v1/breakdown',
    'dimension=harness|provider|model|device_id|project|repository, sort=cost|tokens|events, limit<=100',
    '/v1/breakdown?dimension=model&sort=cost&limit=10',
  ],
  [
    'GET /v1/sessions',
    'Sessions by (device_id, session_id), sort=cost|tokens|last_active, limit<=200',
    '/v1/sessions?sort=cost&limit=20',
  ],
  [
    'GET /v1/sessions/:sessionId',
    'One session: summary plus its events (optional device_id, cap 1000)',
    '/v1/sessions/<session_id>?device_id=<device_id>',
  ],
  ['GET /v1/events', 'Decoded events over filters, limit<=1000, order=desc|asc', '/v1/events?limit=10&order=desc'],
  ['GET /v1/devices', 'Devices with live event counts and last event time', '/v1/devices'],
  [
    'POST /v1/sql',
    'Read-only SELECT/WITH, body { query, limit<=10000 }. Rows are raw: UInt64 values arrive as strings',
    '/v1/sql',
  ],
] as const;

const discovery: Route = async ({ database }) =>
  ok({
    data: {
      name: 'token-tracker ClickHouse API',
      database,
      filters:
        'from, to (ISO, [from, to)), device_id, harness, model, provider, project, repository, session_id (comma-separated or repeated), q (case-insensitive contains over project/repository/session_id/session_title). Add debug=1 to see the generated SQL.',
      endpoints: endpoints.map(([route, description, example]) => ({ route, description, example })),
    },
    rows: endpoints.length,
  });

const health: Route = async ({ run }) => {
  const [version, count] = await Promise.all([
    run('SELECT version() AS version'),
    run(`SELECT count() AS events FROM (${live([], { raw: '1', where: [], columns: [], params: {} })}) ${typed}`),
  ]);
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
  const [tables, projections] = await Promise.all([
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
  ]);
  if (!tables.ok) return tables;
  if (!projections.ok) return projections;
  const data = tables.value.map((table) => {
    const own = projections.value.filter((projection) => projection.table === table.table);
    const base = storageStats(table);
    return {
      table: text(table.table),
      ...base,
      // Includes projection parts, which live inside the table's parts.
      bytesOnDisk: Number(table.disk),
      projections: own.map((projection) => ({ name: text(projection.name), ...storageStats(projection) })),
      totalCompressedBytes:
        base.compressedBytes + own.reduce((sum, projection) => sum + Number(projection.compressed), 0),
    };
  });
  return ok({ data, rows: data.length });
};

const summary: Route = async ({ url, run }) => {
  const filter = parseFilters(url);
  if (!filter.ok) return filter;
  const sql = summarySql(filter.value);
  const rows = await run(sql, filter.value.params);
  if (!rows.ok) return rows;
  return ok({ data: summaryRow(rows.value[0]), rows: 1, query: sql });
};

const maxSeriesRows = 5_000;
const timeseries: Route = async ({ url, run }) => {
  const filter = parseFilters(url);
  if (!filter.ok) return filter;
  const bucket = choice(url, 'bucket', buckets, 'day');
  if (!bucket.ok) return bucket;
  const groupBy = choice(url, 'group_by', groupings, 'none');
  if (!groupBy.ok) return groupBy;
  const group = groupings[groupBy.value];
  const sql = `SELECT ${buckets[bucket.value]} AS bucketStart${group ? `, ${group} AS grp` : ''},
    count() AS events, sum(${tokenSum}) AS tokens, sumIf(cost_usd, cost_known = 1) AS costUsd,
    uniqExact(device_id, session_id) AS sessions
    FROM (${live(['timestamp', 'session_id', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'cost_known', ...(group ? [group] : [])], filter.value)})
    GROUP BY bucketStart${group ? ', grp' : ''} ORDER BY bucketStart${group ? ', grp' : ''}
    LIMIT ${maxSeriesRows + 1} ${typed}`;
  const rows = await run(sql, filter.value.params);
  if (!rows.ok) return rows;
  const data = rows.value.slice(0, maxSeriesRows).map((row) => ({
    bucketStart: iso(row.bucketStart),
    ...(group ? { group: row.grp ?? null } : {}),
    events: Number(row.events),
    tokens: Number(row.tokens),
    costUsd: Number(row.costUsd),
    sessions: Number(row.sessions),
  }));
  return ok({ data, rows: data.length, query: sql, truncated: rows.value.length > maxSeriesRows });
};

const breakdown: Route = async ({ url, run }) => {
  const filter = parseFilters(url);
  if (!filter.ok) return filter;
  const dimension = choice(url, 'dimension', dimensions, 'model');
  if (!dimension.ok) return dimension;
  const sort = choice(url, 'sort', breakdownSorts, 'cost');
  if (!sort.ok) return sort;
  const count = limit(url, 100, 20);
  if (!count.ok) return count;
  const column = dimensions[dimension.value];
  const sql = `SELECT ${column} AS name, ${totalsSelect}
    FROM (${live([...totalsColumns, column], filter.value)})
    GROUP BY name ORDER BY ${breakdownSorts[sort.value]}, name LIMIT ${count.value} ${typed}`;
  const rows = await run(sql, filter.value.params);
  if (!rows.ok) return rows;
  const data = rows.value.map((row) => ({ name: row.name ?? null, ...totals(row) }));
  return ok({ data, rows: data.length, query: sql });
};

const sessionsSelect = `device_id AS deviceId, session_id AS sessionId,
  min(timestamp) AS startedAt, max(timestamp) AS lastActiveAt,
  count() AS events, sum(${tokenSum}) AS tokens, sumIf(cost_usd, cost_known = 1) AS costUsd,
  groupUniqArray(harness) AS harnesses, groupUniqArray(model) AS models,
  any(project) AS project, any(repository) AS repository,
  argMax(session_title, timestamp) AS sessionTitle`;
const sessionsColumns = [
  'timestamp',
  'session_id',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost_usd',
  'cost_known',
  'harness',
  'model',
  'project',
  'repository',
  'session_title',
];

const sessions: Route = async ({ url, run }) => {
  const filter = parseFilters(url);
  if (!filter.ok) return filter;
  const sort = choice(url, 'sort', sessionSorts, 'last_active');
  if (!sort.ok) return sort;
  const count = limit(url, 200, 50);
  if (!count.ok) return count;
  const sql = `SELECT ${sessionsSelect} FROM (${live(sessionsColumns, filter.value)})
    GROUP BY device_id, session_id ORDER BY ${sessionSorts[sort.value]}, deviceId, sessionId
    LIMIT ${count.value} ${typed}`;
  const rows = await run(sql, filter.value.params);
  if (!rows.ok) return rows;
  const data = rows.value.map((row) => ({
    ...row,
    startedAt: iso(row.startedAt),
    lastActiveAt: iso(row.lastActiveAt),
    events: Number(row.events),
    tokens: Number(row.tokens),
    costUsd: Number(row.costUsd),
  }));
  return ok({ data, rows: data.length, query: sql });
};

const decodeEvents = (rows: readonly ClickHouseRow[]): Result<unknown[]> => {
  try {
    return ok(rows.map((row) => ({ ...rowToEvent(row), provider: text(row.provider) })));
  } catch (error) {
    return fail(502, 'decode_failed', error instanceof Error ? error.message : String(error));
  }
};

const maxSessionEvents = 1_000;
const sessionDetail =
  (sessionId: string): Route =>
  async ({ url, run }) => {
    const scoped = new URL(url);
    scoped.search = '';
    scoped.searchParams.set('session_id', sessionId);
    for (const device of values(url, 'device_id')) scoped.searchParams.append('device_id', device);
    const filter = parseFilters(scoped);
    if (!filter.ok) return filter;
    const eventsSql = `${live(eventColumns, filter.value)} ORDER BY timestamp, device_id, id LIMIT ${maxSessionEvents + 1}`;
    const [totalsRows, eventRows] = await Promise.all([
      run(summarySql(filter.value), filter.value.params),
      run(eventsSql, filter.value.params),
    ]);
    if (!totalsRows.ok) return totalsRows;
    if (!eventRows.ok) return eventRows;
    const head = summaryRow(totalsRows.value[0]);
    if (!head.events) return fail(404, 'not_found', `No live events for session "${sessionId}".`);
    const events = decodeEvents(eventRows.value.slice(0, maxSessionEvents));
    if (!events.ok) return events;
    return ok({
      data: { summary: head, events: events.value },
      rows: events.value.length,
      query: eventsSql,
      truncated: eventRows.value.length > maxSessionEvents,
    });
  };

const events: Route = async ({ url, run }) => {
  const filter = parseFilters(url);
  if (!filter.ok) return filter;
  const count = limit(url, 1_000, 100);
  if (!count.ok) return count;
  const order = choice(url, 'order', { desc: 'DESC', asc: 'ASC' }, 'desc');
  if (!order.ok) return order;
  const direction = order.value === 'asc' ? 'ASC' : 'DESC';
  const sort = `ORDER BY timestamp ${direction}, device_id ${direction}, id ${direction}`;
  // Pick the page's keys from a narrow dedupe, then read full rows for just
  // those keys: deduping every column across all records is the slow part.
  const page = `SELECT device_id, id FROM (${live(['timestamp'], filter.value)}) ${sort} LIMIT ${count.value}`;
  const sql = `SELECT * FROM (${latestEvents(eventColumns, `${filter.value.raw} AND (device_id, id) IN (${page})`)})
    ${sort}`;
  const rows = await run(sql, filter.value.params);
  if (!rows.ok) return rows;
  const data = decodeEvents(rows.value);
  if (!data.ok) return data;
  return ok({ data: data.value, rows: data.value.length, query: sql });
};

const devices: Route = async ({ run }) => {
  const [registered, counts] = await Promise.all([
    run(`SELECT id, name, platform, last_seen, revoked_at, pricing_updated_at FROM devices FINAL ORDER BY name`),
    run(
      `SELECT device_id, count() AS events, max(timestamp) AS lastEventAt
      FROM (${live(['timestamp'], { raw: '1', where: [], columns: [], params: {} })}) GROUP BY device_id ${typed}`,
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
  return ok({ data: rows.value, rows: rows.value.length, query: wrapped });
};

const route = (method: string, path: string): Result<Route> => {
  const session = path.match(/^\/v1\/sessions\/([^/]+)$/);
  const routes: Record<string, Route> = {
    'GET /': discovery,
    'GET /health': health,
    'GET /v1/schema': schema,
    'GET /v1/storage': storage,
    'GET /v1/summary': summary,
    'GET /v1/timeseries': timeseries,
    'GET /v1/breakdown': breakdown,
    'GET /v1/sessions': sessions,
    'GET /v1/events': events,
    'GET /v1/devices': devices,
    'POST /v1/sql': sql,
  };
  const found =
    session && method === 'GET' ? sessionDetail(decodeURIComponent(session[1])) : routes[`${method} ${path}`];
  if (found) return ok(found);
  const known = session || Object.keys(routes).some((key) => key.endsWith(` ${path}`));
  return known
    ? fail(405, 'method_not_allowed', `${method} is not supported on ${path}.`)
    : fail(404, 'not_found', `No endpoint at ${path}. See GET / for the list.`);
};

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

export const createClickHouseApiHandler = (
  config: ClickHouseConfig,
  client: QueryClient = makeClickHouseClient(config),
) => {
  // ClickHouse error text is useful; credentials never are.
  const redact = (message: string) => {
    const scrubbed = message.replace(/\/\/[^/@\s]*@/g, '//***@');
    return config.password ? scrubbed.replaceAll(config.password, '***') : scrubbed;
  };

  return async (request: Request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const started = performance.now();
    const url = new URL(request.url);
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const run = (sql: string, params: Record<string, ClickHouseParam> = {}) =>
      client.query(sql, params, signal).then(
        (rows) => ok(rows),
        (error: unknown) =>
          signal.aborted
            ? fail(502, 'clickhouse_timeout', `ClickHouse did not answer within ${requestTimeoutMs / 1000}s.`)
            : fail(502, 'clickhouse_error', redact(error instanceof Error ? error.message : String(error))),
      );
    const handler = route(request.method, url.pathname.replace(/\/+$/, '') || '/');
    const result = handler.ok ? await handler.value({ url, request, run, database: config.database }) : handler;
    if (!result.ok)
      return json(result.error.status, { error: { code: result.error.code, message: result.error.message } });
    const { data, rows, query, truncated } = result.value;
    const debug = url.searchParams.get('debug') === '1' || request.method === 'POST';
    return json(200, {
      data,
      meta: {
        database: config.database,
        rows,
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
  const server = Bun.serve({
    hostname: process.env.HOST?.trim() || '0.0.0.0',
    port: Number(process.env.PORT ?? 8791),
    fetch: createClickHouseApiHandler(config),
  });
  console.log(`ClickHouse API (${config.database}) listening on http://${server.hostname}:${server.port}/`);
}
