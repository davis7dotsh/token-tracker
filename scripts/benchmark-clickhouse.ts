// Storage benchmark: SQLite vs ClickHouse UsageStore on an identical,
// deterministic 1M-event dataset. Needs `bun run ch:up` first.
//   bun scripts/benchmark-clickhouse.ts [output.json]
import { Database } from 'bun:sqlite';
import { Effect, type Layer, ManagedRuntime } from 'effect';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, homedir, machine, release, totalmem, type } from 'node:os';
import { join } from 'node:path';
import { makeClickHouseClient } from '../src/lib/server/rpc/clickhouse';
import { eventColumns, formatTimestamp, latestEvents } from '../src/lib/server/rpc/clickhouse-schema';
import { clickHouseUsageStoreLayer } from '../src/lib/server/rpc/clickhouse-store';
import { usageStoreLayer } from '../src/lib/server/rpc/server';
import { UsageStore } from '../src/lib/server/rpc/store';
import type { DeviceRegistration, UsageEvent } from '../src/lib/shared/domain';

// usageStoreLayer switches to ClickHouse on this variable; the SQLite side must stay SQLite.
delete process.env.TOKEN_TRACKER_STORAGE;

const output = process.argv[2] ?? '/tmp/bench-results.json';
const seed = 20261014;
const batchSize = 1_000;
const deviceCount = 10;
// rounds × devices × batchSize = 1M. BENCH_ROUNDS shrinks it for a smoke run.
const rounds = Number(process.env.BENCH_ROUNDS ?? 100);
const pairingSecret = 'benchmark-pairing-secret-long-enough';
// Like the hub, reads exclude a local device ID. It owns no records here.
const excluded = 'bench-hub-local';
const rangeEnd = Date.parse('2026-10-15T00:00:00.000Z');
const day = 86_400_000;
const range = { start: rangeEnd - 180 * day, end: rangeEnd };
const window30d = { start: '2026-09-15T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z' };
const sqliteDirectory = join(homedir(), '.cache', 'token-tracker-bench-sqlite');
const sqlitePath = join(sqliteDirectory, 'usage.sqlite');
const clickHouseConfig = {
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  database: 'token_tracker_bench',
  username: 'token_tracker',
  password: 'token_tracker_dev',
};
const clickHouse = makeClickHouseClient(clickHouseConfig);
// The bench database does not exist until the store creates it.
const clickHouseServer = makeClickHouseClient({ ...clickHouseConfig, database: 'default' });

// --- Deterministic dataset ---------------------------------------------------
// Each batch is a pure function of (seed, round, device): sfc32 seeded through
// splitmix32, so both backends see byte-identical events, any batch can be
// regenerated on demand, and every prefix of rounds spans the full 180 days.
type Random = () => number;
const splitmix = (value: number) => {
  let z = (value + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
};
const sfc32 = (words: readonly number[]): Random => {
  let [a, b, c, d] = words;
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  };
};
const randomFor = (round: number, device: number) => {
  const random = sfc32([0, 1, 2, 3].map((word) => splitmix(splitmix((round * 16 + device) * 4 + word) ^ seed)));
  for (let index = 0; index < 12; index++) random();
  return random;
};
const integer = (random: Random, low: number, high: number) => low + Math.floor(random() * (high - low + 1));
const weighted = <A extends { readonly weight: number }>(random: Random, items: readonly A[]) => {
  let roll = random() * items.reduce((sum, item) => sum + item.weight, 0);
  return items.find((item) => (roll -= item.weight) < 0) ?? items[items.length - 1];
};
const logNormal = (random: Random, median: number, sigma: number, low: number, high: number) => {
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Math.round(Math.min(high, Math.max(low, median * Math.exp(sigma * normal))));
};
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const randomText = (random: Random, length: number, characters = alphabet) =>
  Array.from({ length }, () => characters[Math.floor(random() * characters.length)]).join('');

// Prices are USD per million input, output, cache-read, and cache-write tokens.
type Model = {
  readonly model: string;
  readonly weight: number;
  readonly prices: readonly [number, number, number, number];
  readonly rawModel?: string;
};
const harnesses: readonly {
  readonly harness: UsageEvent['harness'];
  readonly weight: number;
  readonly tiers: readonly string[];
  readonly models: readonly Model[];
}[] = [
  {
    harness: 'claude',
    weight: 55,
    tiers: ['standard', 'priority'],
    models: [
      { model: 'claude-opus-5-5', weight: 40, prices: [5, 25, 0.5, 6.25] },
      { model: 'claude-sonnet-5-5', weight: 45, prices: [3, 15, 0.3, 3.75] },
      { model: 'claude-haiku-5-5', weight: 15, prices: [1, 5, 0.1, 1.25] },
    ],
  },
  {
    harness: 'codex',
    weight: 30,
    tiers: ['default', 'flex', 'priority'],
    models: [
      { model: 'gpt-6.1-sol', weight: 55, prices: [1.25, 10, 0.125, 0], rawModel: 'openai/gpt-6.1-sol' },
      { model: 'gpt-6.1-sol-mini', weight: 30, prices: [0.25, 2, 0.025, 0] },
      { model: 'gpt-6-codex', weight: 15, prices: [1.5, 12, 0.15, 0] },
    ],
  },
  {
    harness: 'pi',
    weight: 7,
    tiers: [],
    models: [
      { model: 'gemini-3.5-pro', weight: 50, prices: [2, 12, 0.2, 0], rawModel: 'google/gemini-3.5-pro' },
      { model: 'kimi-k3', weight: 50, prices: [0.6, 2.5, 0.15, 0], rawModel: 'moonshotai/kimi-k3' },
    ],
  },
  {
    harness: 'grok',
    weight: 5,
    tiers: [],
    models: [
      { model: 'grok-4.7', weight: 60, prices: [3, 15, 0.75, 0] },
      { model: 'grok-4.7-fast', weight: 40, prices: [0.2, 0.5, 0.05, 0] },
    ],
  },
  {
    harness: 'muse',
    weight: 3,
    tiers: [],
    models: [
      { model: 'muse-wonder-full-1.0', weight: 70, prices: [2, 8, 0.2, 0] },
      { model: 'muse-wonder-lite-1.0', weight: 30, prices: [0.4, 1.6, 0.04, 0] },
    ],
  },
];
const projectNames = [
  'token-tracker',
  'web-app',
  'api-gateway',
  'billing',
  'mobile',
  'infra',
  'docs',
  'design-system',
  'auth-service',
  'search',
  'analytics',
  'notifications',
  'cli',
  'sdk-js',
  'sdk-python',
  'data-pipeline',
  'ml-platform',
  'admin-panel',
  'marketing-site',
  'payments',
  'scheduler',
  'video-encoder',
  'scratch',
  'playground',
  'dotfiles',
];
// Zipf-ish: a few projects take most of the work. The last three are not git repos.
const projects = projectNames.map((name, index) => ({
  name,
  weight: 1 / (index + 1),
  repository: index < 22 ? `github.com/acme/${name}` : null,
}));
const titles = [
  'Fix flaky auth tests',
  'Add CSV export',
  'Refactor billing webhooks',
  'Investigate slow dashboard',
  'Upgrade to Svelte 6',
  'Write migration for devices',
  'Review PR feedback',
  'Debug memory leak',
  'Add dark mode',
  'Implement rate limiting',
  'Clean up logging',
  'Port script to Bun',
];
const devices: readonly DeviceRegistration[] = Array.from({ length: deviceCount }, (_, index) => ({
  id: `bench-device-${index}`,
  name: `Bench ${index}`,
  platform: index < 6 ? 'darwin' : 'linux',
}));

// Sessions start on a linear recency ramp: the newest day is about twice as
// dense as the oldest. Events in a session follow 5–120s apart (≤2h total).
const generateBatch = (round: number, device: number, span = range) => {
  const random = randomFor(round, device);
  const home = devices[device].platform === 'darwin' ? `/Users/dev${device}` : `/home/dev${device}`;
  const events: UsageEvent[] = [];
  while (events.length < batchSize) {
    const length = Math.min(integer(random, 20, 60), batchSize - events.length);
    const harness = weighted(random, harnesses);
    const choice = weighted(random, harness.models);
    const project = weighted(random, projects);
    const sessionId = [8, 4, 4, 4, 12].map((size) => randomText(random, size, '0123456789abcdef')).join('-');
    const sessionTitle = random() < 0.5 ? titles[integer(random, 0, titles.length - 1)] : undefined;
    const position = -1 + Math.sqrt(1 + 3 * random());
    let time = span.start + Math.floor(position * (span.end - span.start - 2 * 3_600_000));
    for (let step = 0; step < length; step++) {
      time += integer(random, 5, 120) * 1_000;
      const inputTokens = logNormal(random, 4_000, 1.1, 500, 50_000);
      const outputTokens = logNormal(random, 700, 1, 100, 8_000);
      const cacheReadTokens = random() < 0.75 ? logNormal(random, 60_000, 0.9, 1_000, 600_000) : 0;
      const cacheWriteTokens =
        harness.harness === 'claude' && random() < 0.35 ? logNormal(random, 4_000, 1, 200, 80_000) : 0;
      const reasoningChance = harness.harness === 'codex' ? 0.6 : harness.harness === 'grok' ? 0.3 : 0.15;
      const reasoningTokens = random() < reasoningChance ? logNormal(random, 400, 1, 0, outputTokens) : 0;
      const [input, output, cacheRead, cacheWrite] = choice.prices;
      const tier =
        harness.tiers.length && random() < 0.6 ? harness.tiers[integer(random, 0, harness.tiers.length - 1)] : '';
      const requests = random() < 0.3 ? integer(random, 1, 3) : undefined;
      const index = events.length;
      events.push({
        id: `msg_${round.toString(36).padStart(2, '0')}${device}${index.toString(36).padStart(2, '0')}${randomText(random, 20)}`,
        timestamp: new Date(time).toISOString(),
        harness: harness.harness,
        model: choice.model,
        ...(choice.rawModel && (harness.harness === 'pi' || random() < 0.2) ? { rawModel: choice.rawModel } : {}),
        project: `${home}/code/${project.name}`,
        repository: project.repository,
        sessionId,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        costUsd:
          (inputTokens * input + outputTokens * output + cacheReadTokens * cacheRead + cacheWriteTokens * cacheWrite) /
          1_000_000,
        costKnown: true,
        ...(sessionTitle ? { sessionTitle } : {}),
        ...(tier ? { serviceTier: tier } : {}),
        ...(requests === undefined ? {} : { requests }),
      });
    }
  }
  return events;
};
// Steady-state uploads are recent: the last day of the range.
const recentBatch = (round: number, device: number) =>
  generateBatch(round, device, { start: range.end - day, end: range.end });

// --- Measurement helpers ------------------------------------------------------
const round1 = (value: number) => Math.round(value * 10) / 10;
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return round1(sorted[Math.floor(sorted.length / 2)]);
};
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
type StoreService = UsageStore['Service'];
const backends = {
  sqlite: () => usageStoreLayer({ dataDirectory: sqliteDirectory, pairingSecret }),
  clickhouse: () => clickHouseUsageStoreLayer(clickHouseConfig, pairingSecret),
};
type Backend = keyof typeof backends;
const backendNames: readonly Backend[] = ['sqlite', 'clickhouse'];

// A long-lived store, as a hub keeps one; tokens come from real pairing.
const openStore = async <E>(layer: Layer.Layer<UsageStore, E>) => {
  const runtime = ManagedRuntime.make(layer);
  const use = <A, F>(run: (store: StoreService) => Effect.Effect<A, F>) =>
    runtime.runPromise(Effect.flatMap(UsageStore, run));
  const tokens = new Map<string, string>();
  for (const device of devices)
    tokens.set(device.id, (await use((store) => store.registerDevice(pairingSecret, device))).token);
  const sync = (device: DeviceRegistration, events: readonly UsageEvent[], deletedIds: readonly string[] = []) =>
    use((store) => store.syncUsage(device.id, tokens.get(device.id) ?? '', { device, events, deletedIds }));
  return { sync, dispose: () => runtime.dispose() };
};
const stores = {
  sqlite: () => openStore(backends.sqlite()),
  clickhouse: () => openStore(backends.clickhouse()),
};

// Cold store read: a fresh runtime per run, built before the clock starts, so
// no window cache or hub cache survives between runs. OS page caches and
// ClickHouse's mark cache stay warm.
type Summary = { readonly count: number; readonly check: string };
const coldRead = async <E, A, F>(
  layer: Layer.Layer<UsageStore, E>,
  run: (store: StoreService) => Effect.Effect<A, F>,
  summarize: (value: A) => Summary,
) => {
  const runtime = ManagedRuntime.make(layer);
  try {
    await runtime.runPromise(Effect.asVoid(UsageStore));
    const started = performance.now();
    const value = await runtime.runPromise(Effect.flatMap(UsageStore, run));
    const milliseconds = performance.now() - started;
    return { milliseconds, summary: summarize(value) };
  } finally {
    await runtime.dispose();
    Bun.gc(true);
  }
};
const usageSummary = (usage: { readonly events: readonly UsageEvent[] }) => {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const event of usage.events) {
    input += event.inputTokens;
    output += event.outputTokens;
    cacheRead += event.cacheReadTokens;
  }
  return { count: usage.events.length, check: `${input}/${output}/${cacheRead}` };
};
const readOp = <A, F>(
  op: string,
  run: (store: StoreService) => Effect.Effect<A, F>,
  summarize: (value: A) => Summary,
) => ({
  op,
  measure: (backend: Backend) =>
    backend === 'sqlite'
      ? coldRead(backends.sqlite(), run, summarize)
      : coldRead(backends.clickhouse(), run, summarize),
});
const readOps = [
  readOp('getUsageAll', (store) => store.getUsage(excluded), usageSummary),
  readOp('getUsage30d', (store) => store.getUsage(excluded, window30d), usageSummary),
  readOp(
    'getUsage30dDevices',
    (store) => store.getUsage(excluded, { ...window30d, devices: [devices[1].id, devices[4].id, devices[7].id] }),
    usageSummary,
  ),
  readOp(
    'getDimensions',
    (store) => store.getDimensions(excluded),
    (rows) => ({
      count: rows.length,
      check: createHash('sha256')
        .update(
          rows
            .map((row) => JSON.stringify([row.deviceId, row.harness, row.model, row.project]))
            .sort()
            .join('\n'),
        )
        .digest('hex')
        .slice(0, 16),
    }),
  ),
  readOp(
    'getDevices',
    (store) => store.getDevices(),
    (rows) => ({
      count: rows.length,
      check: `${rows
        .map((row) => row.id)
        .sort()
        .join(',')}:${rows.reduce((sum, row) => sum + row.eventCount, 0)}`,
    }),
  ),
];

const clickHouseRows = (sql: string, params: Parameters<typeof clickHouse.query>[1] = {}) =>
  clickHouse.query(sql, params);
const waitForMerges = async () => {
  const started = performance.now();
  while (performance.now() - started < 180_000) {
    const [row] = await clickHouseRows('SELECT count() AS merges FROM system.merges WHERE database = {db:String}', {
      db: clickHouseConfig.database,
    });
    if (Number(row?.merges) === 0) break;
    await Bun.sleep(1_000);
  }
  return round1((performance.now() - started) / 1_000);
};
const partsState = async () => {
  const [parts] = await clickHouseRows(
    `SELECT count() AS parts, sum(rows) AS rows, sum(data_compressed_bytes) AS compressed,
      sum(data_uncompressed_bytes) AS uncompressed, sum(bytes_on_disk) AS on_disk
    FROM system.parts WHERE database = {db:String} AND table = 'usage_events' AND active`,
    { db: clickHouseConfig.database },
  );
  const [projections] = await clickHouseRows(
    `SELECT count() AS parts, sum(data_compressed_bytes) AS compressed, sum(data_uncompressed_bytes) AS uncompressed
    FROM system.projection_parts WHERE database = {db:String} AND table = 'usage_events' AND active`,
    { db: clickHouseConfig.database },
  );
  return {
    activeParts: Number(parts?.parts),
    rows: Number(parts?.rows),
    compressedBytes: Number(parts?.compressed),
    uncompressedBytes: Number(parts?.uncompressed),
    bytesOnDisk: Number(parts?.on_disk),
    projectionParts: Number(projections?.parts),
    projectionCompressedBytes: Number(projections?.compressed),
    projectionUncompressedBytes: Number(projections?.uncompressed),
  };
};
const sqliteBytes = async () => {
  // Fold the WAL into the main file first; the store connections are closed.
  const database = new Database(sqlitePath);
  database.run('PRAGMA wal_checkpoint(TRUNCATE)');
  database.close();
  const sizes = await Promise.all(
    ['', '-wal', '-shm'].map((suffix) =>
      stat(`${sqlitePath}${suffix}`).then(
        (file) => file.size,
        () => 0,
      ),
    ),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
};

// --- Results ------------------------------------------------------------------
const [versionRow] = await clickHouseServer.query('SELECT version() AS version');
const results = {
  environment: {
    machine: `${type()} ${release()} ${machine()} · ${cpus()[0]?.model ?? 'unknown CPU'} (${cpus().length} threads) · ${Math.round(totalmem() / 2 ** 30)} GiB RAM`,
    bunVersion: Bun.version,
    clickhouseVersion: String(versionRow?.version),
    datasetEvents: rounds * deviceCount * batchSize,
    devices: deviceCount,
    seed,
    sqliteDirectory,
    clickhouseDatabase: clickHouseConfig.database,
    timeDistribution: 'linear recency ramp over 2026-04-18..2026-10-14 UTC (newest day ≈2× oldest)',
  },
  ingest: {
    sqlite: { totalSeconds: 0, eventsPerSec: 0, checkpoints: [] as { events: number; elapsedSeconds: number }[] },
    clickhouse: { totalSeconds: 0, eventsPerSec: 0, checkpoints: [] as { events: number; elapsedSeconds: number }[] },
  },
  reads: [] as {
    size: number;
    op: string;
    sqliteMs: number;
    clickhouseMs: number;
    eventsReturned: number;
    sqliteRunsMs: number[];
    clickhouseRunsMs: number[];
    match: boolean;
  }[],
  writes1m: [] as {
    op: string;
    sqliteMs: number;
    clickhouseMs: number;
    sqliteRunsMs: number[];
    clickhouseRunsMs: number[];
  }[],
  storage: {
    sqliteBytes: 0,
    clickhouseCompressedBytes: 0,
    clickhouseUncompressedBytes: 0,
    clickhouseOptimizedCompressedBytes: 0,
    clickhouseOptimizedUncompressedBytes: 0,
    clickhouseBeforeOptimize: {} as Awaited<ReturnType<typeof partsState>>,
    clickhouseAfterOptimize: {} as Awaited<ReturnType<typeof partsState>>,
    optimizeSeconds: 0,
  },
  nativeQueries: [] as {
    op: string;
    sqliteMs: number;
    clickhouseMs: number;
    clickhouseOptimizedMs?: number;
    sqliteIndexedMs?: number;
    rows: number;
    match: boolean;
  }[],
  notes: [] as string[],
  failures: [] as string[],
};
const save = () => writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
const fail = (message: string) => {
  results.failures.push(message);
  log({ failure: message });
};

// --- Setup --------------------------------------------------------------------
await rm(sqliteDirectory, { recursive: true, force: true });
await mkdir(sqliteDirectory, { recursive: true });
await clickHouse.command(`DROP DATABASE IF EXISTS ${clickHouseConfig.database}`, { database: 'default' });
results.notes.push(
  'Single machine: Bun, SQLite, and ClickHouse (Docker, same NVMe ext4 disk as SQLite) share one host; no network latency between hub and ClickHouse.',
  'Store reads are cold at the store level (fresh ManagedRuntime per run, so no window or hub cache) but warm at the OS level: page cache and ClickHouse mark cache stay warm, and each op gets one throwaway warm-up.',
  'Store read timings include decoding every row into UsageEvent objects in TypeScript; dashboard aggregation (buildDashboard) and pricing are excluded and would cost the same on both backends.',
  'Ingest is the real syncUsage path, 1,000 events per call, sequential, one backend at a time; generation time is excluded.',
  'Native queries bypass UsageStore: bun:sqlite readonly with json_extract over usage_events, and the ClickHouse HTTP client with the argMax latest-version pattern.',
);

// --- Ingest and reads at each size --------------------------------------------
const elapsed = { sqlite: 0, clickhouse: 0 };
const segments = [
  ...[
    { to: 1, reads: true },
    { to: 10, reads: true },
    { to: 50, reads: false },
  ].filter((segment) => segment.to < rounds),
  { to: rounds, reads: true },
];
let from = 0;
const ingestStores = {
  sqlite: await stores.sqlite(),
  clickhouse: await stores.clickhouse(),
};
for (const segment of segments) {
  for (const backend of backendNames) {
    const store = ingestStores[backend];
    for (let round = from; round < segment.to; round++) {
      for (let device = 0; device < deviceCount; device++) {
        const events = generateBatch(round, device);
        const started = performance.now();
        const ack = await store.sync(devices[device], events);
        elapsed[backend] += performance.now() - started;
        if (ack.accepted !== events.length)
          fail(`${backend} accepted ${ack.accepted}/${events.length} events in round ${round} device ${device}`);
      }
    }
    const events = segment.to * deviceCount * batchSize;
    results.ingest[backend].checkpoints.push({ events, elapsedSeconds: round1(elapsed[backend] / 1_000) });
    log({ ingest: backend, events, elapsedSeconds: round1(elapsed[backend] / 1_000) });
  }
  from = segment.to;
  await save();
  if (!segment.reads) continue;

  const size = segment.to * deviceCount * batchSize;
  const settled = await waitForMerges();
  const parts = await partsState();
  results.notes.push(
    `At ${size} events, waited ${settled}s for ClickHouse merges to settle before reads (${parts.activeParts} active parts).`,
  );
  for (const read of readOps) {
    const runs = { sqlite: [] as number[], clickhouse: [] as number[] };
    const summaries = { sqlite: [] as Summary[], clickhouse: [] as Summary[] };
    for (const backend of backendNames) {
      await read.measure(backend); // throwaway warm-up
      for (let run = 0; run < 3; run++) {
        const measured = await read.measure(backend);
        runs[backend].push(round1(measured.milliseconds));
        summaries[backend].push(measured.summary);
      }
    }
    const [sqlite] = summaries.sqlite;
    const [clickhouse] = summaries.clickhouse;
    const match = sqlite.count === clickhouse.count && sqlite.check === clickhouse.check;
    if (!match)
      fail(
        `${read.op} at ${size}: sqlite ${sqlite.count} (${sqlite.check}) vs clickhouse ${clickhouse.count} (${clickhouse.check})`,
      );
    results.reads.push({
      size,
      op: read.op,
      sqliteMs: median(runs.sqlite),
      clickhouseMs: median(runs.clickhouse),
      eventsReturned: sqlite.count,
      sqliteRunsMs: runs.sqlite,
      clickhouseRunsMs: runs.clickhouse,
      match,
    });
    log(results.reads[results.reads.length - 1]);
    await save();
  }
}
for (const backend of backendNames) {
  const seconds = elapsed[backend] / 1_000;
  results.ingest[backend].totalSeconds = round1(seconds);
  results.ingest[backend].eventsPerSec = Math.round((rounds * deviceCount * batchSize) / seconds);
}
await Promise.all(backendNames.map((backend) => ingestStores[backend].dispose()));

// --- Storage before and after OPTIMIZE ----------------------------------------
await waitForMerges();
results.storage.sqliteBytes = await sqliteBytes();
const before = await partsState();
results.storage.clickhouseBeforeOptimize = before;
results.storage.clickhouseCompressedBytes = before.compressedBytes + before.projectionCompressedBytes;
results.storage.clickhouseUncompressedBytes = before.uncompressedBytes + before.projectionUncompressedBytes;
results.notes.push(
  'ClickHouse storage bytes include the events_by_time projection (a full second copy sorted by time); the before/after breakdowns list table and projection separately. SQLite bytes are the whole usage.sqlite file after a TRUNCATE checkpoint: devices, usage_dimensions, and both indexes included.',
);
await save();

// --- Native aggregation queries -----------------------------------------------
const tokenSum = (prefix: string) =>
  ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .map((field) => `json_extract(${prefix}payload, '$.${field}')`)
    .join(' + ');
const windowParams = { start: formatTimestamp(window30d.start), end: formatTimestamp(window30d.end) };
const chWindow = "timestamp >= {start:DateTime64(3, 'UTC')} AND timestamp < {end:DateTime64(3, 'UTC')}";
const chTokens = 'input_tokens + output_tokens + cache_read_tokens + cache_write_tokens';
const aggregateColumns = [
  'timestamp',
  'harness',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost_usd',
  'is_deleted',
];
const drilldownSession = generateBatch(Math.floor(rounds / 2), 7)[0].sessionId;
type Row = Record<string, unknown>;
// Integer columns must match exactly; cost sums may differ in the last bits.
const sameRows = (left: readonly Row[], right: readonly Row[], keys: readonly string[], costs: readonly string[]) =>
  left.length === right.length &&
  left.every((row, index) => {
    const other = right[index];
    return (
      keys.every((key) => String(row[key]) === String(other[key])) &&
      costs.every(
        (key) => Math.abs(Number(row[key]) - Number(other[key])) <= 1e-9 * Math.max(1, Math.abs(Number(row[key]))),
      )
    );
  });
const nativeQueries = [
  {
    op: 'dailyByHarness30d',
    sqlite: (database: Database) =>
      database
        .query<Row, [string, string]>(
          `SELECT substr(timestamp, 1, 10) AS day, json_extract(payload, '$.harness') AS harness,
            SUM(${tokenSum('')}) AS tokens, SUM(json_extract(payload, '$.costUsd')) AS cost, COUNT(*) AS events
          FROM usage_events WHERE timestamp >= ? AND timestamp < ?
          GROUP BY day, harness ORDER BY day, harness`,
        )
        .all(window30d.start, window30d.end),
    // Same narrowing as the store's window read: records with any version in
    // the window, then only those whose latest version is still inside it.
    clickhouse: () =>
      clickHouseRows(
        `SELECT toString(toDate(timestamp)) AS day, harness, sum(${chTokens}) AS tokens, sum(cost_usd) AS cost,
          count() AS events
        FROM (${latestEvents(aggregateColumns, `(device_id, id) IN (SELECT device_id, id FROM usage_events WHERE ${chWindow})`)})
        WHERE is_deleted = 0 AND ${chWindow}
        GROUP BY day, harness ORDER BY day, harness`,
        windowParams,
      ),
    compare: (left: readonly Row[], right: readonly Row[]) =>
      sameRows(left, right, ['day', 'harness', 'tokens', 'events'], ['cost']),
  },
  {
    op: 'topModelsByCost',
    sqlite: (database: Database) =>
      database
        .query<Row, []>(
          `SELECT json_extract(payload, '$.model') AS model, SUM(json_extract(payload, '$.costUsd')) AS cost,
            SUM(${tokenSum('')}) AS tokens, COUNT(*) AS events
          FROM usage_events GROUP BY model ORDER BY cost DESC LIMIT 10`,
        )
        .all(),
    clickhouse: () =>
      clickHouseRows(
        `SELECT model, sum(cost_usd) AS cost, sum(${chTokens}) AS tokens, count() AS events
        FROM (${latestEvents(aggregateColumns)}) WHERE is_deleted = 0
        GROUP BY model ORDER BY cost DESC LIMIT 10`,
      ),
    compare: (left: readonly Row[], right: readonly Row[]) =>
      sameRows(left, right, ['model', 'tokens', 'events'], ['cost']),
  },
  {
    op: 'sessionDrilldown',
    sqlite: (database: Database) =>
      database
        .query<Row, [string]>(
          `SELECT id, timestamp, payload FROM usage_events
          WHERE json_extract(payload, '$.sessionId') = ? ORDER BY timestamp, id`,
        )
        .all(drilldownSession),
    // latestEvents aliases each column to its argMax, so filters on a column
    // other than the key go through a subquery, as the store does for windows.
    clickhouse: () =>
      clickHouseRows(
        `SELECT * FROM (${latestEvents(eventColumns, `(device_id, id) IN (SELECT device_id, id FROM usage_events WHERE session_id = {session:String})`)})
        WHERE is_deleted = 0 AND session_id = {session:String} ORDER BY timestamp, id`,
        { session: drilldownSession },
      ),
    compare: (left: readonly Row[], right: readonly Row[]) => sameRows(left, right, ['id'], []),
  },
];
const timeNative = async <A>(run: () => A | Promise<A>, times = 5) => {
  await run(); // warm-up
  const runs: number[] = [];
  let value = await run();
  for (let index = 0; index < times; index++) {
    const started = performance.now();
    value = await run();
    runs.push(performance.now() - started);
  }
  return { milliseconds: median(runs), value };
};
{
  const database = new Database(sqlitePath, { readonly: true });
  for (const query of nativeQueries) {
    const sqlite = await timeNative(() => query.sqlite(database));
    const clickhouse = await timeNative(query.clickhouse);
    const match = query.compare(sqlite.value, clickhouse.value);
    if (!match)
      fail(`${query.op}: native query results differ (${sqlite.value.length} vs ${clickhouse.value.length} rows)`);
    results.nativeQueries.push({
      op: query.op,
      sqliteMs: sqlite.milliseconds,
      clickhouseMs: clickhouse.milliseconds,
      rows: sqlite.value.length,
      match,
    });
    log(results.nativeQueries[results.nativeQueries.length - 1]);
  }
  database.close();
  await save();
}

// OPTIMIZE FINAL merges every partition into one part and drops superseded versions.
{
  const started = performance.now();
  await clickHouse.command(`OPTIMIZE TABLE ${clickHouseConfig.database}.usage_events FINAL`);
  results.storage.optimizeSeconds = round1((performance.now() - started) / 1_000);
  await waitForMerges();
  const after = await partsState();
  results.storage.clickhouseAfterOptimize = after;
  results.storage.clickhouseOptimizedCompressedBytes = after.compressedBytes + after.projectionCompressedBytes;
  results.storage.clickhouseOptimizedUncompressedBytes = after.uncompressedBytes + after.projectionUncompressedBytes;
  for (const query of nativeQueries) {
    const measured = await timeNative(query.clickhouse);
    const entry = results.nativeQueries.find((item) => item.op === query.op);
    if (entry) entry.clickhouseOptimizedMs = measured.milliseconds;
  }
  log({ storage: results.storage });
  await save();
}

// --- Writes at 1M (warm long-lived stores, as a hub runs) ---------------------
{
  const writers = { sqlite: await stores.sqlite(), clickhouse: await stores.clickhouse() };
  const writeOps = [
    {
      op: 'resyncUnchanged1k',
      batch: (run: number) => ({ device: 3 + run, events: generateBatch(rounds - 1 - run, 3 + run), deletedIds: [] }),
      expected: { accepted: 0, updated: 0, deleted: 0 },
    },
    {
      op: 'corrections1k',
      batch: (run: number) => ({
        device: run,
        events: generateBatch(rounds - 1 - run, run).map((event) => ({
          ...event,
          outputTokens: event.outputTokens + 1,
        })),
        deletedIds: [],
      }),
      expected: { accepted: 0, updated: 1_000, deleted: 0 },
    },
    {
      op: 'newEvents1k',
      batch: (run: number) => ({ device: run, events: recentBatch(rounds + run, run), deletedIds: [] }),
      expected: { accepted: 1_000, updated: 0, deleted: 0 },
    },
    {
      // Deletes the events the previous op added, returning the dataset to 1M.
      op: 'delete1k',
      batch: (run: number) => ({
        device: run,
        events: [],
        deletedIds: recentBatch(rounds + run, run).map((event) => event.id),
      }),
      expected: { accepted: 0, updated: 0, deleted: 1_000 },
    },
  ];
  for (const backend of backendNames) await writers[backend].sync(devices[9], generateBatch(rounds - 1, 9)); // throwaway warm-up: unchanged resync
  for (const write of writeOps) {
    const runs = { sqlite: [] as number[], clickhouse: [] as number[] };
    for (const backend of backendNames) {
      for (let run = 0; run < 3; run++) {
        const batch = write.batch(run);
        const started = performance.now();
        const ack = await writers[backend].sync(devices[batch.device], batch.events, batch.deletedIds);
        runs[backend].push(round1(performance.now() - started));
        const { accepted, updated, deleted } = ack;
        if (
          accepted !== write.expected.accepted ||
          updated !== write.expected.updated ||
          deleted !== write.expected.deleted
        )
          fail(`${backend} ${write.op} run ${run}: ack ${JSON.stringify({ accepted, updated, deleted })}`);
      }
    }
    results.writes1m.push({
      op: write.op,
      sqliteMs: median(runs.sqlite),
      clickhouseMs: median(runs.clickhouse),
      sqliteRunsMs: runs.sqlite,
      clickhouseRunsMs: runs.clickhouse,
    });
    log(results.writes1m[results.writes1m.length - 1]);
    await save();
  }
  await Promise.all(backendNames.map((backend) => writers[backend].dispose()));
}

// --- Final consistency and the indexed SQLite drill-down variant ---------------
{
  const database = new Database(sqlitePath);
  const sqliteCount = database
    .query<{ events: number }, []>('SELECT COUNT(*) AS events FROM usage_events')
    .get()?.events;
  const clickhouseCount = Number(
    (await clickHouseRows(`SELECT count() AS events FROM (${latestEvents(['is_deleted'])}) WHERE is_deleted = 0`))[0]
      ?.events,
  );
  if (sqliteCount !== clickhouseCount)
    fail(`final event counts differ: sqlite ${sqliteCount} vs clickhouse ${clickhouseCount}`);
  results.notes.push(`Final live events after writes: sqlite ${sqliteCount}, clickhouse ${clickhouseCount}.`);

  // The store has no sessionId index. Measure what one expression index buys,
  // then drop it so the bench database keeps the store's real schema.
  const drilldown = nativeQueries.find((query) => query.op === 'sessionDrilldown');
  const entry = results.nativeQueries.find((item) => item.op === 'sessionDrilldown');
  if (drilldown && entry) {
    database.run("CREATE INDEX bench_session ON usage_events(json_extract(payload, '$.sessionId'))");
    entry.sqliteIndexedMs = (await timeNative(() => drilldown.sqlite(database))).milliseconds;
    database.run('DROP INDEX bench_session');
  }
  database.close();
}
await save();
log({ done: output, failures: results.failures.length });
