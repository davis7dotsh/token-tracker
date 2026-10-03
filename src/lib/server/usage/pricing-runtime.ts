import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpIncomingMessage } from 'effect/http';
import { PriceSnapshot, PricingFailure, PricingPolicy, PricingRule, type PricingInfo } from '../../shared/pricing';
import { bundledPolicy, prices, validatePricingRules } from './pricing';

export const PRICING_SOURCE = 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json';
export const PRICING_DOWNLOAD =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const stateFile = 'pricing-state.json';
const maximumStateBytes = 20 * 1024 * 1024;
const StoredPricing = Schema.Struct({
  catalog: PriceSnapshot,
  rules: Schema.Array(PricingRule),
  checkedAt: Schema.NullOr(Schema.String),
  refreshError: Schema.NullOr(Schema.String),
});
type StoredPricing = typeof StoredPricing.Type;
export type PricingState = { readonly policy: PricingPolicy; readonly info: PricingInfo };
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
const revision = (stored: StoredPricing) =>
  createHash('sha256')
    .update(stableJson([stored.catalog, stored.rules]))
    .digest('hex');
const defaultStored = (): StoredPricing => ({ catalog: prices, rules: [], checkedAt: null, refreshError: null });
const dataDirectory = (directory?: string) =>
  resolve(
    directory ??
      process.env.TOKEN_TRACKER_DATA_DIR ??
      join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'token-tracker'),
  );
const toState = (stored: StoredPricing): PricingState => {
  const policy = { catalog: stored.catalog, rules: stored.rules, revision: revision(stored) };
  return {
    policy,
    info: {
      revision: policy.revision,
      updatedAt: stored.catalog.updatedAt,
      checkedAt: stored.checkedAt,
      source: stored.catalog.source,
      rules: stored.rules,
      models: [...new Set([...Object.keys(stored.catalog.models), ...stored.rules.map((rule) => rule.model)])].sort(),
      refreshError: stored.refreshError,
    },
  };
};
const failure = (message: string) => new PricingFailure({ message });
const readStored = async (directory: string): Promise<StoredPricing> => {
  try {
    const contents = await readFile(join(directory, stateFile));
    if (contents.byteLength > maximumStateBytes) throw failure('The saved pricing catalog is too large.');
    const stored = Schema.decodeUnknownSync(StoredPricing)(JSON.parse(contents.toString('utf8')));
    const invalid = validatePricingRules(stored.catalog, stored.rules);
    if (invalid) throw failure(invalid);
    return stored;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return defaultStored();
    return {
      ...defaultStored(),
      refreshError: 'The saved pricing catalog could not be read; bundled prices remain available.',
    };
  }
};
const persistStored = async (directory: string, stored: StoredPricing) => {
  const temporary = join(directory, `${stateFile}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(stored) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, join(directory, stateFile));
  } catch {
    throw failure('Could not save pricing settings. Check the dashboard data directory.');
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return toState(stored);
};

// Serialize same-process writes without holding the lock during network I/O.
// A catalog refresh merges into the latest rules, so it cannot erase an edit
// made while the upstream request was running.
const pendingWrites = new Map<string, Promise<unknown>>();
const exclusive = <A>(directory: string, action: () => Promise<A>) => {
  const previous = pendingWrites.get(directory) ?? Promise.resolve();
  const current = previous.then(action, action);
  pendingWrites.set(directory, current);
  void current
    .finally(() => {
      if (pendingWrites.get(directory) === current) pendingWrites.delete(directory);
    })
    .catch(() => undefined);
  return current;
};
const effectFailure = (error: unknown) =>
  error instanceof PricingFailure ? error : failure('Could not access pricing settings.');

// Local/manual checks never create directories, refresh prices, or change a
// checkpoint. They can use the same durable policy as the server offline.
export const loadPricing = (directory?: string) =>
  Effect.tryPromise({
    try: async () => toState(await readStored(dataDirectory(directory))),
    catch: effectFailure,
  });
export const pricingRefreshDue = (info: PricingInfo, now = new Date()) =>
  info.checkedAt === null ||
  !Number.isFinite(Date.parse(info.checkedAt)) ||
  now.getTime() - Date.parse(info.checkedAt) >= 86_400_000;

// Connected collectors install the central server's already validated policy
// during sync. The content hash keeps local checks and server estimates on the
// exact same rules and rates, without a network request during manual checks.
export const installPricingPolicy = (policy: PricingPolicy, directory?: string, expectedLocalRevision?: string) =>
  Effect.tryPromise({
    try: () =>
      exclusive(dataDirectory(directory), async () => {
        const decoded = Schema.decodeUnknownSync(PricingPolicy)(policy);
        const invalid = validatePricingRules(decoded.catalog, decoded.rules);
        if (invalid) throw failure(invalid);
        const stored = {
          catalog: decoded.catalog,
          rules: decoded.rules,
          checkedAt: new Date().toISOString(),
          refreshError: null,
        };
        if (revision(stored) !== decoded.revision)
          throw failure(
            'The received pricing policy does not match its revision. The previous settings were retained.',
          );
        const current = await readStored(dataDirectory(directory));
        const currentRevision = revision(current);
        if (currentRevision === decoded.revision) return toState(current);
        if (expectedLocalRevision !== undefined && currentRevision !== expectedLocalRevision) {
          throw failure(
            'Local pricing settings changed while downloading the policy. They were retained; retry sync to use the latest settings.',
          );
        }
        return persistStored(dataDirectory(directory), stored);
      }),
    catch: (error) =>
      error instanceof PricingFailure
        ? error
        : failure('The received pricing policy is invalid. The previous settings were retained.'),
  });

export const setPricingRule = (rule: PricingRule, directory?: string) =>
  Effect.tryPromise({
    try: () =>
      exclusive(dataDirectory(directory), async () => {
        const decoded = Schema.decodeUnknownSync(PricingRule)(rule);
        const current = await readStored(dataDirectory(directory));
        const rules = [...current.rules.filter((item) => item.model !== decoded.model), decoded].sort((left, right) =>
          compareKeys(left.model, right.model),
        );
        const invalid = validatePricingRules(current.catalog, rules);
        if (invalid) throw failure(invalid);
        return persistStored(dataDirectory(directory), { ...current, rules });
      }),
    catch: (error) =>
      error instanceof PricingFailure ? error : failure('Enter a valid model name and finite, nonnegative rates.'),
  });
export const deletePricingRule = (model: string, directory?: string) =>
  Effect.tryPromise({
    try: () =>
      exclusive(dataDirectory(directory), async () => {
        const current = await readStored(dataDirectory(directory));
        const rules = current.rules.filter((item) => item.model !== model);
        const invalid = validatePricingRules(current.catalog, rules);
        if (invalid) throw failure(invalid);
        return persistStored(dataDirectory(directory), { ...current, rules });
      }),
    catch: effectFailure,
  });

const UpstreamPrices = Schema.Record(Schema.String, Schema.Unknown);
const rateField =
  /^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(?:_|$)/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const decodeUpstreamPrices = Effect.fn('pricing.decodeUpstream')(function* (input: unknown, now = new Date()) {
  const raw = yield* Schema.decodeUnknownEffect(UpstreamPrices)(input).pipe(
    Effect.mapError(() => failure('The downloaded pricing catalog is invalid. The previous catalog was retained.')),
  );
  const entries: [string, Record<string, number>][] = [];
  for (const [model, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const rates: Record<string, number> = {};
    for (const [field, rate] of Object.entries(value)) {
      if (!rateField.test(field) || rate === null || rate === undefined) continue;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
        return yield* Effect.fail(
          failure(`The downloaded price for ${model} is invalid. The previous catalog was retained.`),
        );
      }
      rates[field] = rate;
    }
    if (rates.input_cost_per_token !== undefined && rates.output_cost_per_token !== undefined)
      entries.push([model, rates]);
  }
  if (entries.length < 100)
    return yield* Effect.fail(
      failure('The downloaded pricing catalog is unexpectedly incomplete. The previous catalog was retained.'),
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
export const refreshPricing = (directory?: string) =>
  Effect.gen(function* () {
    const fetchImplementation = yield* FetchHttpClient.Fetch;
    return yield* Effect.tryPromise({
      try: () => {
        const target = dataDirectory(directory);
        const existing = refreshing.get(target);
        if (existing) return existing;
        const refresh = (async () => {
          const result = await Effect.runPromiseExit(
            downloadCatalog.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchImplementation)),
          );
          return exclusive(target, async () => {
            const current = await readStored(target);
            const checkedAt = new Date().toISOString();
            if (result._tag === 'Failure') {
              return persistStored(target, {
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
            if (invalid) return persistStored(target, { ...current, checkedAt, refreshError: invalid });
            return persistStored(target, { ...current, catalog, checkedAt, refreshError: null });
          });
        })();
        refreshing.set(target, refresh);
        void refresh
          .finally(() => {
            if (refreshing.get(target) === refresh) refreshing.delete(target);
          })
          .catch(() => undefined);
        return refresh;
      },
      catch: effectFailure,
    });
  });
