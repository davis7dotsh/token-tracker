import { Effect, FileSystem, Path, Result } from 'effect';
import type { UsageEvent } from '../../shared/domain';
import { queryT3Databases, type T3Metadata } from './t3-database';
import { runT3DatabaseProcess } from './t3-process';

type T3Options = { home: string; dataDirectory?: string; url?: string };
const text = (value: unknown, maximum = 1024) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value.trim() : undefined;
export const t3MetadataKey = (event: Pick<UsageEvent, 'harness' | 'sessionId'>) =>
  `${event.harness}:${event.sessionId}`;

export const readT3Metadata = Effect.fn('usage.readT3Metadata')(
  function* (options: T3Options) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const configured = options.dataDirectory ?? process.env.TOKEN_TRACKER_T3_DATA_DIR;
    const root = configured?.trim() || path.join(options.home, '.t3', 'userdata');
    const directory = path.resolve(
      root === '~' ? options.home : root.startsWith('~/') ? path.join(options.home, root.slice(2)) : root,
    );
    const baseUrl = options.url ?? process.env.TOKEN_TRACKER_T3_URL ?? 'https://app.t3.codes';
    const identityPath = path.join(directory, 'environment-id');
    const identityInfo = yield* Effect.result(fs.stat(identityPath));
    const identity =
      Result.isSuccess(identityInfo) && identityInfo.success.type === 'File' && identityInfo.success.size <= 512n
        ? yield* Effect.result(fs.readFileString(identityPath))
        : undefined;
    const environmentId = identity && Result.isSuccess(identity) ? text(identity.success, 512) : undefined;
    const filenames: string[] = [];
    for (const name of ['statev2.sqlite', 'state.sqlite']) {
      const filename = path.join(directory, name);
      const info = yield* Effect.result(fs.stat(filename));
      if (Result.isFailure(info) || info.success.type !== 'File' || info.success.size > 2_147_483_648n) continue;
      filenames.push(filename);
    }
    if (filenames.length === 0) return new Map<string, T3Metadata>();
    return yield* runT3DatabaseProcess(queryT3Databases, { filenames, environmentId, baseUrl });
  },
  (effect) =>
    effect.pipe(
      Effect.timeout('1 second'),
      Effect.catch(() => Effect.succeed(new Map<string, T3Metadata>())),
    ),
);
