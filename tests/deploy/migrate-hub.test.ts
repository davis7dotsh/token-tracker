import { expect, test } from 'bun:test';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeDashboardClient, rpcClientLayer, UsageClient } from '../../src/lib/client/rpc';
import { makeHubWebHandler, sqlHubServices } from '../../src/lib/server/rpc/hub';
import { usageStoreLayer } from '../../src/lib/server/rpc/server';
import { UsageStore } from '../../src/lib/server/rpc/store';
import { loadPricing, setPricingRule } from '../../src/lib/server/usage/pricing-runtime';
import { defaultStored } from '../../src/lib/server/usage/pricing-store';
import type { UsageEvent } from '../../src/lib/shared/domain';

const pairingSecret = 'test-migration-pairing-secret';
const migrate = async (source: string, target: string) => {
  const child = Bun.spawn([process.execPath, resolve('scripts/migrate-hub.ts'), source, target], {
    env: { ...process.env, TOKEN_TRACKER_PAIRING_SECRET: pairingSecret },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(deadline);
  }
};

for (const scenario of [
  'alias chain',
  'different catalog',
  'target-only rates',
  'target-only alias',
  'invalid pricing state',
  'unreadable pricing state',
  'missing pricing state',
] as const) {
  test(`migration handles ${scenario} without silently losing pricing rules`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'token-tracker-migration-'));
    const source = join(directory, 'source');
    await mkdir(source);
    const runtime = ManagedRuntime.make(usageStoreLayer({ dataDirectory: source, pairingSecret }));
    const hub = makeHubWebHandler(
      sqlHubServices(pairingSecret).pipe(
        Layer.provide(SqliteClient.layer({ filename: join(directory, 'target.sqlite') })),
      ),
      { trustBrowser: false, autoRefreshPricing: false },
    );
    const server = Bun.serve({ port: 0, fetch: (request) => hub.handler(request) });
    const target = `http://127.0.0.1:${server.port}`;
    const browser = makeDashboardClient(`${target}/rpc`);
    const device = { id: 'source-device', name: 'Source device', platform: 'linux' };
    const event: UsageEvent = {
      id: 'source-request',
      timestamp: new Date().toISOString(),
      harness: 'claude',
      model: 'a-custom',
      rawModel: 'a-custom',
      project: '/work/app',
      repository: null,
      sessionId: 'source-session',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      serviceTier: '',
      costUsd: 2,
      costKnown: true,
    };
    try {
      // Initialize a real source database, even for the pricing-only failure case.
      await runtime.runPromise(Effect.flatMap(UsageStore, (store) => store.getDevices()));
      if (scenario === 'alias chain') {
        await Effect.runPromise(
          setPricingRule(
            { model: 'z-custom', kind: 'rates', rates: { inputPerMillion: 2, outputPerMillion: 2 } },
            source,
          ),
        );
        await Effect.runPromise(setPricingRule({ model: 'm-custom', kind: 'alias', target: 'z-custom' }, source));
        await Effect.runPromise(setPricingRule({ model: 'a-custom', kind: 'alias', target: 'm-custom' }, source));
        const registration = await runtime.runPromise(
          Effect.flatMap(UsageStore, (store) => store.registerDevice(pairingSecret, device)),
        );
        await runtime.runPromise(
          Effect.flatMap(UsageStore, (store) =>
            store.syncUsage(device.id, registration.token, { device, events: [event] }),
          ),
        );
      } else if (scenario === 'different catalog') {
        const stored = defaultStored();
        await writeFile(
          join(source, 'pricing-state.json'),
          JSON.stringify({
            ...stored,
            catalog: {
              ...stored.catalog,
              models: {
                ...stored.catalog.models,
                'source-only-model': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000002 },
              },
            },
            rules: [{ model: 'a-custom', kind: 'alias', target: 'source-only-model' }],
          }),
        );
        expect((await Effect.runPromise(loadPricing(source))).info.rules).toHaveLength(1);
      } else if (scenario === 'target-only rates' || scenario === 'target-only alias') {
        await browser.setPricingRule(
          { model: 'z-custom', kind: 'rates', rates: { inputPerMillion: 2, outputPerMillion: 2 } },
          pairingSecret,
        );
        await Effect.runPromise(
          setPricingRule(
            { model: 'z-custom', kind: 'rates', rates: { inputPerMillion: 2, outputPerMillion: 2 } },
            source,
          ),
        );
        await browser.setPricingRule(
          scenario === 'target-only rates'
            ? { model: 'a-custom', kind: 'rates', rates: { inputPerMillion: 99, outputPerMillion: 99 } }
            : { model: 'a-custom', kind: 'alias', target: 'z-custom' },
          pairingSecret,
        );
      } else if (scenario === 'invalid pricing state') {
        await writeFile(join(source, 'pricing-state.json'), '{invalid');
      } else if (scenario === 'unreadable pricing state') {
        await mkdir(join(source, 'pricing-state.json'));
      }
      if (scenario !== 'alias chain' && scenario !== 'missing pricing state') {
        // A pricing preflight failure must not even register this source device.
        const registration = await runtime.runPromise(
          Effect.flatMap(UsageStore, (store) => store.registerDevice(pairingSecret, device)),
        );
        await runtime.runPromise(
          Effect.flatMap(UsageStore, (store) =>
            store.syncUsage(device.id, registration.token, { device, events: [event] }),
          ),
        );
      }
      const initialTargetRules = (await browser.getPricing()).info.rules;
      // Close the source hub before executing the documented migration command.
      await runtime.dispose();
      const result = await migrate(source, target);
      if (scenario === 'alias chain') {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('3 pricing rules');
        const sourcePricing = await Effect.runPromise(loadPricing(source));
        expect((await browser.getPricing()).info.rules).toEqual(sourcePricing.info.rules);
        expect((await browser.getUsage()).totals).toMatchObject({ tokens: 1_000_000, costUSD: 2 });
        // A collector connects after the initial import. A later migration must
        // preserve its token as well as the accounting totals.
        const collector = ManagedRuntime.make(rpcClientLayer(`${target}/rpc`));
        try {
          const registration = await collector.runPromise(
            Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
          );
          const heartbeat = () =>
            collector.runPromise(
              Effect.flatMap(UsageClient, (client) =>
                client.SyncUsage({ deviceId: device.id, token: registration.token, batch: { device, events: [] } }),
              ),
            );
          expect(await heartbeat()).toMatchObject({ accepted: 0, updated: 0 });
          expect(
            await collector.runPromise(
              Effect.flatMap(UsageClient, (client) =>
                client.SyncUsage({
                  deviceId: device.id,
                  token: registration.token,
                  batch: {
                    device,
                    events: [{ ...event, inputTokens: 2_000_000, costUsd: 4, sessionTitle: 'Corrected target' }],
                  },
                }),
              ),
            ),
          ).toMatchObject({ updated: 1 });
          const repeated = await migrate(source, target);
          expect(repeated.code, repeated.stderr).toBe(0);
          expect(await heartbeat()).toMatchObject({ accepted: 0, updated: 0 });
          const retained = await browser.getUsage();
          expect(retained.totals).toMatchObject({ tokens: 2_000_000, costUSD: 4 });
          expect(retained.sessions[0]?.sessionTitle).toBe('Corrected target');
        } finally {
          await collector.dispose();
        }
      } else if (scenario === 'missing pricing state') {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('0 pricing rules');
        expect(await Bun.file(join(source, 'pricing-state.json')).exists()).toBe(false);
      } else {
        expect(result.code).not.toBe(0);
        expect(result.stdout + result.stderr).toContain(
          scenario === 'different catalog'
            ? 'different rates'
            : scenario === 'target-only rates' || scenario === 'target-only alias'
              ? 'pricing rules absent from the source: a-custom'
              : 'saved pricing state',
        );
        expect(result.stdout).not.toContain('Copied 0 devices');
        expect((await browser.getPricing()).info.rules).toEqual(initialTargetRules);
        expect(await browser.getDevices()).toEqual([]);
        expect((await browser.getUsage()).totals.tokens).toBe(0);
      }
    } finally {
      await runtime.dispose();
      await browser.dispose();
      await server.stop(true);
      await hub.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
