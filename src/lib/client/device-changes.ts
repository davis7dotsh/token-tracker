import type { Device } from '../shared/domain';
import { tabClient } from './dashboard-rpc';

export type DeviceChange =
  | { action: 'rename'; device: Device; name: string }
  | { action: 'revoke'; device: Device }
  | { action: 'restore'; device: Device };
export type DeviceChangeResult = { change: DeviceChange } & (
  | { ok: true; device: Device }
  | { ok: false; message: string }
);
export type DeviceChangesState = {
  inFlight: DeviceChange | undefined;
  // Increments whenever a change settles, so reads started earlier are stale.
  generation: number;
};

const messageFor = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'Could not update this device. Try again.';

// One device change runs at a time. A failure that settles while no Devices
// page is listening is kept until the page next opens, so leaving Settings
// mid-change never hides it.
export const createDeviceChanges = (send: (change: DeviceChange, adminSecret: string) => Promise<Device>) => {
  let inFlight: DeviceChange | undefined;
  let generation = 0;
  let unseen: DeviceChangeResult | undefined;
  const listeners = new Set<(state: DeviceChangesState, result?: DeviceChangeResult) => void>();

  const state = (): DeviceChangesState => ({ inFlight, generation });
  const notify = (result?: DeviceChangeResult) => {
    const snapshot = state();
    for (const listener of listeners) listener(snapshot, result);
  };
  const settle = (result: DeviceChangeResult) => {
    inFlight = undefined;
    generation += 1;
    if (!listeners.size && !result.ok) unseen = result;
    notify(result);
  };

  return {
    state,
    subscribe(listener: (state: DeviceChangesState, result?: DeviceChangeResult) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    // The failure that settled while nothing was listening, once.
    takeUnseen() {
      const result = unseen;
      unseen = undefined;
      return result;
    },
    // Returns whether the change was sent.
    submit(change: DeviceChange, adminSecret: string) {
      if (inFlight) return false;
      inFlight = change;
      unseen = undefined;
      void send(change, adminSecret).then(
        (device) => settle({ change, ok: true, device }),
        (failure: unknown) => settle({ change, ok: false, message: messageFor(failure) }),
      );
      notify();
      return true;
    },
  };
};
export type DeviceChanges = ReturnType<typeof createDeviceChanges>;

let shared: DeviceChanges | undefined;
export const sharedDeviceChanges = () => {
  const client = tabClient();
  if (!client) return undefined;
  shared ??= createDeviceChanges((change, adminSecret) =>
    change.action === 'rename'
      ? client.renameDevice(change.device.id, change.name, adminSecret)
      : change.action === 'revoke'
        ? client.revokeDevice(change.device.id, adminSecret)
        : client.restoreDevice(change.device.id, adminSecret),
  );
  return shared;
};
