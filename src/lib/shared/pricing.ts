import { Schema } from 'effect';

const ModelName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.makeFilter((value) => value === value.trim(), { expected: 'a trimmed model name' }),
);
const Rate = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

export const PriceSnapshot = Schema.Struct({
  updatedAt: Schema.String,
  source: Schema.String,
  models: Schema.Record(Schema.String, Schema.Record(Schema.String, Rate)),
});
export type PriceSnapshot = typeof PriceSnapshot.Type;

// Every rate is USD per one million tokens. An omitted cache rate means that
// price is unavailable; an explicit zero means those tokens are free.
export const PricingRates = Schema.Struct({
  inputPerMillion: Rate,
  outputPerMillion: Rate,
  cacheReadPerMillion: Schema.optionalKey(Rate),
  cacheWritePerMillion: Schema.optionalKey(Rate),
  cacheWrite1hPerMillion: Schema.optionalKey(Rate),
});
export const PricingRule = Schema.Union([
  Schema.Struct({ model: ModelName, kind: Schema.Literals(['alias']), target: ModelName }),
  Schema.Struct({
    model: ModelName,
    kind: Schema.Literals(['rates']),
    nickname: Schema.optionalKey(ModelName),
    rates: PricingRates,
  }),
  Schema.Struct({ model: ModelName, kind: Schema.Literals(['free']) }),
]);
export type PricingRule = typeof PricingRule.Type;

export const PricingPolicy = Schema.Struct({
  catalog: PriceSnapshot,
  rules: Schema.Array(PricingRule),
  revision: Schema.String,
});
export type PricingPolicy = typeof PricingPolicy.Type;

export const PricingInfo = Schema.Struct({
  revision: Schema.String,
  updatedAt: Schema.String,
  checkedAt: Schema.NullOr(Schema.String),
  source: Schema.String,
  rules: Schema.Array(PricingRule),
  models: Schema.Array(Schema.String),
  refreshError: Schema.NullOr(Schema.String),
});
export type PricingInfo = typeof PricingInfo.Type;

export class PricingFailure extends Schema.TaggedError<PricingFailure>()('PricingFailure', {
  message: Schema.String,
}) {}
