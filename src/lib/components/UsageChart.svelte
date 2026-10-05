<script lang="ts">
  import { curveMonotoneX, line, scaleBand, scaleLinear, select } from 'd3';
  import { categoryNames, seriesColor } from '#lib/client/visuals.ts';
  import type { ChartSeries, DashboardResponse } from '#lib/shared/domain.ts';

  let {
    data,
    metric = 'tokens',
    mode = 'bar',
    grouping = 'harnesses',
    onGroupingChange,
  }: {
    data: DashboardResponse;
    metric?: 'tokens' | 'costUSD';
    mode?: 'bar' | 'line';
    grouping?: 'harnesses' | 'providers' | 'models';
    onGroupingChange: (grouping: 'harnesses' | 'providers' | 'models') => void;
  } = $props();
  let width = $state(900);
  let active = $state(-1);
  let stage: HTMLElement | undefined;
  let pointerY = $state<number | undefined>();
  let plot = $state.raw({ left: 0, top: 0, width: 900, height: 320, viewportWidth: 900, viewportHeight: 320 });
  let tooltipSize = $state.raw({ width: 0, height: 0 });
  const height = 320;
  const other = '__other__';
  const groups = [
    { value: 'harnesses', label: 'Harnesses' },
    { value: 'providers', label: 'Providers' },
    { value: 'models', label: 'Models' },
  ] as const;
  const integer = new Intl.NumberFormat('en-US');
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const share = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const hourly = $derived(data.range === 'today');
  const buckets = $derived(hourly ? data.hourly : data.daily);
  const bucketSize = $derived(Math.max(1, Math.ceil(buckets.length / 200)));
  const granularity = $derived(hourly ? 'Hourly' : bucketSize === 1 ? 'Daily' : bucketSize + '-day totals');
  const labelFormat = $derived(
    new Intl.DateTimeFormat(
      undefined,
      hourly ? { timeZone: data.timezone, hour: 'numeric' } : { timeZone: 'UTC', month: 'short', day: 'numeric' },
    ),
  );
  const fullLabelFormat = $derived(
    new Intl.DateTimeFormat(
      undefined,
      hourly
        ? { timeZone: data.timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
        : { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' },
    ),
  );
  const available = $derived({
    harnesses: true,
    providers: buckets.every((bucket) => bucket.providers !== undefined),
    models: buckets.every((bucket) => bucket.models !== undefined),
  });
  const selectedGrouping = $derived(available[grouping] ? grouping : 'harnesses');
  const ranked = $derived(
    [...data[selectedGrouping]].sort((left, right) => right[metric] - left[metric] || right.tokens - left.tokens),
  );
  const visibleNames = $derived(
    new Set((selectedGrouping === 'models' ? ranked.slice(0, 5) : ranked).map((series) => series.name)),
  );
  const chartSeries = $derived.by(() => {
    const result = ranked
      .filter((series) => visibleNames.has(series.name))
      .map((series) => ({
        name: series.name,
        label: categoryNames[series.name] ?? series.name,
        color: seriesColor(series.name, selectedGrouping),
      }));
    if (ranked.length > visibleNames.size) {
      result.push({
        name: other,
        label: 'Other',
        color: seriesColor(other, selectedGrouping),
      });
    }
    return result;
  });
  const points = $derived.by(() => {
    const count = Math.ceil(buckets.length / bucketSize);
    return Array.from({ length: count }, (_, index) => {
      const start = index * bucketSize;
      const end = Math.min(start + bucketSize, buckets.length);
      const values = new Map<string, ChartSeries>();
      let tokens = 0;
      let costUSD = 0;
      for (let bucketIndex = start; bucketIndex < end; bucketIndex++) {
        const bucket = buckets[bucketIndex];
        tokens += bucket.tokens;
        costUSD += bucket.costUSD;
        for (const item of bucket[selectedGrouping] ?? []) {
          const name = visibleNames.has(item.name) ? item.name : other;
          const previous = values.get(name);
          values.set(name, {
            name,
            tokens: (previous?.tokens ?? 0) + item.tokens,
            costUSD: (previous?.costUSD ?? 0) + item.costUSD,
            unpricedTokens: (previous?.unpricedTokens ?? 0) + (item.unpricedTokens ?? 0),
          });
        }
      }
      const first = buckets[start];
      const last = buckets[end - 1];
      return {
        key: 'start' in first ? first.start : first.date,
        end: 'end' in last ? last.end : last.date,
        tokens,
        costUSD,
        values,
        unpricedTokens: [...values.values()].reduce((sum, series) => sum + (series.unpricedTokens ?? 0), 0),
      };
    });
  });
  const x = $derived(
    scaleBand<string>()
      .domain(points.map((point) => point.key))
      .range([52, width - 12])
      .padding(0.25),
  );
  const y = $derived(
    scaleLinear()
      .domain([
        0,
        Math.max(
          metric === 'costUSD' ? 0.000001 : 1,
          ...points.map((point) =>
            mode === 'bar' ? point[metric] : Math.max(0, ...[...point.values.values()].map((series) => series[metric])),
          ),
        ),
      ])
      .nice(4)
      .range([height - 35, 20]),
  );
  const ticks = $derived(y.ticks(4));
  const lines = $derived(
    chartSeries.map((series, index) => ({
      ...series,
      dash: dashForSeries(index),
      path:
        line<(typeof points)[number]>()
          .x((point) => (x(point.key) ?? 52) + x.bandwidth() / 2)
          .y((point) => y(point.values.get(series.name)?.[metric] ?? 0))
          .curve(curveMonotoneX)(points) ?? '',
    })),
  );
  const bars = $derived.by(() =>
    points.flatMap((point) => {
      let accumulated = 0;
      return chartSeries.map((series) => {
        const value = point.values.get(series.name)?.[metric] ?? 0;
        const bottom = y(accumulated);
        accumulated += value;
        return {
          key: point.key + ':' + series.name,
          name: series.name,
          color: series.color,
          x: x(point.key) ?? 52,
          y: y(accumulated),
          height: bottom - y(accumulated),
        };
      });
    }),
  );
  const selected = $derived(points[active]);
  const selectedSeries = $derived(
    selected
      ? chartSeries.flatMap((series) => {
          const value = selected.values.get(series.name);
          return value && value.tokens > 0 ? [{ ...series, ...value }] : [];
        })
      : [],
  );
  const empty = $derived(data.totals.tokens === 0);
  const tickIndices = $derived([
    ...new Set(
      Array.from({ length: width < 500 ? 4 : 7 }, (_, index) =>
        Math.round((index * Math.max(0, points.length - 1)) / (width < 500 ? 3 : 6)),
      ),
    ),
  ]);
  const tooltipBounds = $derived.by(() => {
    const left = Math.max(8, 8 - plot.left);
    const right = Math.min(plot.width - 8, plot.viewportWidth - plot.left - 8);
    const top = Math.max(8, 8 - plot.top);
    const bottom = Math.min(plot.height - 8, plot.viewportHeight - plot.top - 8);
    return {
      left,
      right,
      top,
      bottom,
      maxWidth: Math.max(1, Math.min(310, right - left)),
      maxHeight: Math.max(1, Math.min(280, bottom - top)),
    };
  });
  const tooltipPosition = $derived.by(() => {
    if (!selected) return { left: 8, top: 8 };
    const anchorX = (((x(selected.key) ?? 52) + x.bandwidth() / 2) * plot.width) / width;
    const anchorY =
      pointerY ??
      (y(mode === 'bar' ? selected[metric] : Math.max(0, ...selectedSeries.map((series) => series[metric]))) *
        plot.height) /
        height;
    const tooltipWidth = Math.min(tooltipSize.width, tooltipBounds.maxWidth);
    const tooltipHeight = Math.min(tooltipSize.height, tooltipBounds.maxHeight);
    const preferredLeft =
      anchorX + 12 + tooltipWidth <= tooltipBounds.right ? anchorX + 12 : anchorX - 12 - tooltipWidth;
    const preferredTop =
      anchorY + 12 + tooltipHeight <= tooltipBounds.bottom ? anchorY + 12 : anchorY - 12 - tooltipHeight;
    return {
      left: Math.max(tooltipBounds.left, Math.min(preferredLeft, tooltipBounds.right - tooltipWidth)),
      top: Math.max(tooltipBounds.top, Math.min(preferredTop, tooltipBounds.bottom - tooltipHeight)),
    };
  });

  function updatePlotBounds() {
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    plot = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }
  function observe(node: HTMLElement) {
    stage = node;
    updatePlotBounds();
    const observer = new ResizeObserver(([entry]) => {
      width = Math.max(240, entry.contentRect.width);
      updatePlotBounds();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      stage = undefined;
    };
  }
  function measureTooltip(node: HTMLElement) {
    const measure = () => {
      const rect = node.getBoundingClientRect();
      tooltipSize = { width: rect.width, height: rect.height };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }
  function animatePath(node: SVGPathElement, path: string) {
    const selection = select(node);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !node.getAttribute('d')) selection.attr('d', path);
    else selection.interrupt().transition().duration(280).attr('d', path);
    return () => selection.interrupt();
  }
  function label(key: string, full = false) {
    return (full ? fullLabelFormat : labelFormat).format(new Date(hourly ? key : key + 'T12:00:00Z'));
  }
  function dashForSeries(index: number) {
    return selectedGrouping === 'models' ? ['', '6 3', '2 3', '9 3 2 3', '3 2', '8 4'][index % 6] : '';
  }
  function pointer(event: PointerEvent) {
    const node = event.currentTarget;
    if (!(node instanceof HTMLElement) || points.length === 0) return;
    updatePlotBounds();
    const offset = ((event.clientX - plot.left) * width) / Math.max(1, plot.width);
    const firstCenter = (x(points[0].key) ?? 52) + x.bandwidth() / 2;
    active = Math.max(0, Math.min(points.length - 1, Math.round((offset - firstCenter) / Math.max(1, x.step()))));
    pointerY = Math.max(0, Math.min(plot.height, event.clientY - plot.top));
  }
  function keyboard(event: KeyboardEvent) {
    if (points.length === 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      active = Math.max(0, Math.min(points.length - 1, active + (event.key === 'ArrowRight' ? 1 : -1)));
    } else if (event.key === 'Home') {
      event.preventDefault();
      active = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      active = points.length - 1;
    } else if (event.key === 'Escape') active = -1;
    else return;
    pointerY = undefined;
    updatePlotBounds();
  }
  function formatValue(value: Pick<ChartSeries, 'tokens' | 'costUSD' | 'unpricedTokens'>, detailed = false) {
    if (metric === 'tokens') return (detailed ? integer : compact).format(value.tokens);
    if (value.tokens > 0 && (value.unpricedTokens ?? 0) >= value.tokens) return 'Unpriced';
    return money.format(value.costUSD) + ((value.unpricedTokens ?? 0) > 0 ? '*' : '');
  }
  const percentage = (value: number, total: number) => share.format(total > 0 ? value / total : 0);
  const formatTick = (value: number) =>
    metric === 'costUSD' ? (value < 1 ? money.format(value) : '$' + compact.format(value)) : compact.format(value);
</script>

<svelte:window onresize={updatePlotBounds} onscroll={updatePlotBounds} />

<div class="chart-toolbar">
  <div class="segmented chart-grouping" role="group" aria-label="Chart breakdown">
    {#each groups as group (group.value)}
      <button
        class={selectedGrouping === group.value ? 'active' : ''}
        aria-pressed={selectedGrouping === group.value}
        disabled={!available[group.value]}
        onclick={() => onGroupingChange(group.value)}>{group.label}</button
      >
    {/each}
  </div>
  <span class="chart-granularity">{granularity}</span>
</div>
<div
  class="chart-stage"
  {@attach observe}
  role="slider"
  aria-label={(hourly ? 'Hourly' : 'Daily') + ' usage by ' + selectedGrouping + '. Use arrow keys to inspect.'}
  aria-valuemin="0"
  aria-valuemax={Math.max(0, points.length - 1)}
  aria-valuenow={Math.max(0, active)}
  aria-valuetext={selected
    ? label(selected.key, true) +
      ': ' +
      formatValue(selected, true) +
      (metric === 'tokens' ? ' tokens' : ' estimated cost')
    : 'Use arrow keys to inspect usage'}
  tabindex="0"
  onpointerdown={pointer}
  onpointermove={pointer}
  onpointerleave={(event) => {
    if (event.pointerType !== 'touch') active = -1;
  }}
  onkeydown={keyboard}
>
  <svg viewBox={'0 0 ' + width + ' ' + height} aria-hidden="true">
    {#each ticks as tick (tick)}
      <g>
        <line class="chart-grid" x1="52" x2={width - 12} y1={y(tick)} y2={y(tick)} />
        <text class="chart-label" x="42" y={y(tick) + 4} text-anchor="end">{formatTick(tick)}</text>
      </g>
    {/each}
    {#if mode === 'bar'}
      {#each bars as bar (bar.key)}
        <rect
          class="usage-bar"
          x={bar.x}
          y={bar.y}
          width={Math.max(1, x.bandwidth())}
          height={Math.max(0, bar.height)}
          fill={bar.color}
          rx="2"
        />
      {/each}
    {:else}
      {#each lines as series (series.name)}
        <path
          class="usage-line"
          fill="none"
          stroke={series.color}
          stroke-width="2.5"
          stroke-dasharray={series.dash}
          stroke-linecap="round"
          stroke-linejoin="round"
          {@attach (node: SVGPathElement) => animatePath(node, series.path)}
        />
      {/each}
    {/if}
    {#each tickIndices as index (index)}
      {@const point = points[index]}
      {#if point}
        <text class="chart-label" x={(x(point.key) ?? 52) + x.bandwidth() / 2} y={height - 9} text-anchor="middle"
          >{label(point.key)}</text
        >
      {/if}
    {/each}
    {#if selected && !empty}
      <line
        class="chart-crosshair"
        x1={(x(selected.key) ?? 52) + x.bandwidth() / 2}
        x2={(x(selected.key) ?? 52) + x.bandwidth() / 2}
        y1="15"
        y2={height - 35}
      />
      {#if mode === 'line'}
        {#each selectedSeries as series (series.name)}
          <circle
            cx={(x(selected.key) ?? 52) + x.bandwidth() / 2}
            cy={y(series[metric])}
            r="4"
            fill={series.color}
            stroke="var(--surface)"
            stroke-width="2"
          />
        {/each}
      {/if}
    {/if}
  </svg>
  {#if empty}
    <div class="chart-empty">
      <strong>No usage in this view</strong><span>Try another period or change your filters.</span>
    </div>
  {/if}
  {#if selected && !empty}
    <div
      class="chart-tooltip"
      {@attach measureTooltip}
      role="status"
      onpointermove={(event) => event.stopPropagation()}
      onpointerdown={(event) => event.stopPropagation()}
      style:left={tooltipPosition.left + 'px'}
      style:top={tooltipPosition.top + 'px'}
      style:right="auto"
      style:max-width={tooltipBounds.maxWidth + 'px'}
      style:max-height={tooltipBounds.maxHeight + 'px'}
      style:visibility={tooltipSize.width ? 'visible' : 'hidden'}
    >
      <strong
        >{label(selected.key, true)}{selected.end !== selected.key && !hourly
          ? ' – ' + label(selected.end)
          : ''}</strong
      >
      {#each selectedSeries as series (series.name)}
        <div>
          <span title={series.label}><i style:background={series.color}></i><span>{series.label}</span></span>
          <span class="tooltip-values"
            ><b>{formatValue(series, true)}</b><span>{percentage(series[metric], selected[metric])}</span></span
          >
        </div>
      {/each}
      <div class="tooltip-total"><span>Total</span><b>{formatValue(selected, true)}</b></div>
      {#if metric === 'costUSD' && selected.unpricedTokens > 0}
        <p class="tooltip-note">Unpriced tokens are excluded from cost.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .chart-toolbar {
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--muted);
    font-size: 12px;
  }
  .chart-grouping button {
    padding: 5px 9px;
    font-size: 11px;
  }
  .chart-stage {
    height: 320px;
  }
  .chart-stage > svg {
    height: 320px;
  }
  .chart-tooltip {
    width: max-content;
    min-width: 0;
    max-width: 310px;
    box-sizing: border-box;
    max-height: 280px;
    overflow-y: auto;
    pointer-events: auto;
    font-size: 12px;
  }
  .chart-tooltip > div {
    gap: 14px;
  }
  .chart-tooltip > div > span {
    min-width: 0;
  }
  .chart-tooltip > div > span > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chart-tooltip b {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .chart-tooltip .tooltip-values {
    flex-shrink: 0;
    gap: 8px;
    font-variant-numeric: tabular-nums;
  }
  .tooltip-note {
    margin: 8px 0 0;
    font-size: 10px;
    color: var(--muted);
  }
  .usage-line {
    vector-effect: non-scaling-stroke;
  }
  @media (max-width: 600px) {
    .chart-grouping button {
      padding: 5px 7px;
    }
    .chart-tooltip {
      padding: 10px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .usage-bar {
      transition: none;
    }
  }
</style>
