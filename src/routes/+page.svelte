<script lang="ts">
  import { exportSessions } from '#lib/client/session-export';
  import { onMount, untrack, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { makeDashboardClient } from '#lib/client/dashboard-rpc';
  import {
    dashboardRanges,
    readDefaultRange,
    readHiddenProjects,
    decodeFilter,
    type DashboardRange,
  } from '#lib/client/dashboard-url';
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
    splitFrom,
    rangeFrom,
    filtersFrom,
    setSelection,
    formatValue,
    valueOf,
    periodOf,
    type Group,
    type Metric,
    type Picked,
  } from '#lib/client/usage-workbench';
  import type { DashboardResponse, UsageQuery, Device } from '#lib/shared/domain';
  import Icon from '#lib/components/Icon.svelte';
  import Activity from '#lib/components/workbench/Activity.svelte';
  import ChoiceMenu from '#lib/components/workbench/ChoiceMenu.svelte';
  import ScopeDialog from '#lib/components/workbench/ScopeDialog.svelte';
  import './workbench.css';
  let shortcut = $state('Ctrl K');
  const p = $derived(new URLSearchParams(page.url.search));
  const compare = $derived(p.get('view') === 'compare');
  const group = $derived(splitFrom(p.get('split') ?? p.get('chartBy') ?? p.get('breakdown')));
  const metric: Metric = $derived(p.get('metric') === 'cost' ? 'costUSD' : 'tokens');
  let defaultRange = $state<DashboardRange>('30d'),
    timezone = $state('UTC'),
    hidden = $state.raw<readonly string[]>([]);
  const range = $derived(rangeFrom(p.get('range'), defaultRange));
  const filters = $derived(filtersFrom(p));
  const query: UsageQuery = $derived({
    range,
    timezone,
    ...filters,
    excludedProjects: p.has('excludedProjects')
      ? decodeFilter(p.get('excludedProjects') ?? '')
      : hidden.length
        ? hidden
        : undefined,
  });
  const key = $derived(JSON.stringify(query));
  let data = $state.raw<DashboardResponse>(),
    devices = $state.raw<readonly Device[]>([]),
    client = $state.raw<ReturnType<typeof makeDashboardClient>>();
  let loading = $state(true),
    error = $state(''),
    loadedKey = $state('');
  let request: AbortController | undefined;
  let overlay = $state.raw<{ picked?: Picked; group?: Group }>();
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
  const narrowed = $derived(Boolean(active.length) && groups.every((g) => data?.[g].length === 1));
  const count = $derived(data?.sessions.length ?? 0),
    perPage = 12;
  const cursor = $derived(
    Math.max(0, Math.min(Math.ceil(count / perPage) - 1, Math.floor(Number(p.get('page')) || 1) - 1)),
  );
  const sessionDate = $derived(
    new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }),
  );
  const rangeChoices = dashboardRanges.map((r) => ({
    value: r.value,
    label: r.value === '30d' ? '30 days' : r.value === '7d' ? '7 days' : r.label,
  }));
  let chartColors = $state.raw(new Map<Group, ReadonlyMap<string, string>>());
  // Hold the facet order still while checking values, even when the server re-ranks the filtered breakdown.
  let railOrder = $state.raw<Partial<Record<Group, readonly string[]>>>({});
  const availableRail = $derived.by(() => {
    const d = data;
    return groups.map((g) => {
      const options = new Set(d?.filters[g] ?? []);
      const available = [
        ...new Set([...(railOrder[g] ?? []).filter((v) => options.has(v)), ...options, ...(filters[g] ?? [])]),
      ];
      const limit = g === 'devices' ? 10 : 6;
      return { g, items: [...new Set([...available.slice(0, limit), ...(filters[g] ?? [])])], total: available.length };
    });
  });
  function href(change: (q: URLSearchParams) => void) {
    const q = new URLSearchParams(p);
    change(q);
    return `/${q.size ? '?' + q : ''}`;
  }
  function go(change: (q: URLSearchParams) => void, drill = false) {
    const url = href(change);
    if (url !== page.url.pathname + page.url.search) void goto(url, { reset: false, state: { usageDrill: drill } });
  }
  function updatePage(n: number) {
    go((q) => q.set('page', String(n)));
  }
  function update(k: string, v: string) {
    go((q) => {
      q.set(k, v);
      q.delete('page');
    });
  }
  async function refresh() {
    if (!client) return;
    const q = query,
      k = key;
    request?.abort();
    const c = new AbortController();
    request = c;
    loading = true;
    error = '';
    try {
      const result = await client.getUsage(q, c.signal);
      if (!c.signal.aborted && k === key) {
        if (!data || groups.every((g) => q[g] === undefined))
          railOrder = Object.fromEntries(groups.map((g) => [g, result[g].map((row) => row.name)]));
        chartColors = new Map(groups.map((g) => [g, assignChartColors(result[g], chartColors.get(g))]));
        data = result;
        loadedKey = k;
      }
    } catch (e) {
      if (!c.signal.aborted) error = e instanceof Error ? e.message : 'Could not load usage.';
    } finally {
      if (!c.signal.aborted) loading = false;
    }
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
      if (!document.hidden && !overlay && !loading) void refresh();
    }, 60000);
    return () => {
      clearInterval(timer);
      abort.abort();
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
        void refresh();
      });
  });
  function palette(g?: Group) {
    if (!data || !ready) return;
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    overlay = { group: g };
  }
  function inspect(pick: Picked) {
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    overlay = { picked: pick };
  }
  function close() {
    overlay = undefined;
    void tick().then(() => {
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('.scope-trigger')?.focus({ preventScroll: true });
    });
  }
  function apply(next: Pick<UsageQuery, Group>, drill?: Group) {
    if (overlay) close();
    go((q) => {
      for (const g of groups) setSelection(q, g, next[g]);
      if (drill) q.set('split', drill);
      q.delete('page');
    }, !!drill);
  }
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

<svelte:head><title>{compare ? 'Comparison desk' : 'Usage overview'} · Token tracker</title></svelte:head>
<svelte:window onkeydown={keys} />
<div class="usage-app" class:compare {@attach theme.attach}>
  <header class="wb-mast">
    <div class="wb-wrap wb-mast-inner">
      <a class="wb-brand" href="/" aria-label="Token tracker overview"
        ><svg width="23" height="24" viewBox="0 0 28 28" fill="currentColor" aria-hidden="true"
          ><path d="M2 16h5v10H2zM11 9h5v17h-5zM20 2h5v24h-5z" /></svg
        ><span>Token tracker<b>.</b></span></a
      >
      <nav aria-label="Usage views">
        <a
          aria-current={!compare ? 'page' : undefined}
          href={href((q) => {
            q.delete('view');
            q.delete('page');
          })}>Overview</a
        ><a
          aria-current={compare ? 'page' : undefined}
          href={href((q) => {
            q.set('view', 'compare');
            q.delete('page');
          })}>Compare</a
        >
      </nav>
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
    <div class="wb-heading">
      <h1>{compare ? 'Comparison desk' : 'Usage overview'}</h1>
      <button
        class="wb-link export"
        disabled={!data || !ready}
        onclick={() => data && exportSessions(data, (id) => label('devices', id))}
        ><Icon name="download" size={15} /> Export CSV</button
      >
    </div>
    {#snippet rangeControl()}<ChoiceMenu
        label="Date range"
        icon="calendar"
        value={range}
        choices={rangeChoices}
        onchange={(v) => update('range', v)}
      />{/snippet}
    {#snippet filterButton()}<button class="scope-trigger wb-link" disabled={!ready} onclick={() => palette()}
        ><Icon name="sliders" size={16} />{compare ? 'Search filters' : 'Filter usage'} <kbd>{shortcut}</kbd></button
      >{/snippet}
    {#snippet chips()}{#if active.length}<div class="scope-chips">
          <button class="summary-chip" onclick={() => palette()}>{active.length} filters</button
          >{#each active as f (JSON.stringify([f.g, f.v]))}<button
              class="scope-chip"
              onclick={() => toggle(f.g, f.v)}
              title={`Remove ${groupNames[f.g]}: ${label(f.g, f.v)}`}>{label(f.g, f.v)} ×</button
            >{/each}<button class="wb-link" onclick={() => apply({})}>Clear all</button>
        </div>{:else if !compare}<span class="all-usage"
          >{query.excludedProjects?.length ? `${query.excludedProjects.length} projects hidden` : 'All usage'}</span
        >{/if}{/snippet}
    <div class:desk-grid={compare}>
      {#if compare}<aside class="scope-rail">
          <h2><Icon name="sliders" size={17} />Scope</h2>
          {@render rangeControl()}{@render filterButton()}{@render chips()}
          {#each availableRail.slice(0, 3) as { g, items, total } (g)}<details open>
              <summary>{groupNames[g]} <small>{filters[g]?.length || ''}</small></summary>{#each items as v (v)}<label
                  class="wb-facet-row"
                  title={label(g, v)}
                  ><input
                    type="checkbox"
                    checked={filters[g]?.includes(v) ?? false}
                    onchange={() => toggle(g, v)}
                  /><span>{label(g, v)}</span></label
                >{/each}{#if total > items.length}<button class="wb-link more-filters" onclick={() => palette(g)}
                  >All {total} {g} →</button
                >{/if}
            </details>{/each}
        </aside>{/if}
      <div class="wb-content">
        {#if compare}<div class="scope-mobile">
            <div class="wb-section-head"><b>Scope</b>{@render rangeControl()}</div>
            <div class="mobile-groups">
              {#each groups.slice(0, 3) as g (g)}<button onclick={() => palette(g)}
                  >{groupNames[g]} {filters[g]?.length || ''}⌄</button
                >{/each}<button onclick={() => palette()}>More ⌄</button>
            </div>
            {@render chips()}
          </div>{:else}<div class="wb-scope">
            {@render rangeControl()}{@render filterButton()}{@render chips()}
          </div>{/if}
        {#if error}<div class="wb-error" role="alert">
            {error} <button class="wb-link" onclick={() => void refresh()}>Retry</button>
          </div>{/if}
        {#if data}{@const d = data}
          <div class="reading" aria-busy={loading} inert={!ready}>
            <section class="wb-kpis" aria-label="Usage summary">
              {#each [['Total tokens', formatValue(d.totals.tokens, 'tokens'), periodOf(d)], ['Estimated API cost', valueOf(d.totals, 'costUSD'), d.totals.unpricedTokens ? 'Priced tokens only' : 'API equivalent'], ['Sessions', d.totals.sessions.toLocaleString(), 'in this scope'], ['Cache hit rate', (d.totals.cacheHitRate * 100).toFixed(1) + '%', 'of input tokens']] as [name, val, sub] (name)}<div
                >
                  <span>{name}</span><strong>{val}</strong><small>{sub}</small>
                </div>{/each}
            </section>
            {#key JSON.stringify([loadedKey, group, metric, compare, p.get('scale')])}<Activity
                data={d}
                colors={chartColors.get(group) ?? new Map()}
                {group}
                {metric}
                {compare}
                independent={p.get('scale') === 'series'}
                narrowed={!!narrowed}
                canUndo={!!page.state.usageDrill}
                {label}
                {inspect}
                setGroup={(v) => update('split', v)}
                setMetric={(v) => update('metric', v === 'tokens' ? 'tokens' : 'cost')}
                setScale={(v) => update('scale', v ? 'series' : 'shared')}
                undo={() => history.back()}
                clear={() => apply({})}
              />{/key}
            <section class="wb-sessions">
              <div class="wb-section-head">
                <div class="wb-title-line">
                  <h2>Sessions</h2>
                  <small>{count.toLocaleString()}</small>
                </div>
                <div class="wb-pager">
                  <small
                    >{count ? `${cursor * perPage + 1}–${Math.min((cursor + 1) * perPage, count)}` : '0'} of {count.toLocaleString()}</small
                  ><button aria-label="Previous sessions" disabled={!cursor} onclick={() => updatePage(cursor)}
                    >‹</button
                  ><button
                    aria-label="Next sessions"
                    disabled={(cursor + 1) * perPage >= count}
                    onclick={() => updatePage(cursor + 2)}>›</button
                  >
                </div>
              </div>
              <table>
                <thead><tr><th>Project</th><th>Model</th><th>Device</th><th>Started</th><th>Tokens</th></tr></thead
                ><tbody
                  >{#each d.sessions.slice(cursor * perPage, (cursor + 1) * perPage) as s (JSON.stringify( [s.deviceId, s.harness, s.id] ))}{@const project =
                      s.repository ?? s.project}{@const dest =
                      nativeThreadUrl(s) ?? safeWebUrl(s.t3ThreadUrl) ?? cursorAgentUrl(s)}<tr
                      ><td
                        ><div>
                          <button title={project} onclick={() => inspect({ group: 'projects', name: project })}
                            >{label('projects', project)}</button
                          >{#if dest}<a
                              aria-label={`Open ${sessionDisplayName(s)}`}
                              href={dest}
                              title={sessionDisplayName(s)}><Icon name="external" size={12} /></a
                            >{/if}
                        </div></td
                      ><td
                        >{#if d.filters.models.includes(s.model)}<button
                            title={s.model}
                            onclick={() => inspect({ group: 'models', name: s.model })}>{modelLabel(s.model)}</button
                          >{:else}<span title={s.model}>{s.model}</span>{/if}</td
                      ><td
                        ><button onclick={() => inspect({ group: 'devices', name: s.deviceId })}
                          >{label('devices', s.deviceId)}</button
                        ></td
                      ><td>{sessionDate.format(new Date(s.startedAt))}</td><td>{formatValue(s.tokens, 'tokens')}</td
                      ></tr
                    >{:else}<tr><td colspan="5">No matching sessions.</td></tr>{/each}</tbody
                >
              </table>
            </section>
          </div>
        {:else if !error}<div class="wb-loading" role="status">Reading tracker usage…</div>{/if}
      </div>
    </div>
    <div class="wb-bottom">
      <button disabled={loading} onclick={() => void refresh()}
        >{loading
          ? 'Updating…'
          : `Refresh${data ? ' · ' + new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`}</button
      >
    </div>
  </main>
  {#if overlay && data && client}<ScopeDialog
      {data}
      {query}
      {metric}
      {client}
      {label}
      {apply}
      {close}
      picked={overlay.picked}
      initialGroup={overlay.group}
    />{/if}
</div>
