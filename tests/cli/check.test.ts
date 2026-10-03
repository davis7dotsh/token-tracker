import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Schema } from 'effect';
import { DashboardResponse } from '../../src/lib/shared/domain';

const runCheck = async (directory: string, args: string[] = []) => {
  const child = Bun.spawn([process.execPath, resolve('src/cli/run.ts'), ...args, '--json'], {
    env: {
      ...process.env,
      HOME: directory,
      TOKEN_TRACKER_CONFIG_DIR: join(directory, 'config'),
      TOKEN_TRACKER_DATA_DIR: join(directory, '.local', 'share', 'token-tracker'),
      CLAUDE_CONFIG_DIR: join(directory, '.claude'),
      CODEX_HOME: join(directory, '.codex'),
      PI_CODING_AGENT_DIR: join(directory, '.pi', 'agent'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return Schema.decodeUnknownSync(DashboardResponse)(JSON.parse(stdout));
};

describe('local usage check', () => {
  test('defaults to a rolling 30 days and leaves configured sync state unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'token-tracker-check-'));
    try {
      await mkdir(join(directory, 'config'));
      const connection = JSON.stringify({
        url: 'http://127.0.0.1:1',
        token: 'unreachable',
        device: { id: 'machine', name: 'fixture', platform: 'linux' },
        intervalMinutes: 5,
        scheduler: null,
        connectedAt: '2026-01-01T00:00:00Z',
      });
      const checkpoint = JSON.stringify({
        version: 1,
        remote: 'http://127.0.0.1:1',
        deviceId: 'machine',
        syncedAt: '2026-01-01T00:00:00Z',
        eventDigests: { unchanged: 'fingerprint' },
      });
      await writeFile(join(directory, 'config', 'connection.json'), connection);
      await writeFile(join(directory, 'config', 'checkpoint.json'), checkpoint);
      const first = await runCheck(directory);
      const second = await runCheck(directory, ['check']);
      expect(first.range).toBe('30d');
      expect(Date.parse(first.period.end) - Date.parse(first.period.start)).toBe(30 * 86_400_000);
      expect(second.totals).toEqual(first.totals);
      expect(await readFile(join(directory, 'config', 'connection.json'), 'utf8')).toBe(connection);
      expect(await readFile(join(directory, 'config', 'checkpoint.json'), 'utf8')).toBe(checkpoint);
      expect(await Bun.file(join(directory, 'config', 'device-id')).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
