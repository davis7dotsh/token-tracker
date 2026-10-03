<script lang="ts">
  import { untrack } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { makeDashboardClient } from '#lib/client/rpc.ts';
  import type { Breakdown, DashboardResponse, Device, UsageQuery } from '#lib/shared/domain.ts';
  import Icon from '#lib/components/Icon.svelte';
  import MultiSelect from '#lib/components/MultiSelect.svelte';
  import PricingDialog from '#lib/components/PricingDialog.svelte';
  import ThemeToggle from '#lib/components/ThemeToggle.svelte';
  import UsageChart from '#lib/components/UsageChart.svelte';

  const ranges = [
    { value: '6m', label: '6 months' },
    { value: '30d', label: '1 month' },
    { value: '7d', label: '1 week' },
    { value: 'today', label: '1 day' },
  ] as const;
  const names: Record<string, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    pi: 'Pi',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    xai: 'xAI',
    unknown: 'Unknown',
  };
  const colors: Record<string, string> = { claude: '#4DABF7', codex: '#8695a8', pi: '#b6c4d4' };
  const integer = new Intl.NumberFormat('en-US');
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  const currency = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  let query = $state<UsageQuery>({ range: '30d', timezone: 'UTC' });
  let data = $state.raw<DashboardResponse>();
  let devices = $state.raw<readonly Device[]>([]);
  let loading = $state(true);
  let error = $state('');
  let chartMode = $state<'bar' | 'line'>('bar');
  let metric = $state<'tokens' | 'costUSD'>('tokens');
  let grouping = $state<'harnesses' | 'models' | 'providers' | 'devices' | 'projects'>('harnesses');
  let showAll = $state(false);
  let sessionSearch = $state('');
  let sessionPage = $state(0);
  let sort = $state<'tokens' | 'lastActiveAt'>('lastActiveAt');
  let sourcesDialog: HTMLDialogElement;
  let pricingDialog: { show: () => void };
  let client = $state.raw<ReturnType<typeof makeDashboardClient>>();
  let request: AbortController | undefined;
  let requestVersion = 0;

  const rangeIndex = $derived(
    Math.max(
      0,
      ranges.findIndex((range) => range.value === query.range),
    ),
  );
  const filterKeys = ['harnesses', 'providers', 'models', 'devices', 'projects'] as const;
  const chips = $derived(
    filterKeys.flatMap((key) => {
      const selected = query[key];
      if (selected === undefined) return [];
      if (selected.length === 0) return [{ key, value: '__none__', label: `No ${key}` }];
      return selected.map((value) => ({
        key,
        value,
        label:
          key === 'devices' ? deviceName(value) : key === 'projects' ? projectName(value) : (names[value] ?? value),
      }));
    }),
  );
  const breakdown = $derived(data?.[grouping] ?? []);
  const visibleBreakdown = $derived(showAll ? breakdown : breakdown.slice(0, 5));
  const filteredSessions = $derived.by(() => {
    const search = sessionSearch.toLowerCase();
    return [...(data?.sessions ?? [])]
      .filter((session) =>
        `${session.project} ${session.model} ${session.harness} ${session.id} ${session.repository ?? ''}`
          .toLowerCase()
          .includes(search),
      )
      .sort((a, b) => (sort === 'tokens' ? b.tokens - a.tokens : b.lastActiveAt.localeCompare(a.lastActiveAt)));
  });
  const pages = $derived(Math.max(1, Math.ceil(filteredSessions.length / 8)));
  const currentPage = $derived(Math.min(sessionPage, pages - 1));
  const sessions = $derived(filteredSessions.slice(currentPage * 8, currentPage * 8 + 8));
  const period = $derived(
    data ? `${formatDate(data.period.start)} – ${formatDate(data.period.end)}` : 'Reading usage…',
  );
  const totals = $derived(data?.totals);
  const unpriced = $derived(totals?.unpricedTokens ?? 0);
  const unpricedModels = $derived(data?.models.filter((row) => row.unpricedTokens > 0).length ?? 0);

  function deviceName(id: string) {
    return (
      devices.find((device) => device.id === id)?.name ?? (id === 'local' ? (data?.machine ?? 'This machine') : id)
    );
  }
  function projectName(value: string) {
    return (
      value
        .replace(/^https?:\/\//, '')
        .replace(/\.git$/, '')
        .split(/[\\/]/)
        .filter(Boolean)
        .slice(-2)
        .join('/') || value
    );
  }
  function formatDate(value: string) {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${value.slice(0, 10)}T12:00:00Z`),
    );
  }
  function formatCost(row: Pick<Breakdown, 'tokens' | 'unpricedTokens' | 'costUSD'>) {
    return row.tokens > 0 && row.unpricedTokens >= row.tokens
      ? 'Unpriced'
      : `${currency.format(row.costUSD)}${row.unpricedTokens > 0 ? '*' : ''}`;
  }
  function relative(value: string) {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60000));
    return minutes < 1
      ? 'Just now'
      : minutes < 60
        ? `${minutes}m ago`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)}h ago`
          : `${Math.floor(minutes / 1440)}d ago`;
  }
  function updateUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('range', query.range ?? '30d');
    for (const key of filterKeys) {
      url.searchParams.delete(key);
      const selected = query[key];
      if (selected !== undefined) url.searchParams.set(key, selected.length === 0 ? 'none' : selected.join(','));
    }
    void replaceState(url, {});
  }
  async function refresh() {
    if (!client) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const version = ++requestVersion;
    loading = true;
    error = '';
    void client
      .getDevices(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted && version === requestVersion) devices = next;
      })
      .catch(() => {
        /* Keep the previous device metadata when offline. */
      });
    try {
      const next = await client.getUsage({ ...query }, controller.signal);
      if (controller.signal.aborted || version !== requestVersion) return;
      data = next;
      if (next.filters.selectedModels && JSON.stringify(next.filters.selectedModels) !== JSON.stringify(query.models)) {
        query = { ...query, models: [...next.filters.selectedModels] };
        updateUrl();
      }
    } catch (failure) {
      if (controller.signal.aborted || version !== requestVersion) return;
      error = failure instanceof Error ? failure.message : 'Could not load usage. Try again.';
    } finally {
      if (version === requestVersion) loading = false;
    }
  }
  function changeQuery(next: UsageQuery) {
    query = next;
    sessionPage = 0;
    updateUrl();
    void refresh();
  }
  function removeChip(key: (typeof filterKeys)[number], value: string) {
    const remaining = (query[key] ?? []).filter((entry) => entry !== value);
    changeQuery({ ...query, [key]: value === '__none__' || remaining.length === 0 ? undefined : remaining });
  }
  function mountDashboard() {
    untrack(() => {
      const url = new URL(window.location.href);
      const requested = url.searchParams.get('range');
      const range = ranges.find((entry) => entry.value === requested)?.value ?? '30d';
      const filters = Object.fromEntries(
        filterKeys.flatMap((key) => {
          const value = url.searchParams.get(key);
          return value === null ? [] : [[key, value === 'none' ? [] : value.split(',')]];
        }),
      );
      query = { ...filters, range, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      client = makeDashboardClient();
      void refresh();
    });
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60000);
    return () => {
      clearInterval(timer);
      request?.abort();
      void client?.dispose();
      client = undefined;
    };
  }
  function exportCsv() {
    if (!data) return;
    const escape = (value: string | number) => {
      const text = String(value);
      return `"${text.replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
    };
    const rows = [
      [
        'session',
        'harness',
        'models',
        'project',
        'repository',
        'device',
        'tokens',
        'estimated_cost_usd',
        'unpriced_tokens',
        'last_active',
      ],
      ...data.sessions.map((session) => [
        session.id,
        session.harness,
        session.model,
        session.project,
        session.repository ?? '',
        deviceName(session.deviceId),
        session.tokens,
        session.costUSD,
        session.unpricedTokens,
        session.lastActiveAt,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob([rows.map((row) => row.map(escape).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `token-usage-${data.period.start}-${data.period.end}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function rangeKeyboard(event: KeyboardEvent) {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const index = (rangeIndex + direction + ranges.length) % ranges.length;
    changeQuery({ ...query, range: ranges[index].value });
    document.querySelector<HTMLButtonElement>(`[data-range="${ranges[index].value}"]`)?.focus();
  }
</script>

<svelte:head><title>Usage · Token tracker</title><meta name="theme-color" content="var(--surface)" /></svelte:head>
<svelte:window ononline={() => void refresh()} />

<div class="workspace" {@attach mountDashboard}>
  <header class="topbar">
    <a class="wordmark" href="/"
      ><svg class="brand-mark" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"
        ><rect x="5" y="18" width="5" height="9" rx="1.5" /><rect x="13.5" y="11" width="5" height="16" rx="1.5" /><rect
          x="22"
          y="5"
          width="5"
          height="22"
          rx="1.5"
        /></svg
      >Token tracker<span class="brand-dot">.</span></a
    >
    <div class="topbar-right">
      <div class="connection">
        <Icon name="monitor" size={17} /><span class="machine-name">{data?.machine ?? 'This machine'}</span><span
          class={['status-dot', error ? 'offline' : data ? 'online' : '']}
        ></span><span>{error ? 'Offline' : data ? 'Connected' : 'Connecting'}</span>
      </div>
      <ThemeToggle />
    </div>
  </header>

  <main>
    <div class="page-heading">
      <h1>Usage</h1>
      <div class="page-actions">
        <div class="range-selector" role="radiogroup" tabindex="-1" aria-label="Date range" onkeydown={rangeKeyboard}>
          <span class="range-indicator" style:transform={`translateX(${rangeIndex * 100}%)`}
          ></span>{#each ranges as range (range.value)}<button
              class={['range-option', query.range === range.value && 'selected']}
              role="radio"
              aria-checked={query.range === range.value}
              tabindex={query.range === range.value ? 0 : -1}
              data-range={range.value}
              onclick={() => changeQuery({ ...query, range: range.value })}>{range.label}</button
            >{/each}
        </div>
        <div class="secondary-actions">
          <button
            class={['icon-button', loading && 'refreshing']}
            aria-label="Refresh usage"
            title="Refresh usage"
            onclick={() => void refresh()}><Icon name="refresh" /></button
          ><button class="button" disabled={!data} onclick={exportCsv}
            ><Icon name="download" size={16} /><span>Export CSV</span></button
          >
        </div>
      </div>
    </div>

    <div class="filter-row">
      <div class="filters">
        <MultiSelect
          label="Harnesses"
          options={data?.filters.harnesses ?? []}
          value={query.harnesses}
          {names}
          onchange={(harnesses) => changeQuery({ ...query, harnesses })}
        />
        <MultiSelect
          label="Providers"
          options={data?.filters.providers ?? []}
          value={query.providers}
          {names}
          onchange={(providers) => changeQuery({ ...query, providers })}
        />
        <MultiSelect
          label="Models"
          options={data?.filters.models ?? []}
          value={query.models}
          onchange={(models) => changeQuery({ ...query, models })}
        />
        <MultiSelect
          label="Devices"
          options={data?.filters.devices ?? []}
          value={query.devices}
          names={Object.fromEntries((data?.filters.devices ?? []).map((id) => [id, deviceName(id)]))}
          onchange={(selected) => changeQuery({ ...query, devices: selected })}
        />
        <MultiSelect
          label="Projects"
          options={data?.filters.projects ?? []}
          value={query.projects}
          names={Object.fromEntries((data?.filters.projects ?? []).map((id) => [id, projectName(id)]))}
          onchange={(projects) => changeQuery({ ...query, projects })}
        />
      </div>
      <span class="period-label"
        >{period}<span class={['refresh-state', loading && 'visible']} aria-live="polite">Updating…</span></span
      >
    </div>
    <div class="filter-chip-region">
      <div class="filter-chips">
        {#each chips as chip (`${chip.key}:${chip.value}`)}<button
            class="filter-chip"
            onclick={() => removeChip(chip.key, chip.value)}>{chip.label}<Icon name="close" size={12} /></button
          >{/each}
      </div>
      {#if chips.length}<button
          class="text-button"
          onclick={() => changeQuery({ range: query.range, timezone: query.timezone })}>Clear filters</button
        >{/if}
    </div>

    {#if error}<div class="notice-region">
        <div class="notice error-notice" role="alert">
          <Icon name="warning" /><span>{error}{data ? ' Showing the last successful update.' : ''}</span><button
            onclick={() => void refresh()}>Try again</button
          >
        </div>
      </div>{/if}

    <section class="metrics" aria-label="Usage summary" aria-busy={loading}>
      <div class="metric">
        <span class="metric-label">Total tokens</span><strong class={['metric-value', !data && 'skeleton']}
          >{totals ? compact.format(totals.tokens) : '—'}</strong
        ><span class="metric-detail"
          >{totals ? `${integer.format(totals.tokens)} tokens` : 'Input, output & cache'}</span
        >
      </div>
      <div class="metric">
        <span class="metric-label">Estimated API cost</span><strong class={['metric-value', !data && 'skeleton']}
          >{totals ? formatCost(totals) : '—'}</strong
        ><span class="metric-detail metric-pricing-detail"
          ><span>At model API rates</span><button
            class={['pricing-control', unpriced > 0 && 'needs-pricing']}
            aria-label={unpriced > 0
              ? `Model pricing: ${unpricedModels} ${unpricedModels === 1 ? 'model needs' : 'models need'} pricing`
              : 'Model pricing'}
            title={unpriced > 0 ? `${compact.format(unpriced)} tokens need pricing` : 'Manage model aliases and prices'}
            onclick={() => pricingDialog.show()}
            ><Icon name="info" size={14} />{#if unpriced > 0}<span>{unpricedModels} unpriced</span>{/if}</button
          ></span
        >
      </div>
      <div class="metric">
        <span class="metric-label">Sessions</span><strong class={['metric-value', !data && 'skeleton']}
          >{totals ? integer.format(totals.sessions) : '—'}</strong
        ><span class="metric-detail"
          >{totals ? `${integer.format(totals.requests)} requests` : 'Across your harnesses'}</span
        >
      </div>
      <div class="metric">
        <span class="metric-label">Cache hit rate</span><strong class={['metric-value', !data && 'skeleton']}
          >{totals ? `${(totals.cacheHitRate * 100).toFixed(1)}%` : '—'}</strong
        ><span class="metric-detail">Cached input / total input</span>
      </div>
    </section>

    <div class="analytics-grid">
      <section class="activity-panel" aria-labelledby="activity-title">
        <div class="section-heading">
          <h2 id="activity-title">{metric === 'tokens' ? 'Token activity' : 'Cost activity'}</h2>
          <div class="chart-controls">
            <div class="segmented" aria-label="Chart type">
              <button
                class={chartMode === 'bar' ? 'active' : ''}
                aria-label="Bar chart"
                aria-pressed={chartMode === 'bar'}
                onclick={() => (chartMode = 'bar')}><Icon name="bars" size={16} /></button
              ><button
                class={chartMode === 'line' ? 'active' : ''}
                aria-label="Line chart"
                aria-pressed={chartMode === 'line'}
                onclick={() => (chartMode = 'line')}><Icon name="line" size={16} /></button
              >
            </div>
            <div class="segmented" aria-label="Chart measurement">
              <button
                class={metric === 'tokens' ? 'active' : ''}
                aria-pressed={metric === 'tokens'}
                onclick={() => (metric = 'tokens')}>Tokens</button
              ><button
                class={metric === 'costUSD' ? 'active' : ''}
                aria-pressed={metric === 'costUSD'}
                onclick={() => (metric = 'costUSD')}>Cost</button
              >
            </div>
          </div>
        </div>
        {#if data}<UsageChart {data} mode={chartMode} {metric} />{:else}<div class="chart-loading" aria-live="polite">
            {#if error}<Icon name="warning" size={24} /><span>Usage is unavailable</span><button
                class="text-button"
                onclick={() => void refresh()}>Try again</button
              >{:else}<span class="spinner"></span><span>Reading local usage</span>{/if}
          </div>{/if}
        <div class="token-composition">
          <span><i class="composition-input"></i>Input <b>{totals ? compact.format(totals.inputTokens) : '—'}</b></span
          ><span
            ><i class="composition-output"></i>Output <b>{totals ? compact.format(totals.outputTokens) : '—'}</b></span
          ><span
            ><i class="composition-cache"></i>Cache
            <b>{totals ? compact.format(totals.cacheReadTokens + totals.cacheWriteTokens) : '—'}</b></span
          >
        </div>
      </section>
      <section class="breakdown-panel" aria-labelledby="breakdown-title">
        <div class="section-heading">
          <h2 id="breakdown-title">Breakdown</h2>
          <span class="muted">{breakdown.length || '—'}</span>
        </div>
        <div class="breakdown-tabs" aria-label="Breakdown grouping">
          {#each ['harnesses', 'models', 'providers', 'devices', 'projects'] as group (group)}<button
              class={grouping === group ? 'active' : ''}
              aria-pressed={grouping === group}
              onclick={() => {
                if (
                  group === 'harnesses' ||
                  group === 'models' ||
                  group === 'providers' ||
                  group === 'devices' ||
                  group === 'projects'
                )
                  grouping = group;
                showAll = false;
              }}>{group.charAt(0).toUpperCase() + group.slice(1)}</button
            >{/each}
        </div>
        <div class="breakdown-list">
          {#each visibleBreakdown as row (row.name)}<div class="breakdown-row">
              <div class="breakdown-top">
                <span class="breakdown-name" title={row.name}
                  ><i style:background={colors[row.name] ?? '#4DABF7'}></i>{grouping === 'devices'
                    ? deviceName(row.name)
                    : grouping === 'projects'
                      ? projectName(row.name)
                      : (names[row.name] ?? row.name)}</span
                ><b>{formatCost(row)}</b>
              </div>
              <div class="breakdown-track">
                <span
                  style:width={`${Math.max(0, totals?.tokens ? (row.tokens / totals.tokens) * 100 : 0)}%`}
                  style:background={colors[row.name] ?? '#4DABF7'}
                ></span>
              </div>
              <div class="breakdown-meta">
                <span>{compact.format(row.tokens)} tokens</span><span
                  >{totals?.tokens ? ((row.tokens / totals.tokens) * 100).toFixed(1) : '0'}%</span
                >
              </div>
            </div>{:else}<div class="breakdown-empty">{data ? 'No usage to show' : 'Loading breakdown…'}</div>{/each}
        </div>
        {#if breakdown.length > 5}<button class="text-button show-more" onclick={() => (showAll = !showAll)}
            >{showAll ? 'Show top five' : `Show all ${breakdown.length}`}</button
          >{/if}
      </section>
    </div>

    <section class="sessions-panel" aria-labelledby="sessions-title">
      <div class="section-heading">
        <div class="sessions-title">
          <h2 id="sessions-title">Sessions</h2>
          <span class="count-badge">{data?.sessions.length ?? 0}</span>
        </div>
        <label class="session-search"
          ><Icon name="search" size={16} /><input
            type="search"
            placeholder="Search sessions"
            aria-label="Search sessions"
            bind:value={sessionSearch}
            oninput={() => (sessionPage = 0)}
          /></label
        >
      </div>
      <div class="table-scroll">
        <table>
          <thead
            ><tr
              ><th scope="col">Session / project</th><th scope="col">Harness / model</th><th scope="col" class="numeric"
                ><button onclick={() => (sort = 'tokens')}>Tokens</button></th
              ><th scope="col" class="numeric">Est. cost</th><th scope="col" class="numeric"
                ><button onclick={() => (sort = 'lastActiveAt')}>Last active</button></th
              ></tr
            ></thead
          ><tbody
            >{#each sessions as session (`${session.deviceId}:${session.harness}:${session.id}`)}<tr
                ><td
                  ><span class="session-project" title={session.repository ?? session.project}
                    >{projectName(session.repository ?? session.project)}</span
                  ><span class="session-id">{session.id.slice(0, 16)} · {deviceName(session.deviceId)}</span></td
                ><td
                  ><span class="session-harness">{names[session.harness] ?? session.harness}</span><span
                    class="session-model"
                    title={session.model}>{session.model}</span
                  ></td
                ><td class="numeric">{compact.format(session.tokens)}</td><td class="numeric">{formatCost(session)}</td
                ><td class="numeric session-time" title={new Date(session.lastActiveAt).toLocaleString()}
                  >{relative(session.lastActiveAt)}</td
                ></tr
              >{:else}<tr
                ><td colspan="5" class="table-empty"
                  >{!data
                    ? error
                      ? 'Could not load sessions'
                      : 'Loading sessions…'
                    : sessionSearch
                      ? 'No sessions match your search'
                      : 'No sessions in this view'}</td
                ></tr
              >{/each}</tbody
          >
        </table>
      </div>
      <div class="table-footer">
        <span
          >{filteredSessions.length
            ? `${currentPage * 8 + 1}–${Math.min((currentPage + 1) * 8, filteredSessions.length)} of ${filteredSessions.length}`
            : '0 sessions'}</span
        >
        <div class="pagination">
          <button
            aria-label="Previous page"
            disabled={currentPage === 0}
            onclick={() => (sessionPage = currentPage - 1)}
            ><span class="previous-arrow"><Icon name="arrow" size={16} /></span></button
          ><span>{currentPage + 1} / {pages}</span><button
            aria-label="Next page"
            disabled={currentPage >= pages - 1}
            onclick={() => (sessionPage = currentPage + 1)}><Icon name="arrow" size={16} /></button
          >
        </div>
      </div>
    </section>
    {#if devices.length}<div class="device-status" aria-label="Device sync status">
        <Icon name="network" size={16} />{#each devices as device (device.id)}<span
            ><b>{device.name}</b>
            {device.lastSeen ? `synced ${relative(device.lastSeen)}` : 'awaiting first sync'}</span
          >{/each}
      </div>{/if}
    <footer>
      <span><Icon name="terminal" size={15} />Local logs & connected devices</span>
      <div class="footer-actions">
        <button onclick={() => pricingDialog.show()}>Model pricing<Icon name="arrow" size={14} /></button><button
          onclick={() => sourcesDialog.showModal()}>Data sources<Icon name="arrow" size={14} /></button
        >
      </div>
    </footer>
  </main>
</div>

<PricingDialog bind:this={pricingDialog} {client} {query} onchange={refresh} />

<dialog class="sources-dialog" bind:this={sourcesDialog}>
  <div class="dialog-heading">
    <h2>Data sources & pricing</h2>
    <button class="icon-button" aria-label="Close data sources" onclick={() => sourcesDialog.close()}
      ><Icon name="close" /></button
    >
  </div>
  <div class="sources-list">
    {#each data?.sources ?? [] as source (`${source.harness}:${source.path}`)}<div class="source-row">
        <div>
          <strong>{names[source.harness] ?? source.harness}</strong><span class={['source-status', source.status]}
            >{source.status}</span
          >
        </div>
        <code>{source.path}</code><span>{source.files} files · {integer.format(source.events)} usage records</span
        >{#if source.error}<p>{source.error}</p>{/if}
      </div>{/each}
  </div>
  {#if data}<div class="pricing-note">
      <strong>Estimated API-equivalent cost</strong>
      <p>
        {data.pricing.method}. Pricing updated {data.pricing.updatedAt}. These estimates are separate from your
        subscription bill.
      </p>
      {#each data.warnings as warning (warning)}<p>{warning}</p>{/each}
    </div>{/if}
</dialog>
