import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Console, Effect, FileSystem, Path, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpIncomingMessage } from 'effect/http';
import { PriceSnapshot } from '../src/lib/server/usage/pricing';

const source = 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json';
const download = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const UpstreamPrices = Schema.Record(Schema.String, Schema.Unknown);
const rateField =
  /^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(?:_|$)/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class PricingUpdateError extends Schema.TaggedError<PricingUpdateError>()('PricingUpdateError', {
  message: Schema.String,
}) {}

const update = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const response = yield* client.get(download);
  const raw = yield* HttpIncomingMessage.schemaBodyJson(UpstreamPrices)(response);
  const models: Record<string, Record<string, number>> = {};
  for (const [model, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const rates: Record<string, number> = {};
    for (const [field, rate] of Object.entries(value)) {
      if (!rateField.test(field) || rate === null || rate === undefined) continue;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
        return yield* Effect.fail(
          new PricingUpdateError({
            message: `Invalid price for ${model}: ${field}. The bundled snapshot was not changed.`,
          }),
        );
      }
      rates[field] = rate;
    }
    // Keep every tier, cache TTL, and context threshold provided by upstream.
    // A model without both base input and output prices stays unpriced.
    if (rates.input_cost_per_token !== undefined && rates.output_cost_per_token !== undefined) models[model] = rates;
  }
  if (Object.keys(models).length < 100) {
    return yield* Effect.fail(
      new PricingUpdateError({
        message: 'The downloaded price catalog is unexpectedly incomplete. The bundled snapshot was not changed.',
      }),
    );
  }
  const snapshot = yield* Schema.decodeUnknownEffect(PriceSnapshot)({
    source,
    updatedAt: new Date().toISOString().slice(0, 10),
    models,
  });
  const target = path.resolve(process.argv[2] ?? path.join(import.meta.dir, '../src/lib/server/usage/pricing.json'));
  const temporary = `${target}.tmp-${process.pid}`;
  yield* fs.writeFileString(temporary, JSON.stringify(snapshot) + '\n');
  yield* fs.rename(temporary, target);
  yield* Console.log(
    `Updated ${Object.keys(snapshot.models).length} model prices (${snapshot.updatedAt}) in ${target}`,
  );
});

update.pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(BunServices.layer), BunRuntime.runMain);
