<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { sharedDeviceChanges, type DeviceChange, type DeviceChangeResult } from '#lib/client/device-changes.ts';
  import { failureMessage, getSettings, relativeTime } from '#lib/client/settings.svelte.ts';
  import type { Device } from '#lib/shared/domain.ts';
  import type { AdminAccess } from '#lib/shared/rpc.ts';
  import Icon from '#lib/components/Icon.svelte';

  const settings = getSettings();
  const changes = sharedDeviceChanges();
  const integer = new Intl.NumberFormat('en-US');
  let devices = $state.raw<readonly Device[]>();
  let access = $state.raw<AdminAccess>();
  let loading = $state(true);
  let loadError = $state('');
  let editing = $state('');
  let draft = $state('');
  let confirming = $state('');
  // Changes run through a tab-level client, so one can still be in flight from
  // a previous visit.
  let busy = $state(changes?.state().inFlight?.device.id ?? '');
  let feedback = $state.raw<{ message: string; failed: boolean }>();
  let request: AbortController | undefined;

  const isLocal = (device: Device) => device.id === 'local' || device.id === access?.localDeviceId;
  const status = (device: Device) =>
    device.revokedAt
      ? { label: 'Revoked', tone: 'revoked' }
      : isLocal(device)
        ? { label: 'This machine', tone: 'online' }
        : device.needsReconnect
          ? { label: 'Needs reconnect', tone: '' }
          : device.lastSeen
            ? { label: 'Active', tone: 'online' }
            : { label: 'Awaiting first sync', tone: '' };

  async function load() {
    const client = settings.client;
    if (!client) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    loadError = '';
    const since = changes?.state().generation;
    try {
      const [nextDevices, nextAccess] = await Promise.all([
        client.getDevices(controller.signal),
        client.getAdminAccess(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      // A change that settled mid-read may not be in it.
      if (changes?.state().generation !== since) return void load();
      devices = nextDevices;
      access = nextAccess;
    } catch (failure) {
      if (!controller.signal.aborted) loadError = failureMessage(failure, 'Could not load devices. Try again.');
    } finally {
      if (request === controller) loading = false;
    }
  }

  function mount() {
    const unsubscribe = changes?.subscribe((state, result) => {
      busy = state.inFlight?.device.id ?? '';
      if (result) settled(result);
    });
    untrack(() => {
      const missed = changes?.takeUnseen();
      if (missed?.ok === false)
        feedback = { message: `${missedAction(missed.change)}. ${missed.message}`, failed: true };
      void load();
    });
    return () => {
      unsubscribe?.();
      request?.abort();
    };
  }

  function startRename(device: Device) {
    editing = device.id;
    confirming = '';
    draft = device.name;
    feedback = undefined;
  }

  function startRevoke(device: Device) {
    confirming = device.id;
    editing = '';
    feedback = undefined;
  }

  function cancel() {
    editing = '';
    confirming = '';
  }

  const succeeded = {
    rename: (device: Device) => `Renamed to ${device.name}`,
    revoke: (device: Device) => `Revoked ${device.name}`,
    restore: (device: Device) => `Restored ${device.name}. Connect it again with the command below to resume syncing.`,
  };

  // Failures that settled after leaving Settings say which change they were.
  const missedAction = (change: DeviceChange) =>
    change.action === 'rename'
      ? `Could not rename ${change.device.name} to ${change.name}`
      : `Could not ${change.action} ${change.device.name}`;

  function settled(result: DeviceChangeResult) {
    if (result.ok) {
      devices = devices?.map((item) => (item.id === result.device.id ? result.device : item));
      cancel();
      feedback = { message: succeeded[result.change.action](result.device), failed: false };
    } else feedback = { message: result.message, failed: true };
  }

  function change(device: Device, action: keyof typeof succeeded) {
    if (!changes || busy) return;
    feedback = undefined;
    changes.submit(
      action === 'rename' ? { action, device, name: draft.trim() } : { action, device },
      settings.adminSecret,
    );
  }

  // Renames save on Enter or blur; Escape, an empty name, or the same name
  // leave the device unchanged.
  function commitRename(device: Device) {
    if (editing !== device.id || busy) return;
    const name = draft.trim();
    if (!name || name === device.name) cancel();
    else change(device, 'rename');
  }

  function renameKeyboard(event: KeyboardEvent, device: Device) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitRename(device);
    }
  }

  function focusInput(input: HTMLInputElement) {
    input.focus();
    input.select();
  }
</script>

<h1 class="settings-title">Devices</h1>
<div class="device-toolbar" {@attach mount}>
  <span class="muted">{devices ? `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}` : ''}</span>
  {#if access?.secretRequired}<input
      class="pricing-secret"
      type="password"
      aria-label="Pairing secret"
      bind:value={settings.adminSecret}
      placeholder="Pairing secret"
      autocomplete="current-password"
    />{/if}
</div>

{#if loadError}<div class="notice-region">
    <div class="notice error-notice" role="alert">
      <Icon name="warning" /><span>{loadError}</span><button onclick={() => void load()}>Try again</button>
    </div>
  </div>{/if}

<div class="device-list" aria-busy={loading}>
  {#if devices}
    {#each devices as device (device.id)}
      {@const deviceStatus = status(device)}

      <div class="device-row">
        <div class="device-main">
          {#if editing === device.id}<input
              class="device-name-input"
              aria-label={`New name for ${device.name}`}
              bind:value={draft}
              maxlength="200"
              disabled={busy === device.id}
              autocomplete="off"
              onkeydown={(event) => renameKeyboard(event, device)}
              onblur={() => commitRename(device)}
              {@attach focusInput}
            />{:else}<strong class="device-name" title={device.name}>{device.name}</strong>{/if}
          {#if confirming === device.id}<span class="device-meta device-warning"
              >Usage history stays. This device can’t sync or reconnect until you restore it here.</span
            >{:else}<span class="device-meta"
              >{device.platform} · {integer.format(device.eventCount)} records · {device.lastSeen
                ? `last seen ${relativeTime(device.lastSeen)}`
                : 'never synced'}</span
            >{/if}
        </div>
        <span class={['device-state', deviceStatus.tone]}><i aria-hidden="true"></i>{deviceStatus.label}</span>
        <div class="device-actions">
          {#if editing === device.id}{#if busy === device.id}<span class="device-meta">Saving…</span
              >{/if}{:else if confirming === device.id}<button
              class="button device-revoke-confirm"
              disabled={busy === device.id}
              onclick={() => change(device, 'revoke')}>{busy === device.id ? 'Revoking…' : 'Revoke'}</button
            ><button class="text-button" disabled={busy === device.id} onclick={cancel}>Cancel</button
            >{:else if device.revokedAt}<button
              class="text-button"
              disabled={Boolean(busy)}
              onclick={() => change(device, 'restore')}>{busy === device.id ? 'Restoring…' : 'Restore'}</button
            >{:else if !isLocal(device)}<button
              class="icon-button"
              aria-label={`Rename ${device.name}`}
              title="Rename"
              disabled={Boolean(busy)}
              onclick={() => startRename(device)}><Icon name="edit" size={16} /></button
            ><button class="text-button device-revoke" disabled={Boolean(busy)} onclick={() => startRevoke(device)}
              >Revoke</button
            >{/if}
        </div>
      </div>
    {:else}<p class="device-empty">No devices yet</p>{/each}
  {:else if loading}
    {#each [0, 1, 2] as placeholder (placeholder)}<div class="device-row" aria-hidden="true">
        <div class="device-main">
          <span class="device-name skeleton">Device name</span><span class="device-meta skeleton"
            >platform · records · last seen</span
          >
        </div>
      </div>{/each}
  {:else}<p class="device-empty">Devices are unavailable</p>
  {/if}
</div>

<div class="settings-feedback" aria-live="polite">
  {#if feedback}<span class={feedback.failed ? 'failed' : 'succeeded'} role={feedback.failed ? 'alert' : undefined}
      >{#if !feedback.failed}<Icon name="check" size={15} />{/if}{feedback.message}</span
    >{/if}
</div>

<div class="settings-hint">
  <Icon name="terminal" size={15} /><span>Connect a device</span><code
    >token-tracker connect {page.url.origin} --pairing-secret &lt;secret&gt;</code
  >
</div>

<style>
  .device-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 37px;
    margin-bottom: 14px;
  }
  .device-list {
    border-top: 1px solid var(--border);
  }
  .device-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 150px 150px;
    align-items: center;
    gap: 20px;
    min-height: 76px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .device-main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .device-name {
    height: 32px;
    display: flex;
    align-items: center;
    max-width: max-content;
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .device-name-input {
    width: min(100%, 320px);
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink);
    font-size: 14px;
  }
  .device-meta {
    max-width: max-content;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }
  .device-warning {
    color: #c1834e;
  }
  .device-state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .device-state i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #a2a8b2;
  }
  .device-state.online i {
    background: #48b58d;
    box-shadow: 0 0 0 3px #48b58d16;
  }
  .device-state.revoked {
    color: #c1834e;
  }
  .device-state.revoked i {
    background: #c1834e;
  }
  .device-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
  }
  .device-revoke {
    color: #c1834e;
    font-size: 12px;
  }
  .device-actions .text-button {
    font-size: 12px;
  }
  .device-revoke-confirm {
    border-color: #c1834e70;
    background: #c1834e14;
    color: #c1834e;
  }
  .device-empty {
    display: flex;
    align-items: center;
    min-height: 76px;
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    border-bottom: 1px solid var(--border);
  }
  @media (max-width: 780px) {
    .device-row {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px 16px;
    }
    .device-actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
      min-height: 36px;
    }
  }
</style>
