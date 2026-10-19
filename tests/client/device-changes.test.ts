import { expect, test } from 'bun:test';
import { createDeviceChanges, type DeviceChange } from '../../src/lib/client/device-changes';
import type { Device } from '../../src/lib/shared/domain';

const laptop: Device = {
  id: 'laptop',
  name: 'Laptop',
  platform: 'linux',
  lastSeen: null,
  eventCount: 0,
  revokedAt: null,
  needsReconnect: false,
};

// A hub whose changes settle only when the test says so.
const fakeHub = () => {
  const sent: { change: DeviceChange; adminSecret: string }[] = [];
  const waiting: ((failure?: string) => void)[] = [];
  const changes = createDeviceChanges(
    (change, adminSecret) =>
      new Promise<Device>((resolve, reject) => {
        sent.push({ change, adminSecret });
        waiting.push((failure) =>
          failure
            ? reject(new Error(failure))
            : resolve(change.action === 'rename' ? { ...change.device, name: change.name } : change.device),
        );
      }),
  );
  const next = async (failure?: string) => {
    waiting.shift()?.(failure);
    await Bun.sleep(0);
  };
  return { changes, sent, next };
};

test('one change runs at a time and carries its pairing secret', async () => {
  const hub = fakeHub();
  expect(hub.changes.submit({ action: 'rename', device: laptop, name: 'Work' }, 'secret')).toBe(true);
  expect(hub.changes.submit({ action: 'revoke', device: laptop }, 'secret')).toBe(false);
  expect(hub.changes.state().inFlight?.action).toBe('rename');
  await hub.next();
  expect(hub.sent).toEqual([{ change: { action: 'rename', device: laptop, name: 'Work' }, adminSecret: 'secret' }]);
  expect(hub.changes.state()).toEqual({ inFlight: undefined, generation: 1 });
});

test('listeners see results as they settle, and nothing is kept for later', async () => {
  const hub = fakeHub();
  const results: unknown[] = [];
  const unsubscribe = hub.changes.subscribe((_, result) => result && results.push(result));
  hub.changes.submit({ action: 'rename', device: laptop, name: 'Work' }, '');
  await hub.next('Pairing secret is incorrect.');
  unsubscribe();
  expect(results).toEqual([
    { change: { action: 'rename', device: laptop, name: 'Work' }, ok: false, message: 'Pairing secret is incorrect.' },
  ]);
  expect(hub.changes.takeUnseen()).toBeUndefined();
});

test('a failure that settles with no page listening is kept once', async () => {
  const hub = fakeHub();
  const unsubscribe = hub.changes.subscribe(() => {});
  hub.changes.submit({ action: 'rename', device: laptop, name: 'Work' }, '');
  // The page unmounts before the hub answers.
  unsubscribe();
  await hub.next('Hub unavailable');
  expect(hub.changes.takeUnseen()).toMatchObject({ ok: false, message: 'Hub unavailable' });
  expect(hub.changes.takeUnseen()).toBeUndefined();
  // Successes need no retained notice: the next read shows them.
  hub.changes.submit({ action: 'rename', device: laptop, name: 'Work' }, '');
  await hub.next();
  expect(hub.changes.takeUnseen()).toBeUndefined();
});
