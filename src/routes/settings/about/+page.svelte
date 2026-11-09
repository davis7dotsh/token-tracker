<script lang="ts">
  import { untrack } from 'svelte';
  import { failureMessage, getSettings } from '#lib/client/settings.svelte.ts';
  import { safeWebUrl } from '#lib/client/session-links.ts';
  import type { HubInfo } from '#lib/shared/rpc.ts';
  import Icon from '#lib/components/Icon.svelte';

  const settings = getSettings();
  let about = $state.raw<HubInfo>();
  let loading = $state(true);
  let error = $state('');
  let request: AbortController | undefined;

  const catalogUrl = $derived(about ? safeWebUrl(about.pricing.source) : undefined);
  const rows = $derived([
    { label: 'Version', value: about?.version },
    { label: 'Hub machine', value: about && (about.localDeviceName ?? 'None (hosted hub)') },
    {
      label: 'Devices',
      value: about && `${about.devices} (${about.activeDevices} active)`,
    },
    { label: 'Pricing catalog updated', value: about?.pricing.updatedAt },
    {
      label: 'Catalog last checked',
      value: about && (about.pricing.checkedAt ? formatTime(about.pricing.checkedAt) : 'Never'),
    },
  ]);

  function formatTime(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
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
      const info = await client.getHubInfo(controller.signal);
      if (!controller.signal.aborted) about = info;
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
        >{about?.pricing.source ?? (loading ? 'Loading source' : '—')}</span
      >{/if}
  </div>
</div>
{#if about?.pricing.refreshError}<div class="notice-region settings-notice">
    <div class="notice error-notice"><Icon name="warning" /><span>{about.pricing.refreshError}</span></div>
  </div>{/if}
