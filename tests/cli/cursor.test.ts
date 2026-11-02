import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Schema } from 'effect';
import { CursorSnapshot } from '../../src/lib/server/usage/cursor-snapshot';

// Exercise the same CLI a collector runs, but never send credentials or test
// traffic to Cursor. The second import moves an unattributed total into a run.
test('Cursor connect, correction, failed refresh and disconnect preserve private local history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-cursor-cli-'));
  const config = join(directory, 'config');
  const snapshotFile = join(config, 'cursor-usage.json');
  const keyFile = join(config, 'cursor-key.json');
  const preload = join(directory, 'mock.mjs');
  const fixtureKey = crypto.randomUUID();
  try {
    await writeFile(
      preload,
      `globalThis.fetch = async (url, init) => {
      const key = process.env.FIXTURE_KEY;
      if (url.origin !== 'https://api.cursor.com' || init.method !== 'GET' || init.headers.Authorization !== 'Bearer ' + key) return new Response('unauthorized', {status: 401});
      if (process.env.FIXTURE_MODE === 'denied') return new Response(key, {status: 403});
      const stamp = '2026-01-01T00:00:00Z';
      const usage = {inputTokens: 5, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 16};
      if (url.pathname === '/v1/agents') return Response.json({items: [{id:'a1',createdAt:stamp,env:{type:'cloud'}}]});
      if (url.pathname === '/v1/agents/a1/usage') return Response.json({totalUsage: usage, runs: process.env.FIXTURE_MODE === 'mapped' ? [{id:'r1',usage}] : []});
      if (url.pathname === '/v1/agents/a1/runs') return Response.json({items:[{id:'r1',agentId:'a1',createdAt:stamp}]});
      return new Response('not found', {status:404});
    };`,
    );
    const invoke = async (command: string, mode = '', useEnv = false, stdin = '') => {
      const child = Bun.spawn([process.execPath, '--preload', preload, resolve('src/cli/run.ts'), 'cursor', command], {
        env: {
          ...process.env,
          TOKEN_TRACKER_CONFIG_DIR: config,
          CURSOR_API_KEY: useEnv ? fixtureKey : undefined,
          FIXTURE_KEY: fixtureKey,
          FIXTURE_MODE: mode,
        },
        stdin: new Blob([stdin]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(out + err).not.toContain(fixtureKey);
      return { code, text: err + out };
    };
    const connected = await invoke('connect', '', false, `${fixtureKey}\n`);
    expect(connected.code, connected.text).toBe(0);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const snapshotText = () => readFile(snapshotFile, 'utf8');
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(CursorSnapshot));
    const initial = decode(await snapshotText());
    const firstId = initial.events[0].id;
    expect(initial.events).toHaveLength(1);
    const refresh = await invoke('sync', 'mapped');
    expect(refresh.code, refresh.text).toBe(0);
    const retained = await snapshotText();
    const mapped = decode(retained);
    expect(mapped.events).toHaveLength(1);
    expect(mapped.events[0].id).not.toBe(firstId);
    expect(mapped.retractedIds).toEqual([firstId]);
    expect(retained).not.toContain(fixtureKey);
    expect((await invoke('sync', 'denied')).code).not.toBe(0);
    expect(await snapshotText()).toBe(retained);
    expect((await invoke('disconnect')).code).toBe(0);
    expect(await Bun.file(keyFile).exists()).toBe(false);
    expect(await snapshotText()).toBe(retained);
    expect((await invoke('sync')).code).not.toBe(0);
    expect((await invoke('sync', '', true)).code).toBe(0);
    expect(await Bun.file(keyFile).exists()).toBe(false);
    expect(decode(await snapshotText()).retractedIds).toEqual([mapped.events[0].id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
