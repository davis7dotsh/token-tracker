<script lang="ts">
  import { untrack } from 'svelte';
  import { Schema } from 'effect';
  import { useSearchParams } from 'runed/kit';
  import { page } from '$app/state';
  import {
    breakdownGroups,
    dashboardUrlSchema,
    encodeFilter,
    filterKeys,
    normalizedDashboardParams,
    usageQueryFromParams,
  } from '#lib/client/dashboard-url.ts';
  import { makeDashboardClient } from '#lib/client/rpc.ts';
  import {
    nativeThreadUrl,
    projectLabel,
    repositoryWebUrl,
    safeWebUrl,
    sessionDisplayName,
  } from '#lib/client/session-links.ts';
  import { categoryNames, distinctSeriesColors, seriesColor, type VisualGrouping } from '#lib/client/visuals.ts';
  import { UsageQuery, type Breakdown, type DashboardResponse, type Device } from '#lib/shared/domain.ts';
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
  const integer = new Intl.NumberFormat('en-US');
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  const currency = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const params = useSearchParams(dashboardUrlSchema, { noScroll: true });
  let timezone = $state('UTC');
  const queryKey = $derived(JSON.stringify(usageQueryFromParams(params, timezone)));
  const decodeQuery = Schema.decodeUnknownSync(UsageQuery);
  const query = $derived(decodeQuery(JSON.parse(queryKey)));
  let data = $state.raw<DashboardResponse>();
  let devices = $state.raw<readonly Device[]>([]);
  let loading = $state(true);
  let error = $state('');
  const chartMode = $derived(params.chart);
  const metric = $derived(params.metric === 'cost' ? 'costUSD' : 'tokens');
  const grouping = $derived(params.breakdown);
  const showAll = $derived(params.expanded);
  const sessionSearch = $derived(params.search);
  const sessionPage = $derived(params.page - 1);
  const sort = $derived(params.sort);
  let sourcesDialog: HTMLDialogElement;
  let pricingDialog: { show: () => void };
  let client = $state.raw<ReturnType<typeof makeDashboardClient>>();
  let request: AbortController | undefined;
  let requestVersion = 0;
  let observedQueryKey = '';
  let dataQueryKey = $state('');
  const deviceColors = $derived(
    distinctSeriesColors([...devices.map((device) => device.id), ...(data?.filters.devices ?? [])]),
  );
  const projectColors = $derived(distinctSeriesColors(data?.filters.projects ?? []));

  function categoryColor(name: string, group: VisualGrouping) {
    return (
      (group === 'devices' ? deviceColors.get(name) : group === 'projects' ? projectColors.get(name) : undefined) ??
      seriesColor(name, group)
    );
  }

  $effect(() => {
    const url = page.shallow?.url ?? page.url;
    untrack(() => {
      const values = normalizedDashboardParams(params);
      const invalid = Object.entries(values).some(([key, value]) => {
        const present = url.searchParams.getAll(key);
        return present.length > 1 || (present.length === 1 && present[0] !== String(value));
      });
      if (invalid) params.update(values, { pushHistory: false });
    });
  });

  $effect(() => {
    const key = queryKey;
    const ready = client !== undefined;
    if (ready && key !== observedQueryKey) {
      observedQueryKey = key;
      untrack(() => void refresh());
    }
  });

  const rangeIndex = $derived(
    Math.max(
      0,
      ranges.findIndex((range) => range.value === query.range),
    ),
  );
  const chips = $derived(
    filterKeys.flatMap((key) => {
      const selected = query[key];
      if (selected === undefined) return [];
      if (selected.length === 0) return [{ key, value: '__none__', label: `No ${key}`, color: '' }];
      return selected.map((value) => ({
        key,
        value,
        label:
          key === 'devices'
            ? deviceName(value)
            : key === 'projects'
              ? projectName(value)
              : (categoryNames[value] ?? value),
        color: categoryColor(value, key),
      }));
    }),
  );
  const breakdown = $derived(
    [...(data?.[grouping] ?? [])].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name)),
  );
  const visibleBreakdown = $derived(showAll ? breakdown : breakdown.slice(0, 5));
  const breakdownTotal = $derived(data?.totals[metric] ?? 0);
  const breakdownOverview = $derived.by(() => {
    const leading = breakdown
      .slice(0, 5)
      .map((row) => ({ name: row.name, value: row[metric], color: categoryColor(row.name, grouping) }));
    const remaining = breakdown.slice(5).reduce((sum, row) => sum + row[metric], 0);
    return remaining > 0 ? [...leading, { name: 'Other', value: remaining, color: 'var(--series-neutral)' }] : leading;
  });
  const sessionIndex = $derived(
    (data?.sessions ?? []).map((session) => ({
      session,
      search:
        `${session.sessionTitle ?? ''} ${session.projectName ?? ''} ${session.project} ${session.model} ${session.harness} ${session.id} ${session.repository ?? ''} ${session.t3ThreadId ?? ''}`.toLowerCase(),
    })),
  );
  const sortedSessions = $derived(
    [...sessionIndex].sort((a, b) =>
      sort === 'tokens'
        ? b.session.tokens - a.session.tokens
        : b.session.lastActiveAt.localeCompare(a.session.lastActiveAt),
    ),
  );
  const filteredSessions = $derived.by(() => {
    const search = sessionSearch.toLowerCase();
    return sortedSessions.filter((entry) => entry.search.includes(search)).map((entry) => entry.session);
  });
  const pages = $derived(Math.max(1, Math.ceil(filteredSessions.length / 8)));
  const currentPage = $derived(Math.min(sessionPage, pages - 1));
  const sessions = $derived(filteredSessions.slice(currentPage * 8, currentPage * 8 + 8));
  $effect(() => {
    if (data && !loading && dataQueryKey === queryKey && params.page > pages) {
      untrack(() => params.update({ page: pages }, { pushHistory: false }));
    }
  });
  const period = $derived(
    data ? `${formatDate(data.period.start)} – ${formatDate(data.period.end)}` : 'Reading usage…',
  );
  const totals = $derived(data?.totals);
  const unpriced = $derived(totals?.unpricedTokens ?? 0);
  const unpricedModels = $derived(data?.models.filter((row) => row.unpricedTokens > 0).length ?? 0);
  const deviceNames = $derived(new Map(devices.map((device) => [device.id, device.name])));
  const composition = $derived([
    { key: 'input', label: 'Input', value: totals?.inputTokens ?? 0, cost: data?.tokenCosts?.input },
    { key: 'output', label: 'Output', value: totals?.outputTokens ?? 0, cost: data?.tokenCosts?.output },
    { key: 'cache-read', label: 'Cache read', value: totals?.cacheReadTokens ?? 0, cost: data?.tokenCosts?.cacheRead },
    {
      key: 'cache-write',
      label: 'Cache write',
      value: totals?.cacheWriteTokens ?? 0,
      cost: data?.tokenCosts?.cacheWrite,
    },
  ]);

  function breakdownName(name: string) {
    return grouping === 'devices'
      ? deviceName(name)
      : grouping === 'projects'
        ? projectName(name)
        : (categoryNames[name] ?? name);
  }
  function share(value: number, total: number) {
    return total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  }
  function compositionTitle(part: (typeof composition)[number]) {
    const tokens = `${part.label}: ${integer.format(part.value)} tokens (${share(part.value, totals?.tokens ?? 0).toFixed(1)}%)${
      part.key === 'output' && totals?.reasoningTokens
        ? `, including ${integer.format(totals.reasoningTokens)} reasoning tokens`
        : ''
    }`;
    const cost =
      !part.cost || (part.value > 0 && part.cost.unavailableTokens >= part.value)
        ? 'Cost breakdown unavailable'
        : `${currency.format(part.cost.costUSD)} estimated cost`;
    const excluded = part.cost?.unavailableTokens
      ? `; ${integer.format(part.cost.unavailableTokens)} tokens excluded from this cost breakdown`
      : '';
    const unattributed = data?.tokenCosts?.unattributedCostUSD
      ? `; ${currency.format(data.tokenCosts.unattributedCostUSD)} in reported usage costs cannot be split by token category`
      : '';
    return `${tokens}; ${cost}${excluded}${unattributed}`;
  }
  function compositionCost(part: (typeof composition)[number]) {
    if (!part.cost) return '—';
    return part.value > 0 && part.cost.unavailableTokens >= part.value ? '—' : currency.format(part.cost.costUSD);
  }

  function deviceName(id: string) {
    return deviceNames.get(id) ?? (id === 'local' ? (data?.machine ?? 'This machine') : id);
  }
  function projectName(value: string) {
    return projectLabel(value);
  }
  function formatDate(value: string) {
    return date.format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
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
  async function refresh() {
    if (!client) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const version = ++requestVersion;
    const requestedKey = queryKey;
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
      const requestedQuery = query;
      const next = await client.getUsage({ ...requestedQuery }, controller.signal);
      if (controller.signal.aborted || version !== requestVersion || requestedKey !== queryKey) return;
      data = next;
      if (
        next.filters.selectedModels &&
        JSON.stringify(next.filters.selectedModels) !== JSON.stringify(requestedQuery.models)
      ) {
        params.update({ models: encodeFilter(next.filters.selectedModels) }, { pushHistory: false });
        observedQueryKey = JSON.stringify(usageQueryFromParams(params, timezone));
      }
      dataQueryKey = JSON.stringify(usageQueryFromParams(params, timezone));
    } catch (failure) {
      if (controller.signal.aborted || version !== requestVersion || requestedKey !== queryKey) return;
      error = failure instanceof Error ? failure.message : 'Could not load usage. Try again.';
    } finally {
      if (version === requestVersion) loading = false;
    }
  }
  function changeQuery(next: UsageQuery) {
    params.update({
      range: ranges.find((entry) => entry.value === next.range)?.value ?? '30d',
      harnesses: encodeFilter(next.harnesses),
      providers: encodeFilter(next.providers),
      models: encodeFilter(next.models),
      devices: encodeFilter(next.devices),
      projects: encodeFilter(next.projects),
      page: 1,
    });
  }
  function removeChip(key: (typeof filterKeys)[number], value: string) {
    const remaining = (query[key] ?? []).filter((entry) => entry !== value);
    changeQuery({ ...query, [key]: query[key]?.length === 0 || remaining.length === 0 ? undefined : remaining });
  }
  function mountDashboard() {
    untrack(() => {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      client = makeDashboardClient();
    });
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60000);
    return () => {
      clearInterval(timer);
      request?.abort();
      params.cleanup();
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
        'session_title',
        'project_name',
        't3_thread_id',
        't3_thread_url',
        't3_native_thread_url',
        'repository_url',
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
        session.sessionTitle ?? '',
        session.projectName ?? '',
        session.t3ThreadId ?? '',
        safeWebUrl(session.t3ThreadUrl) ?? '',
        nativeThreadUrl(session) ?? '',
        repositoryWebUrl(session.repository) ?? '',
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

  <main data-loading={loading}>
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
          names={categoryNames}
          grouping="harnesses"
          onchange={(harnesses) => changeQuery({ ...query, harnesses })}
        />
        <MultiSelect
          label="Providers"
          options={data?.filters.providers ?? []}
          value={query.providers}
          names={categoryNames}
          grouping="providers"
          onchange={(providers) => changeQuery({ ...query, providers })}
        />
        <MultiSelect
          label="Models"
          options={data?.filters.models ?? []}
          value={query.models}
          grouping="models"
          onchange={(models) => changeQuery({ ...query, models })}
        />
        <MultiSelect
          label="Devices"
          options={data?.filters.devices ?? []}
          value={query.devices}
          grouping="devices"
          colors={deviceColors}
          names={Object.fromEntries((data?.filters.devices ?? []).map((id) => [id, deviceName(id)]))}
          onchange={(selected) => changeQuery({ ...query, devices: selected })}
        />
        <MultiSelect
          label="Projects"
          options={data?.filters.projects ?? []}
          value={query.projects}
          grouping="projects"
          colors={projectColors}
          names={Object.fromEntries((data?.filters.projects ?? []).map((id) => [id, projectName(id)]))}
          onchange={(projects) => changeQuery({ ...query, projects })}
        />
      </div>
      <span class="period-label"
        ><span class="usage-period">{period}</span><span
          class={['refresh-state', loading && 'visible']}
          role="status"
          aria-atomic="true">{loading ? (data ? 'Updating…' : 'Loading usage…') : ''}</span
        ></span
      >
    </div>
    <div class="filter-chip-region">
      <div class="filter-chips">
        {#each chips as chip (`${chip.key}:${chip.value}`)}<button
            class="filter-chip"
            aria-label={`Remove ${chip.label} filter`}
            onclick={() => removeChip(chip.key, chip.value)}
            >{#if chip.color}<i class="category-swatch" style:background={chip.color} aria-hidden="true"></i>{/if}<span
              class="filter-chip-label">{chip.label}</span
            ><Icon name="close" size={12} /></button
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
        <span class="metric-label">Total tokens</span><strong class={['metric-value', !data && loading && 'skeleton']}
          >{totals ? compact.format(totals.tokens) : '—'}</strong
        ><span class="metric-detail"
          >{totals ? `${integer.format(totals.tokens)} tokens` : 'Input, output & cache'}</span
        >
      </div>
      <div class="metric">
        <span class="metric-label">Estimated API cost</span><strong
          class={['metric-value', !data && loading && 'skeleton']}>{totals ? formatCost(totals) : '—'}</strong
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
        <span class="metric-label">Sessions</span><strong class={['metric-value', !data && loading && 'skeleton']}
          >{totals ? integer.format(totals.sessions) : '—'}</strong
        ><span class="metric-detail"
          >{totals ? `${integer.format(totals.requests)} requests` : 'Across your harnesses'}</span
        >
      </div>
      <div class="metric">
        <span class="metric-label">Cache hit rate</span><strong class={['metric-value', !data && loading && 'skeleton']}
          >{totals ? `${(totals.cacheHitRate * 100).toFixed(1)}%` : '—'}</strong
        ><span class="metric-detail">Cached input / total input</span>
      </div>
    </section>

    <div class="analytics-grid">
      <section class="activity-panel" aria-labelledby="activity-title" aria-busy={loading}>
        <div class="section-heading">
          <h2 id="activity-title">{metric === 'tokens' ? 'Token activity' : 'Cost activity'}</h2>
          <div class="chart-controls">
            <div class="segmented" aria-label="Chart type">
              <button
                class={chartMode === 'bar' ? 'active' : ''}
                aria-label="Bar chart"
                aria-pressed={chartMode === 'bar'}
                onclick={() => params.update({ chart: 'bar' })}><Icon name="bars" size={16} /></button
              ><button
                class={chartMode === 'line' ? 'active' : ''}
                aria-label="Line chart"
                aria-pressed={chartMode === 'line'}
                onclick={() => params.update({ chart: 'line' })}><Icon name="line" size={16} /></button
              >
            </div>
            <div class="segmented" aria-label="Chart measurement">
              <button
                class={metric === 'tokens' ? 'active' : ''}
                aria-pressed={metric === 'tokens'}
                onclick={() => params.update({ metric: 'tokens' })}>Tokens</button
              ><button
                class={metric === 'costUSD' ? 'active' : ''}
                aria-pressed={metric === 'costUSD'}
                onclick={() => params.update({ metric: 'cost' })}>Cost</button
              >
            </div>
          </div>
        </div>
        {#if data}<UsageChart
            {data}
            mode={chartMode}
            {metric}
            grouping={params.chartBy}
            onGroupingChange={(chartBy) => params.update({ chartBy })}
          />{:else}<div class="chart-loading">
            {#if error}<Icon name="warning" size={24} /><span>Usage is unavailable</span><button
                class="text-button"
                onclick={() => void refresh()}>Try again</button
              >{:else}<span class="spinner"></span><span>Reading local usage</span>{/if}
          </div>{/if}
        <div class="token-composition" aria-label="Token composition">
          <div class="composition-track" role="img" aria-label={composition.map(compositionTitle).join('; ')}>
            {#each composition as part (part.key)}<span
                class={`composition-segment composition-${part.key}`}
                style:width={`${share(part.value, totals?.tokens ?? 0)}%`}
                aria-hidden="true"
              ></span>{/each}
          </div>
          <div class="composition-values">
            {#each composition as part (part.key)}<div class="composition-value" title={compositionTitle(part)}>
                <span class="composition-name"
                  ><i class={`composition-${part.key}`} aria-hidden="true"></i>{part.label}<span
                    class="composition-percent">{totals ? `${share(part.value, totals.tokens).toFixed(1)}%` : '—'}</span
                  ></span
                ><span class="composition-totals"
                  ><b>{totals ? compact.format(part.value) : '—'}</b><span class="composition-cost"
                    ><span class="composition-cost-amount">{compositionCost(part)}</span
                    >{#if part.cost?.unavailableTokens}<span aria-hidden="true">*</span>{/if}</span
                  ></span
                >
              </div>{/each}
          </div>
        </div>
      </section>
      <section class="breakdown-panel" aria-labelledby="breakdown-title" aria-busy={loading}>
        <div class="section-heading">
          <h2 id="breakdown-title">Breakdown</h2>
          <span class="muted">{breakdown.length || '—'}</span>
        </div>
        <div class="breakdown-tabs" aria-label="Breakdown grouping">
          {#each breakdownGroups as group (group)}<button
              class={grouping === group ? 'active' : ''}
              aria-pressed={grouping === group}
              onclick={() => params.update({ breakdown: group, expanded: false })}
              >{group.charAt(0).toUpperCase() + group.slice(1)}</button
            >{/each}
        </div>
        <div class="breakdown-summary">
          <div
            class="breakdown-share-track"
            role="img"
            aria-label={`${metric === 'tokens' ? 'Token' : 'Priced cost'} share by ${grouping}`}
          >
            {#each breakdownOverview as segment (segment.name)}{#if segment.value > 0}<span
                  style:width={`${share(segment.value, breakdownTotal)}%`}
                  style:background={segment.color}
                  title={`${breakdownName(segment.name)}: ${metric === 'tokens' ? `${compact.format(segment.value)} tokens` : currency.format(segment.value)} · ${share(segment.value, breakdownTotal).toFixed(1)}%`}
                  aria-hidden="true"
                ></span>{/if}{/each}
          </div>
          <span class="breakdown-pricing-note"
            >{metric === 'costUSD' && unpriced > 0 ? `${compact.format(unpriced)} unpriced tokens excluded` : ''}</span
          >
        </div>
        <div class="breakdown-list">
          {#each visibleBreakdown as row (row.name)}<div class="breakdown-row">
              <div class="breakdown-top">
                <span class="breakdown-name" title={row.name}
                  ><i class="category-swatch" style:background={categoryColor(row.name, grouping)} aria-hidden="true"
                  ></i><span class="breakdown-label">{breakdownName(row.name)}</span></span
                ><b title={metric === 'tokens' ? `${integer.format(row.tokens)} tokens` : formatCost(row)}
                  >{metric === 'tokens' ? compact.format(row.tokens) : formatCost(row)}</b
                >
              </div>
              <div class="breakdown-track">
                <span
                  style:width={`${share(row[metric], breakdownTotal)}%`}
                  style:background={categoryColor(row.name, grouping)}
                ></span>
              </div>
              <div class="breakdown-meta">
                <span
                  title={row.unpricedTokens > 0
                    ? `${integer.format(row.unpricedTokens)} tokens have no model price`
                    : ''}
                  >{metric === 'tokens'
                    ? formatCost(row)
                    : `${compact.format(row.tokens)} tokens`}{#if row.unpricedTokens > 0}<span
                      class="breakdown-unpriced"
                    >
                      · {compact.format(row.unpricedTokens)} unpriced</span
                    >{/if}</span
                ><span
                  >{metric === 'costUSD' && row.tokens > 0 && row.unpricedTokens >= row.tokens
                    ? '—'
                    : `${share(row[metric], breakdownTotal).toFixed(1)}%`}</span
                >
              </div>
            </div>{:else}<div class="breakdown-empty">{data ? 'No usage to show' : 'Loading breakdown…'}</div>{/each}
        </div>
        <div class="breakdown-footer">
          {#if breakdown.length > 5}<button
              class="text-button show-more"
              onclick={() => params.update({ expanded: !showAll })}
              >{showAll ? 'Show top five' : `Show all ${breakdown.length}`}</button
            >{/if}
        </div>
      </section>
    </div>

    <section class="sessions-panel" aria-labelledby="sessions-title" aria-busy={loading}>
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
            value={sessionSearch}
            oninput={(event) => params.update({ search: event.currentTarget.value, page: 1 }, { pushHistory: false })}
          /></label
        >
      </div>
      <div class="table-scroll">
        <table>
          <thead
            ><tr
              ><th scope="col">Session / project</th><th scope="col">Harness / model</th><th scope="col" class="numeric"
                ><button onclick={() => params.update({ sort: 'tokens', page: 1 })}>Tokens</button></th
              ><th scope="col" class="numeric">Est. cost</th><th scope="col" class="numeric"
                ><button onclick={() => params.update({ sort: 'lastActiveAt', page: 1 })}>Last active</button></th
              ></tr
            ></thead
          ><tbody
            >{#each sessions as session (`${session.deviceId}:${session.harness}:${session.id}`)}
              {@const threadUrl = safeWebUrl(session.t3ThreadUrl)}
              {@const nativeUrl = nativeThreadUrl(session)}
              {@const repoUrl = repositoryWebUrl(session.repository)}
              {@const pathName = session.project.split(/[\\/]/).filter(Boolean).at(-1) ?? session.project}
              {@const name = sessionDisplayName(session)}
              {@const hasTitle = Boolean(session.sessionTitle || session.projectName)}
              {@const primaryUrl = nativeUrl ?? threadUrl ?? (hasTitle ? undefined : repoUrl)}
              <tr
                ><td
                  ><div class="session-project" title={name}>
                    {#if primaryUrl}<a
                        href={primaryUrl}
                        target={nativeUrl ? undefined : '_blank'}
                        rel="noopener noreferrer"
                        aria-label={`${threadUrl ? 'Open T3 Code thread' : 'Open repository'}: ${name}`}
                      >
                        <span>{name}</span><Icon name="external" size={14} />
                      </a>{:else}<span>{name}</span>{/if}
                  </div>
                  <div
                    class="session-context"
                    title={hasTitle ? (session.repository ?? session.project) : session.project}
                  >
                    {#if (hasTitle || threadUrl) && repoUrl}<a
                        href={repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open repository: ${projectName(session.repository ?? session.project)}`}
                      >
                        <Icon name="repository" size={14} /><span
                          >{projectName(session.repository ?? session.project)}</span
                        >
                      </a>{:else}<span>{hasTitle ? session.projectName || projectName(session.project) : pathName}</span
                      >{/if}
                    <span class="session-device">- {deviceName(session.deviceId)}</span>
                  </div></td
                ><td
                  ><span class="session-harness"
                    ><i
                      class="category-swatch"
                      style:background={seriesColor(session.harness, 'harnesses')}
                      aria-hidden="true"
                    ></i><span>{categoryNames[session.harness] ?? session.harness}</span></span
                  ><span class="session-model" title={session.model}
                    ><i
                      class="category-swatch"
                      style:background={seriesColor(session.model, 'models')}
                      aria-hidden="true"
                    ></i><span>{session.model}</span></span
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
            onclick={() => params.update({ page: currentPage })}
            ><span class="previous-arrow"><Icon name="arrow" size={16} /></span></button
          ><span>{currentPage + 1} / {pages}</span><button
            aria-label="Next page"
            disabled={currentPage >= pages - 1}
            onclick={() => params.update({ page: currentPage + 2 })}><Icon name="arrow" size={16} /></button
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
        {#if page.data.passcodeEnabled}<form method="POST" action="/logout">
            <button type="submit">Sign out</button>
          </form>{/if}
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
          <strong
            ><i class="category-swatch" style:background={seriesColor(source.harness, 'harnesses')} aria-hidden="true"
            ></i>
            {categoryNames[source.harness] ?? source.harness}</strong
          ><span class={['source-status', source.status]}>{source.status}</span>
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
