import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PricingPolicy, PricingRule } from '../../shared/pricing';
import {
  decodeStoredPricing,
  defaultStored,
  makePricingRuntime,
  pricingFailure,
  unreadableStored,
  type PricingStorage,
  type StoredPricing,
} from './pricing-store';

export {
  decodeUpstreamPrices,
  PRICING_DOWNLOAD,
  PRICING_SOURCE,
  pricingRefreshDue,
  type PricingState,
} from './pricing-store';

const stateFile = 'pricing-state.json';
const maximumStateBytes = 20 * 1024 * 1024;
const dataDirectory = (directory?: string) =>
  resolve(
    directory ??
      process.env.TOKEN_TRACKER_DATA_DIR ??
      join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'token-tracker'),
  );
const storedByDirectory = new Map<string, { fingerprint: string | null; stored: StoredPricing }>();
const rememberStored = (directory: string, fingerprint: string | null, stored: StoredPricing) => {
  storedByDirectory.delete(directory);
  storedByDirectory.set(directory, { fingerprint, stored });
  if (storedByDirectory.size > 32) {
    const oldest = storedByDirectory.keys().next().value;
    if (oldest !== undefined) storedByDirectory.delete(oldest);
  }
};
// File identity and nanosecond timestamps detect atomic replacement and edits
// from other processes, while unchanged requests reuse a validated snapshot.
const fingerprintFor = (file: BigIntStats) => `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
const storedFingerprint = async (directory: string) => {
  const file = await stat(join(directory, stateFile), { bigint: true });
  if (file.size > BigInt(maximumStateBytes)) throw pricingFailure('The saved pricing catalog is too large.');
  return fingerprintFor(file);
};
const readStored = async (directory: string, strict = false): Promise<StoredPricing> => {
  try {
    const fingerprint = await storedFingerprint(directory);
    const cached = storedByDirectory.get(directory);
    if (cached?.fingerprint === fingerprint) return cached.stored;
    const contents = await readFile(join(directory, stateFile));
    if (contents.byteLength > maximumStateBytes) throw pricingFailure('The saved pricing catalog is too large.');
    const stored = decodeStoredPricing(contents.toString('utf8'));
    // A concurrent external write can change the path between stat and read.
    // Its snapshot is usable for this request but must not enter the cache.
    if (fingerprint === (await storedFingerprint(directory))) rememberStored(directory, fingerprint, stored);
    return stored;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      const cached = storedByDirectory.get(directory);
      if (cached?.fingerprint === null) return cached.stored;
      const stored = defaultStored();
      rememberStored(directory, null, stored);
      return stored;
    }
    if (strict) throw pricingFailure('Could not read or validate the saved pricing state.');
    return unreadableStored();
  }
};
const writeStored = async (directory: string, stored: StoredPricing) => {
  const temporary = join(directory, `${stateFile}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(stored) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    const written = await stat(temporary, { bigint: true });
    await rename(temporary, join(directory, stateFile));
    const saved = await stat(join(directory, stateFile), { bigint: true });
    if (
      saved.dev === written.dev &&
      saved.ino === written.ino &&
      saved.size === written.size &&
      saved.mtimeNs === written.mtimeNs
    )
      rememberStored(directory, fingerprintFor(saved), stored);
    else storedByDirectory.delete(directory);
  } catch {
    throw pricingFailure('Could not save pricing settings. Check the dashboard data directory.');
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

// Private `pricing-state.json` in the data directory, shared by the Bun hub,
// scheduled sync, and read-only local checks.
export const filePricingStorage = (directory?: string, strict = false): PricingStorage => {
  const target = dataDirectory(directory);
  return { key: target, read: () => readStored(target, strict), write: (stored) => writeStored(target, stored) };
};

export const filePricing = (directory?: string) => makePricingRuntime(filePricingStorage(directory));

export const loadPricing = (directory?: string, options: { strict?: boolean } = {}) =>
  makePricingRuntime(filePricingStorage(directory, options.strict)).load;
export const installPricingPolicy = (policy: PricingPolicy, directory?: string, expectedLocalRevision?: string) =>
  filePricing(directory).install(policy, expectedLocalRevision);
export const setPricingRule = (rule: PricingRule, directory?: string) => filePricing(directory).setRule(rule);
export const deletePricingRule = (model: string, directory?: string) => filePricing(directory).deleteRule(model);
export const refreshPricing = (directory?: string) => filePricing(directory).refresh;
