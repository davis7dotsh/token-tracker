import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboard, collectUsage } from '../../src/lib/server/usage';
import { readCursorSnapshot, type CursorSnapshot } from '../../src/lib/server/usage/cursor-snapshot';
import { bundledPolicy } from '../../src/lib/server/usage/pricing';
import { usageRevision } from '../../src/lib/server/usage/revision';

test('offline Cursor import invalidates the local dashboard, preserves accounting, and fails closed on corrupt withdrawals', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tracker-cursor-'));
  try {
    const cursorSnapshotFile = join(home, 'cursor-usage.json');
    const options = {
      home,
      cursorSnapshotFile,
      deviceId: 'collector',
      pricingPolicy: bundledPolicy,
      claudeDirs: [],
      codexDirs: [],
      piDirs: [],
      museDirs: [],
      grokDirs: [],
    };
    const collect = () => Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
    const revision = () => Effect.runPromise(usageRevision(options)().pipe(Effect.provide(BunServices.layer)));
    const missing = await revision();
    expect((await collect()).sources).toHaveLength(0);
    const snapshot = {
      version: 1,
      syncedAt: '2026-01-02T12:00:00Z',
      warnings: [],
      retractedIds: ['cursor:old'],
      events: [
        {
          id: 'cursor:run:a:b',
          harness: 'cursor',
          sessionId: 'a',
          timestamp: '2026-01-01T12:00:00Z',
          model: 'cursor-unknown',
          project: 'Cursor Cloud Agents',
          repository: null,
          requests: 0,
          inputTokens: 3,
          outputTokens: 4,
          cacheReadTokens: 50,
          cacheWriteTokens: 20,
          reasoningTokens: 0,
          costUsd: 0,
          costKnown: false,
        },
      ],
    } satisfies CursorSnapshot;
    await writeFile(cursorSnapshotFile, JSON.stringify(snapshot));
    expect(await revision()).not.toBe(missing);
    const usage = await collect();
    expect(usage.retractedIds).toEqual(['cursor:old']);
    expect(usage.events[0].deviceId).toBe('collector');
    expect(usage.sources[0]).toMatchObject({ harness: 'cursor', status: 'ready', events: 1 });
    const dashboard = buildDashboard(usage, { range: 'all', harnesses: ['cursor'] }, new Date('2026-01-03'));
    expect(dashboard.totals).toMatchObject({ tokens: 77, sessions: 1, requests: 0, unpricedTokens: 77 });
    const read = () =>
      Effect.runPromise(readCursorSnapshot(cursorSnapshotFile).pipe(Effect.provide(BunServices.layer)));
    const original = await read();
    expect(await read()).toBe(original);
    const replacement = { ...snapshot, syncedAt: '2026-01-03T12:00:00Z' };
    await writeFile(`${cursorSnapshotFile}.tmp`, JSON.stringify(replacement));
    await rename(`${cursorSnapshotFile}.tmp`, cursorSnapshotFile);
    expect((await read())?.syncedAt).toBe(replacement.syncedAt);
    await rm(cursorSnapshotFile);
    expect(await read()).toBeNull();
    await writeFile(cursorSnapshotFile, JSON.stringify({ ...snapshot, retractedIds: ['claude:untouched'] }));
    const bad = await collect();
    expect(bad.sources[0].status).toBe('error');
    expect(bad.retractedIds).toBeUndefined();
    expect(bad.events).toHaveLength(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
