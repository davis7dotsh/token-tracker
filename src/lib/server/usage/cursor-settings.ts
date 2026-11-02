import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { configDirectory, writePrivateJson } from '../../../cli/state';

export const cursorKeyConfigured = () =>
  stat(join(configDirectory(), 'cursor-key.json')).then(
    (s) => s.isFile(),
    () => false,
  );

export async function saveCursorKey(key: string) {
  if (!/^[!-~]{1,4096}$/.test(key)) return 'Enter a valid Cursor API key.';
  // Verify access without fetching history or switching the active usage source.
  try {
    const response = await fetch('https://api.cursor.com/v1/agents?limit=1', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return 'Cursor rejected the key. Check agent read access.';
    if (!response.ok) return 'Cursor could not verify the key. Try again later.';
  } catch {
    return 'Could not reach Cursor. No key was changed.';
  }
  const written = await Effect.runPromise(
    writePrivateJson('cursor-key.json', { key }).pipe(Effect.provide(BunServices.layer), Effect.isSuccess),
  );
  return written ? null : 'Could not save the key on this tracker.';
}
