import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { DashboardResponse, Device, DeviceRegistration, SyncAck, SyncBatch, UsageQuery } from './domain';
import { PricingFailure, PricingInfo, PricingPolicy, PricingRule } from './pricing';

export const PricingSettings = Schema.Struct({
  info: PricingInfo,
  unresolved: Schema.Array(Schema.Struct({ model: Schema.String, tokens: Schema.Number, reason: Schema.String })),
  // Public hubs require the pairing secret for pricing changes from the browser.
  secretRequired: Schema.Boolean,
});
export type PricingSettings = typeof PricingSettings.Type;

export class UsageFailure extends Schema.TaggedError<UsageFailure>()('UsageFailure', {
  message: Schema.String,
}) {}

export class StorageFailure extends Schema.TaggedError<StorageFailure>()('StorageFailure', {
  message: Schema.String,
}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {
  message: Schema.String,
}) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()('InvalidRequest', {
  message: Schema.String,
}) {}

const SyncFailure = Schema.Union([StorageFailure, Unauthorized, InvalidRequest]);

export const UsageRpc = RpcGroup.make(
  Rpc.make('GetUsage', { payload: UsageQuery, success: DashboardResponse, error: UsageFailure }),
  Rpc.make('GetDevices', { success: Schema.Array(Device), error: StorageFailure }),
  Rpc.make('GetPricing', {
    payload: UsageQuery,
    success: PricingSettings,
    error: Schema.Union([PricingFailure, UsageFailure]),
  }),
  Rpc.make('GetPricingPolicy', {
    payload: { revision: Schema.optionalKey(Schema.String) },
    success: Schema.NullOr(PricingPolicy),
    error: PricingFailure,
  }),
  Rpc.make('SetPricingRule', {
    payload: { rule: PricingRule, adminSecret: Schema.String },
    success: PricingInfo,
    error: Schema.Union([PricingFailure, Unauthorized]),
  }),
  Rpc.make('DeletePricingRule', {
    payload: { model: Schema.String, adminSecret: Schema.String },
    success: PricingInfo,
    error: Schema.Union([PricingFailure, Unauthorized]),
  }),
  Rpc.make('RefreshPricing', {
    payload: { adminSecret: Schema.String },
    success: PricingInfo,
    error: Schema.Union([PricingFailure, Unauthorized]),
  }),
  Rpc.make('RegisterDevice', {
    payload: { pairingSecret: Schema.String, device: DeviceRegistration },
    success: Schema.Struct({ device: Device, token: Schema.String }),
    error: SyncFailure,
  }),
  Rpc.make('SyncUsage', {
    payload: { deviceId: Schema.String, token: Schema.String, batch: SyncBatch },
    success: SyncAck,
    error: SyncFailure,
  }),
  Rpc.make('ImportUsage', {
    payload: { pairingSecret: Schema.String, batch: SyncBatch },
    success: SyncAck,
    error: SyncFailure,
  }),
);
