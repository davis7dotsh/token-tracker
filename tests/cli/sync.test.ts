import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { UsageClient, rpcClientLayer } from '../../src/lib/client/rpc';
import { LocalUsage, makeRpcWebHandler } from '../../src/lib/server/rpc/server';
import { DashboardResponse } from '../../src/lib/shared/domain';

test('CLI pairs and uploads once, then sends imported historical records and corrections without duplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-cli-sync-'));
  const home = join(directory, 'client');
  const configuration = join(home, 'config');
  const logs = join(home, '.claude', 'projects', 'fixture');
  const pairingSecret = 'cli-test-pairing-secret';
  const web = makeRpcWebHandler(
    { dataDirectory: join(directory, 'server'), pairingSecret },
    Layer.succeed(LocalUsage, {
      device: { id: 'server-device', name: 'Server', platform: 'linux' },
      collect: Effect.succeed({ events: [], sources: [], warnings: [], pricingUpdatedAt: '2026-10-03T00:00:00Z' }),
    }),
  );
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => web.handler(request) });
  const url = `http://127.0.0.1:${server.port}`;
  const runtime = ManagedRuntime.make(rpcClientLayer(`${url}/rpc`));
  const record = (id: string, output = 10, timestamp = '2026-10-01T00:00:00Z') =>
    JSON.stringify({
      type: 'assistant',
      timestamp,
      cwd: '/work/app',
      sessionId: 'test-session',
      message: {
        id,
        model: 'claude-fable-5-1',
        usage: { input_tokens: 100, output_tokens: output },
        content: 'private response',
      },
    });
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, resolve('src/cli/run.ts'), ...args], {
      env: {
        ...process.env,
        HOME: home,
        TOKEN_TRACKER_CONFIG_DIR: configuration,
        TOKEN_TRACKER_DATA_DIR: join(home, '.local', 'share', 'token-tracker'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEX_HOME: join(home, '.codex'),
        PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
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
    return stdout;
  };
  try {
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'one.jsonl'), `${record('one')}\n`);
    expect(await run(['connect', url, '--pairing-secret', pairingSecret, '--no-schedule'])).toContain(
      '1 changed records',
    );
    expect((await stat(join(configuration, 'connection.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(configuration, 'checkpoint.json'))).mode & 0o777).toBe(0o600);
    expect(await run(['sync'])).toContain('0 changed records');
    await writeFile(join(logs, 'old-import.jsonl'), `${record('old-import', 20, '2019-01-01T00:00:00Z')}\n`);
    expect(await run(['sync'])).toContain('1 changed records');
    await writeFile(join(logs, 'one.jsonl'), `${record('one', 30)}\n`);
    expect(await run(['sync'])).toContain('1 changed records (0 new, 1 updated)');
    expect(await run(['sync'])).toContain('0 changed records');
    const report = await runtime.runPromise(Effect.flatMap(UsageClient, (client) => client.GetUsage({ range: 'all' })));
    expect(report.totals.requests).toBe(2);
    expect(report.totals.outputTokens).toBe(50);
    expect(JSON.stringify(report)).not.toContain('private response');
    await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) =>
        client.SetPricingRule({
          adminSecret: pairingSecret,
          rule: {
            model: 'claude-fable-5-1',
            kind: 'rates',
            nickname: 'Personal Claude',
            rates: { inputPerMillion: 2, outputPerMillion: 8 },
          },
        }),
      ),
    );
    expect(await run(['sync'])).toContain('2 changed records (0 new, 2 updated)');
    const pricingPath = join(home, '.local', 'share', 'token-tracker', 'pricing-state.json');
    expect((await stat(pricingPath)).mode & 0o777).toBe(0o600);
    const beforePricing = await readFile(pricingPath, 'utf8');
    expect(await run(['sync'])).toContain('0 changed records');
    expect(await readFile(pricingPath, 'utf8')).toBe(beforePricing);
    const beforeCheck = await readFile(join(configuration, 'checkpoint.json'), 'utf8');
    const localReport = Schema.decodeUnknownSync(DashboardResponse)(
      JSON.parse(await run(['check', '--range', 'all', '--model', 'claude-fable-5-1', '--json'])),
    );
    expect(localReport.models.map((model) => model.name)).toEqual(['Personal Claude']);
    expect(localReport.totals.costUSD).toBeCloseTo(0.0008, 8);
    expect(await readFile(join(configuration, 'checkpoint.json'), 'utf8')).toBe(beforeCheck);
    expect(await readFile(pricingPath, 'utf8')).toBe(beforePricing);
  } finally {
    await runtime.dispose();
    await server.stop(true);
    await web.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
