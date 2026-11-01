import { Effect } from 'effect';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { StorageFailure } from '../../shared/rpc';

// Explicit and XDG locations win everywhere. Windows otherwise uses roaming
// AppData, so device-id, credentials, and checkpoints share one directory.
export const configDirectory = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) => {
  if (env.TOKEN_TRACKER_CONFIG_DIR !== undefined) return env.TOKEN_TRACKER_CONFIG_DIR;
  const path = platform === 'win32' ? win32 : posix;
  if (platform === 'win32' && env.XDG_CONFIG_HOME === undefined)
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'token-tracker');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'token-tracker');
};

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
