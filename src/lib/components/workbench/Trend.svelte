<script lang="ts">
  import { untrack } from 'svelte';
  import { prefersReducedMotion, Tween } from 'svelte/motion';
  import { area, curveMonotoneX, easeCubicInOut, easeCubicOut, interpolateNumberArray, line } from 'd3';
  import type { DashboardResponse } from '../../shared/domain';
  import {
    axisValue,
    bucketSelection,
    deviceSuffixes,
    groupNames,
    groups,
    nicePeak,
    timeBuckets,
    valueOf,
    type Group,
    type Metric,
  } from '../../client/usage-workbench';
  import Icon from '../Icon.svelte';

  let {
    data,
    group,
    metric,
    colors,
    label,
    selected,
    onselect,
    setGroup,
    chart,
    setChart,
  }: {
    data: DashboardResponse;
    group: Group;
    metric: Metric;
    colors: ReadonlyMap<string, string>;
    label: (g: Group, id: string) => string;
    selected: string | undefined;
    onselect: (key: string | undefined) => void;
    setGroup: (g: Group) => void;
    chart: 'bar' | 'line';
    setChart: (chart: 'bar' | 'line') => void;
  } = $props();
  const kinds = [
    ['bar', 'bars', 'Bar chart'],
    ['line', 'line', 'Line chart'],
  ] as const;
  const lines = $derived(chart === 'line');

  const buckets = $derived(timeBuckets(data, group));
  const active = $derived(bucketSelection(buckets, selected).bucket);
  const stackPeak = $derived(nicePeak(buckets.reduce((max, b) => Math.max(max, b[metric]), 0)));
  const ranked = $derived([...data[group]].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name)));
  const suffixes = $derived(group === 'devices' ? deviceSuffixes(data.devices, label) : undefined);
  const neutral = 'var(--wb-muted)';
  const top = $derived(
    ranked.slice(0, 6).map(({ name }) => ({
      name,
      text: label(group, name) + (suffixes?.has(name) ? ` · ${suffixes.get(name)}` : ''),
      color: colors.get(name) ?? neutral,
    })),
  );
  const other = { name: null, text: 'Other', color: neutral };
  const series = $derived(ranked.length > top.length ? [...top, other] : top);
  const zero = { tokens: 0, costUSD: 0, unpricedTokens: 0 };
  const stacks = $derived(
    buckets.map((b) => {
      const parts = top.map((s) => b.rows.get(s.name) ?? zero);
      if (series.length > parts.length) {
        const tail = { tokens: b.tokens, costUSD: b.costUSD, unpricedTokens: b.unpricedTokens };
        for (const p of parts) {
          tail.tokens -= p.tokens;
          tail.costUSD -= p.costUSD;
          tail.unpricedTokens -= p.unpricedTokens;
        }
        parts.push({ ...tail, costUSD: Math.max(0, tail.costUSD) });
      }
      return parts;
    }),
  );
  // Largest first within each bucket: the bottom of the bar and the top of the tooltip.
  const orders = $derived(
    stacks.map((parts) => parts.map((_, j) => j).sort((a, b) => parts[b][metric] - parts[a][metric] || a - b)),
  );
  // Lines plot each series on its own, so the scale follows the largest series, not the stack.
  const peak = $derived(
    lines ? nicePeak(stacks.reduce((max, parts) => parts.reduce((m, p) => Math.max(m, p[metric]), max), 0)) : stackPeak,
  );
  // Every mark is drawn from tweened fractions of the plot height, so a change of
  // metric, filter or data glides to its new shape. A different set of buckets or
  // series has nothing to glide from, so it rises from the baseline instead.
  const target = $derived(stacks.flatMap((parts) => parts.map((p) => Math.max(0, p[metric]) / peak)));
  const shape = $derived(JSON.stringify([group, data.range, buckets.map((b) => b.key), series.map((s) => s.name)]));
  const heights = new Tween<number[]>([], {
    easing: easeCubicOut,
    interpolate: (from, to) => {
      const step = interpolateNumberArray(
        to.map((_, i) => from[i] ?? 0),
        to,
      );
      return (t) => [...step(t)];
    },
  });
  // 0 draws bars, 1 draws lines; in between the bars sink while the lines rise.
  const mix = new Tween(0, { easing: easeCubicInOut });
  let drawn = '';
  $effect(() => {
    const next = target,
      key = shape,
      duration = prefersReducedMotion.current ? 0 : 520;
    untrack(() => {
      if (key !== drawn)
        void heights.set(
          next.map(() => 0),
          { duration: 0 },
        );
      drawn = key;
      void heights.set(next, { duration });
    });
  });
  $effect(() => {
    const next = lines ? 1 : 0,
      duration = prefersReducedMotion.current ? 0 : 420;
    untrack(() => void mix.set(next, { duration }));
  });
  const at = (i: number, j: number) => heights.current[i * series.length + j] ?? 0;
  const x = (i: number) => (1000 * (i + 0.5)) / buckets.length;
  const y = (i: number, j: number) => 200 - 200 * at(i, j) * mix.current;
  const curves = $derived(
    series.map((_, j) => {
      const points = buckets.map((_, i) => [x(i), y(i, j)] as [number, number]);
      return {
        stroke: line().curve(curveMonotoneX)(points) ?? '',
        fill: area().curve(curveMonotoneX).y0(200)(points) ?? '',
      };
    }),
  );
  const note = $derived(
    !data.totals.tokens
      ? 'No usage in this scope.'
      : metric === 'costUSD' && data.totals.tokens === data.totals.unpricedTokens
        ? 'No priced usage in this scope.'
        : buckets.some((b) => !b.hasHistory)
          ? `No ${groupNames[group].toLowerCase()} history available.`
          : '',
  );
  const ticks = (length: number, count: number) =>
    length <= count
      ? Array.from({ length }, (_, i) => i)
      : Array.from({ length: count }, (_, i) => Math.round((i * (length - 1)) / (count - 1)));
  const tickIndices = $derived(ticks(buckets.length, 8));
  const narrowTicks = $derived(new Set(ticks(tickIndices.length, 4)));
  const mid = (i: number) => `${(100 * (i + 0.5)) / buckets.length}%`;
  let hovered = $state<string>();
  const tip = $derived(buckets.findIndex((b) => b.key === hovered));
  let focused = $state<string>();
  const tabKey = $derived(buckets.find((b) => b.key === focused)?.key ?? active?.key ?? buckets[0]?.key);
  const bucketDescription = (b: (typeof buckets)[number]) =>
    `${b.label}${b.partial ? ' (in progress)' : ''}: ${valueOf(b, metric)}${metric === 'tokens' ? ' tokens' : ''}`;
  function keys(e: KeyboardEvent, i: number) {
    if (!(e.currentTarget instanceof HTMLButtonElement)) return;
    const next =
      e.key === 'ArrowRight'
        ? i + 1
        : e.key === 'ArrowLeft'
          ? i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buckets.length - 1
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    hovered = undefined;
    e.currentTarget.parentElement
      ?.querySelectorAll('button')
      [Math.max(0, Math.min(buckets.length - 1, next))]?.focus({ preventScroll: true });
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
      hovered = undefined;
      if (active) onselect(undefined);
    }
  }}
  onscroll={() => (hovered = undefined)}
/>
<section class="trend" aria-label="Usage trend">
  <header>
    <h2>{metric === 'tokens' ? 'Token activity' : 'Cost activity'}</h2>
    <div class="controls">
      <div class="wb-segmented" role="group" aria-label="Colour by">
        {#each groups as g (g)}<button
            type="button"
            aria-pressed={group === g}
            onclick={() => group !== g && setGroup(g)}>{groupNames[g]}</button
          >{/each}
      </div>
      <div class="wb-segmented kinds" role="group" aria-label="Chart type">
        {#each kinds as [kind, icon, name] (kind)}<button
            type="button"
            aria-pressed={chart === kind}
            aria-label={name}
            title={name}
            onclick={() => setChart(kind)}><Icon name={icon} size={15} /></button
          >{/each}
      </div>
    </div>
  </header>
  <div class="chart">
    <div class="ticks" aria-hidden="true">
      {#each [4, 3, 2, 1, 0] as n (n)}<span>{axisValue((peak * n) / 4, metric)}</span>{/each}
    </div>
    <div class="plot">
      <div class="rules" aria-hidden="true">
        {#each [4, 3, 2, 1, 0] as n (n)}<i></i>{/each}
      </div>
      <div class="buckets" role="group" aria-label="Time buckets" onpointerleave={() => (hovered = undefined)}>
        {#each buckets as b, i (b.key)}
          <button
            type="button"
            class="bucket"
            class:dim={active && active !== b}
            class:partial={b.partial}
            aria-pressed={active === b}
            aria-label={bucketDescription(b)}
            tabindex={tabKey === b.key ? 0 : -1}
            onfocus={() => (focused = b.key)}
            onkeydown={(e) => keys(e, i)}
            onpointerenter={(e) => (hovered = e.pointerType === 'mouse' ? b.key : undefined)}
            onclick={() => onselect(active === b ? undefined : b.key)}
          >
            {#if !note && mix.current < 1}{#each orders[i] as j (series[j].name)}{#if at(i, j) > 0}<span
                    class="segment"
                    style:--ink={series[j].color}
                    style:height={`${100 * at(i, j) * (1 - mix.current)}%`}
                  ></span>{/if}{/each}{/if}
          </button>
        {/each}
      </div>
      {#if mix.current > 0 && !note}
        <svg
          class="lines"
          class:dim={active}
          viewBox="0 0 1000 200"
          preserveAspectRatio="none"
          aria-hidden="true"
          style:opacity={mix.current}
          >{#each [...series.keys()].reverse() as j (series[j].name)}<path
              d={curves[j].fill}
              fill={series[j].color}
              fill-opacity=".07"
            /><path
              d={curves[j].stroke}
              stroke={series[j].color}
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
              vector-effect="non-scaling-stroke"
              fill="none"
            />{/each}</svg
        >
        {#each [tip, active ? buckets.indexOf(active) : -1] as i, n (n)}{#if i >= 0 && (n === 0 || i !== tip)}{#each orders[i] as j (series[j].name)}{#if stacks[i][j][metric] > 0}<i
                  class="point"
                  style:--ink={series[j].color}
                  style:left={mid(i)}
                  style:top={`${100 - 100 * at(i, j) * mix.current}%`}
                  style:opacity={mix.current}
                ></i>{/if}{/each}{/if}{/each}
      {/if}
      {#if note}<div class="note">{note}</div>{/if}
      {#if tip >= 0}
        <div role="tooltip" class="tip" style:--position={mid(tip)}>
          <div class="tip-head">
            <span>{buckets[tip].label}{buckets[tip].partial ? ' · partial' : ''}</span><b
              >{valueOf(buckets[tip], metric)}{metric === 'tokens' ? ' tokens' : ''}</b
            >
          </div>
          {#if buckets[tip].hasHistory}{#each orders[tip] as j (series[j].name)}<div class="tip-row">
                <i class="dot" style:--ink={series[j].color}></i><span>{series[j].text}</span><b
                  >{valueOf(stacks[tip][j], metric)}</b
                >
              </div>{/each}{/if}
        </div>
      {/if}
    </div>
    <div class="dates" aria-hidden="true">
      {#each tickIndices as i, j (i)}<span
          class:dense={!narrowTicks.has(j)}
          style:--position={mid(i)}
          style:--characters={`${buckets[i].short.length}ch`}>{buckets[i].short}</span
        >{/each}
    </div>
  </div>
  <div class="series-key" aria-label={`${groupNames[group]} legend`}>
    {#each series as s (s.name)}<span class="key-item" title={s.text}
        ><i class="dot" style:--ink={s.color}></i><span>{s.text}</span></span
      >{/each}
  </div>
</section>

<style>
  .trend {
    min-width: 0;
    container: trend / inline-size;
    border-top: 1px solid var(--wb-line);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 58px;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .kinds button {
    display: grid;
    place-items: center;
    padding: 0 7px;
  }
  .lines {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .point {
    position: absolute;
    z-index: 1;
    width: 9px;
    height: 9px;
    transform: translate(-50%, -50%);
    border: 2px solid var(--wb-bg);
    border-radius: 50%;
    background: var(--ink);
    pointer-events: none;
  }
  .chart {
    display: grid;
    grid-template-columns: 5.5ch minmax(0, 1fr);
    grid-template-rows: clamp(140px, 24vh, 260px) 24px;
    gap: 0 9px;
    padding-top: 8px;
    font: 11px var(--wb-mono);
    color: var(--wb-muted);
  }
  .ticks,
  .rules {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .ticks {
    align-items: end;
    white-space: nowrap;
  }
  .ticks span {
    line-height: 0;
  }
  .plot,
  .dates {
    min-width: 0;
    position: relative;
  }
  .rules {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .rules i {
    border-top: 1px dashed var(--wb-line);
  }
  .rules i:last-child {
    border-top-style: solid;
  }
  .buckets {
    display: flex;
    position: relative;
    height: 100%;
  }
  .bucket {
    position: relative;
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    flex-direction: column-reverse;
    align-items: center;
  }
  .segment {
    width: 70%;
    max-width: 72px;
    background: var(--ink);
  }
  .segment:last-child {
    border-radius: 2px 2px 0 0;
  }
  .segment {
    transition: opacity 0.2s;
  }
  .bucket.dim .segment {
    opacity: 0.35;
  }
  .bucket {
    transition: background-color 0.2s;
  }
  .lines path {
    transition: opacity 0.2s;
  }
  .lines.dim path {
    opacity: 0.5;
  }
  .bucket[aria-pressed='true'],
  .bucket:focus-visible {
    background: color-mix(in srgb, var(--wb-accent) 9%, transparent);
    box-shadow: inset 0 -3px var(--wb-accent);
  }
  .bucket:focus-visible {
    outline-offset: -2px;
  }
  @media (hover: hover) {
    .bucket:hover {
      background: color-mix(in srgb, var(--wb-accent) 7%, transparent);
    }
  }
  .partial .segment {
    background-image: repeating-linear-gradient(135deg, transparent 0 4px, rgb(0 0 0 / 0.28) 4px 6px);
  }
  .dates {
    grid-column: 2;
    overflow: hidden;
  }
  .dates span {
    position: absolute;
    top: 7px;
    left: clamp(calc(var(--characters) / 2), var(--position), calc(100% - var(--characters) / 2));
    transform: translateX(-50%);
    white-space: nowrap;
  }
  .series-key {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 40px;
    padding-bottom: 4px;
    overflow: auto hidden;
    scrollbar-width: thin;
    color: var(--wb-muted);
    font-size: 12px;
  }
  .key-item {
    display: flex;
    gap: 6px;
    align-items: center;
    flex: 0 0 auto;
    max-width: min(21ch, 65%);
  }
  .key-item > span,
  .tip-row span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dot {
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--ink);
    flex: none;
  }
  .tip {
    --width: min(245px, 100%);
    position: absolute;
    left: clamp(0px, calc(var(--position) - var(--width) / 2), calc(100% - var(--width)));
    width: var(--width);
    bottom: calc(100% + 6px);
    padding: 8px 10px;
    border: 1px solid var(--wb-line);
    border-radius: 5px;
    background: var(--wb-panel);
    color: var(--wb-ink);
    box-shadow: 0 4px 15px #0002;
    z-index: 2;
    pointer-events: none;
    font:
      12px/1.5 'Geist Variable',
      system-ui,
      sans-serif;
  }
  .tip-head,
  .tip-row {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .tip-head {
    justify-content: space-between;
    margin-bottom: 3px;
    border-bottom: 1px solid var(--wb-line);
  }
  .tip b {
    flex: none;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    font-weight: 560;
  }
  .note {
    pointer-events: none;
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: max-content;
    max-width: 100%;
    padding: 5px;
    background: var(--wb-bg);
    text-align: center;
    font:
      13px 'Geist Variable',
      system-ui,
      sans-serif;
  }
  @container trend (max-width: 560px) {
    h2 {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .controls {
      flex: 1;
      justify-content: space-between;
    }
    .controls :global(.wb-segmented button) {
      padding: 0 7px;
    }
  }
  @container trend (max-width: 640px) {
    .dates .dense {
      display: none;
    }
  }
  @container trend (max-width: 420px) {
    .chart {
      grid-template-columns: 5.2ch minmax(0, 1fr);
      gap: 0 5px;
      font-size: 10px;
    }
  }
</style>
