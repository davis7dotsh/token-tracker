import { Data, Effect, Schema } from 'effect';
import { SessionMetadata } from '../../shared/domain';
import type { T3DatabaseInput, T3Metadata } from './t3-database';

class T3MetadataUnavailable extends Data.TaggedError('T3MetadataUnavailable') {}
const MetadataEntries = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.Struct({ ...SessionMetadata.fields, repositoryPaths: Schema.Array(Schema.String) }),
  ]),
);

export const runT3DatabaseProcess = (
  query: (input: T3DatabaseInput) => Promise<[string, T3Metadata][]>,
  input: T3DatabaseInput,
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn({
          // Compiled Bun binaries can also run Bun's runtime with this flag.
          // Embed the reader so production server/CLI builds need no assets.
          cmd: [
            process.execPath,
            '-e',
            `const input = await new Response(Bun.stdin.stream()).json();
             const entries = await (${query.toString()})(input);
             process.stdout.write(JSON.stringify(entries));`,
          ],
          env: { ...process.env, BUN_BE_BUN: '1' },
          stdin: new Blob([JSON.stringify(input)]),
          stdout: 'pipe',
          stderr: 'ignore',
        }),
      catch: () => new T3MetadataUnavailable(),
    }),
    (child) =>
      Effect.gen(function* () {
        const payload = yield* Effect.tryPromise({
          try: async () => {
            const payload: unknown = await new Response(child.stdout).json();
            if ((await child.exited) !== 0) throw new T3MetadataUnavailable();
            return payload;
          },
          catch: () => new T3MetadataUnavailable(),
        });
        const entries = yield* Schema.decodeUnknownEffect(MetadataEntries)(payload);
        return new Map(entries.map(([key, value]) => [key, { ...value, repositoryPaths: [...value.repositoryPaths] }]));
      }),
    (child) =>
      Effect.promise(async () => {
        // Effect interruption cannot stop native SQLite work on its own.
        // Kill and reap the isolated process before the timeout returns.
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }),
  );
