import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Console, Effect, FileSystem, Option, Stdio, Stream } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { UsageClient, rpcClientLayer } from '../lib/client/rpc';
import { getLocalDevice } from '../lib/server/rpc/identity';
import { buildDashboard, collectUsage, resolveRepository } from '../lib/server/usage';
import { resolveDisplayModel } from '../lib/server/usage/pricing';
import { loadPricing } from '../lib/server/usage/pricing-runtime';
import { formatReport } from './report';
import { installSchedule, removeSchedule } from './scheduler';
import {
  CliFailure,
  type Connection,
  configDirectory,
  readCheckpoint,
  readConnection,
  writePrivateJson,
} from './state';
import { syncOnce, watchSync } from './sync';

const truth = (name: string, fallback = false) => Flag.Boolean(name).pipe(Flag.withDefault(fallback));
const optionalString = (name: string) => Flag.String(name).pipe(Flag.optional);
const selections = (value: Option.Option<string>) =>
  Option.isSome(value)
    ? value.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;

const reportFlags = {
  range: Flag.Literals('range', ['today', '7d', '30d', '6m', '90d', 'all']).pipe(Flag.withDefault('30d')),
  days: Flag.Int('days').pipe(Flag.optional),
  since: Flag.Date('since').pipe(Flag.optional),
  until: Flag.Date('until').pipe(Flag.optional),
  project: optionalString('project'),
  harness: optionalString('harness'),
  model: optionalString('model'),
  timezone: optionalString('timezone'),
  json: truth('json'),
};

const makeCheckCommand = <Name extends string>(name: Name) =>
  Command.make(
    name,
    reportFlags,
    Effect.fn('cli.check')(function* (options) {
      // Local checks deliberately do not read/write connection state or checkpoints.
      const pricing = yield* loadPricing();
      const data = yield* collectUsage({ pricingPolicy: pricing.policy });
      const now = new Date();
      let projects: string[] | undefined;
      if (Option.isSome(options.project)) {
        const path = resolve(options.project.value);
        const repository = yield* resolveRepository(path);
        projects = repository ? [repository, path] : [path];
      }
      const custom = Option.isSome(options.days) || Option.isSome(options.since) || Option.isSome(options.until);
      const days = Option.getOrElse(options.days, () => 30);
      if (days <= 0 || days > 36_500)
        return yield* Effect.fail(
          new CliFailure({
            message: '--days must be between 1 and 36500.',
          }),
        );
      const end = Option.getOrElse(options.until, () => now);
      const start = Option.getOrElse(options.since, () => new Date(end.getTime() - days * 86_400_000));
      if (start >= end)
        return yield* Effect.fail(
          new CliFailure({
            message: '--since must be before --until.',
          }),
        );
      const selected = custom
        ? {
            ...data,
            events: data.events.filter((event) => {
              const timestamp = Date.parse(event.timestamp);
              return timestamp >= start.getTime() && timestamp < end.getTime();
            }),
          }
        : data;
      const result = yield* Effect.try({
        try: () =>
          buildDashboard(
            selected,
            {
              range: custom ? 'all' : options.range,
              timezone: Option.getOrElse(options.timezone, () => Intl.DateTimeFormat().resolvedOptions().timeZone),
              harnesses: selections(options.harness),
              models: selections(options.model)?.map((model) => resolveDisplayModel(model, pricing.policy)),
              projects,
            },
            now,
            hostname(),
          ),
        catch: () =>
          new CliFailure({
            message: 'Invalid report timeframe or timezone.',
          }),
      });
      const report = custom
        ? {
            ...result,
            period: {
              start: start.toISOString(),
              end: end.toISOString(),
            },
          }
        : result;
      const stdio = yield* Stdio.Stdio;
      // Await the platform sink so large JSON reports are fully flushed through
      // pipes before the CLI runtime finishes.
      yield* Stream.run(
        Stream.make(`${options.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`),
        stdio.stdout(),
      );
    }),
  ).pipe(Command.withDescription('Read local usage. Defaults to this machine over the last 30 days.'));

const check = makeCheckCommand('check');

const connect = Command.make(
  'connect',
  {
    url: Argument.String('url'),
    secret: optionalString('pairing-secret'),
    name: optionalString('name'),
    interval: Flag.Int('interval').pipe(Flag.withDefault(5)),
    schedule: truth('schedule', true),
  },
  Effect.fn('cli.connect')(function* (options) {
    if (options.interval < 1 || options.interval > 1440)
      return yield* Effect.fail(
        new CliFailure({
          message: '--interval must be 1–1440 minutes.',
        }),
      );
    const url = yield* Effect.try({
      try: () => {
        const value = new URL(options.url);
        if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password)
          throw new Error('Unsupported URL');
        return value.href.replace(/\/$/, '');
      },
      catch: () =>
        new CliFailure({
          message: 'Use an HTTP or HTTPS dashboard URL without embedded credentials.',
        }),
    });
    const secret = Option.getOrElse(options.secret, () => process.env.TOKEN_TRACKER_PAIRING_SECRET ?? '');
    if (!secret)
      return yield* Effect.fail(
        new CliFailure({
          message: 'Pass --pairing-secret or set TOKEN_TRACKER_PAIRING_SECRET to the dashboard’s pairing secret.',
        }),
      );
    const local = yield* getLocalDevice();
    const device = {
      ...local,
      name: Option.getOrElse(options.name, () => local.name),
    };
    const registration = yield* Effect.gen(function* () {
      const client = yield* UsageClient;
      return yield* client.RegisterDevice({
        pairingSecret: secret,
        device,
      });
    }).pipe(Effect.timeout('30 seconds'), Effect.provide(rpcClientLayer(new URL('rpc', `${url}/`).href)));
    const connection: Connection = {
      url,
      token: registration.token,
      device,
      intervalMinutes: options.interval,
      scheduler: null,
      connectedAt: new Date().toISOString(),
    };
    yield* writePrivateJson('connection.json', connection);
    if (options.schedule) {
      const scheduler = yield* installSchedule(options.interval);
      yield* writePrivateJson('connection.json', {
        ...connection,
        scheduler,
      });
      yield* Console.log(`Automatic sync enabled every ${options.interval} minutes (${scheduler}).`);
    }
    yield* Console.log(`Connected ${device.name} to ${url}. Uploading all available history…`);
    yield* syncOnce();
  }),
).pipe(Command.withDescription('Pair this machine, upload its history, and enable scheduled pushes.'));

const sync = Command.make(
  'sync',
  {
    watch: truth('watch'),
    quiet: truth('quiet'),
    interval: Flag.Int('interval').pipe(Flag.withDefault(5)),
  },
  Effect.fn('cli.sync')(function* (options) {
    if (options.interval < 1 || options.interval > 1440)
      return yield* Effect.fail(
        new CliFailure({
          message: '--interval must be 1–1440 minutes.',
        }),
      );
    if (options.watch) yield* watchSync(options.interval, options.quiet);
    else yield* syncOnce(options.quiet);
  }),
).pipe(Command.withDescription('Push new or changed usage; retry safely after offline periods.'));

const status = Command.make(
  'status',
  { json: truth('json') },
  Effect.fn('cli.status')(function* (options) {
    const connection = yield* readConnection();
    if (!connection) {
      yield* Console.log(options.json ? JSON.stringify({ connected: false }) : 'Local only. No remote configured.');
      return;
    }
    const checkpoint = yield* readCheckpoint(connection);
    const result = {
      connected: true,
      url: connection.url,
      device: connection.device,
      scheduler: connection.scheduler,
      intervalMinutes: connection.intervalMinutes,
      syncedAt: checkpoint.syncedAt,
      syncedRecords: Object.keys(checkpoint.eventDigests).length,
    };
    yield* Console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : [
            `${connection.device.name} → ${connection.url}`,
            `Last sync: ${checkpoint.syncedAt ?? 'never'} · ${result.syncedRecords.toLocaleString('en-US')} records`,
            connection.scheduler
              ? `Scheduled every ${connection.intervalMinutes} minutes (${connection.scheduler})`
              : 'Scheduled sync disabled',
          ].join('\n'),
    );
  }),
);

const disconnect = Command.make(
  'disconnect',
  {},
  Effect.fn('cli.disconnect')(function* () {
    const connection = yield* readConnection();
    if (connection) yield* removeSchedule(connection.scheduler);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(join(configDirectory(), 'connection.json'), {
      force: true,
    });
    yield* fs.remove(join(configDirectory(), 'checkpoint.json'), {
      force: true,
    });
    yield* Console.log('Disconnected. Future usage checks stay local. Uploaded history remains on the dashboard.');
  }),
);

const serve = Command.make(
  'serve',
  {
    host: Flag.String('host').pipe(Flag.withDefault('127.0.0.1')),
    port: Flag.Int('port').pipe(Flag.withDefault(8787)),
    entry: optionalString('entry'),
  },
  Effect.fn('cli.serve')(function* (options) {
    if (options.port < 1 || options.port > 65535)
      return yield* Effect.fail(new CliFailure({ message: '--port must be 1–65535.' }));
    const root = Bun.main.includes('$bunfs')
      ? resolve(dirname(process.execPath), '..')
      : resolve(import.meta.dir, '../..');
    const entry = Option.getOrElse(options.entry, () => join(root, 'build/index.js'));
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(entry)))
      return yield* Effect.fail(
        new CliFailure({
          message: 'Dashboard build not found. Run bun run build or pass --entry <build/index.js>.',
        }),
      );
    const binary = Bun.main.includes('$bunfs') ? (process.env.BUN_EXEC_PATH ?? Bun.which('bun')) : process.execPath;
    if (!binary)
      return yield* Effect.fail(
        new CliFailure({
          message: 'The dashboard server currently needs Bun installed. Local checks and sync run standalone.',
        }),
      );
    yield* Console.log(`Dashboard: http://${options.host}:${options.port}`);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn([binary, entry], {
              env: {
                ...process.env,
                HOST: options.host,
                PORT: String(options.port),
              },
              stdout: 'inherit',
              stderr: 'inherit',
            }),
          ),
          (child) => Effect.sync(() => child.kill()),
        );
        const code = yield* Effect.promise(() => child.exited);
        if (code)
          return yield* Effect.fail(
            new CliFailure({
              message: `Dashboard server exited with status ${code}.`,
            }),
          );
      }),
    );
  }),
).pipe(Command.withDescription('Start the SvelteKit dashboard through Bun.'));

export const cli = makeCheckCommand('token-tracker').pipe(
  Command.withDescription('Token usage for Claude Code, Codex, and Pi.'),
  Command.withSubcommands([check, connect, sync, status, disconnect, serve]),
);
