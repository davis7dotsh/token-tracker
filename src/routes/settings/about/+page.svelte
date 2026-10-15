<script lang="ts">
  import { untrack } from 'svelte';
  import { Schema } from 'effect';
  import { failureMessage, getSettings } from '#lib/client/settings.svelte.ts';
  import { safeWebUrl } from '#lib/client/session-links.ts';
  import type { Device } from '#lib/shared/domain.ts';
  import type { AdminAccess, PricingSettings } from '#lib/shared/rpc.ts';
  import Icon from '#lib/components/Icon.svelte';

  const settings = getSettings();
  const decodeHealth = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));
  let about = $state.raw<{
    version: string;
    devices: readonly Device[];
    access: AdminAccess;
    pricing: PricingSettings;
  }>();
  let loading = $state(true);
  let error = $state('');
  let request: AbortController | undefined;

  const machine = $derived.by(() => {
    if (!about) return undefined;
    const local = about.access.localDeviceId;
    return local === null ? 'None (hosted hub)' : (about.devices.find((device) => device.id === local)?.name ?? local);
  });
  const catalogUrl = $derived(about ? safeWebUrl(about.pricing.info.source) : undefined);
  const rows = $derived([
    { label: 'Version', value: about?.version },
    { label: 'Hub machine', value: machine },
    {
      label: 'Devices',
      value: about && `${about.devices.length} (${about.devices.filter((device) => !device.revokedAt).length} active)`,
    },
    { label: 'Pricing catalog updated', value: about?.pricing.info.updatedAt },
    {
      label: 'Catalog last checked',
      value: about && (about.pricing.info.checkedAt ? formatTime(about.pricing.info.checkedAt) : 'Never'),
    },
  ]);

  function formatTime(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  async function readVersion(signal: AbortSignal) {
    const response = await fetch('/api/health', { signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Could not read the hub version. Try again.');
    return decodeHealth(await response.json()).version;
  }

  async function load() {
    const client = settings.client;
    if (!client) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    error = '';
    try {
      const [version, devices, access, pricing] = await Promise.all([
        readVersion(controller.signal),
        client.getDevices(controller.signal),
        client.getAdminAccess(controller.signal),
        client.getPricing({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, controller.signal),
      ]);
      if (!controller.signal.aborted) about = { version, devices, access, pricing };
    } catch (failure) {
      if (!controller.signal.aborted) error = failureMessage(failure, 'Could not load hub details. Try again.');
    } finally {
      if (request === controller) loading = false;
    }
  }

  function mount() {
    untrack(() => void load());
    return () => request?.abort();
  }
</script>

<h1 class="settings-title">About</h1>
{#if error}<div class="notice-region">
    <div class="notice error-notice" role="alert">
      <Icon name="warning" /><span>{error}</span><button onclick={() => void load()}>Try again</button>
    </div>
  </div>{/if}
<div class="settings-rows" aria-busy={loading} {@attach mount}>
  {#each rows as row (row.label)}<div class="settings-row">
      <span class="settings-label">{row.label}</span><span
        class={['settings-value', row.value === undefined && loading && 'skeleton']}
        >{row.value ?? (loading ? 'Loading value' : '—')}</span
      >
    </div>{/each}
  <div class="settings-row">
    <span class="settings-label">Pricing catalog source</span>{#if catalogUrl}<a
        class="settings-value settings-link"
        href={catalogUrl}
        target="_blank"
        rel="noopener noreferrer">{new URL(catalogUrl).hostname}<Icon name="external" size={13} /></a
      >{:else}<span class={['settings-value', !about && loading && 'skeleton']}
        >{about?.pricing.info.source ?? (loading ? 'Loading source' : '—')}</span
      >{/if}
  </div>
</div>
{#if about?.pricing.info.refreshError}<div class="notice-region settings-notice">
    <div class="notice error-notice"><Icon name="warning" /><span>{about.pricing.info.refreshError}</span></div>
  </div>{/if}
