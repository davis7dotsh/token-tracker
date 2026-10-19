<script lang="ts">
  import { sharedPricingSaves } from '#lib/client/pricing-saves.ts';
  import { getSettings } from '#lib/client/settings.svelte.ts';
  import PricingEditor from '#lib/components/PricingEditor.svelte';

  const settings = getSettings();
  // Unpriced models come from all synced history, not a dashboard date range.
  const query = { range: 'all', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } as const;
</script>

<h1 class="settings-title">Pricing</h1>
<PricingEditor client={settings.client} saves={sharedPricingSaves()} {query} bind:adminSecret={settings.adminSecret} />
