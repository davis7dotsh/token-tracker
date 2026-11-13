<script lang="ts">
  import type { ChartSeries, DashboardResponse, UsageQuery } from '../../shared/domain';
  import {
    bucketSelection,
    deviceSuffixes,
    groupNames,
    periodOf,
    timeBuckets,
    valueOf,
    type Group,
    type Metric,
  } from '../../client/usage-workbench';
  import Icon from '../Icon.svelte';

  let {
    data,
    metric,
    selected,
    colors,
    label,
    filters,
    toggle,
    openAll,
    onselect,
  }: {
    data: DashboardResponse;
    metric: Metric;
    selected: string | undefined;
    colors: ReadonlyMap<Group, ReadonlyMap<string, string>>;
    label: (g: Group, id: string) => string;
    filters: Pick<UsageQuery, Group>;
    toggle: (g: Group, name: string) => void;
    openAll: (g: Group) => void;
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
  const scope = $derived(bucketSelection(timeBuckets(data, 'harnesses'), selected));
  const total = $derived(scope.bucket ?? data.totals);
  const suffixes = $derived(deviceSuffixes(data.devices, label));
  const measure = (v: number) => (total[metric] > 0 ? Math.min(100, (100 * v) / total[metric]) : 0);
  const percent = (v: number) =>
    total[metric] === 0 ? '—' : v > 0 && measure(v) < 1 ? '<1%' : `${Math.round(measure(v))}%`;
  const spark = (values: number[], peak: number) =>
    values
      .map(
        (v, i) =>
          `${((60 * i) / Math.max(1, values.length - 1)).toFixed(1)},${(17 - (16 * v) / (peak || 1)).toFixed(1)}`,
      )
      .join(' ');

  // Rank within the scope; the history plotted beside each name always uses the full range.
  const panels = $derived(
    order.map((g) => {
      const history = timeBuckets(data, g);
      const bucket = history[scope.index];
      const ranked: ChartSeries[] = bucket
        ? [...bucket.rows].map(([name, values]) => ({ name, ...values }))
        : [...data[g]];
      ranked.sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name));
      const list = g !== 'providers' && g !== 'harnesses';
      const rows = (list ? ranked.slice(0, 7) : ranked).map((r) => ({
        ...r,
        text: label(g, r.name),
        suffix: g === 'devices' ? suffixes.get(r.name) : undefined,
        color: colors.get(g)?.get(r.name) ?? neutral,
        values: list ? history.map((b) => b.rows.get(r.name)?.[metric] ?? 0) : [],
      }));
      const tail = list ? ranked.slice(7) : [];
      const tailTotals = tail.reduce(
        (sum, r) => ({
          tokens: sum.tokens + r.tokens,
          costUSD: sum.costUSD + r.costUSD,
          unpricedTokens: sum.unpricedTokens + (r.unpricedTokens ?? 0),
        }),
        { tokens: 0, costUSD: 0, unpricedTokens: 0 },
      );
      const other = tail.length
        ? {
            ...tailTotals,
            text: 'Other',
            suffix: undefined,
            color: neutral,
            values: history.map((b) => tail.reduce((sum, r) => sum + (b.rows.get(r.name)?.[metric] ?? 0), 0)),
          }
        : undefined;
      const peak = Math.max(0, ...rows.map((r) => Math.max(0, ...r.values)), ...(other?.values ?? []));
      return {
        g,
        list,
        rows,
        other,
        peak,
        available: data.filters[g].length,
        hasHistory: !bucket || bucket.hasHistory,
        sparkAvailable: history.every((b) => b.hasHistory),
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

<section class="breakdown" aria-label="Usage breakdown">
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
          <button class="all" type="button" aria-label={`All ${p.available} ${p.g}`} onclick={() => openAll(p.g)}
            >All {p.available} <Icon name="arrow" size={12} /></button
          >
        {:else}
          <div class="split-track" role="group" aria-label={`${titles[p.g]} share`}>
            {#each p.rows as r (r.name)}{#if r[metric] > 0}<button
                  type="button"
                  class="slice"
                  style:--ink={r.color}
                  style:width={`${measure(r[metric])}%`}
                  title={`${r.text} · ${percent(r[metric])}`}
                  aria-label={`${r.text}, ${valueOf(r, metric)}, ${percent(r[metric])}`}
                  aria-pressed={filters[p.g]?.includes(r.name) ?? false}
                  onclick={() => toggle(p.g, r.name)}
                ></button>{/if}{/each}
          </div>
          <div class="split-key">
            {#each p.rows as r (r.name)}<button
                type="button"
                style:--ink={r.color}
                title={r.text}
                aria-pressed={filters[p.g]?.includes(r.name) ?? false}
                onclick={() => toggle(p.g, r.name)}
                ><i class="swatch"></i>{@render nameOf(r)}<span class="value">{valueOf(r, metric)}</span><span
                  class="pct">{percent(r[metric])}</span
                ></button
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
  .all,
  .split-key button {
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
    height: calc(7 * var(--slot));
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
  .split-key [aria-pressed='true'] {
    background: var(--wb-soft);
    color: var(--wb-accent);
  }
  .row[aria-pressed='true'] .name,
  .split-key [aria-pressed='true'] .name {
    font-weight: 650;
  }
  button.row:hover,
  .split-key button:hover {
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
  .split-track {
    display: flex;
    height: 23px;
    align-items: center;
    position: relative;
  }
  .split-track::before {
    content: '';
    position: absolute;
    inset: 5px 0;
    background: var(--wb-soft);
    border-radius: 2px;
  }
  .slice {
    transition: width 0.45s cubic-bezier(0.33, 1, 0.68, 1);
    height: 100%;
    position: relative;
  }
  .slice::before {
    content: '';
    position: absolute;
    inset: 5px 0;
    background: var(--ink);
    box-shadow: inset -1px 0 var(--wb-bg);
  }
  .slice:first-child::before {
    border-radius: 2px 0 0 2px;
  }
  .slice:last-child::before {
    border-radius: 0 2px 2px 0;
  }
  .slice:hover::before,
  .slice[aria-pressed='true']::before {
    outline: 1px solid var(--wb-ink);
    outline-offset: -1px;
  }
  .split-key {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0 15px;
    height: 84px;
    overflow: auto;
    scrollbar-width: thin;
  }
  .split-key button {
    gap: 5px;
    max-width: 100%;
    min-width: 0;
    height: 28px;
    white-space: nowrap;
    font-size: 12px;
  }
  @container breakdown (560px <= width < 900px) {
    .layout {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-areas: 'models projects' 'devices providers' 'devices harnesses';
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
      height: calc(9 * var(--slot) + 22px);
      padding: 6px 0 16px;
      border: 0;
    }
    .panel.visible {
      display: block;
    }
    h3 {
      display: none;
    }
    .split-track {
      margin-block: 5px;
    }
    .split-key {
      display: block;
      height: calc(8 * var(--slot));
    }
    .split-key button {
      width: 100%;
      height: var(--slot);
      gap: 8px;
    }
    .split-key .name {
      flex: 1;
    }
    .split-key .pct {
      width: 4ch;
    }
  }
</style>
