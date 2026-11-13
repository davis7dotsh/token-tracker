<script lang="ts">
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
  import ChoiceMenu from './ChoiceMenu.svelte';

  let {
    data,
    group,
    metric,
    colors,
    label,
    selected,
    onselect,
    setGroup,
  }: {
    data: DashboardResponse;
    group: Group;
    metric: Metric;
    colors: ReadonlyMap<string, string>;
    label: (g: Group, id: string) => string;
    selected: string | undefined;
    onselect: (key: string | undefined) => void;
    setGroup: (g: Group) => void;
  } = $props();

  const choices = groups.map((g) => ({ value: g, label: groupNames[g] }));
  const buckets = $derived(timeBuckets(data, group));
  const active = $derived(bucketSelection(buckets, selected).bucket);
  const peak = $derived(nicePeak(buckets.reduce((max, b) => Math.max(max, b[metric]), 0)));
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
    <ChoiceMenu
      label="Colour by"
      prefix="Colour by"
      value={group}
      {choices}
      onchange={(v) => {
        const g = groups.find((g) => g === v);
        if (g) setGroup(g);
      }}
    />
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
            {#if !note}{#each stacks[i] as part, j (series[j].name)}{#if part[metric] > 0}<span
                    class="segment"
                    style:--ink={series[j].color}
                    style:height={`${(100 * part[metric]) / peak}%`}
                  ></span>{/if}{/each}{/if}
          </button>
        {/each}
      </div>
      {#if note}<div class="note">{note}</div>{/if}
      {#if tip >= 0}
        <div role="tooltip" class="tip" style:--position={mid(tip)}>
          <div class="tip-head">
            <span>{buckets[tip].label}{buckets[tip].partial ? ' · partial' : ''}</span><b
              >{valueOf(buckets[tip], metric)}{metric === 'tokens' ? ' tokens' : ''}</b
            >
          </div>
          {#if buckets[tip].hasHistory}{#each series as s, j (s.name)}<div class="tip-row">
                <i class="dot" style:--ink={s.color}></i><span>{s.text}</span><b>{valueOf(stacks[tip][j], metric)}</b>
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
  .bucket.dim .segment {
    opacity: 0.35;
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
    top: 6px;
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
