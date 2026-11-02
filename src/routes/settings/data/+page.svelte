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
  <summary>Set up Cursor Cloud Agents</summary>
  <ol>
    <li>
      In <a href="https://cursor.com/dashboard/api" target="_blank" rel="noopener noreferrer">Cursor’s API keys page</a
      >, create a user API key with permission to read your cloud agents.
    </li>
    <li>
      On one tracker machine, run <code>token-tracker cursor connect</code>. Paste the key into the hidden terminal
      prompt to import usage.
    </li>
    <li>
      Refresh with <code>token-tracker cursor sync</code>, or leave <code>token-tracker cursor sync --watch</code> running
      for ongoing updates.
    </li>
  </ol>
  <p>
    Run tokens are counted on the run’s creation date. Any remaining usage without a run is counted on the agent’s
    creation date. Cursor does not report model names or request counts here. To forget the saved key without deleting
    history, run <code>token-tracker cursor disconnect</code>.
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
          >{#if source.harness === 'cursor' && source.syncedAt}Last imported <time datetime={source.syncedAt}
              >{new Date(source.syncedAt).toLocaleString()}</time
            >{:else}{source.files} {source.files === 1 ? 'file' : 'files'}{/if} · {integer.format(source.events)} usage records</span
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
  ol {
    padding-inline-start: 22px;
  }
  li + li {
    margin-top: 6px;
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
