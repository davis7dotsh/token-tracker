import { Clock, Data, Effect, Layer, Result, Schedule, Schema } from 'effect';
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Device, DeviceRegistration, UsageEvent } from '../../shared/domain';
import { HubPricing, UsageFeed } from '../rpc/hub';
import { UsageStore } from '../rpc/store';
import { TraceRow, traceEvent } from './events';
import { makeProjectResolver, type ProjectPath } from './projects';

export class TraceSourceError extends Data.TaggedError('TraceSourceError')<{ readonly message: string }> {}

// Self-hosted only. The hub reads traces.v_usage_events from ClickHouse over
// HTTP as a read-only user, from `since` onwards (the cutover instant).
export type TraceSourceConfig = {
  readonly url: string;
  readonly user: string;
  readonly passwordFile: string;
  readonly since: string;
  readonly intervalMs: number;
  readonly projectsFile?: string;
  readonly stateFile: string;
};

export const traceSourceConfig = (dataDirectory: string, env: NodeJS.ProcessEnv = process.env) => {
  const url = env.TOKEN_TRACKER_TRACES_URL?.trim();
  if (!url) return Result.succeed(undefined);
  const since = new Date(env.TOKEN_TRACKER_TRACES_SINCE?.trim() || '1970-01-01T00:00:00Z');
  const minutes = Number(env.TOKEN_TRACKER_TRACES_INTERVAL_MINUTES ?? 5);
  if (!URL.canParse(url) || !Number.isFinite(since.getTime()) || !(minutes >= 0.5 && minutes <= 1440))
    return Result.fail(
      new TraceSourceError({
        message:
          'Trace source: TOKEN_TRACKER_TRACES_URL must be a URL, TOKEN_TRACKER_TRACES_SINCE an ISO time, and TOKEN_TRACKER_TRACES_INTERVAL_MINUTES 0.5–1440.',
      }),
    );
  const projectsFile = env.TOKEN_TRACKER_TRACES_PROJECTS?.trim();
  return Result.succeed<TraceSourceConfig>({
    url,
    user: env.TOKEN_TRACKER_TRACES_USER?.trim() || 'agent_reader',
    passwordFile: env.TOKEN_TRACKER_TRACES_PASSWORD_FILE?.trim() ?? '',
    since: since.toISOString(),
    intervalMs: minutes * 60_000,
    ...(projectsFile ? { projectsFile } : {}),
    stateFile: join(dataDirectory, 'trace-source.json'),
  });
};

// Rows arriving after their window was pulled (long streams, late inserts) are
// picked up by re-reading this much before the watermark on every pull.
const overlapMs = 2 * 3_600_000;
// ClickHouse caps reader queries at 60 s; a day of heavy use reads in about one.
const windowMs = 86_400_000;
// Short write transactions let dashboard reads interleave with a large pull.
const eventsPerBatch = 1_000;

const columns = `id, toString(toDateTime64(requested_at, 3)) AS requested_at, session_key, harness, machine, machine_os,
  cwd, repository, title, is_subagent, toString(session_updated_at) AS session_updated_at, model, service_tier, failed,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens`;
const literal = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const eventsQuery = (sessions?: readonly string[]) => `SELECT ${columns}
  FROM traces.v_usage_events(since = {since:DateTime64(3, 'UTC')}, until = {until:DateTime64(3, 'UTC')})
  ${sessions ? `WHERE session_key IN (${sessions.map(literal).join(', ') || "''"})` : ''}`;
// What a session contributes to its rows. The index rewrites active sessions
// every minute; only a change here makes their stored rows stale.
const sessionFields = (row: { harness: string; machine: string; cwd: string; repository: string; title: string }) =>
  [row.harness, row.machine, row.cwd, row.repository, row.title].join('\0');
const ChangedSession = Schema.Struct({
  session_key: Schema.String,
  first: Schema.String,
  last: Schema.String,
  latest: Schema.String,
  harness: Schema.String,
  machine: Schema.String,
  cwd: Schema.String,
  repository: Schema.String,
  title: Schema.String,
});
const State = Schema.Struct({ watermark: Schema.String, sessionsSeen: Schema.String });
type State = typeof State.Type;
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(State));
const decodeRow = Schema.decodeUnknownEffect(TraceRow);
const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(ChangedSession));
const decodePaths = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ machine: Schema.String, path: Schema.String, repository: Schema.NullOr(Schema.String) }),
    ),
  ),
);

const clickhouseTime = (iso: string) => iso.replace('T', ' ').replace('Z', '');
const failure = (message: string) => () => new TraceSourceError({ message });

export const makeTraceClient = (config: TraceSourceConfig) => {
  const query = Effect.fn('traces.query')(function* (sql: string, params: Record<string, string>) {
    const password = config.passwordFile
      ? (yield* Effect.tryPromise({
          try: () => readFile(config.passwordFile, 'utf8'),
          catch: failure('The trace store password file could not be read.'),
        })).trim()
      : '';
    const url = new URL(config.url);
    url.searchParams.set('default_format', 'JSONEachRow');
    url.searchParams.set('output_format_json_quote_64bit_integers', '0');
    for (const [name, value] of Object.entries(params)) url.searchParams.set(`param_${name}`, value);
    const text = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, {
          method: 'POST',
          body: sql,
          headers: { 'X-ClickHouse-User': config.user, 'X-ClickHouse-Key': password },
          signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
        return body;
      },
      catch: (error) =>
        new TraceSourceError({
          message: `The trace store query failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    return yield* Effect.try({
      try: () =>
        text
          .split('\n')
          .filter((line) => line.trim())
          .map((line): unknown => JSON.parse(line)),
      catch: failure('The trace store returned invalid JSON.'),
    });
  });
  const events = (window: { since: string; until: string }, sessions?: readonly string[]) =>
    query(eventsQuery(sessions), { since: clickhouseTime(window.since), until: clickhouseTime(window.until) }).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(row))),
      Effect.mapError((error) =>
        error instanceof TraceSourceError ? error : new TraceSourceError({ message: 'Unexpected trace row shape.' }),
      ),
    );
  // Sessions the index (re)wrote since the last check: their rows may now name
  // a folder, repository or title they lacked when first pulled.
  const changedSessions = (seen: string) =>
    query(
      `SELECT session_key, toString(min(first_seen)) AS first, toString(max(last_seen)) AS last,
         toString(max(updated_at)) AS latest,
         argMax(harness, updated_at) AS harness, argMax(machine, updated_at) AS machine, argMax(cwd, updated_at) AS cwd,
         argMax(repository, updated_at) AS repository, argMax(title, updated_at) AS title
       FROM traces.sessions WHERE updated_at > {seen:DateTime64(3, 'UTC')} GROUP BY session_key`,
      { seen },
    ).pipe(
      Effect.flatMap((rows) => decodeSessions(rows)),
      Effect.mapError((error) =>
        error instanceof TraceSourceError ? error : new TraceSourceError({ message: 'Unexpected session probe.' }),
      ),
    );
  return { events, changedSessions };
};

const readState = (file: string) =>
  Effect.tryPromise(() => readFile(file, 'utf8')).pipe(
    Effect.flatMap((text) => Effect.try(() => decodeState(text))),
    Effect.orElseSucceed(() => undefined),
  );
const writeState = (file: string, state: State) =>
  Effect.tryPromise({
    try: async () => {
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    catch: failure('The trace source state could not be saved.'),
  });

// Continue a machine's history under its collector device when one exists.
// New machines get a stable `trace:` device; usage without a known machine
// collects under one "Unknown machine" device rather than being dropped.
export const traceDevice = (devices: readonly Device[], machine: string, platform: string): DeviceRegistration => {
  const name = machine || 'Unknown machine';
  const known = devices
    .filter((device) => device.name.toLowerCase() === name.toLowerCase() && !device.revokedAt)
    .sort((left, right) => (right.lastSeen ?? '').localeCompare(left.lastSeen ?? ''))[0];
  if (known) return { id: known.id, name: known.name, platform: known.platform };
  return { id: `trace:${(machine || 'unknown').toLowerCase()}`.slice(0, 200), name, platform };
};

export const traceSourceLayer = (config: TraceSourceConfig) =>
  Layer.succeed(UsageFeed, {
    run: (refreshed) =>
      Effect.gen(function* () {
        const store = yield* UsageStore;
        const pricing = yield* HubPricing;
        const client = makeTraceClient(config);
        // Collector history is frozen once traces are the source: learn the
        // folder-to-repository pairs once, plus an optional exported list for
        // hubs without collector history (a side-by-side instance).
        const learned = yield* store.getProjectPaths().pipe(Effect.orElseSucceed((): ProjectPath[] => []));
        const exported = config.projectsFile
          ? yield* Effect.tryPromise(() => readFile(config.projectsFile ?? '', 'utf8')).pipe(
              Effect.flatMap((text) => Effect.try(() => decodePaths(text))),
              Effect.tapError(() => Effect.logWarning('Trace source: the projects file could not be read.')),
              Effect.orElseSucceed((): ProjectPath[] => []),
            )
          : [];
        const repository = makeProjectResolver([...learned, ...exported]);
        // Session fields as last stored, so a session rewrite with nothing new
        // does not re-read its rows. Empty after a restart: re-read once.
        const known = new Map<string, string>();

        const save = Effect.fn('traces.save')(function* (rows: readonly TraceRow[]) {
          const { policy } = yield* pricing.load;
          const pricingUpdatedAt = `${policy.catalog.updatedAt} (${policy.revision})`;
          const devices = yield* store.getDevices();
          const byDevice = new Map<string, { device: DeviceRegistration; events: UsageEvent[] }>();
          const withdrawn: string[] = [];
          for (const row of rows) {
            if (row.session_updated_at > '1970-01-02') known.set(row.session_key, sessionFields(row));
            const mapped = traceEvent(row, repository, policy, config.since);
            if (!mapped) {
              withdrawn.push(row.id);
              continue;
            }
            const device = traceDevice(devices, mapped.machine, mapped.platform);
            let group = byDevice.get(device.id);
            if (!group) byDevice.set(device.id, (group = { device, events: [] }));
            group.events.push(mapped.event);
          }
          let changed = yield* store.withdrawTraces(withdrawn);
          for (const { device, events } of byDevice.values())
            for (let offset = 0; offset < events.length; offset += eventsPerBatch) {
              const ack = yield* store.ingestTraces({
                device,
                events: events.slice(offset, offset + eventsPerBatch),
                pricingUpdatedAt,
              });
              changed += ack.accepted + ack.updated + ack.deleted;
              // bun:sqlite blocks the event loop: leave room for page loads
              // between write transactions, which matters on a busy disk.
              yield* Effect.sleep('100 millis');
            }
          return { rows: rows.length, stored: rows.length - withdrawn.length, changed };
        });

        const pull = Effect.fn('traces.pull')(function* (sessions?: {
          keys: readonly string[];
          first: string;
          last: string;
        }) {
          const now = yield* Clock.currentTimeMillis;
          const state = sessions === undefined ? yield* readState(config.stateFile) : undefined;
          const from = sessions
            ? Math.max(Date.parse(config.since), Date.parse(`${sessions.first.replace(' ', 'T')}Z`) - 3_600_000)
            : Math.max(Date.parse(config.since), state ? Date.parse(state.watermark) - overlapMs : -Infinity);
          const totals = { rows: 0, stored: 0, changed: 0 };
          const end = sessions ? Math.min(now, Date.parse(`${sessions.last.replace(' ', 'T')}Z`) + 3_600_000) : now;
          for (let start = from; start < end; start += windowMs) {
            const until = Math.min(start + windowMs, end + 3_600_000);
            const rows = yield* client.events(
              { since: new Date(start).toISOString(), until: new Date(until).toISOString() },
              sessions?.keys,
            );
            const result = yield* save(rows);
            totals.rows += result.rows;
            totals.stored += result.stored;
            totals.changed += result.changed;
            if (!sessions) {
              const current = yield* readState(config.stateFile);
              yield* writeState(config.stateFile, {
                watermark: new Date(Math.min(until, now)).toISOString(),
                sessionsSeen: current?.sessionsSeen ?? '',
              });
            }
          }
          return totals;
        });

        const cycle = Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const before = yield* readState(config.stateFile);
          // A fresh hub's first pull already sees today's session metadata.
          const latest = (rows: readonly { latest: string }[], fallback: string) =>
            rows.reduce((max, row) => (row.latest > max ? row.latest : max), fallback);
          const seen = before?.sessionsSeen || latest(yield* client.changedSessions('1970-01-01 00:00:00'), '');
          const recent = yield* pull();
          // New usage first: warm the last view before the slower re-reads of
          // older sessions, whose days that view usually does not include.
          if (recent.changed) yield* refreshed;
          const touched = yield* client.changedSessions(seen);
          const stale = touched.filter((session) => known.get(session.session_key) !== sessionFields(session));
          const late = stale.length
            ? yield* pull({
                keys: stale.map((session) => session.session_key),
                first: stale.reduce((min, session) => (session.first < min ? session.first : min), stale[0].first),
                last: stale.reduce((max, session) => (session.last > max ? session.last : max), stale[0].last),
              })
            : undefined;
          for (const session of stale) known.set(session.session_key, sessionFields(session));
          const after = yield* readState(config.stateFile);
          if (after) yield* writeState(config.stateFile, { ...after, sessionsSeen: latest(touched, seen) });
          const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
          yield* Effect.logInfo(
            `Trace source (${seconds.toFixed(1)} s): ${recent.rows} rows (${recent.changed} changes)` +
              (late
                ? `; ${stale.length} of ${touched.length} sessions updated, ${late.rows} rows (${late.changed} changes)`
                : ''),
          );
          if (late?.changed) yield* refreshed;
        });
        yield* cycle.pipe(
          Effect.catch((error) => Effect.logWarning(`Trace source: ${error.message}`)),
          Effect.repeat(Schedule.spaced(config.intervalMs)),
        );
      }).pipe(Effect.ignore),
  });
