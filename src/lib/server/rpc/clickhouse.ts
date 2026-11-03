// A minimal ClickHouse HTTP client on global fetch, so the hub and the compiled
// CLI need no driver. Every value travels as a server-side query parameter
// (`{name:Type}` placeholders), never as interpolated SQL.
export type ClickHouseConfig = {
  readonly url: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
};

export const clickHouseConfigFromEnv = () => ({
  url: process.env.CLICKHOUSE_URL?.trim() || 'http://localhost:8123',
  database: process.env.CLICKHOUSE_DATABASE?.trim() || 'token_tracker',
  username: process.env.CLICKHOUSE_USERNAME?.trim() || 'token_tracker',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
});

export type ClickHouseParam = string | number | bigint | readonly string[];
export type ClickHouseRow = Record<string, unknown>;

// Parameter values use ClickHouse's escaped text format; array items are quoted.
const escapeText = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
const quote = (value: string) => `'${escapeText(value).replaceAll("'", "\\'")}'`;
const paramValue = (value: ClickHouseParam) =>
  typeof value === 'string'
    ? escapeText(value)
    : typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : `[${value.map(quote).join(',')}]`;

// JSONEachRow cells are strings, numbers (UInt64 arrives quoted), or null.
export const text = (value: unknown) =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'bigint' ? String(value) : '';
const isRow = (value: unknown): value is ClickHouseRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// JSON.stringify cannot encode bigint versions. ClickHouse accepts quoted UInt64s.
const encodeRow = (row: ClickHouseRow) =>
  JSON.stringify(row, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));

export const makeClickHouseClient = (config: ClickHouseConfig) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.database))
    throw new Error(`Invalid ClickHouse database name: ${config.database}`);
  const headers: Record<string, string> = config.username
    ? { authorization: `Basic ${btoa(`${config.username}:${config.password}`)}` }
    : {};
  const request = async (
    body: string,
    search: Record<string, string>,
    options: { readonly database?: string; readonly signal?: AbortSignal } = {},
  ) => {
    const url = new URL(config.url);
    url.searchParams.set('database', options.database ?? config.database);
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
    const response = await fetch(url, { method: 'POST', headers, body, signal: options.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`ClickHouse request failed (${response.status}): ${text.trim()}`);
    return text;
  };
  const params = (values: Record<string, ClickHouseParam>) =>
    Object.fromEntries(Object.entries(values).map(([name, value]) => [`param_${name}`, paramValue(value)]));

  return {
    database: config.database,
    // `database` overrides the default, e.g. 'default' before the target database exists.
    command: (sql: string, options: { readonly database?: string; readonly signal?: AbortSignal } = {}) =>
      request(sql, {}, options).then(() => undefined),
    query: async (sql: string, values: Record<string, ClickHouseParam> = {}, signal?: AbortSignal) => {
      const text = await request(`${sql}\nFORMAT JSONEachRow`, params(values), { signal });
      return text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const row: unknown = JSON.parse(line);
          if (!isRow(row)) throw new Error('ClickHouse returned a row that is not an object.');
          return row;
        });
    },
    insert: (table: string, rows: readonly ClickHouseRow[], signal?: AbortSignal) =>
      rows.length
        ? request(
            rows.map(encodeRow).join('\n'),
            { query: `INSERT INTO ${table} FORMAT JSONEachRow` },
            { signal },
          ).then(() => undefined)
        : Promise.resolve(undefined),
  };
};
export type ClickHouseClient = ReturnType<typeof makeClickHouseClient>;
