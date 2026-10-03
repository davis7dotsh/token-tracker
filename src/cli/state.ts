import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effect, FileSystem, Schema } from 'effect';

export class CliFailure extends Schema.TaggedError<CliFailure>()('CliFailure', {
  message: Schema.String,
}) {}

export const Connection = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  device: Schema.Struct({ id: Schema.String, name: Schema.String, platform: Schema.String }),
  intervalMinutes: Schema.Number,
  scheduler: Schema.NullOr(Schema.Literals(['systemd', 'launchd'])),
  connectedAt: Schema.String,
});
export type Connection = typeof Connection.Type;

export const Checkpoint = Schema.Struct({
  version: Schema.Literal(1),
  remote: Schema.String,
  deviceId: Schema.String,
  syncedAt: Schema.NullOr(Schema.String),
  eventDigests: Schema.Record(Schema.String, Schema.String),
});
export type Checkpoint = typeof Checkpoint.Type;

export const configDirectory = () =>
  resolve(
    process.env.TOKEN_TRACKER_CONFIG_DIR ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'token-tracker'),
  );

const parseJson = (text: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new CliFailure({ message: 'Invalid JSON in token-tracker configuration.' }),
  });

export const readConnection = Effect.fn('cli.readConnection')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(configDirectory(), 'connection.json');
  if (!(yield* fs.exists(path))) return null;
  const value = yield* parseJson(yield* fs.readFileString(path));
  return yield* Schema.decodeUnknownEffect(Connection)(value).pipe(
    Effect.mapError(() => new CliFailure({ message: 'Invalid connection configuration. Reconnect this machine.' })),
  );
});

export const writePrivateJson = Effect.fn('cli.writePrivateJson')(function* (name: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const directory = configDirectory();
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
  const destination = join(directory, name);
  const temporary = join(directory, `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
  yield* fs.writeFileString(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  yield* fs
    .rename(temporary, destination)
    .pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.catch(() => Effect.void))));
  yield* fs.chmod(destination, 0o600);
});

export const readCheckpoint = Effect.fn('cli.readCheckpoint')(function* (connection: Connection) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(configDirectory(), 'checkpoint.json');
  const empty: Checkpoint = {
    version: 1,
    remote: connection.url,
    deviceId: connection.device.id,
    syncedAt: null,
    eventDigests: {},
  };
  if (!(yield* fs.exists(path))) return empty;
  const value = yield* parseJson(yield* fs.readFileString(path));
  const checkpoint = yield* Schema.decodeUnknownEffect(Checkpoint)(value).pipe(
    Effect.mapError(
      () => new CliFailure({ message: 'Invalid sync checkpoint. Remove checkpoint.json to safely replay history.' }),
    ),
  );
  return checkpoint.remote === connection.url && checkpoint.deviceId === connection.device.id ? checkpoint : empty;
});

// A lock prevents an interactive sync and the scheduled job from racing their
// acknowledgements. The owner PID lets the next run recover after a crash.
export const syncLock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = configDirectory();
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'sync.lock');
  if (yield* fs.exists(path)) {
    const owner = Number(yield* fs.readFileString(path));
    const alive =
      Number.isSafeInteger(owner) &&
      owner > 0 &&
      (() => {
        try {
          process.kill(owner, 0);
          return true;
        } catch (cause) {
          return !(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH');
        }
      })();
    if (alive) return yield* Effect.fail(new CliFailure({ message: 'Another sync is already running.' }));
    yield* fs.remove(path, { force: true });
  }
  return yield* Effect.acquireRelease(
    fs
      .writeFileString(path, String(process.pid), { flag: 'wx', mode: 0o600 })
      .pipe(Effect.mapError(() => new CliFailure({ message: 'Another sync is already running.' }))),
    () => fs.remove(path, { force: true }).pipe(Effect.catch(() => Effect.void)),
  );
});
