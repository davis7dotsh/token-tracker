import { expect, test } from 'bun:test';
import { checkReadOnlySql, createClickHouseApiHandler } from '../../scripts/clickhouse-api';
import type { ClickHouseParam, ClickHouseRow } from '../../src/lib/server/rpc/clickhouse';

const config = {
  url: 'http://clickhouse.test:8123',
  database: 'bench',
  username: 'reader',
  password: 'hunter2-secret',
};
const stub = (answer: (sql: string) => ClickHouseRow[]) => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string, _values?: Record<string, ClickHouseParam>, _signal?: AbortSignal) => {
      calls.push(sql);
      return answer(sql);
    },
  };
  return { calls, handler: createClickHouseApiHandler(config, client) };
};
const get = (handler: (request: Request) => Promise<Response>, path: string) =>
  handler(new Request(`http://api.test${path}`));
const postSql = (handler: (request: Request) => Promise<Response>, body: unknown) =>
  handler(new Request('http://api.test/v1/sql', { method: 'POST', body: JSON.stringify(body) }));

test('the SQL guard accepts single read-only statements', () => {
  for (const sql of [
    'SELECT count() FROM usage_events',
    '  with t AS (SELECT 1 AS x) SELECT x FROM t;  ',
    "SELECT formatDateTime(now(), '%F'), format('{}', 1)",
    'SELECT table, sum(rows) FROM system.parts GROUP BY table',
    'SELECT settings_changed FROM t -- comment',
  ])
    expect(checkReadOnlySql(sql).ok).toBe(true);
  expect(checkReadOnlySql('SELECT 1;')).toEqual({ ok: true, value: 'SELECT 1' });
});

test('the SQL guard rejects writes, multiple statements, FORMAT, and external reads', () => {
  for (const sql of [
    'DELETE FROM usage_events WHERE 1',
    'INSERT INTO usage_events SELECT * FROM usage_events',
    'SELECT 1; DROP TABLE usage_events',
    'SELECT 1;;',
    'SELECT 1 FORMAT CSV',
    "WITH x AS (SELECT 1) SELECT * FROM x INTO OUTFILE '/tmp/x'",
    ...[
      'UPDATE',
      'ALTER',
      'DROP',
      'CREATE',
      'TRUNCATE',
      'OPTIMIZE',
      'ATTACH',
      'DETACH',
      'RENAME',
      'KILL',
      'GRANT',
      'REVOKE',
      'USE',
      'SET',
      'SYSTEM',
    ].map((keyword) => `SELECT 1 WHERE 1 /* ${keyword.toLowerCase()} */`),
    "SELECT * FROM url('http://example.com', CSV)",
    `SELECT '${'x'.repeat(10_000)}'`,
    '',
    42,
  ]) {
    const result = checkReadOnlySql(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(400);
  }
});

test('invalid enums, limits, and timestamps return 400 without querying ClickHouse', async () => {
  const { calls, handler } = stub(() => []);
  for (const [path, valid] of [
    ['/v1/timeseries?bucket=year', 'hour, day, week, month'],
    ['/v1/timeseries?group_by=color', 'none, harness'],
    ['/v1/breakdown?dimension=nope', 'harness, provider, model'],
    ['/v1/breakdown?limit=501', '1 to 500'],
    ['/v1/events?offset=-1', '0 to'],
    ['/v1/summary?harnes=claude', 'Valid parameters for GET /v1/summary: from, to, range, device_id, harness'],
    ['/v1/sessions/abc?limit=5', 'device_id, events_limit, events_offset, include_events, debug'],
    ['/v1/summary?range=30d&from=2026-01-01', 'range or from/to'],
    ['/v1/summary?range=1y', '24h, 7d, 30d, 90d, 180d, all'],
    ['/v1/timeseries?tz=Mars/Olympus', 'IANA'],
    ['/v1/timeseries?tz=%2B05:00', 'IANA'],
    ['/v1/sessions?sort=oldest', 'cost, tokens, last_active'],
    ['/v1/events?limit=0', '1 to 1000'],
    ['/v1/summary?from=yesterday', 'ISO'],
  ]) {
    const response = await get(handler, path);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain(valid);
  }
  const rejected = await postSql(handler, { query: 'SELECT 1; DROP TABLE usage_events' });
  expect(rejected.status).toBe(400);
  expect((await postSql(handler, { query: 'SELECT 1', limit: 50_000 })).status).toBe(400);
  expect(calls).toEqual([]);
});

test('values are bound, SQL is capped, and failures hide credentials', async () => {
  const { calls, handler } = stub((sql) =>
    sql.startsWith('SELECT version()') ? [{ version: '24.8' }] : [{ events: 3 }],
  );
  const health = await get(handler, '/health');
  expect(health.headers.get('access-control-allow-origin')).toBe('*');
  expect((await health.json()).data).toEqual({ ok: true, version: '24.8', liveEvents: 3 });

  await get(handler, "/v1/summary?harness=claude,codex&q=x' OR 1=1");
  expect(calls.at(-1)).toContain('harness IN {harness:Array(String)}');
  expect(calls.at(-1)).not.toContain('OR 1=1');

  const capped = await postSql(handler, { query: 'SELECT 1 -- note' });
  expect((await capped.json()).meta.query).toBe(
    'SELECT * FROM (\nSELECT 1 -- note\n) LIMIT 1000 SETTINGS readonly = 1',
  );

  const failing = createClickHouseApiHandler(config, {
    query: () => Promise.reject(new Error(`connect failed http://reader:${config.password}@clickhouse.test`)),
  });
  const response = await get(failing, '/v1/summary');
  expect(response.status).toBe(502);
  const body = await response.json();
  expect(body.error.code).toBe('clickhouse_error');
  expect(JSON.stringify(body)).not.toContain(config.password);
});

test('list endpoints report total and hasMore, probing past the last page', async () => {
  const { calls, handler } = stub((sql) =>
    sql.includes('LIMIT 2 OFFSET 2')
      ? [
          { name: 'a', costUsd: 1, tokens: 10, pricedOutputTokens: 0, total: 5, totalCostUsd: 4 },
          { name: 'b', costUsd: 0.1 + 0.2, tokens: 0, total: 5, totalCostUsd: 4 },
        ]
      : sql.includes('LIMIT 1 OFFSET 0')
        ? [{ name: 'a', total: 5 }]
        : sql.startsWith('SELECT count() AS total')
          ? [{ total: 12 }]
          : [],
  );
  const page = await (await get(handler, '/v1/breakdown?limit=2&offset=2')).json();
  expect(page.meta).toMatchObject({ rows: 2, total: 5, hasMore: true, offset: 2, limit: 2 });
  expect(page.data[0]).toMatchObject({
    costShare: 0.25,
    costPerMillionTokens: 100_000,
    costPerMillionOutputTokens: null,
  });
  expect(page.data[1].costUsd).toBe(0.3);

  const past = await (await get(handler, '/v1/breakdown?offset=40')).json();
  expect(past.meta).toMatchObject({ rows: 0, total: 5, hasMore: false });
  expect(calls.at(-1)).toContain('LIMIT 1 OFFSET 0');

  const events = await (await get(handler, '/v1/events?limit=10&offset=2')).json();
  expect(events.meta).toMatchObject({ rows: 0, total: 12, hasMore: true });
});

test('session detail pages its events or skips them', async () => {
  const { calls, handler } = stub((sql) => (sql.includes('AS devices') ? [{ events: 3 }] : []));
  const paged = await (await get(handler, '/v1/sessions/s1?events_limit=2&events_offset=1')).json();
  expect(paged.data).toEqual(expect.objectContaining({ eventsTotal: 3, events: [] }));
  expect(calls.some((sql) => /LIMIT 2\s+OFFSET 1/.test(sql))).toBe(true);

  calls.length = 0;
  const skipped = await (await get(handler, '/v1/sessions/s1?include_events=false')).json();
  expect(skipped.data).not.toHaveProperty('events');
  expect(skipped.data.eventsTotal).toBe(3);
  expect(calls).toHaveLength(1);
});

test('raw SQL cells that are safe numbers become numbers', async () => {
  const { handler } = stub(() => [
    { count: '1000000', big: '18446744073709551615', ratio: '0.125', id: '007', name: 'claude', list: ['1', '2'] },
  ]);
  const body = await (await postSql(handler, { query: 'SELECT count() FROM usage_events_live' })).json();
  expect(body.data).toEqual([
    { count: 1_000_000, big: '18446744073709551615', ratio: 0.125, id: '007', name: 'claude', list: [1, 2] },
  ]);
});
