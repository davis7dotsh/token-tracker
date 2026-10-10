import { expect, test } from 'bun:test';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Layer } from 'effect';
import { createSession, sessionCookie, validSession } from '../../src/lib/server/auth';
import { dashboardPasscode, handleHubRequest } from '../../src/lib/server/host/cloudflare';
import { makeHubWebHandler, sqlHubServices } from '../../src/lib/server/rpc/hub';

const passcode = 'test-only-dashboard-passcode';
const pairingSecret = 'test-only-collector-pairing-secret';
const message = (tag: string, payload: unknown = {}, id = '1') =>
  JSON.stringify({ _tag: 'Request', id, tag, payload: tag === 'GetDevices' ? null : payload, headers: [] }) + '\n';

test('Cloudflare forwarding separates signed-in dashboard reads from authenticated collector RPC', async () => {
  const hub = makeHubWebHandler(
    sqlHubServices(pairingSecret).pipe(Layer.provide(SqliteClient.layer({ filename: ':memory:' }))),
    { trustBrowser: false, autoRefreshPricing: false },
  );
  const request = async (body: string, cookie?: string, pathname = '/rpc') => {
    const authenticated = await validSession(cookie, passcode);
    return handleHubRequest({
      request: new Request(`https://dashboard.test${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/ndjson', cookie: `${sessionCookie}=${cookie ?? ''}` },
        body,
      }),
      platform: {
        env: {
          HUB: { fetch: (request) => hub.handler(request) },
          TOKEN_TRACKER_DASHBOARD_PASSCODE: passcode,
          LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
        },
      },
      locals: { passcodeEnabled: true, dashboardAuthenticated: authenticated },
    });
  };
  const rpc = async (tag: string, payload: unknown = {}, cookie?: string) =>
    (await request(message(tag, payload), cookie)).text();
  const device = { id: 'laptop', name: 'Private laptop', platform: 'darwin' };
  try {
    // Missing bindings fail closed instead of making a public dashboard.
    expect(dashboardPasscode({ platform: undefined })).toBe('');
    const registered = await rpc('RegisterDevice', { device, pairingSecret });
    const decoded: { exit?: { value?: { token?: string } } } = JSON.parse(registered.trim());
    const token = decoded.exit?.value?.token;
    expect(typeof token).toBe('string');
    expect(await rpc('SyncUsage', { deviceId: device.id, token, batch: { device, events: [] } })).toContain('accepted');
    expect(await rpc('GetPricingPolicy')).toContain('Unauthorized');
    const forgedProof = await request(
      JSON.stringify({
        _tag: 'Request',
        id: '1',
        tag: 'GetPricingPolicy',
        payload: {},
        headers: [
          ['x-token-tracker-pricing-policy-access', ''],
          ['x-token-tracker-collector-access', ''],
        ],
      }) + '\n',
    );
    expect(await forgedProof.text()).toContain('Unauthorized');
    expect(await rpc('GetPricingPolicy', { deviceId: device.id, token: 'wrong-token' })).toContain('Unauthorized');
    expect(await rpc('GetPricingPolicy', { deviceId: device.id, token })).toContain('catalog');
    expect(await rpc('GetPricingPolicy', { pairingSecret })).toContain('catalog');
    for (const tag of ['GetUsage', 'GetDevices', 'GetPricing']) {
      const anonymous = await rpc(tag);
      expect(anonymous).not.toContain('Private laptop');
      expect(anonymous).not.toContain('totals');
      expect(anonymous).not.toContain('unresolved');
      expect(anonymous).toContain('Unknown');
    }
    const mixed = await request(message('GetPricingPolicy', { pairingSecret }) + message('GetDevices', {}, '2'));
    expect(await mixed.text()).not.toContain('Private laptop');
    for (const path of ['/%72pc', '/rpc/'])
      expect(await (await request(message('GetDevices'), undefined, path)).text()).not.toContain('Private laptop');
    const cookie = await createSession(passcode);
    expect(await rpc('GetDevices', {}, cookie)).toContain('Private laptop');
    expect(await rpc('GetUsage', {}, cookie)).toContain('totals');
    expect(await rpc('GetPricing', {}, cookie)).toContain('unresolved');
    expect(await rpc('GetDevices', {}, cookie + 'tampered')).not.toContain('Private laptop');
    expect(await rpc('SetPricingRule', { rule: { model: 'test', kind: 'free' }, adminSecret: '' }, cookie)).toContain(
      'Unauthorized',
    );
  } finally {
    await hub.dispose();
  }
});

test('collector-only requests cannot borrow a self-hosted browser pricing grant', async () => {
  const hub = makeHubWebHandler(
    sqlHubServices(pairingSecret).pipe(Layer.provide(SqliteClient.layer({ filename: ':memory:' }))),
    { trustBrowser: true, autoRefreshPricing: false },
  );
  const request = () =>
    new Request('https://dashboard.test/rpc', {
      method: 'POST',
      headers: { origin: 'https://dashboard.test', 'content-type': 'application/ndjson' },
      body: message('SetPricingRule', { rule: { model: 'test', kind: 'free' }, adminSecret: '' }),
    });
  try {
    expect(await (await hub.handler(request(), true)).text()).toContain('Unauthorized');
    expect(await (await hub.handler(request())).text()).toContain('rules');
  } finally {
    await hub.dispose();
  }
});
