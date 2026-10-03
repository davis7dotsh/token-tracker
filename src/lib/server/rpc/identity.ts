import { Effect } from 'effect';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { StorageFailure } from '../../shared/rpc';

export const configDirectory = () =>
  process.env.TOKEN_TRACKER_CONFIG_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'token-tracker');

export const getLocalDeviceId = Effect.fn('identity.getLocalDeviceId')(function* () {
  return yield* Effect.tryPromise({
    try: async () => {
      const directory = configDirectory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'device-id');
      try {
        const existing = (await readFile(path, 'utf8')).trim();
        if (existing) return existing;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const id = randomUUID();
      try {
        await writeFile(path, `${id}\n`, { flag: 'wx', mode: 0o600 });
        return id;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
          return (await readFile(path, 'utf8')).trim();
        throw error;
      }
    },
    catch: () => new StorageFailure({ message: 'Could not read or create this machine’s identity.' }),
  });
});

export const getLocalDevice = Effect.fn('identity.getLocalDevice')(function* () {
  const id = yield* getLocalDeviceId();
  return { id, name: hostname(), platform: process.platform };
});
