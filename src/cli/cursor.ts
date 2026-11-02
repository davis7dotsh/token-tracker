import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { Console, Effect, FileSystem, Redacted, Schedule, Schema, Stdio, Stream } from 'effect';
import { Command, Flag, Prompt } from 'effect/cli';
import { CursorApiError, fetchCursorUsage } from '../lib/cursor/cloud';
import { cursorSnapshotName, readCursorSnapshot, type CursorSnapshot } from '../lib/server/usage/cursor-snapshot';
import { tokenTotal } from '../lib/server/usage/parsers';
import { CliFailure, configDirectory, writePrivateJson } from './state';

// Use a separate local OS-backed lock: pulls can take minutes and must not
// block uploads of the previous snapshot. SQLite releases it even on SIGKILL.
const cursorLock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = configDirectory();
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const db = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new Database(join(directory, 'cursor-lock.sqlite'), { create: true }),
      catch: () => new CliFailure({ message: 'Could not open the local Cursor lock.' }),
    }),
    (db) => Effect.sync(() => db.close()),
  );
  yield* Effect.try({
    try: () => db.run('BEGIN IMMEDIATE'),
    catch: () => new CliFailure({ message: 'Could not lock the Cursor snapshot. Another import may be running.' }),
  });
});

const keyName = 'cursor-key.json';
const keySchema = Schema.Struct({ key: Schema.String });
const maxKeyLength = 4096;
const invalidKey = () => new CliFailure({ message: 'Provide a single nonempty Cursor Cloud Agents API key.' });
const checkedKey = (raw: string) => {
  const key = raw.trim();
  return key.length > 0 && key.length <= maxKeyLength && /^[!-~]+$/.test(key)
    ? Effect.succeed(Redacted.make(key))
    : Effect.fail(invalidKey());
};

const promptKey = Effect.gen(function* () {
  if (process.env.CURSOR_API_KEY !== undefined) return yield* checkedKey(process.env.CURSOR_API_KEY);
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    const key = yield* Prompt.Hidden({ message: 'Cursor Cloud Agents API key (hidden)' });
    return yield* checkedKey(Redacted.value(key));
  }
  // Accept a private pipe without ever putting the key in a flag, log, or shell history.
  const text = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => '',
      (acc, chunk) =>
        acc.length + chunk.length > maxKeyLength + 2 ? Effect.fail(invalidKey()) : Effect.succeed(acc + chunk),
    ),
  );
  return yield* checkedKey(text);
});

const readKey = Effect.gen(function* () {
  if (process.env.CURSOR_API_KEY !== undefined) return yield* checkedKey(process.env.CURSOR_API_KEY);
  const fs = yield* FileSystem.FileSystem;
  const path = join(configDirectory(), keyName);
  if (!(yield* fs.exists(path)))
    return yield* Effect.fail(
      new CliFailure({ message: 'Run token-tracker cursor connect first, or set CURSOR_API_KEY for this invocation.' }),
    );
  const text = yield* fs.readFileString(path);
  // Do not let a schema error echo malformed credential file contents.
  const saved = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(keySchema)(JSON.parse(text)),
    catch: invalidKey,
  });
  return yield* checkedKey(saved.key);
});

export const mergeCursorSnapshot = (
  previous: CursorSnapshot | null,
  fresh: Awaited<ReturnType<typeof fetchCursorUsage>>,
  syncedAt: string,
): CursorSnapshot => {
  const refreshedAgents = new Set(fresh.agentIds);
  const retracted = new Set(previous?.retractedIds ?? []);
  const events = [...fresh.events];
  for (const event of previous?.events ?? []) {
    if (refreshedAgents.has(event.sessionId)) retracted.add(event.id);
    else events.push(event); // Disappearance from the API isn't evidence of deletion.
  }
  for (const event of fresh.events) retracted.delete(event.id);
  return { version: 1, syncedAt, events, warnings: [], ...(retracted.size ? { retractedIds: [...retracted] } : {}) };
};

const refresh = Effect.fn('cli.refreshCursor')(function* (providedKey?: Redacted.Redacted) {
  yield* cursorLock;
  const key = providedKey ?? (yield* readKey);
  const previous = yield* readCursorSnapshot();
  yield* Console.log('Reading Cursor cloud agent history…');
  const fresh = yield* Effect.tryPromise({
    try: async (signal) => {
      const started = Date.now();
      let completed = 0;
      let retryAt = 0;
      const report = () => {
        const seconds = Math.ceil((retryAt - Date.now()) / 1000);
        const state = seconds > 0 ? `rate limited; retrying in ${seconds}s` : 'reading history';
        console.error(
          `Cursor: ${completed} cloud agents read · ${Math.floor((Date.now() - started) / 1000)}s elapsed · ${state}…`,
        );
      };
      const timer = setInterval(report, 15_000);
      try {
        return await fetchCursorUsage(Redacted.value(key), {
          signal,
          onAgentComplete: (count) => {
            completed = count;
            if (count === 1) report();
          },
          onRateLimit: (waitMs) => {
            retryAt = Date.now() + waitMs;
            report();
          },
        });
      } finally {
        clearInterval(timer);
      }
    },
    catch: (error) =>
      new CliFailure({ message: error instanceof CursorApiError ? error.message : 'Could not fetch Cursor usage.' }),
  });
  const snapshot = mergeCursorSnapshot(previous, fresh, new Date().toISOString());
  yield* writePrivateJson(cursorSnapshotName, snapshot);
  if (providedKey) yield* writePrivateJson(keyName, { key: Redacted.value(key) });
  const tokens = snapshot.events.reduce((sum, event) => sum + tokenTotal(event), 0);
  yield* Console.log(
    `Refreshed ${fresh.agentIds.length} cloud agent(s). Local Cursor history: ${tokens.toLocaleString('en-US')} tokens.`,
  );
});

const connect = Command.make('connect', {}, () => Effect.scoped(Effect.flatMap(promptKey, (key) => refresh(key)))).pipe(
  Command.withDescription(
    'Import cloud agent usage and save the validated API key privately on this collector. Paste it at the hidden prompt or pass it on stdin.',
  ),
);
const sync = Command.make(
  'sync',
  {
    watch: Flag.Boolean('watch').pipe(Flag.withDefault(false)),
    interval: Flag.Int('interval').pipe(
      Flag.withDefault(15),
      Flag.withDescription('Minutes between refreshes in watch mode (1–1440).'),
    ),
  },
  Effect.fn('cli.cursorSync')(function* (options) {
    if (options.interval < 1 || options.interval > 1440)
      return yield* Effect.fail(new CliFailure({ message: '--interval must be 1–1440 minutes.' }));
    const once = Effect.scoped(refresh());
    if (!options.watch) return yield* once;
    yield* once.pipe(
      Effect.catch((error) => Console.error(`Cursor refresh failed; keeping the last snapshot: ${error.message}`)),
      Effect.repeat(Schedule.spaced(`${options.interval} minutes`)),
    );
  }),
).pipe(
  Command.withDescription(
    'Refresh local Cursor history using CURSOR_API_KEY or the saved key. Use --watch to repeat in the foreground. Does not push to the hub.',
  ),
);
const disconnect = Command.make('disconnect', {}, () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* cursorLock;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(join(configDirectory(), keyName), { force: true });
      yield* Console.log(
        'Removed the saved Cursor key. Imported usage is retained. To revoke the key, use your Cursor dashboard.',
      );
    }),
  ),
).pipe(Command.withDescription('Forget the saved Cursor key without deleting usage history.'));

export const cursor = Command.make('cursor').pipe(
  Command.withDescription('Import usage from the Cursor Cloud Agents API.'),
  Command.withSubcommands([connect, sync, disconnect]),
);
