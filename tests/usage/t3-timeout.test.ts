import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { runT3DatabaseProcess } from '../../src/lib/server/usage/t3-process';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('a slow native SQLite query keeps the event loop responsive and is killed and reaped at its deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-t3-timeout-'));
  temporary.push(directory);
  const marker = join(directory, 'child.pid');
  let ticks = 0;
  const interval = setInterval(() => ticks++, 10);
  const started = performance.now();
  try {
    const result = await Effect.runPromise(
      runT3DatabaseProcess(
        async (input) => {
          const { Database } = await import('bun:sqlite');
          await Bun.write(input.filenames[0], String(process.pid));
          const database = new Database(':memory:');
          try {
            // This native query takes far longer than the deadline; it cannot
            // be interrupted by an Effect timer on the same JavaScript thread.
            database
              .query(`WITH RECURSIVE n(x) AS (VALUES (1) UNION ALL SELECT x + 1 FROM n WHERE x < 1000000)
                SELECT sum(a.x + b.x) FROM n a CROSS JOIN n b`)
              .get();
            return [];
          } finally {
            database.close();
          }
        },
        { filenames: [marker], baseUrl: 'https://app.t3.codes' },
      ).pipe(Effect.timeout('300 millis'), Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(ticks).toBeGreaterThan(5);
    const childPid = Number(await readFile(marker, 'utf8'));
    expect(childPid).toBeGreaterThan(0);
    // The timeout has awaited process exit, so no slow query remains running.
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    clearInterval(interval);
  }
});

test('the isolated reader validates optional metadata before returning it', async () => {
  const metadata = await Effect.runPromise(
    runT3DatabaseProcess(
      async () => [
        ['codex:session', { sessionTitle: 'Readable thread', t3ThreadId: 'mcp:thread', repositoryPaths: ['/repo'] }],
      ],
      { filenames: [], baseUrl: 'https://app.t3.codes' },
    ),
  );
  expect(metadata.get('codex:session')).toEqual({
    sessionTitle: 'Readable thread',
    t3ThreadId: 'mcp:thread',
    repositoryPaths: ['/repo'],
  });
});

test('a crashed metadata subprocess fails rather than leaving collection waiting', async () => {
  const result = await Effect.runPromise(
    runT3DatabaseProcess(
      async () => {
        throw new Error('unreadable database');
      },
      { filenames: [], baseUrl: 'https://app.t3.codes' },
    ).pipe(Effect.result),
  );
  expect(Result.isFailure(result)).toBe(true);
});
