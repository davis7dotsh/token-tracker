import { randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
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
const checkedFingerprint = (file: BigIntStats) => {
  if (!file.isFile()) throw pricingFailure('The saved pricing catalog is not a regular file.');
  if (file.size > BigInt(maximumStateBytes)) throw pricingFailure('The saved pricing catalog is too large.');
  return fingerprintFor(file);
};
const storedFingerprint = async (directory: string) =>
  checkedFingerprint(await stat(join(directory, stateFile), { bigint: true }));
// On startup, SSR, RPC, and background refresh can all see the same cold
// catalog. Share only reads that observed the identical on-disk version. Each
// caller still handles failures according to its own strict/fallback policy.
const pendingReads = new Map<string, { fingerprint: string; read: Promise<StoredPricing> }>();
const readMatching = async (directory: string, fingerprint: string) => {
  const pending = pendingReads.get(directory);
  if (pending?.fingerprint === fingerprint) return pending.read;
  const read = (async () => {
    // A path replaced with a FIFO between stat and open must not pin an I/O worker.
    const handle = await open(join(directory, stateFile), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = checkedFingerprint(await handle.stat({ bigint: true }));
      const contents = await handle.readFile();
      if (contents.byteLength > maximumStateBytes) throw pricingFailure('The saved pricing catalog is too large.');
      const stored = decodeStoredPricing(contents.toString('utf8'));
      // An external writer can replace the file before open or while reading.
      if (opened === fingerprint && fingerprint === (await storedFingerprint(directory)))
        rememberStored(directory, fingerprint, stored);
      return stored;
    } finally {
      await handle.close();
    }
  })();
  if (pending || pendingReads.size < 32) pendingReads.set(directory, { fingerprint, read });
  try {
    return await read;
  } finally {
    if (pendingReads.get(directory)?.read === read) pendingReads.delete(directory);
  }
};
const readStored = async (directory: string, strict = false): Promise<StoredPricing> => {
  try {
    const fingerprint = await storedFingerprint(directory);
    const cached = storedByDirectory.get(directory);
    if (cached?.fingerprint === fingerprint) return cached.stored;
    return await readMatching(directory, fingerprint);
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
    if (process.platform !== 'win32') await chmod(directory, 0o700);
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
