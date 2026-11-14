<script lang="ts">
  import { exportSessions } from '#lib/client/session-export';
  import { onMount, untrack, tick } from 'svelte';
  import { page } from '$app/state';
  import { useSearchParams } from 'runed/kit';
  import { makeWorkbenchCache, usageScopeKey } from '#lib/client/workbench-cache';
  import { makeDashboardClient, usagePageSize } from '#lib/client/dashboard-rpc';
  import {
    dashboardRanges,
    defaultDashboardRange,
    readDefaultRange,
    readHiddenProjects,
    decodeFilter,
    encodeFilter,
    type DashboardRange,
  } from '#lib/client/dashboard-url';
  import { filtersOf, splitOf, splitTo, workbenchUrlSchema, type WorkbenchParams } from '#lib/client/workbench-url';
  import { assignChartColors } from '#lib/client/workbench-colors';
  import { categoryNames, modelLabel } from '#lib/client/visuals';
  import {
    cursorAgentUrl,
    nativeThreadUrl,
    projectLabel,
    projectLabels,
    safeWebUrl,
    sessionDisplayName,
  } from '#lib/client/session-links';
  import { theme } from '#lib/client/theme.svelte';
  import {
    groupNames,
    groups,
    rangeFrom,
    formatValue,
    valueOf,
    periodOf,
    deltaOf,
    timeBuckets,
    type Group,
    type Metric,
  } from '#lib/client/usage-workbench';
  import { sessionPageSize as perPage } from '#lib/shared/dashboard-page';
  import type { DashboardPage, UsageQuery, Device, SessionSort } from '#lib/shared/domain';
  import { initialOrder, isDefaultSessionSort } from '#lib/shared/session-sort';
  import Icon from '#lib/components/Icon.svelte';
  import Trend from '#lib/components/workbench/Trend.svelte';
  import Breakdown from '#lib/components/workbench/Breakdown.svelte';
  import ScopeDialog from '#lib/components/workbench/ScopeDialog.svelte';
  import './workbench.css';
  let shortcut = $state('Ctrl K');
  const currentUrl = $derived(page.shallow?.url ?? page.url);
  // All view state lives in the URL. Scope changes (filters, split, range)
  // push history so Back restores the previous view; the rest, including the
  // selected chart bucket, replaces it.
  const params = useSearchParams(workbenchUrlSchema, { pushHistory: false, noScroll: true });
  function set(values: Partial<WorkbenchParams>, push = false) {
    params.update(values, { pushHistory: push });
  }
  const group = $derived(splitOf(params, currentUrl.searchParams));
  const metric: Metric = $derived(params.metric === 'cost' ? 'costUSD' : 'tokens');
  const sort: SessionSort = $derived({ by: params.sort, order: params.order });
  const sortKey = $derived(`${sort.by}:${sort.order}`);
  let defaultRange = $state<DashboardRange>(defaultDashboardRange),
    timezone = $state('UTC'),
    hidden = $state.raw<readonly string[]>([]);
  const range = $derived(rangeFrom(params.range, defaultRange));
  const filters = $derived(filtersOf(params));
  const query: UsageQuery = $derived({
    range,
    timezone,
    ...filters,
    // A present-but-empty param is an explicit "hide nothing" link; only an
    // absent one falls back to this browser's saved hidden projects.
    excludedProjects: currentUrl.searchParams.has('excludedProjects')
      ? decodeFilter(params.excludedProjects)
      : hidden.length
        ? hidden
        : undefined,
  });
  const scope = $derived(usageScopeKey(query));
  const requestedPage = $derived(params.page);
  const pageKey = (scope: string, n: number, order: string) => `${n}:${order}:${scope}`;
  const key = $derived(pageKey(scope, requestedPage, sortKey));
  const cache = makeWorkbenchCache(usagePageSize);
  let data = $state.raw<DashboardPage>(),
    devices = $state.raw<readonly Device[]>([]),
    client = $state.raw<ReturnType<typeof makeDashboardClient>>();
  let chartData = $state.raw<DashboardPage>();
  let loading = $state(true),
    error = $state(''),
    exportError = $state(''),
    loadedKey = $state(''),
    loadedScope = $state(''),
    loadedSort = '',
    exporting = $state(false);
  let exportRequest: AbortController | undefined;
  let generation = 0;
  let prefetch: { key: string; stop: AbortController; result: Promise<DashboardPage> } | undefined;
  let request: AbortController | undefined;
  let overlay = $state.raw<{ group?: Group }>();
  let returnTo: HTMLElement | undefined;
  const active = $derived(groups.flatMap((g) => (filters[g] ?? []).map((v) => ({ g, v }))));
  const projects = $derived(projectLabels(data?.filters.projects ?? []));
  const names = $derived(new Map(devices.map((d) => [d.id, d.name])));
  const label = (g: Group, id: string) =>
    g === 'devices'
      ? (names.get(id) ?? (id === 'local' ? (data?.machine ?? 'This machine') : id))
      : g === 'projects'
        ? (projects.get(id) ?? projectLabel(id))
        : g === 'models'
          ? modelLabel(id)
          : (categoryNames[id] ?? id);
  const ready = $derived(data && loadedKey === key);
  const count = $derived(data?.sessionCount ?? 0),
    offset = $derived(data?.sessionOffset ?? 0);
  const cursor = $derived(Math.floor(offset / perPage));
  const sessionDate = $derived(
    new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }),
  );
  const rangeNames = { today: 'Today', '7d': '7d', '30d': '30d', '90d': '90d', '6m': '6m' } as const;
  const wholeRange = {
    today: 'all of today',
    '7d': 'all 7 days',
    '30d': 'all 30 days',
    '90d': 'all 90 days',
    '6m': 'all 6 months',
  };
  let chartColors = $state.raw(new Map<Group, ReadonlyMap<string, string>>());
  // A stale or foreign bucket key (another range, an old link) selects nothing.
  const day = $derived(
    chartData && params.day && timeBuckets(chartData, group).some((b) => b.key === params.day) ? params.day : undefined,
  );
  const selectDay = (key: string | undefined) => set({ day: key ?? '' });
  async function fetchPage(q: UsageQuery, n: number, k: string, order: SessionSort, signal: AbortSignal) {
    if (!client) throw new Error('Dashboard is not ready.');
    const since = generation,
      started = new Date(),
      same = loadedScope === usageScopeKey(q) && loadedSort === `${order.by}:${order.order}`;
    const value = await client.getUsagePage(
      q,
      n,
      signal,
      same ? data : undefined,
      isDefaultSessionSort(order) ? undefined : order,
    );
    if (!signal.aborted && since === generation) cache.put(k, value, started);
    return value;
  }
  async function readPage(q: UsageQuery, n: number, signal: AbortSignal, order = sort) {
    const k = pageKey(usageScopeKey(q), n, `${order.by}:${order.order}`);
    return cache.get(k) ?? (prefetch?.key === k ? prefetch.result : fetchPage(q, n, k, order, signal));
  }
  function cancelPrefetch() {
    prefetch?.stop.abort();
    prefetch = undefined;
  }
  function warmPage(n: number) {
    if (!ready || loading || n < 1 || n > Math.ceil(count / perPage)) return;
    const k = pageKey(scope, n, sortKey);
    if (cache.get(k) || prefetch?.key === k) return;
    cancelPrefetch();
    const stop = new AbortController();
    const result = fetchPage(query, n, k, sort, stop.signal);
    prefetch = { key: k, stop, result };
    // Speculation is never an error on the displayed page. Navigation joins
    // this request, or retries normally if it already failed.
    void result
      .catch(() => {})
      .finally(() => {
        if (prefetch?.stop === stop) prefetch = undefined;
      });
  }
  async function refresh(force = false) {
    if (!client) return;
    const q = query,
      k = key,
      scopeKey = scope,
      order = sort,
      orderKey = sortKey;
    request?.abort();
    const c = new AbortController();
    request = c;
    if (force || prefetch?.key !== k) cancelPrefetch();
    if (force) {
      generation++;
      cache.clear();
    }
    loading = true;
    error = '';
    try {
      const result = await readPage(q, requestedPage, c.signal, order);
      if (!c.signal.aborted && k === key) {
        if (chartData?.daily !== result.daily) {
          chartColors = new Map(groups.map((g) => [g, assignChartColors(result[g], chartColors.get(g))]));
          chartData = result;
        }
        data = result;
        loadedKey = k;
        loadedScope = scopeKey;
        loadedSort = orderKey;
      }
    } catch (e) {
      if (!c.signal.aborted) error = e instanceof Error ? e.message : 'Could not load usage.';
    } finally {
      if (!c.signal.aborted) loading = false;
    }
  }
  async function downloadSessions() {
    if (!data || !client || !ready || exporting) return;
    const c = new AbortController(),
      k = scope;
    exportRequest = c;
    exporting = true;
    exportError = '';
    try {
      const full = data.sessions.length === count ? data : await client.getSessionExport(query, c.signal);
      if (!c.signal.aborted && k === scope) exportSessions(full, (id) => label('devices', id));
    } catch (e) {
      if (!c.signal.aborted) exportError = e instanceof Error ? e.message : 'Could not export sessions.';
    } finally {
      if (exportRequest === c) exporting = false;
    }
  }
  function resume() {
    if (!document.hidden && !overlay && !loading && !cache.get(key)) void refresh(true);
  }
  onMount(() => {
    shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
    defaultRange = readDefaultRange();
    hidden = readHiddenProjects();
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const rpc = makeDashboardClient('/rpc', { requestTimeoutMs: 120000 });
    client = rpc;
    const abort = new AbortController();
    void rpc
      .getDevices(abort.signal)
      .then((d) => {
        if (!abort.signal.aborted) devices = d;
      })
      .catch(() => {});
    const timer = setInterval(() => {
      if (!document.hidden && !overlay && !loading) void refresh(true);
    }, 60000);
    return () => {
      clearInterval(timer);
      abort.abort();
      exportRequest?.abort();
      cancelPrefetch();
      request?.abort();
      void rpc.dispose();
    };
  });
  $effect(() => {
    const k = key;
    const rpc = client;
    if (rpc && k)
      untrack(() => {
        overlay = undefined;
        exportRequest?.abort();
        exportError = '';
        void refresh();
      });
  });
  function palette(g?: Group) {
    if (!data || !ready) return;
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    overlay = { group: g };
  }
  function close() {
    overlay = undefined;
    void tick().then(() => {
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('.scope-trigger')?.focus({ preventScroll: true });
    });
  }
  function apply(next: Pick<UsageQuery, Group>) {
    if (overlay) close();
    set({ ...Object.fromEntries(groups.map((g) => [g, encodeFilter(next[g])])), page: 1 }, true);
  }
  // A session cell narrows to its value; clicking the sole filter again clears it.
  function only(g: Group, v: string) {
    const sole = filters[g]?.length === 1 && filters[g][0] === v;
    apply({ ...filters, [g]: sole ? undefined : [v] });
  }
  function sortBy(by: SessionSort['by']) {
    const order = sort.by === by ? (sort.order === 'asc' ? 'desc' : 'asc') : initialOrder(by);
    set({ sort: by, order, page: 1 });
  }
  const columns = [
    { by: 'project', label: 'Project' },
    { by: 'model', label: 'Model' },
    { by: 'device', label: 'Device' },
    { by: 'active', label: 'Last active' },
    { by: 'cost', label: 'Cost' },
    { by: 'tokens', label: 'Tokens' },
  ] as const;
  function toggle(g: Group, v: string) {
    const old = filters[g] ?? [],
      next = old.includes(v) ? old.filter((x) => x !== v) : [...old, v];
    apply({ ...filters, [g]: next.length ? next : undefined });
  }
  function keys(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay) close();
      else palette();
    }
  }
</script>

<svelte:head><title>Usage · Token tracker</title></svelte:head>
<svelte:window onkeydown={keys} />
<svelte:document onvisibilitychange={resume} />
<div class="usage-app" {@attach theme.attach}>
  <header class="wb-mast">
    <div class="wb-wrap wb-mast-inner">
      <a class="wb-brand" href="/" aria-label="Token tracker overview"
        ><svg width="23" height="24" viewBox="0 0 28 28" fill="currentColor" aria-hidden="true"
          ><path d="M2 16h5v10H2zM11 9h5v17h-5zM20 2h5v24h-5z" /></svg
        ><span>Token tracker<b>.</b></span></a
      >
      <div class="mast-tools">
        <a href="/settings" aria-label="Settings"><Icon name="settings" size={17} /></a><button
          aria-label="Switch theme"
          onclick={() => theme.choose(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}
          ><span class="light-icon"><Icon name="moon" size={17} /></span><span class="dark-icon"
            ><Icon name="sun" size={17} /></span
          ></button
        >
      </div>
    </div>
  </header>
  <main class="wb-wrap wb-main">
    <div class="wb-board">
      <div class="wb-question">
        <div class="wb-scope">
          <div class="wb-scope-controls">
            <div class="wb-segmented" role="group" aria-label="Date range">
              {#each dashboardRanges as r (r.value)}<button
                  aria-pressed={range === r.value}
                  title={r.label}
                  onclick={() => range !== r.value && set({ range: r.value, day: '', page: 1 }, true)}
                  >{rangeNames[r.value]}</button
                >{/each}
            </div>
            <button class="scope-trigger wb-link" disabled={!ready} onclick={() => palette()}
              ><Icon name="sliders" size={16} />Filter <kbd>{shortcut}</kbd></button
            >
            <div class="wb-scope-end">
              <div class="wb-segmented" role="group" aria-label="Metric">
                {#each [['tokens', 'Tokens'], ['cost', 'Cost']] as const as [value, name] (value)}<button
                    aria-pressed={params.metric === value}
                    onclick={() => set({ metric: value })}>{name}</button
                  >{/each}
              </div>
              <button
                class="wb-link refresh"
                class:spinning={loading}
                disabled={loading}
                title="Refresh"
                aria-label="Refresh"
                onclick={() => void refresh(true)}
                ><Icon name="refresh" size={14} /><span
                  >{data
                    ? new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '––:––'}</span
                ></button
              >
            </div>
          </div>
          <div class="wb-status">
            {#if error}<span class="wb-error" role="alert"
                >{error} <button class="wb-link" onclick={() => void refresh(true)}>Retry</button></span
              >{:else if exportError}<span class="wb-error" role="alert"
                >{exportError}
                <button class="wb-link" disabled={!ready || exporting} onclick={() => void downloadSessions()}
                  >Retry export</button
                ></span
              >{:else if active.length}{#each active as f (JSON.stringify([f.g, f.v]))}<button
                  class="scope-chip"
                  onclick={() => toggle(f.g, f.v)}
                  title={`Remove ${groupNames[f.g]}: ${label(f.g, f.v)}`}>{label(f.g, f.v)} ×</button
                >{/each}<button class="wb-link" onclick={() => apply({})}>Clear all</button>{:else}<span
                class="all-usage"
                >{query.excludedProjects?.length
                  ? `${query.excludedProjects.length} projects hidden`
                  : 'All usage'}</span
              >{/if}
          </div>
        </div>
        {#if data}{@const d = data}{@const shown = chartData ?? d}
          <div class="reading" aria-busy={loading} inert={loadedScope !== scope}>
            <section class="wb-strip" aria-label="Usage summary">
              {#each [{ name: 'Tokens', value: formatValue(d.totals.tokens, 'tokens'), delta: deltaOf(d.totals.tokens, d.previous?.tokens) }, { name: 'Est. cost', value: valueOf(d.totals, 'costUSD'), delta: deltaOf(d.totals.costUSD, d.previous?.costUSD) }, { name: 'Sessions', value: d.totals.sessions.toLocaleString(), delta: deltaOf(d.totals.sessions, d.previous?.sessions) }] as k (k.name)}<div
                  class="wb-stat"
                >
                  <span>{k.name}</span><strong>{k.value}</strong><small class={k.delta?.direction ?? ''}
                    >{#if k.delta}{k.delta.direction === 'up' ? '↑' : k.delta.direction === 'down' ? '↓' : '→'}
                      {k.delta.text}{/if}</small
                  >
                </div>{/each}
              <small class="wb-period">{periodOf(d)}</small>
            </section>
            <Trend
              data={shown}
              {group}
              {metric}
              colors={chartColors.get(group) ?? new Map()}
              {label}
              selected={day}
              onselect={selectDay}
              setGroup={(g) => set(splitTo(g), true)}
              chart={params.chart}
              setChart={(chart) => set({ chart })}
            />
          </div>
        {:else if !error}<div class="wb-loading" role="status">Reading tracker usage…</div>{/if}
      </div>
      {#if data}<div class="wb-answer reading" aria-busy={loading} inert={loadedScope !== scope}>
          <Breakdown
            data={chartData ?? data}
            {metric}
            selected={day}
            colors={chartColors}
            {label}
            {filters}
            {toggle}
            openAll={(g) => palette(g)}
            onselect={selectDay}
          />
        </div>{/if}
    </div>
    {#if data}{@const d = data}
      <section class="wb-sessions" inert={!ready}>
        <div class="wb-section-head">
          <h2>Sessions</h2>
          <div class="wb-pager">
            <small
              >{count ? `${cursor * perPage + 1}–${Math.min((cursor + 1) * perPage, count)}` : '0'} of {count.toLocaleString()}{day
                ? ` · ${wholeRange[range]}`
                : ''}</small
            ><button
              aria-label="Previous sessions"
              onpointerenter={() => warmPage(cursor)}
              onfocus={() => warmPage(cursor)}
              disabled={!cursor}
              onclick={() => set({ page: cursor })}><Icon name="chevron" size={16} /></button
            ><button
              aria-label="Next sessions"
              onpointerenter={() => warmPage(cursor + 2)}
              onfocus={() => warmPage(cursor + 2)}
              disabled={(cursor + 1) * perPage >= count}
              onclick={() => set({ page: cursor + 2 })}><Icon name="chevron" size={16} /></button
            ><button
              class="wb-link export"
              disabled={!ready || exporting}
              title="Export CSV"
              aria-label="Export CSV"
              onclick={() => void downloadSessions()}
              ><Icon name="download" size={14} /><span>{exporting ? 'Exporting…' : 'Export CSV'}</span></button
            >
          </div>
        </div>
        <table>
          <thead
            ><tr
              >{#each columns as c (c.by)}<th
                  aria-sort={sort.by === c.by ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}
                  ><button class:sorted={sort.by === c.by} onclick={() => sortBy(c.by)}
                    >{c.label}<span class="sort-mark" class:asc={sort.by === c.by && sort.order === 'asc'}
                      ><Icon name="chevron" size={12} /></span
                    ></button
                  ></th
                >{/each}</tr
            ></thead
          ><tbody
            >{#each d.sessions as s (JSON.stringify([s.deviceId, s.harness, s.id]))}{@const project =
                s.repository ?? s.project}{@const dest =
                nativeThreadUrl(s) ?? safeWebUrl(s.t3ThreadUrl) ?? cursorAgentUrl(s)}<tr
                ><td
                  ><div>
                    <button title={project} onclick={() => only('projects', project)}
                      >{label('projects', project)}</button
                    >{#if dest}<a aria-label={`Open ${sessionDisplayName(s)}`} href={dest} title={sessionDisplayName(s)}
                        ><Icon name="external" size={12} /></a
                      >{/if}
                  </div></td
                ><td
                  >{#if d.filters.models.includes(s.model)}<button
                      title={s.model}
                      onclick={() => only('models', s.model)}>{modelLabel(s.model)}</button
                    >{:else}<span title={s.model}>{s.model}</span>{/if}</td
                ><td><button onclick={() => only('devices', s.deviceId)}>{label('devices', s.deviceId)}</button></td><td
                  title={`Started ${sessionDate.format(new Date(s.startedAt))}`}
                  >{sessionDate.format(new Date(s.lastActiveAt))}</td
                ><td>{valueOf(s, 'costUSD')}</td><td>{formatValue(s.tokens, 'tokens')}</td></tr
              >{:else}<tr><td colspan="6">No matching sessions.</td></tr
              >{/each}{#each { length: perPage - Math.max(1, d.sessions.length) }, i (i)}<tr
                class="filler"
                aria-hidden="true"><td colspan="6"></td></tr
              >{/each}</tbody
          >
        </table>
      </section>
    {/if}
  </main>
  {#if overlay && data && client}<ScopeDialog
      {data}
      {query}
      {label}
      {apply}
      {close}
      initialGroup={overlay.group}
    />{/if}
</div>
