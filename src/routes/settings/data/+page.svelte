<script lang="ts">
  import { untrack } from 'svelte';
  import { failureMessage, getSettings } from '#lib/client/settings.svelte.ts';
  import { categoryNames, seriesColor } from '#lib/client/visuals.ts';
  import type { DashboardResponse } from '#lib/shared/domain.ts';
  import Icon from '#lib/components/Icon.svelte';

  const settings = getSettings();
  const integer = new Intl.NumberFormat('en-US');
  let data = $state.raw<DashboardResponse>();
  let loading = $state(true);
  let error = $state('');
  let request: AbortController | undefined;

  async function load() {
    const client = settings.client;
    if (!client) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    error = '';
    try {
      const next = await client.getUsage(
        { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        controller.signal,
      );
      if (!controller.signal.aborted) data = next;
    } catch (failure) {
      if (!controller.signal.aborted) error = failureMessage(failure, 'Could not load data sources. Try again.');
    } finally {
      if (request === controller) loading = false;
    }
  }

  function mount() {
    untrack(() => void load());
    return () => request?.abort();
  }
</script>

<h1 class="settings-title">Data</h1>
{#if error}<div class="notice-region">
    <div class="notice error-notice" role="alert">
      <Icon name="warning" /><span>{error}</span><button onclick={() => void load()}>Try again</button>
    </div>
  </div>{/if}
<div class="settings-rows" aria-busy={loading} {@attach mount}>
  <div class="settings-row">
    <span class="settings-label">Machine</span><span class={['settings-value', !data && loading && 'skeleton']}
      >{data?.machine ?? 'Loading machine'}</span
    >
  </div>
</div>

<details class="cursor-setup" id="cursor">
  <summary>Set up Cursor usage</summary>
  <p>
    For account usage, export a personal unified usage CSV and run <code>token-tracker cursor import report.csv</code>
    on one tracker machine. Import newer exports there to update totals. Overlapping billing items count once.
  </p>
  <p>
    For per-agent history instead, create a user key on <a
      href="https://cursor.com/dashboard/api"
      target="_blank"
      rel="noopener noreferrer">Cursor’s API keys page</a
    >, then run <code>token-tracker cursor connect</code>. Refresh with <code>token-tracker cursor sync</code> or add
    <code>--watch</code>. Agent counters can miss account usage. Switching sources preserves both histories but displays
    only the active one.
  </p>
</details>

<div class="sources-list" aria-busy={loading}>
  {#if data}
    {#each data.sources as source (`${source.harness}:${source.path}`)}<div class="source-row">
        <div>
          <strong
            ><i class="category-swatch" style:background={seriesColor(source.harness, 'harnesses')} aria-hidden="true"
            ></i>
            {categoryNames[source.harness] ?? source.harness}</strong
          ><span class={['source-status', source.status]}>{source.status}</span>
        </div>
        <code>{source.path}</code><span
          >{#if source.harness === 'cursor' && source.syncedAt}{source.cursorSource === 'billing'
              ? 'Billing CSV'
              : 'Cloud Agents API'} · Last imported
            <time datetime={source.syncedAt}>{new Date(source.syncedAt).toLocaleString()}</time>{:else}{source.files}
            {source.files === 1 ? 'file' : 'files'}{/if} · {integer.format(source.events)} usage records</span
        >{#if source.error}<p>{source.error}</p>{/if}
      </div>{:else}<p class="settings-empty">No data sources reported</p>{/each}
  {:else if loading}
    {#each [0, 1, 2] as placeholder (placeholder)}<div class="source-row" aria-hidden="true">
        <div><strong class="skeleton">Harness name</strong></div>
        <code class="skeleton">~/.local/share/harness/sessions</code><span class="skeleton"
          >0 files · 0 usage records</span
        >
      </div>{/each}
  {/if}
</div>

{#if data}<div class="pricing-note">
    <strong>Estimated API-equivalent cost</strong>
    <p>
      {data.pricing.method}. Pricing updated {data.pricing.updatedAt}. These estimates are separate from your
      subscription bill.
    </p>
    {#each data.warnings as warning (warning)}<p>{warning}</p>{/each}
  </div>{/if}

<style>
  .cursor-setup {
    padding: 17px 0;
    font-size: 13px;
    line-height: 1.6;
    border-bottom: 1px solid var(--border);
  }
  summary {
    width: fit-content;
    color: var(--ink);
    font-weight: 500;
    cursor: pointer;
  }
  .cursor-setup p {
    margin-bottom: 0;
    color: var(--table-secondary);
  }
  a {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .cursor-setup code {
    overflow-wrap: anywhere;
  }
</style>
