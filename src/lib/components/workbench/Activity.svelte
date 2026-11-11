<script lang="ts">
  import { tick, onDestroy } from 'svelte';
  import type { DashboardResponse } from '../../shared/domain';
  import {
    groups,
    groupNames,
    timeBuckets,
    nicePeak,
    valueOf,
    axisValue,
    type Group,
    type Metric,
  } from '../../client/usage-workbench';
  import ChoiceMenu from './ChoiceMenu.svelte';
  import Icon from '../Icon.svelte';
  let {
    data,
    colors,
    group,
    metric,
    chart,
    compare,
    independent,
    narrowed,
    label,
    select,
    setGroup,
    setMetric,
    setChart,
    setScale,
    clear,
  }: {
    data: DashboardResponse;
    colors: ReadonlyMap<string, string>;
    group: Group;
    metric: Metric;
    chart: 'bar' | 'line';
    compare: boolean;
    independent: boolean;
    narrowed: boolean;
    label: (g: Group, id: string) => string;
    select: (name: string) => void;
    setGroup: (v: Group) => void;
    setMetric: (v: Metric) => void;
    setChart: (v: 'bar' | 'line') => void;
    setScale: (v: boolean) => void;
    clear: () => void;
  } = $props();
  const buckets = $derived(timeBuckets(data, group));
  const missingHistory = $derived(
    (data.range === 'today' ? data.hourly : data.daily).some((b) => b[group] === undefined),
  );
  const zero = { tokens: 0, costUSD: 0, unpricedTokens: 0 };
  const ranked = $derived([...data[group]].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name)));
  const heights = $derived(
    buckets.map((b) => [...b.rows].sort((a, b) => (rankIndex.get(a[0]) ?? 0) - (rankIndex.get(b[0]) ?? 0))),
  );
  const rankIndex = $derived(new Map(ranked.map((r, i) => [r.name, i])));
  const peak = $derived(nicePeak(Math.max(0, ...buckets.map((b) => b[metric]))));
  const trends = $derived(
    ranked.map((row) => {
      const points = buckets.map((b) => b.rows.get(row.name)?.[metric] ?? 0);
      return { row, points, peak: nicePeak(Math.max(0, ...points)) };
    }),
  );
  const shared = $derived(Math.max(1, ...trends.map((r) => r.peak)));
  const lines = $derived(chart === 'line' && !compare);
  // Lines plot each series on its own, so the scale follows the largest series, not the stack.
  const scale = $derived(lines ? nicePeak(Math.max(0, ...trends.flatMap((t) => t.points))) : peak);
  const mid = (i: number) => ((i + 0.5) / Math.max(1, buckets.length)) * 100;
  const linePath = (p: number[]) =>
    p.map((v, i) => `${(mid(i) * 10).toFixed(2)},${(200 - (200 * v) / scale).toFixed(2)}`).join(' ');
  const pct = (n: number) => (data.totals[metric] ? ((n / data.totals[metric]) * 100).toFixed(1) + '%' : '—');
  const at = (index: number) => (100 * index) / Math.max(1, buckets.length - 1);
  const coordinates = (p: number[], max: number) =>
    p.map((v, i) => `${(at(i) * 6).toFixed(2)},${(40 - (40 * v) / max).toFixed(2)}`).join(' ');
  const cadence = $derived(data.range === 'today' ? 'Hourly' : data.range === '6m' ? '6-day buckets' : 'Daily');
  const ticks = $derived([...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (buckets.length - 1))))]);
  // Label every day of a short range; otherwise thin to evenly spaced buckets.
  const barTicks = $derived(
    buckets.length <= 14
      ? buckets.map((_, i) => i)
      : [...new Set(Array.from({ length: 6 }, (_, k) => Math.round(((buckets.length - 1) * k) / 5)))],
  );
  const splitChoices = groups.map((g) => ({ value: g, label: groupNames[g] }));
  type Hover = {
    i: number;
    x: number;
    edge: number;
    below: boolean;
    maxHeight: number;
    series?: string;
    pinned: boolean;
  };
  let hover = $state.raw<Hover>();
  let panel = $state<HTMLDivElement>();
  let zone: HTMLElement;
  let opener: HTMLElement | undefined;
  let pointerType = '';
  const isTouchClick = (e: MouseEvent) =>
    e.detail > 0 && (pointerType === 'touch' || (e instanceof PointerEvent && e.pointerType === 'touch'));
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let keyboardBucket = $state(0);
  let tipWidth = $state(256);
  const current = $derived(hover && buckets[hover.i]);
  const tipRows = $derived(
    current &&
      [...ranked].sort(
        (a, b) => (current?.rows.get(b.name)?.[metric] ?? 0) - (current?.rows.get(a.name)?.[metric] ?? 0),
      ),
  );
  function cancelLeave() {
    clearTimeout(leaveTimer);
  }
  function hide() {
    cancelLeave();
    hover = undefined;
  }
  function restore() {
    hide();
    opener?.focus({ preventScroll: true });
  }
  function leave() {
    cancelLeave();
    if (!hover?.pinned) leaveTimer = setTimeout(hide, 180);
  }
  function show(i: number, rect: DOMRect, x: number, series?: string, pinned = false) {
    cancelLeave();
    if (hover?.pinned && !pinned) return;
    const below = rect.top < Math.min(170, innerHeight * 0.34) && innerHeight - rect.bottom > rect.top;
    const edge = below ? rect.bottom - 1 : rect.top + 1;
    if (hover?.i === i && hover.x === x && hover.edge === edge && hover.series === series && hover.pinned === pinned)
      return;
    hover = {
      i,
      x,
      edge,
      below,
      maxHeight: Math.min(306, Math.max(80, (below ? innerHeight - edge : edge) - 8)),
      series,
      pinned,
    };
  }
  // Bars hit-test their segments; lines take the nearest point within reach of the cursor.
  function segment(e: MouseEvent, el: HTMLElement, i: number) {
    if (!lines)
      return e.target instanceof Element ? e.target.closest<HTMLElement>('[data-series]')?.dataset.series : undefined;
    const r = el.getBoundingClientRect();
    const y = (t: (typeof trends)[number]) => r.bottom - (r.height * t.points[i]) / scale;
    const near = trends.reduce<(typeof trends)[number] | undefined>(
      (best, t) => (!best || Math.abs(y(t) - e.clientY) < Math.abs(y(best) - e.clientY) ? t : best),
      undefined,
    );
    return near && near.points[i] > 0 && Math.abs(y(near) - e.clientY) < 28 ? near.row.name : undefined;
  }
  function onBar(e: PointerEvent, el: HTMLElement, i: number) {
    if (e.pointerType === 'touch') return;
    const r = el.getBoundingClientRect();
    opener = el;
    show(i, r, r.left + r.width / 2, segment(e, el, i));
  }
  async function pin(el: HTMLElement, i: number, series?: string, x?: number, focus = true) {
    const r = el.getBoundingClientRect();
    opener = el.closest('button') ?? el;
    show(i, r, x ?? r.left + r.width / 2, series, true);
    if (focus) {
      await tick();
      panel?.querySelector('button')?.focus({ preventScroll: true });
    }
  }
  function pick(name: string) {
    if (panel?.contains(document.activeElement)) opener?.focus({ preventScroll: true });
    hide();
    select(name);
  }
  function barClick(e: MouseEvent, el: HTMLElement, i: number) {
    const s = segment(e, el, i);
    if (s && !narrowed && !isTouchClick(e)) {
      pick(s);
      return;
    }
    void pin(el, i, s);
  }
  function bucketKeys(e: KeyboardEvent, i: number) {
    const next =
      e.key === 'ArrowRight' ? Math.min(buckets.length - 1, i + 1) : e.key === 'ArrowLeft' ? Math.max(0, i - 1) : null;
    if (next === null) return;
    e.preventDefault();
    keyboardBucket = next;
    zone.querySelector<HTMLButtonElement>(`[data-index="${next}"]`)?.focus();
  }
  function trendAt(el: HTMLElement, clientX: number) {
    const r = el.getBoundingClientRect();
    const i = Math.max(
      0,
      Math.min(buckets.length - 1, Math.round(((clientX - r.left) / Math.max(1, r.width)) * (buckets.length - 1))),
    );
    return { i, r, x: r.left + (r.width * at(i)) / 100 };
  }
  function onTrend(e: PointerEvent, el: HTMLElement, name: string) {
    if (e.pointerType === 'touch') return;
    const { i, r, x } = trendAt(el, e.clientX);
    opener = el.closest('button') ?? el;
    show(i, r, x, name);
  }
  function trendClick(e: MouseEvent, name: string) {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('.spark') : null;
    if (!target) return pick(name);
    const { i, x } = trendAt(target, e.clientX);
    if (isTouchClick(e)) {
      void pin(target, i, name, x);
      return;
    }
    pick(name);
  }
  function trendKeys(e: KeyboardEvent, name: string) {
    const el = e.currentTarget instanceof HTMLElement ? e.currentTarget.querySelector<HTMLElement>('.spark') : null;
    if (!el) return;
    if ((e.key === 'Enter' || e.key === ' ') && hover?.series === name) {
      e.preventDefault();
      void pin(el, hover.i, name, hover.x);
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = Math.max(0, Math.min(buckets.length - 1, (hover?.i ?? -1) + (e.key === 'ArrowRight' ? 1 : -1)));
    const r = el.getBoundingClientRect();
    opener = el.closest('button') ?? el;
    show(i, r, r.left + (r.width * at(i)) / 100, name);
  }
  onDestroy(cancelLeave);
</script>

<svelte:window
  onkeydown={(e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') hide();
    if (e.key === 'Escape' && hover) {
      if (hover.pinned) restore();
      else hide();
    }
  }}
  onpointerdown={(e) => {
    pointerType = e.pointerType;
    if (hover && e.target instanceof Element && !panel?.contains(e.target) && !e.target.closest('.columns,.spark'))
      hide();
  }}
  onresize={hide}
  onscroll={hide}
/>
<section class="wb-activity" bind:this={zone}>
  <div class="wb-section-head">
    <div class="wb-title-line">
      <h2>
        {narrowed
          ? 'Session activity'
          : compare
            ? 'Series comparison'
            : metric === 'tokens'
              ? 'Token activity'
              : 'Cost activity'}
      </h2>
      {#if !compare}<small>{cadence}</small>{/if}
    </div>
    <div class="wb-controls">
      {#if !narrowed}<ChoiceMenu
          icon="network"
          prefix={compare ? 'Compare by' : 'Split by'}
          label={compare ? 'Compare by' : 'Split by'}
          value={group}
          choices={splitChoices}
          onchange={(v) => {
            const g = groups.find((k) => k === v);
            if (g) setGroup(g);
          }}
        />{/if}
      <div class="wb-tabs" aria-label="Chart metric">
        {#each ['tokens', 'costUSD'] as m (m)}<button
            aria-pressed={metric === m}
            onclick={() => setMetric(m === 'tokens' ? 'tokens' : 'costUSD')}
            >{m === 'tokens' ? 'Tokens' : 'Cost'}</button
          >{/each}
      </div>
      {#if !compare}<div class="wb-tabs chart-kind" aria-label="Chart type">
          {#each [['bar', 'bars', 'Bar chart'], ['line', 'line', 'Line chart']] as const as [kind, icon, name] (kind)}<button
              aria-pressed={chart === kind}
              aria-label={name}
              title={name}
              onclick={() => setChart(kind)}><Icon name={icon} size={16} /></button
            >{/each}
        </div>{/if}
    </div>
  </div>
  {#if !ranked.length}<div class="wb-empty">
      No usage matches this scope.<button class="wb-link" onclick={clear}>Clear filters</button>
    </div>
  {:else if missingHistory}<div class="wb-empty">
      This hub does not report {groupNames[group].toLowerCase()} history.<button
        class="wb-link"
        onclick={() => setGroup('harnesses')}>Show harness history</button
      >
    </div>
  {:else if metric === 'costUSD' && data.totals.unpricedTokens > 0 && data.totals.unpricedTokens === data.totals.tokens}<div
      class="wb-empty"
    >
      No priced usage in this scope.<button class="wb-link" onclick={() => setMetric('tokens')}>View tokens</button>
    </div>
  {:else if compare && !narrowed}
    <div class="matrix-header matrix-grid">
      <span>{groupNames[group]}</span><span>{cadence} trend</span><span
        >{metric === 'tokens' ? 'Tokens' : 'Est. cost'}</span
      ><span>Share</span>
    </div>
    <div class="matrix-body" onscroll={hide}>
      {#each trends as t (t.row.name)}{@const max = independent ? t.peak : shared}{@const c = colors.get(
          t.row.name,
        )}{@const path = coordinates(t.points, max)}
        <button
          class="matrix-entry matrix-grid"
          onkeydown={(e) => trendKeys(e, t.row.name)}
          onclick={(e) => trendClick(e, t.row.name)}
          aria-label={`Inspect ${label(group, t.row.name)}`}
          ><span class="series-name"><i style:--sw={c}></i><span>{label(group, t.row.name)}</span></span><span
            class="spark"
            class:unpriced={metric === 'costUSD' && t.row.tokens > 0 && t.row.tokens === t.row.unpricedTokens}
            role="presentation"
            onpointermove={(e) => onTrend(e, e.currentTarget, t.row.name)}
            onpointerleave={leave}
          >
            <svg viewBox="0 0 600 40" preserveAspectRatio="none" aria-hidden="true"
              ><polygon points={`0,40 ${path} 600,40`} fill={c} fill-opacity=".12" /><polyline
                points={path}
                stroke={c}
                stroke-width="1.7"
                vector-effect="non-scaling-stroke"
                fill="none"
              /></svg
            >
            {#if hover}<span class="guide" style:left={`${at(hover.i)}%`}></span>{#if t.row.name === hover.series}<i
                  class="point"
                  style:left={`${at(hover.i)}%`}
                  style:top={`${100 - (100 * t.points[hover.i]) / max}%`}
                  style:--sw={c}
                ></i>{/if}{/if}
          </span><strong>{valueOf(t.row, metric)}</strong><span class="wb-num">{pct(t.row[metric])}</span></button
        >
      {/each}
    </div>
    <div class="matrix-grid axis-grid">
      <span></span>
      <div class="axis">
        {#each ticks as i (i)}<span>{buckets[i].short}</span>{/each}
      </div>
    </div>
  {:else}
    <div class="stack-chart">
      <div class="y-axis">
        {#each [4, 3, 2, 1, 0] as n (n)}<span>{axisValue((scale * n) / 4, metric)}</span>{/each}
      </div>
      <div class="plot-grid">
        <div class="guides">
          {#each [0, 1, 2, 3, 4] as n (n)}<i></i>{/each}
        </div>
        {#if lines}<svg class="line-plot" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true"
            >{#each [...trends].reverse() as t (t.row.name)}<polyline
                points={linePath(t.points)}
                stroke={colors.get(t.row.name)}
                stroke-width="2"
                stroke-linejoin="round"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
                fill="none"
              />{/each}</svg
          >{#if hover && current}{#each trends as t (t.row.name)}{#if t.points[hover.i] > 0}<i
                  class="dot"
                  class:bright={hover.series === t.row.name}
                  style:left={`${mid(hover.i)}%`}
                  style:top={`${100 - (100 * t.points[hover.i]) / scale}%`}
                  style:--sw={colors.get(t.row.name)}
                ></i>{/if}{/each}{/if}{/if}
        <div role="group" aria-label="Time buckets" class="columns" class:lines onpointerleave={leave}>
          {#each buckets as b, i (i)}<button
              data-index={i}
              class:marked={hover?.i === i}
              tabindex={i === keyboardBucket ? 0 : -1}
              aria-label={`${b.label}: ${valueOf(b, metric)}. Show series`}
              onclick={(e) => barClick(e, e.currentTarget, i)}
              onpointermove={(e) => onBar(e, e.currentTarget, i)}
              onkeydown={(e) => bucketKeys(e, i)}
              >{#if !lines}{#each heights[i] as [name, x] (name)}{#if x[metric] > 0}<span
                      data-series={name}
                      class:bright={hover?.i === i && hover.series === name}
                      style:height={`${(100 * x[metric]) / peak}%`}
                      style:--sw={colors.get(name)}
                    ></span>{/if}{/each}{/if}</button
            >{/each}
        </div>
      </div>
      <div class="axis bar-axis">
        {#each barTicks as i (i)}<span style:left={`${mid(i)}%`}>{buckets[i].short}</span>{/each}
      </div>
    </div>
    {#if !narrowed}<div class="legend" aria-label={`${groupNames[group]} breakdown`}>
        {#each ranked as row (row.name)}<button onclick={() => pick(row.name)} title={label(group, row.name)}
            ><i style:--sw={colors.get(row.name)}></i><b>{label(group, row.name)}</b><span>{valueOf(row, metric)}</span
            ><small>{pct(row[metric])}</small></button
          >{/each}
      </div>{/if}
  {/if}
  {#if compare && !narrowed && ranked.length}<div class="chart-end">
      <ChoiceMenu
        label="Trend scale"
        prefix="Scale"
        value={independent ? 'series' : 'shared'}
        choices={[
          { value: 'shared', label: `Shared · 0–${axisValue(shared, metric)}` },
          { value: 'series', label: 'Per series' },
        ]}
        onchange={(v) => setScale(v === 'series')}
      />
    </div>{/if}
</section>
{#if hover && current}
  <div
    class="series-pop"
    role="group"
    aria-label={`Usage for ${current.label}`}
    bind:this={panel}
    bind:offsetWidth={tipWidth}
    onfocusout={(e) => {
      if (hover?.pinned && e.relatedTarget instanceof Node && !panel?.contains(e.relatedTarget)) hide();
    }}
    onpointerenter={cancelLeave}
    onpointerleave={leave}
    style:left={`${Math.max(6, Math.min(innerWidth - tipWidth - 6, hover.x - tipWidth / 2))}px`}
    style:top={`${hover.edge}px`}
    class:above={!hover.below}
    style:max-height={`${hover.maxHeight}px`}
  >
    <div class="pop-date">
      <span>{current.label}</span><strong>{valueOf(current, metric)}{metric === 'tokens' ? ' tokens' : ''}</strong>
    </div>
    <div class="pop-list">
      {#each tipRows ?? [] as row (row.name)}<button
          class:over={hover.series === row.name}
          onclick={() => pick(row.name)}
          ><i style:--sw={colors.get(row.name)}></i><span>{label(group, row.name)}</span><b
            >{valueOf(current.rows.get(row.name) ?? zero, metric)}</b
          ></button
        >{/each}
    </div>
  </div>
{/if}
