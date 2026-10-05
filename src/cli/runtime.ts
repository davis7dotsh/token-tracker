import { Runtime } from 'effect';
import type { Writable } from 'node:stream';

const drain = (stream: Writable) =>
  new Promise<void>((resolve) => {
    if (stream.destroyed || stream.writableEnded) return resolve();
    stream.end(() => resolve());
  });

// runMain invokes teardown after the main fiber and its scopes finish. Cancelled
// native filesystem callbacks can outlive that fiber, so the CLI must exit once
// its output has drained instead of waiting for unrelated event-loop handles.
export const cliTeardown: Runtime.Teardown = (exit) => {
  Runtime.defaultTeardown(exit, (code) => {
    void Promise.allSettled([drain(process.stdout), drain(process.stderr)]).then(() => {
      process.exit(code);
    });
  });
};
