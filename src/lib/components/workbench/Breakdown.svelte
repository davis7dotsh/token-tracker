<script lang="ts">
  import type { DashboardBucketBreakdown, DashboardView, Device, UsageQuery } from '../../shared/domain';
  import { viewRankedLimit } from '../../shared/dashboard-view';
  import {
    bucketSelection,
    deviceSuffixes,
    groupNames,
    periodOf,
    valueOf,
    viewBuckets,
    type Group,
    type Metric,
  } from '../../client/usage-workbench';
  import Icon from '../Icon.svelte';

  let {
    data,
    devices = [],
    selectedBucket,
    bucketLoading = false,
    metric,
    selected,
    colors,
    label,
    filters,
    toggle,
    openAll,
    onwarmfilters,
    onselect,
  }: {
    data: DashboardView;
    devices?: readonly Device[];
    selectedBucket?: DashboardBucketBreakdown;
    bucketLoading?: boolean;
    metric: Metric;
    selected: string | undefined;
    colors: ReadonlyMap<Group, ReadonlyMap<string, string>>;
    label: (g: Group, id: string) => string;
    filters: Pick<UsageQuery, Group>;
    toggle: (g: Group, name: string) => void;
    openAll: (g: Group) => void;
    onwarmfilters?: () => void;
    onselect: (key: string | undefined) => void;
  } = $props();

  const id = $props.id();
  const order = ['models', 'projects', 'devices', 'providers', 'harnesses'] as const;
  const titles = {
    models: 'Models',
    projects: 'Projects',
    devices: 'Devices',
    providers: 'Providers',
    harnesses: 'Harnesses',
  };
  const neutral = 'var(--wb-muted)';
  let tab = $state<Group>('models');
  const buckets = $derived(viewBuckets(data));
  const scope = $derived(bucketSelection(buckets, selected));
  const total = $derived(scope.bucket ?? data.totals);
  const suffixes = $derived(
    deviceSuffixes(devices.length ? devices.map((d) => ({ name: d.id })) : data.breakdown.devices.rows, label),
  );
  const measure = (v: number) => (total[metric] > 0 ? Math.min(100, (100 * v) / total[metric]) : 0);
  const percent = (v: number) =>
    total[metric] === 0 ? '—' : v > 0 && measure(v) < 1 ? '<1%' : `${Math.round(measure(v))}%`;
  const spark = (values: readonly number[], peak: number) =>
    values
      .map(
        (v, i) =>
          `${((60 * i) / Math.max(1, values.length - 1)).toFixed(1)},${(17 - (16 * v) / (peak || 1)).toFixed(1)}`,
      )
      .join(' ');

  // Rank within the scope; the history plotted beside each name always uses the full range.
  const panels = $derived(
    order.map((g) => {
      const rangeDim = data.breakdown[g];
      const list = g !== 'providers' && g !== 'harnesses';
      const exactBucket =
        scope.bucket && selectedBucket?.key === scope.bucket.key ? selectedBucket.breakdown[g] : undefined;
      const sourceRows = exactBucket
        ? exactBucket.rows
        : scope.bucket
          ? rangeDim.rows
              .map((r) => ({
                ...r,
                tokens: r.t?.[scope.index] ?? 0,
                costUSD: r.c?.[scope.index] ?? 0,
                unpricedTokens: r.u?.[scope.index] ?? 0,
              }))
              .filter((r) => r.tokens > 0 || r.costUSD > 0)
          : rangeDim.rows;
      const totalCount = exactBucket
        ? exactBucket.totalCount
        : scope.bucket
          ? rangeDim.totalCount > rangeDim.rows.length
            ? Math.max(sourceRows.length, rangeDim.totalCount)
            : sourceRows.length
          : rangeDim.totalCount;
      const ranked = [...sourceRows].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name));
      const picked = list ? ranked.slice(0, viewRankedLimit) : ranked;
      const rows = picked.map((r) => ({
        name: r.name,
        tokens: r.tokens,
        costUSD: r.costUSD,
        unpricedTokens: r.unpricedTokens ?? 0,
        text: label(g, r.name),
        suffix: g === 'devices' ? suffixes.get(r.name) : undefined,
        color: colors.get(g)?.get(r.name) ?? neutral,
        values: list ? ((metric === 'tokens' ? r.t : r.c) ?? []) : [],
      }));
      const sumTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
      const hasOther =
        list &&
        (totalCount > rows.length ||
          (Boolean(scope.bucket) &&
            !exactBucket &&
            rangeDim.totalCount > rangeDim.rows.length &&
            total.tokens > sumTokens));
      const other = hasOther
        ? (() => {
            const sumCost = rows.reduce((sum, r) => sum + r.costUSD, 0);
            const sumUnpriced = rows.reduce((sum, r) => sum + r.unpricedTokens, 0);
            const exactOtherValues = exactBucket
              ? metric === 'tokens'
                ? exactBucket.otherT
                : exactBucket.otherC
              : undefined;
            return {
              tokens: Math.max(0, total.tokens - sumTokens),
              costUSD: Math.max(0, total.costUSD - sumCost),
              unpricedTokens: Math.max(0, total.unpricedTokens - sumUnpriced),
              text: 'Other',
              suffix: undefined,
              color: neutral,
              values:
                exactOtherValues ??
                buckets.map((b, i) => Math.max(0, b[metric] - rows.reduce((sum, r) => sum + (r.values[i] ?? 0), 0))),
            };
          })()
        : undefined;
      const peak = Math.max(0, ...rows.map((r) => Math.max(0, ...r.values)), ...(other?.values ?? []));
      return {
        g,
        list,
        rows,
        other,
        peak,
        available: data.filterCounts[g],
        hasHistory: true,
        sparkAvailable: buckets.length > 0,
      };
    }),
  );
  type Panel = (typeof panels)[number];
  type Row = Panel['rows'][number] | NonNullable<Panel['other']>;
  function tabKeys(e: KeyboardEvent, index: number) {
    const pos =
      e.key === 'ArrowRight'
        ? (index + 1) % order.length
        : e.key === 'ArrowLeft'
          ? (index + order.length - 1) % order.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? order.length - 1
              : undefined;
    if (pos === undefined || !(e.currentTarget instanceof HTMLElement)) return;
    e.preventDefault();
    tab = order[pos];
    e.currentTarget.parentElement?.querySelectorAll('button')[pos]?.focus();
  }
</script>

{#snippet nameOf(r: Row)}
  <span class="name"
    ><span>{r.text}</span>{#if r.suffix}<small>· {r.suffix}</small>{/if}</span
  >
{/snippet}
{#snippet rankedRow(r: Row, p: Panel)}
  <i class="swatch" aria-hidden="true"></i>
  <span class="identity">{@render nameOf(r)}<i class="share" style:width={`${measure(r[metric])}%`}></i></span>
  <span class="sparkline" aria-hidden="true"
    >{#if p.sparkAvailable}<svg viewBox="0 0 60 18" preserveAspectRatio="none"
        ><polyline
          points={spark(r.values, p.peak)}
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          vector-effect="non-scaling-stroke"
        /></svg
      >{/if}</span
  >
  <span class="value">{valueOf(r, metric)}</span><span class="pct">{percent(r[metric])}</span>
{/snippet}

<section class="breakdown" aria-label="Usage breakdown" aria-busy={bucketLoading}>
  <header>
    <div class="scope" aria-live="polite" aria-atomic="true">
      <h2>{scope.bucket?.label ?? periodOf(data)}</h2>
      <span>{valueOf(total, metric)}{metric === 'tokens' ? ' tokens' : ''}</span>
    </div>
    <div class="nav">
      <button
        type="button"
        aria-label="Previous bucket"
        title="Previous bucket"
        class="prev"
        disabled={!scope.previous}
        onclick={() => onselect(scope.previous)}><Icon name="arrow" size={15} /></button
      >
      <button
        type="button"
        aria-label="Next bucket"
        title="Next bucket"
        disabled={!scope.next}
        onclick={() => onselect(scope.next)}><Icon name="arrow" size={15} /></button
      >
      <button
        type="button"
        aria-label="Clear bucket selection"
        title="Clear bucket selection"
        class="clear"
        disabled={!scope.bucket}
        onclick={() => onselect(undefined)}><Icon name="close" size={15} /></button
      >
    </div>
  </header>
  <div class="tabs" role="tablist" aria-label="Breakdown dimension">
    {#each order as g, i (g)}<button
        type="button"
        role="tab"
        aria-selected={tab === g}
        aria-controls={`${id}-${g}`}
        tabindex={tab === g ? 0 : -1}
        onkeydown={(e) => tabKeys(e, i)}
        onclick={() => (tab = g)}>{groupNames[g]}</button
      >{/each}
  </div>
  <div class="layout">
    {#each panels as p (p.g)}
      <section
        id={`${id}-${p.g}`}
        class="panel"
        class:split={!p.list}
        class:visible={tab === p.g}
        style:--area={p.g}
        aria-label={titles[p.g]}
      >
        <h3>{titles[p.g]}</h3>
        {#if p.list}
          <div class="ranked">
            {#each p.rows as r (r.name)}
              <button
                type="button"
                class="row"
                style:--ink={r.color}
                aria-pressed={filters[p.g]?.includes(r.name) ?? false}
                title={`${r.text}${r.suffix ? ` · ${r.suffix}` : ''}`}
                onclick={() => toggle(p.g, r.name)}>{@render rankedRow(r, p)}</button
              >
            {/each}
            {#if !p.rows.length}<span class="empty">{p.hasHistory ? 'No usage' : 'History unavailable'}</span>{/if}
          </div>
          <div class="tail">
            {#if p.other}<div class="row" style:--ink={neutral}>{@render rankedRow(p.other, p)}</div>{/if}
          </div>
          <button
            class="all"
            type="button"
            aria-label={`All ${p.available} ${p.g}`}
            onpointerenter={onwarmfilters}
            onfocus={onwarmfilters}
            onclick={() => openAll(p.g)}>All {p.available} <Icon name="arrow" size={12} /></button
          >
        {:else}
          <div class="split-bars" role="group" aria-label={`${titles[p.g]} share`}>
            {#each p.rows as r (r.name)}<button
                type="button"
                class="bar-row"
                style:--ink={r.color}
                title={`${r.text} · ${valueOf(r, metric)} (${percent(r[metric])})`}
                aria-pressed={filters[p.g]?.includes(r.name) ?? false}
                onclick={() => toggle(p.g, r.name)}
                ><i class="swatch" aria-hidden="true"></i>{@render nameOf(r)}<span class="bar-track" aria-hidden="true"
                  >{#if r[metric] > 0}<i class="bar-fill" style:width={`${measure(r[metric])}%`}></i>{/if}</span
                ><span class="value">{valueOf(r, metric)}</span><span class="pct">{percent(r[metric])}</span></button
              >{:else}<span class="empty">{p.hasHistory ? 'No usage' : 'History unavailable'}</span>{/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>
</section>

<style>
  .breakdown {
    container: breakdown / inline-size;
    min-width: 0;
    border-top: 1px solid var(--wb-line);
    --slot: 32px;
  }
  header,
  .scope,
  .nav,
  .tabs,
  .name,
  .all {
    display: flex;
    align-items: center;
  }
  header {
    justify-content: space-between;
    height: 60px;
    gap: 8px;
  }
  .scope {
    min-width: 0;
    gap: 13px;
    white-space: nowrap;
  }
  .scope h2,
  .scope span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scope span,
  .value,
  .pct {
    font-variant-numeric: tabular-nums;
  }
  .scope span {
    color: var(--wb-muted);
  }
  .nav {
    flex: none;
    gap: 2px;
  }
  .nav button {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 3px;
  }
  .nav .clear {
    margin-left: 3px;
  }
  .nav .prev :global(svg) {
    transform: rotate(180deg);
  }
  .nav button:hover:not(:disabled),
  .all:hover {
    color: var(--wb-accent);
    background: var(--wb-soft);
  }
  .tabs {
    display: none;
  }
  .layout {
    display: grid;
    min-width: 0;
    column-gap: clamp(18px, 2.4cqi, 36px);
    grid-template-columns: repeat(6, minmax(0, 1fr));
    grid-template-areas: 'models models projects projects devices devices' 'providers providers providers harnesses harnesses harnesses';
  }
  .panel {
    grid-area: var(--area);
    min-width: 0;
    padding-bottom: 12px;
    border-top: 1px solid var(--wb-line);
  }
  h3 {
    display: flex;
    align-items: center;
    height: 38px;
    margin: 0;
    font-size: 15px;
    font-weight: 590;
    letter-spacing: -0.025em;
  }
  .ranked {
    height: calc(10 * var(--slot));
  }
  .tail,
  .all,
  .row {
    height: var(--slot);
  }
  .row {
    display: grid;
    grid-template-columns: 7px minmax(0, 1fr) 44px 8.4ch 3.7ch;
    gap: 7px;
    align-items: center;
    width: 100%;
    text-align: left;
    font-size: 12px;
    white-space: nowrap;
  }
  .value,
  .pct {
    text-align: right;
  }
  .value {
    font-weight: 540;
  }
  .pct {
    color: var(--wb-muted);
    font-size: 11px;
  }
  .swatch {
    display: block;
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: var(--ink);
  }
  .identity {
    min-width: 0;
    position: relative;
  }
  .name {
    gap: 4px;
    min-width: 0;
  }
  .name > span {
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  .name small {
    font: 10px var(--wb-mono);
    flex: none;
    color: var(--wb-muted);
  }
  .share {
    transition: width 0.45s cubic-bezier(0.33, 1, 0.68, 1);
    position: absolute;
    bottom: -3px;
    left: 0;
    height: 2px;
    border-radius: 1px;
    background: var(--ink);
    opacity: 0.65;
  }
  .sparkline {
    width: 100%;
    height: 18px;
    color: var(--ink);
  }
  .sparkline svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .row[aria-pressed='true'],
  .bar-row[aria-pressed='true'] {
    background: var(--wb-soft);
    color: var(--wb-accent);
  }
  .row[aria-pressed='true'] .name,
  .bar-row[aria-pressed='true'] .name {
    font-weight: 650;
  }
  button.row:hover,
  .bar-row:hover {
    background: var(--wb-soft);
  }
  .all {
    gap: 4px;
    color: var(--wb-accent);
    font-size: 12px;
  }
  .empty {
    display: flex;
    align-items: center;
    height: var(--slot);
    font-size: 12px;
    color: var(--wb-muted);
  }
  .split-bars {
    height: calc(6 * var(--slot));
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .bar-row {
    display: grid;
    grid-template-columns: 7px minmax(0, 12.5ch) minmax(48px, 1fr) 8.4ch 3.7ch;
    gap: 8px;
    align-items: center;
    width: 100%;
    height: var(--slot);
    text-align: left;
    font-size: 12px;
    white-space: nowrap;
  }
  .bar-track {
    height: 8px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--wb-ink) 7%, transparent);
    overflow: hidden;
  }
  .bar-fill {
    display: block;
    height: 100%;
    min-width: 3px;
    border-radius: 2px;
    background: var(--ink);
    transition: width 0.45s cubic-bezier(0.33, 1, 0.68, 1);
  }
  @container breakdown (560px <= width < 900px) {
    .layout {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-areas: 'models projects' 'devices providers' 'devices harnesses';
    }
    .split-bars {
      height: calc(5 * var(--slot));
    }
  }
  @container breakdown (max-width: 899px) {
    .sparkline {
      display: none;
    }
    .row {
      grid-template-columns: 7px minmax(0, 1fr) 8.4ch 3.7ch;
    }
  }
  @container breakdown (width < 560px) {
    header {
      height: 56px;
    }
    .scope {
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 2px;
    }
    .scope h2 {
      font-size: 17px;
      max-width: 100%;
    }
    .scope span {
      max-width: 100%;
      font-size: 12px;
    }
    .tabs {
      display: flex;
      height: 35px;
      border-bottom: 1px solid var(--wb-line);
    }
    .tabs button {
      align-self: stretch;
      flex: 1;
      min-width: 0;
      font-size: 12px;
      color: var(--wb-muted);
      border-bottom: 2px solid transparent;
    }
    .tabs [aria-selected='true'] {
      border-color: var(--wb-accent);
      color: var(--wb-ink);
      font-weight: 580;
    }
    .layout {
      display: block;
    }
    .panel {
      display: none;
      height: calc(12 * var(--slot) + 22px);
      padding: 6px 0 16px;
      border: 0;
    }
    .panel.visible {
      display: block;
    }
    h3 {
      display: none;
    }
    .split-bars {
      height: calc(11 * var(--slot));
    }
    .bar-row {
      grid-template-columns: 7px minmax(0, 10.5ch) minmax(40px, 1fr) 8ch 3.7ch;
      gap: 6px;
    }
  }
</style>
