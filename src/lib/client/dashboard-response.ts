import type { DashboardResponse, SourceStatus, Totals } from '../shared/domain';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown) => typeof value === 'string';
const number = (value: unknown) => typeof value === 'number';
const array = (value: unknown, check: (item: unknown) => boolean): value is unknown[] =>
  Array.isArray(value) && value.every(check);
const strings = (value: unknown) => array(value, string);
const fields = (value: Record<string, unknown>, keys: readonly string[], check: (item: unknown) => boolean) =>
  keys.every((key) => check(value[key]));
const optional = (value: unknown, check: (item: unknown) => boolean) => value === undefined || check(value);
const harnesses = { claude: true, codex: true, pi: true, grok: true, muse: true } satisfies Record<
  DashboardResponse['sessions'][number]['harness'],
  boolean
>;
const ranges = { today: true, '7d': true, '30d': true, '6m': true, '90d': true, all: true } satisfies Record<
  DashboardResponse['range'],
  boolean
>;
const sourceStatuses = { missing: true, empty: true, ready: true, partial: true, error: true } satisfies Record<
  SourceStatus['status'],
  boolean
>;
const member = (value: unknown, values: Record<string, boolean>) => string(value) && Object.hasOwn(values, value);
const totalKeys = [
  'tokens',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'costUSD',
  'unpricedTokens',
  'sessions',
  'requests',
  'cacheHitRate',
] as const satisfies readonly (keyof Totals)[];
const totals = (value: unknown) => record(value) && fields(value, totalKeys, number);
const breakdown = (value: unknown) => record(value) && string(value.name) && totals(value);
const series = (value: unknown) =>
  record(value) &&
  string(value.name) &&
  fields(value, ['tokens', 'costUSD'], number) &&
  optional(value.unpricedTokens, number);
const bucket = (value: unknown): value is Record<string, unknown> =>
  record(value) &&
  fields(value, ['tokens', 'costUSD'], number) &&
  array(value.harnesses, breakdown) &&
  optional(value.providers, (items) => array(items, series)) &&
  optional(value.models, (items) => array(items, series)) &&
  optional(value.projects, (items) => array(items, series));
const session = (value: unknown) =>
  record(value) &&
  totals(value) &&
  fields(value, ['id', 'model', 'provider', 'project', 'deviceId', 'startedAt', 'lastActiveAt'], string) &&
  member(value.harness, harnesses) &&
  (value.repository === null || string(value.repository)) &&
  fields(value, ['sessionTitle', 'projectName', 't3ThreadId', 't3ThreadUrl'], (item) => optional(item, string));
const source = (value: unknown) =>
  record(value) &&
  member(value.harness, harnesses) &&
  string(value.path) &&
  fields(value, ['files', 'events'], number) &&
  member(value.status, sourceStatuses) &&
  optional(value.error, string);
const filters = (value: unknown) =>
  record(value) &&
  fields(value, ['harnesses', 'models', 'providers', 'projects', 'devices'], strings) &&
  optional(value.selectedModels, strings) &&
  array(value.modelProviders, (item) => record(item) && fields(item, ['model', 'provider'], string));
const cost = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const projectInsight = (value: unknown) =>
  record(value) &&
  string(value.name) &&
  fields(value, ['tokens', 'costUSD', 'unpricedTokens', 'sessions'], number) &&
  strings(value.paths) &&
  strings(value.projectNames) &&
  optional(value.lastActiveAt, string);
const tokenCostPart = (value: unknown) =>
  record(value) &&
  cost(value.costUSD) &&
  typeof value.unavailableTokens === 'number' &&
  Number.isInteger(value.unavailableTokens) &&
  value.unavailableTokens >= 0;
const tokenCosts = (value: unknown) =>
  record(value) &&
  fields(value, ['input', 'output', 'cacheRead', 'cacheWrite'], tokenCostPart) &&
  cost(value.unattributedCostUSD);

// Keep the browser boundary structural, matching DashboardResponse without the
// collector's Effect runtime. Missing or incompatible results must never enter
// reactive page state; optional legacy fields and additional fields stay valid.
export const isDashboardResponse = (value: unknown): value is DashboardResponse =>
  record(value) &&
  fields(value, ['machine', 'generatedAt', 'timezone'], string) &&
  member(value.range, ranges) &&
  record(value.period) &&
  fields(value.period, ['start', 'end'], string) &&
  totals(value.totals) &&
  (value.previous === null || totals(value.previous)) &&
  optional(value.tokenCosts, tokenCosts) &&
  optional(value.projectInsights, (items) => array(items, projectInsight)) &&
  array(value.daily, (item) => bucket(item) && string(item.date)) &&
  array(value.hourly, (item) => bucket(item) && fields(item, ['start', 'end'], string)) &&
  fields(value, ['harnesses', 'models', 'providers', 'projects', 'devices'], (items) => array(items, breakdown)) &&
  array(value.sessions, session) &&
  filters(value.filters) &&
  array(value.sources, source) &&
  strings(value.warnings) &&
  record(value.pricing) &&
  fields(value.pricing, ['method', 'updatedAt'], string);
