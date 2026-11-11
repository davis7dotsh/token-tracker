import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import {
  DashboardPage,
  DashboardPageDelta,
  DashboardResponse,
  SessionExport,
  UsageInfo,
  Device,
  DeviceRegistration,
  SyncAck,
  SyncBatch,
  UsageQuery,
  SessionSort,
} from './domain';
import { PricingFailure, PricingInfo, PricingPolicy, PricingRule } from './pricing';

const unresolvedModels = Schema.Array(
  Schema.Struct({ model: Schema.String, tokens: Schema.Number, reason: Schema.String }),
);
const pricingCatalog = {
  info: PricingInfo,
  // Public hubs require the pairing secret for pricing changes from the browser.
  secretRequired: Schema.Boolean,
};
export const PricingSettings = Schema.Struct({ ...pricingCatalog, unresolved: unresolvedModels });
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

// Browser administration: device and pricing changes use the same rule.
export const AdminAccess = Schema.Struct({
  secretRequired: Schema.Boolean,
  // This hub's own machine is collected directly and cannot be renamed, revoked, or restored.
  localDeviceId: Schema.NullOr(Schema.String),
});
export type AdminAccess = typeof AdminAccess.Type;

export const HubInfo = Schema.Struct({
  version: Schema.String,
  localDeviceName: Schema.NullOr(Schema.String),
  devices: Schema.Number,
  activeDevices: Schema.Number,
  pricing: PricingInfo.mapFields(({ source, updatedAt, checkedAt, refreshError }) => ({
    source,
    updatedAt,
    checkedAt,
    refreshError,
  })),
});
export type HubInfo = typeof HubInfo.Type;

export const UsageRpc = RpcGroup.make(
  Rpc.make('GetUsage', { payload: UsageQuery, success: DashboardResponse, error: UsageFailure }),
  Rpc.make('GetSessionExport', { payload: UsageQuery, success: SessionExport, error: UsageFailure }),
  Rpc.make('GetUsagePage', {
    payload: {
      query: UsageQuery,
      page: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      sort: Schema.optionalKey(SessionSort),
    },
    success: DashboardPage,
    error: UsageFailure,
  }),
  Rpc.make('GetUsagePageUpdate', {
    payload: {
      query: UsageQuery,
      page: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      sort: Schema.optionalKey(SessionSort),
      viewRevision: Schema.String.check(Schema.isMaxLength(64)),
      sessionOffset: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    },
    success: Schema.Union([DashboardPageDelta, DashboardPage]),
    error: UsageFailure,
  }),
  Rpc.make('GetUsageInfo', { payload: UsageQuery, success: UsageInfo, error: UsageFailure }),
  Rpc.make('GetHubInfo', { success: HubInfo, error: Schema.Union([PricingFailure, StorageFailure]) }),
  Rpc.make('GetDevices', { success: Schema.Array(Device), error: StorageFailure }),
  Rpc.make('GetAdminAccess', { success: AdminAccess }),
  Rpc.make('RenameDevice', {
    payload: { deviceId: Schema.String, name: Schema.String, adminSecret: Schema.String },
    success: Device,
    error: SyncFailure,
  }),
  Rpc.make('RevokeDevice', {
    payload: { deviceId: Schema.String, adminSecret: Schema.String },
    success: Device,
    error: SyncFailure,
  }),
  Rpc.make('RestoreDevice', {
    payload: { deviceId: Schema.String, adminSecret: Schema.String },
    success: Device,
    error: SyncFailure,
  }),
  Rpc.make('GetPricingCatalog', { success: Schema.Struct(pricingCatalog), error: PricingFailure }),
  Rpc.make('GetUnresolvedPricing', {
    payload: UsageQuery,
    success: Schema.Struct({ revision: Schema.String, unresolved: unresolvedModels }),
    error: Schema.Union([PricingFailure, UsageFailure]),
  }),
  Rpc.make('GetPricing', {
    payload: UsageQuery,
    success: PricingSettings,
    error: Schema.Union([PricingFailure, UsageFailure]),
  }),
  Rpc.make('GetPricingPolicy', {
    payload: {
      revision: Schema.optionalKey(Schema.String),
      deviceId: Schema.optionalKey(Schema.String),
      token: Schema.optionalKey(Schema.String),
      pairingSecret: Schema.optionalKey(Schema.String),
    },
    success: Schema.NullOr(PricingPolicy),
    error: Schema.Union([PricingFailure, Unauthorized, StorageFailure]),
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
