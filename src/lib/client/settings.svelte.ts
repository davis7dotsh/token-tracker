import { createContext } from 'svelte';
import type { makeDashboardClient } from './rpc';
export { relativeTime } from './format';

// Settings sections share one RPC client and, on hubs that require it, the
// pairing secret typed for pricing or device changes. The secret is never stored.
export class SettingsState {
  adminSecret = $state('');
  readonly client: ReturnType<typeof makeDashboardClient> | undefined;
  constructor(client: ReturnType<typeof makeDashboardClient> | undefined) {
    this.client = client;
  }
}

export const [getSettings, setSettings] = createContext<SettingsState>();

export const failureMessage = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback;
