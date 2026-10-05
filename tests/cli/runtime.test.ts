import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const spawn = (program: string) => {
  const source = `import { Effect, Runtime } from 'effect';
    import { BunRuntime } from '@effect/platform-bun';
    import { cliTeardown } from ${JSON.stringify(resolve('src/cli/runtime.ts'))};
    ${program}`;
  const child = Bun.spawn([process.execPath, '--eval', source], { stdout: 'pipe', stderr: 'pipe' });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3_000);
  const result = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    .then(([stdout, stderr, code]) => ({ stdout, stderr, code }))
    .finally(() => clearTimeout(deadline));
  return { child, result };
};

test('completed CLI scopes finalize and exit despite an orphaned event-loop timer', async () => {
  const { result } = spawn(`
    const program = Effect.scoped(Effect.acquireRelease(
      Effect.sync(() => { setInterval(() => {}, 60_000); process.stdout.write('main\\n'); }),
      () => Effect.sleep('20 millis').pipe(Effect.andThen(Effect.sync(() => process.stdout.write('finalized\\n')))),
    ));
    BunRuntime.runMain(program, { teardown: cliTeardown });
  `);
  const output = await result;
  expect(output.code, output.stderr).toBe(0);
  expect(output.stdout).toBe('main\nfinalized\n');
});

test('successful teardown drains large stdout and stderr buffers completely', async () => {
  const size = 2 * 1024 * 1024;
  const { result } = spawn(`
    BunRuntime.runMain(Effect.sync(() => {
      setInterval(() => {}, 60_000);
      process.stdout.write('O'.repeat(${size}));
      process.stderr.write('E'.repeat(${size}));
    }), { teardown: cliTeardown });
  `);
  const output = await result;
  expect(output.code).toBe(0);
  expect(output.stdout).toBe('O'.repeat(size));
  expect(output.stderr).toBe('E'.repeat(size));
});

test('default and custom failure exit codes retain runtime error reporting', async () => {
  const { result: ordinary } = spawn(`
    BunRuntime.runMain(Effect.fail(new Error('ordinary-runtime-failure')), { teardown: cliTeardown });
  `);
  const standard = await ordinary;
  expect(standard.code).toBe(1);
  expect(standard.stdout + standard.stderr).toContain('ordinary-runtime-failure');
  const { result: custom } = spawn(`
    class ExpectedFailure extends Error { [Runtime.errorExitCode] = 23; }
    BunRuntime.runMain(Effect.fail(new ExpectedFailure('custom-runtime-failure')), { teardown: cliTeardown });
  `);
  const marked = await custom;
  expect(marked.code).toBe(23);
  expect(marked.stdout + marked.stderr).toContain('custom-runtime-failure');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} interrupts the main effect, finalizes its scope and retains exit code 130`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'token-tracker-cli-runtime-'));
    directories.push(directory);
    const ready = join(directory, 'ready');
    const { child, result } = spawn(`
      import { writeFileSync } from 'node:fs';
      const program = Effect.scoped(Effect.acquireRelease(Effect.void,
        () => Effect.sleep('20 millis').pipe(Effect.andThen(Effect.sync(() => process.stdout.write('finalized\\n')))),
      ).pipe(
        Effect.andThen(Effect.sleep('10 millis')),
        Effect.andThen(Effect.sync(() => writeFileSync(${JSON.stringify(ready)}, 'ready'))),
        Effect.andThen(Effect.never),
      ));
      BunRuntime.runMain(program, { teardown: cliTeardown });
    `);
    for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(10);
    expect(await Bun.file(ready).exists()).toBe(true);
    child.kill(signal);
    const output = await result;
    expect(output.code, output.stderr).toBe(130);
    expect(output.stdout).toBe('finalized\n');
  });
}
