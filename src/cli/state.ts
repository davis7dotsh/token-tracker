import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ByteSize, Effect, FileSystem, Schema } from 'effect';

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
  let checkpoint = empty;
  if (yield* fs.exists(path)) {
    const value = yield* parseJson(yield* fs.readFileString(path));
    const decoded = yield* Schema.decodeUnknownEffect(Checkpoint)(value).pipe(
      Effect.mapError(
        () => new CliFailure({ message: 'Invalid sync checkpoint. Remove checkpoint.json to safely replay history.' }),
      ),
    );
    if (decoded.remote === connection.url && decoded.deviceId === connection.device.id) checkpoint = decoded;
  }
  const journalPath = join(configDirectory(), 'checkpoint-journal.jsonl');
  if (!(yield* fs.exists(journalPath))) return checkpoint;
  const journal = yield* fs.readFileString(journalPath);
  // Each complete line is an acknowledged delta. A killed append may leave an
  // incomplete final line, which is safe to retry because uploads are idempotent.
  const lines = journal.split('\n');
  for (let index = 0; index < lines.length - 1; index++) {
    if (!lines[index].trim()) continue;
    const decoded = yield* parseJson(lines[index]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Checkpoint)),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!decoded || decoded.remote !== connection.url || decoded.deviceId !== connection.device.id) continue;
    Object.assign(checkpoint.eventDigests, decoded.eventDigests);
    checkpoint = { ...checkpoint, syncedAt: decoded.syncedAt };
  }
  return checkpoint;
});

// Journal writes grow with the acknowledged batch, rather than with all
// previously synced history. Snapshots remain compatible with older clients.
export const appendCheckpoint = Effect.fn('cli.appendCheckpoint')(function* (delta: Checkpoint) {
  const fs = yield* FileSystem.FileSystem;
  const directory = configDirectory();
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(join(directory, 'checkpoint-journal.jsonl'), `\n${JSON.stringify(delta)}\n`, {
    flag: 'a',
    mode: 0o600,
  });
});

export const compactCheckpoint = Effect.fn('cli.compactCheckpoint')(function* (checkpoint: Checkpoint) {
  const fs = yield* FileSystem.FileSystem;
  yield* writePrivateJson('checkpoint.json', checkpoint);
  // If interrupted between these operations, replaying the journal over the
  // new snapshot is harmless. Never remove acknowledgements before the rename.
  yield* fs.remove(join(configDirectory(), 'checkpoint-journal.jsonl'), { force: true });
});

export const compactCheckpointIfLarge = Effect.fn('cli.compactCheckpointIfLarge')(function* (checkpoint: Checkpoint) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(configDirectory(), 'checkpoint-journal.jsonl');
  if (!(yield* fs.exists(path))) return;
  const info = yield* fs.stat(path);
  // Empty heartbeat runs usually append a tiny delta. Bound their journal too,
  // so long-idle machines do not accumulate an ever-growing status read.
  if (ByteSize.toBigInt(info.size) >= 1024n * 1024n) yield* compactCheckpoint(checkpoint);
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
