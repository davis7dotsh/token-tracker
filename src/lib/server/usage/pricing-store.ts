import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpIncomingMessage } from 'effect/http';
import { SqlClient } from 'effect/sql';
import { PriceSnapshot, PricingFailure, PricingPolicy, PricingRule, type PricingInfo } from '../../shared/pricing';
import { bundledPolicy, prices, validatePricingRules } from './pricing';

export const PRICING_SOURCE = 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json';
export const PRICING_DOWNLOAD =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const StoredPricing = Schema.Struct({
  catalog: PriceSnapshot,
  rules: Schema.Array(PricingRule),
  checkedAt: Schema.NullOr(Schema.String),
  refreshError: Schema.NullOr(Schema.String),
});
export type StoredPricing = typeof StoredPricing.Type;
export type PricingState = { readonly policy: PricingPolicy; readonly info: PricingInfo };

// Pricing settings persist through a storage port: private files on a Bun hub,
// or a SQLite row inside the Cloudflare hub's Durable Object.
export type PricingStorage = {
  // Identifies the shared state so writes serialize and refreshes coalesce.
  readonly key: string;
  readonly read: () => Promise<StoredPricing>;
  readonly write: (stored: StoredPricing) => Promise<void>;
};

const compareKeys = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const canonicalCatalogs = new WeakMap<typeof PriceSnapshot.Type, string>();
const canonicalCatalog = (catalog: typeof PriceSnapshot.Type) => {
  const cached = canonicalCatalogs.get(catalog);
  if (cached !== undefined) return cached;
  const canonical = stableJson(catalog);
  canonicalCatalogs.set(catalog, canonical);
  return canonical;
};
const revision = (stored: StoredPricing) =>
  createHash('sha256')
    .update('[')
    .update(canonicalCatalog(stored.catalog))
    .update(',')
    .update(stableJson(stored.rules))
    .update(']')
    .digest('hex');
export const defaultStored = (): StoredPricing => ({ catalog: prices, rules: [], checkedAt: null, refreshError: null });
export const unreadableStored = (): StoredPricing => ({
  ...defaultStored(),
  refreshError: 'The saved pricing catalog could not be read; bundled prices remain available.',
});
const pricingStates = new WeakMap<StoredPricing, PricingState>();
const catalogModelNames = new WeakMap<typeof PriceSnapshot.Type, readonly string[]>();
const modelNames = (catalog: typeof PriceSnapshot.Type) => {
  const cached = catalogModelNames.get(catalog);
  if (cached) return cached;
  const models = Object.keys(catalog.models).sort();
  catalogModelNames.set(catalog, models);
  return models;
};
const toState = (stored: StoredPricing): PricingState => {
  const cached = pricingStates.get(stored);
  if (cached) return cached;
  const policy = { catalog: stored.catalog, rules: stored.rules, revision: revision(stored) };
  const state = {
    policy,
    info: {
      revision: policy.revision,
      updatedAt: stored.catalog.updatedAt,
      checkedAt: stored.checkedAt,
      source: stored.catalog.source,
      rules: stored.rules,
      models: stored.rules.length
        ? [...new Set([...modelNames(stored.catalog), ...stored.rules.map((rule) => rule.model)])].sort()
        : modelNames(stored.catalog),
      refreshError: stored.refreshError,
    },
  };
  pricingStates.set(stored, state);
  return state;
};
export const pricingFailure = (message: string) => new PricingFailure({ message });

// Saved state is validated on every uncached read, whichever storage holds it.
export const decodeStoredPricing = (json: string) => {
  const stored = Schema.decodeUnknownSync(StoredPricing)(JSON.parse(json));
  const invalid = validatePricingRules(stored.catalog, stored.rules);
  if (invalid) throw pricingFailure(invalid);
  return stored;
};

// Serialize same-process writes without holding the lock during network I/O.
// A catalog refresh merges into the latest rules, so it cannot erase an edit
// made while the upstream request was running.
const pendingWrites = new Map<string, Promise<unknown>>();
const exclusive = <A>(key: string, action: () => Promise<A>) => {
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const current = previous.then(action, action);
  pendingWrites.set(key, current);
  void current
    .finally(() => {
      if (pendingWrites.get(key) === current) pendingWrites.delete(key);
    })
    .catch(() => undefined);
  return current;
};
const effectFailure = (error: unknown) =>
  error instanceof PricingFailure ? error : pricingFailure('Could not access pricing settings.');

export const pricingRefreshDue = (info: PricingInfo, now = new Date()) =>
  info.checkedAt === null ||
  !Number.isFinite(Date.parse(info.checkedAt)) ||
  now.getTime() - Date.parse(info.checkedAt) >= 86_400_000;

const UpstreamPrices = Schema.Record(Schema.String, Schema.Unknown);
const rateField =
  /^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(?:_|$)/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const decodeUpstreamPrices = Effect.fn('pricing.decodeUpstream')(function* (input: unknown, now = new Date()) {
  const raw = yield* Schema.decodeUnknownEffect(UpstreamPrices)(input).pipe(
    Effect.mapError(() =>
      pricingFailure('The downloaded pricing catalog is invalid. The previous catalog was retained.'),
    ),
  );
  const entries: [string, Record<string, number>][] = [];
  for (const [model, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const rates: Record<string, number> = {};
    for (const [field, rate] of Object.entries(value)) {
      if (!rateField.test(field) || rate === null || rate === undefined) continue;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
        return yield* Effect.fail(
          pricingFailure(`The downloaded price for ${model} is invalid. The previous catalog was retained.`),
        );
      }
      rates[field] = rate;
    }
    if (rates.input_cost_per_token !== undefined && rates.output_cost_per_token !== undefined)
      entries.push([model, rates]);
  }
  if (entries.length < 100)
    return yield* Effect.fail(
      pricingFailure('The downloaded pricing catalog is unexpectedly incomplete. The previous catalog was retained.'),
    );
  return {
    source: PRICING_SOURCE,
    updatedAt: now.toISOString(),
    models: Object.fromEntries(entries),
  } satisfies typeof PriceSnapshot.Type;
});
const downloadCatalog = Effect.gen(function* () {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const response = yield* client.get(PRICING_DOWNLOAD);
  const raw = yield* HttpIncomingMessage.schemaBodyJson(UpstreamPrices)(response);
  return yield* decodeUpstreamPrices(raw);
}).pipe(Effect.timeout('15 seconds'), Effect.provide(FetchHttpClient.layer));

const refreshing = new Map<string, Promise<PricingState>>();

export const makePricingRuntime = (storage: PricingStorage) => {
  const persist = async (stored: StoredPricing) => {
    await storage.write(stored);
    return toState(stored);
  };
  // Local/manual checks never refresh prices or change a checkpoint. They can
  // use the same durable policy as the server offline.
  const load = Effect.tryPromise({
    try: async () => toState(await storage.read()),
    catch: effectFailure,
  });
  // Connected collectors install the central server's already validated policy
  // during sync. The content hash keeps local checks and server estimates on the
  // exact same rules and rates, without a network request during manual checks.
  const install = (policy: PricingPolicy, expectedLocalRevision?: string) =>
    Effect.tryPromise({
      try: () =>
        exclusive(storage.key, async () => {
          const decoded = Schema.decodeUnknownSync(PricingPolicy)(policy);
          const invalid = validatePricingRules(decoded.catalog, decoded.rules);
          if (invalid) throw pricingFailure(invalid);
          const stored = {
            catalog: decoded.catalog,
            rules: decoded.rules,
            checkedAt: new Date().toISOString(),
            refreshError: null,
          };
          if (revision(stored) !== decoded.revision)
            throw pricingFailure(
              'The received pricing policy does not match its revision. The previous settings were retained.',
            );
          const current = await storage.read();
          const currentRevision = revision(current);
          if (currentRevision === decoded.revision) return toState(current);
          if (expectedLocalRevision !== undefined && currentRevision !== expectedLocalRevision) {
            throw pricingFailure(
              'Local pricing settings changed while downloading the policy. They were retained; retry sync to use the latest settings.',
            );
          }
          return persist(stored);
        }),
      catch: (error) =>
        error instanceof PricingFailure
          ? error
          : pricingFailure('The received pricing policy is invalid. The previous settings were retained.'),
    });
  const setRule = (rule: PricingRule) =>
    Effect.tryPromise({
      try: () =>
        exclusive(storage.key, async () => {
          const decoded = Schema.decodeUnknownSync(PricingRule)(rule);
          const current = await storage.read();
          const rules = [...current.rules.filter((item) => item.model !== decoded.model), decoded].sort((left, right) =>
            compareKeys(left.model, right.model),
          );
          const invalid = validatePricingRules(current.catalog, rules);
          if (invalid) throw pricingFailure(invalid);
          return persist({ ...current, rules });
        }),
      catch: (error) =>
        error instanceof PricingFailure
          ? error
          : pricingFailure('Enter a valid model name and finite, nonnegative rates.'),
    });
  const deleteRule = (model: string) =>
    Effect.tryPromise({
      try: () =>
        exclusive(storage.key, async () => {
          const current = await storage.read();
          const rules = current.rules.filter((item) => item.model !== model);
          const invalid = validatePricingRules(current.catalog, rules);
          if (invalid) throw pricingFailure(invalid);
          return persist({ ...current, rules });
        }),
      catch: effectFailure,
    });
  const refresh = Effect.gen(function* () {
    const fetchImplementation = yield* FetchHttpClient.Fetch;
    return yield* Effect.tryPromise({
      try: () => {
        const existing = refreshing.get(storage.key);
        if (existing) return existing;
        const refresh = (async () => {
          const result = await Effect.runPromiseExit(
            downloadCatalog.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchImplementation)),
          );
          return exclusive(storage.key, async () => {
            const current = await storage.read();
            const checkedAt = new Date().toISOString();
            if (result._tag === 'Failure') {
              return persist({
                ...current,
                checkedAt,
                refreshError:
                  'Could not refresh model prices. The previous catalog and your saved rules remain available.',
              });
            }
            const catalog = {
              ...result.value,
              models: { ...bundledPolicy.catalog.models, ...current.catalog.models, ...result.value.models },
            };
            const invalid = validatePricingRules(catalog, current.rules);
            if (invalid) return persist({ ...current, checkedAt, refreshError: invalid });
            return persist({ ...current, catalog, checkedAt, refreshError: null });
          });
        })();
        refreshing.set(storage.key, refresh);
        void refresh
          .finally(() => {
            if (refreshing.get(storage.key) === refresh) refreshing.delete(storage.key);
          })
          .catch(() => undefined);
        return refresh;
      },
      catch: effectFailure,
    });
  });
  return { load, install, setRule, deleteRule, refresh };
};

// A one-row table in the hub database. The single SQLite writer (a Durable
// Object, or one Bun process in tests) caches the decoded row it last wrote.
let sqlStorages = 0;
export const sqlPricingStorage = Effect.fn('pricing.sqlStorage')(function* () {
  const sql = yield* SqlClient.SqlClient;
  const key = `sql:${++sqlStorages}`;
  yield* sql`CREATE TABLE IF NOT EXISTS pricing_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`;
  let cached: StoredPricing | undefined;
  const read = async () => {
    if (cached) return cached;
    try {
      const rows = await Effect.runPromise(sql<{ payload: string }>`SELECT payload FROM pricing_state WHERE id = 1`);
      cached = rows[0] ? decodeStoredPricing(rows[0].payload) : defaultStored();
      return cached;
    } catch {
      return unreadableStored();
    }
  };
  const write = async (stored: StoredPricing) => {
    const payload = JSON.stringify(stored);
    try {
      await Effect.runPromise(
        sql`INSERT INTO pricing_state (id, payload) VALUES (1, ${payload})
          ON CONFLICT (id) DO UPDATE SET payload = excluded.payload`,
      );
    } catch {
      cached = undefined;
      throw pricingFailure('Could not save pricing settings in the hub database.');
    }
    cached = stored;
  };
  return { key, read, write } satisfies PricingStorage;
});
