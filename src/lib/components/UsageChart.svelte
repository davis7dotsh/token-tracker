<script lang="ts">
  import { area, curveMonotoneX, line, scaleBand, scaleLinear, select } from 'd3';
  import type { DashboardResponse } from '#lib/shared/domain.ts';
  let {
    data,
    metric = 'tokens',
    mode = 'bar',
  }: { data: DashboardResponse; metric?: 'tokens' | 'costUSD'; mode?: 'bar' | 'line' } = $props();
  let width = $state(900);
  let active = $state(-1);
  const height = 320;
  const colors: Record<string, string> = { claude: '#4DABF7', codex: '#8695a8', pi: '#b6c4d4' };
  const labels: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };
  const integer = new Intl.NumberFormat('en-US');
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
  const hourly = $derived(data.range === 'today');
  const points = $derived.by(() => {
    const source = hourly
      ? data.hourly.map((hour) => ({
          key: hour.start,
          end: hour.end,
          tokens: hour.tokens,
          costUSD: hour.costUSD,
          harnesses: hour.harnesses,
        }))
      : data.daily.map((day) => ({
          key: day.date,
          end: day.date,
          tokens: day.tokens,
          costUSD: day.costUSD,
          harnesses: day.harnesses,
        }));
    const count = Math.min(source.length, 100);
    return Array.from({ length: count }, (_, index) => {
      const group = source.slice(
        Math.floor((index * source.length) / count),
        Math.floor(((index + 1) * source.length) / count),
      );
      const harnesses = new Map<string, { name: string; tokens: number; costUSD: number }>();
      for (const bucket of group)
        for (const harness of bucket.harnesses) {
          const previous = harnesses.get(harness.name) ?? { name: harness.name, tokens: 0, costUSD: 0 };
          harnesses.set(harness.name, {
            name: harness.name,
            tokens: previous.tokens + harness.tokens,
            costUSD: previous.costUSD + harness.costUSD,
          });
        }
      return {
        key: group[0].key,
        end: group[group.length - 1].end,
        tokens: group.reduce((sum, bucket) => sum + bucket.tokens, 0),
        costUSD: group.reduce((sum, bucket) => sum + bucket.costUSD, 0),
        harnesses: [...harnesses.values()],
      };
    });
  });
  const names = $derived(data.harnesses.map((item) => item.name));
  const x = $derived(
    scaleBand<string>()
      .domain(points.map((point) => point.key))
      .range([52, width - 12])
      .padding(0.25),
  );
  const y = $derived(
    scaleLinear()
      .domain([0, Math.max(1, ...points.map((point) => point[metric]))])
      .nice(4)
      .range([height - 35, 20]),
  );
  const ticks = $derived(y.ticks(4));
  const coordinates = $derived(
    points.map((point) => [(x(point.key) ?? 52) + x.bandwidth() / 2, y(point[metric])] as [number, number]),
  );
  const linePath = $derived(
    line<[number, number]>()
      .x((point) => point[0])
      .y((point) => point[1])
      .curve(curveMonotoneX)(coordinates) ?? '',
  );
  const areaPath = $derived(
    area<[number, number]>()
      .x((point) => point[0])
      .y0(height - 35)
      .y1((point) => point[1])
      .curve(curveMonotoneX)(coordinates) ?? '',
  );
  const bars = $derived.by(() =>
    points.flatMap((point) => {
      let accumulated = 0;
      return names.map((name) => {
        const value = point.harnesses.find((item) => item.name === name)?.[metric] ?? 0;
        const bottom = y(accumulated);
        accumulated += value;
        return {
          key: `${point.key}:${name}`,
          name,
          x: x(point.key) ?? 52,
          y: y(accumulated),
          height: bottom - y(accumulated),
        };
      });
    }),
  );
  const selected = $derived(points[active]);
  const empty = $derived(data.totals.tokens === 0);
  const tickIndices = $derived([
    ...new Set([
      0,
      ...Array.from({ length: width < 500 ? 4 : 7 }, (_, index) =>
        Math.round((index * Math.max(0, points.length - 1)) / (width < 500 ? 3 : 6)),
      ),
    ]),
  ]);

  function observe(node: HTMLElement) {
    const observer = new ResizeObserver(([entry]) => {
      width = Math.max(240, entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }
  function animatePath(node: SVGPathElement, path: string) {
    const selection = select(node);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !node.getAttribute('d')) selection.attr('d', path);
    else selection.interrupt().transition().duration(280).attr('d', path);
    return () => {
      selection.interrupt();
    };
  }
  function label(key: string, full = false) {
    if (hourly)
      return new Intl.DateTimeFormat(undefined, {
        timeZone: data.timezone,
        hour: 'numeric',
        ...(full ? { minute: '2-digit', timeZoneName: 'short' } : {}),
      }).format(new Date(key));
    return new Intl.DateTimeFormat(undefined, {
      timeZone: 'UTC',
      month: full ? 'long' : 'short',
      day: 'numeric',
      ...(full ? { year: 'numeric' } : {}),
    }).format(new Date(`${key}T12:00:00Z`));
  }
  function pointer(event: PointerEvent) {
    const node = event.currentTarget;
    if (!(node instanceof HTMLElement) || points.length === 0) return;
    const offset = event.clientX - node.getBoundingClientRect().left;
    active = Math.max(
      0,
      Math.min(points.length - 1, Math.floor(((offset - 52) / Math.max(1, width - 64)) * points.length)),
    );
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      active = Math.max(0, Math.min(points.length - 1, active + (event.key === 'ArrowRight' ? 1 : -1)));
    } else if (event.key === 'Escape') active = -1;
  }
  const formatTick = (value: number) =>
    metric === 'costUSD'
      ? `$${value < 1 ? value.toFixed(2) : value.toFixed(0)}`
      : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
</script>

<div class="chart-legend">
  {#each names as name (name)}<span><i style:background={colors[name] ?? '#4DABF7'}></i>{labels[name] ?? name}</span
    >{/each}
  <span class="chart-granularity">{hourly ? 'Hourly' : 'Daily'}</span>
</div>
<div
  class="chart-stage"
  {@attach observe}
  role="slider"
  aria-label={`${hourly ? 'Hourly' : 'Daily'} usage chart. Use left and right arrow keys to inspect.`}
  aria-valuemin="0"
  aria-valuemax={Math.max(0, points.length - 1)}
  aria-valuenow={Math.max(0, active)}
  aria-valuetext={selected
    ? `${label(selected.key, true)}: ${integer.format(selected.tokens)} tokens`
    : 'Use arrow keys to inspect usage'}
  tabindex="0"
  onpointermove={pointer}
  onpointerleave={() => (active = -1)}
  onkeydown={keyboard}
>
  <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    <defs
      ><linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1"
        ><stop offset="0%" stop-color="#4DABF7" stop-opacity=".24" /><stop
          offset="100%"
          stop-color="#4DABF7"
          stop-opacity="0"
        /></linearGradient
      ></defs
    >
    {#each ticks as tick (tick)}<g
        ><line class="chart-grid" x1="52" x2={width - 12} y1={y(tick)} y2={y(tick)} /><text
          class="chart-label"
          x="42"
          y={y(tick) + 4}
          text-anchor="end">{formatTick(tick)}</text
        ></g
      >{/each}
    {#if mode === 'bar'}
      {#each bars as bar (bar.key)}<rect
          class="usage-bar"
          x={bar.x}
          y={bar.y}
          width={Math.max(1, x.bandwidth())}
          height={Math.max(0, bar.height)}
          fill={colors[bar.name] ?? '#4DABF7'}
          rx="2"
        />{/each}
    {:else}
      <path fill="url(#usage-area)" {@attach (node: SVGPathElement) => animatePath(node, areaPath)} />
      <path
        fill="none"
        stroke="#4DABF7"
        stroke-width="2.5"
        stroke-linecap="round"
        {@attach (node: SVGPathElement) => animatePath(node, linePath)}
      />
    {/if}
    {#each tickIndices as index (index)}{@const point = points[index]}{#if point}<text
          class="chart-label"
          x={(x(point.key) ?? 52) + x.bandwidth() / 2}
          y={height - 9}
          text-anchor="middle">{label(point.key)}</text
        >{/if}{/each}
    {#if selected && !empty}
      <line
        class="chart-crosshair"
        x1={(x(selected.key) ?? 52) + x.bandwidth() / 2}
        x2={(x(selected.key) ?? 52) + x.bandwidth() / 2}
        y1="15"
        y2={height - 35}
      />
      <circle
        cx={(x(selected.key) ?? 52) + x.bandwidth() / 2}
        cy={y(selected[metric])}
        r="4"
        fill="#4DABF7"
        stroke="var(--surface)"
        stroke-width="2"
      />
    {/if}
  </svg>
  {#if empty}<div class="chart-empty">
      <strong>No usage in this view</strong><span>Try another period or change your filters.</span>
    </div>{/if}
  {#if selected && !empty}<div class="chart-tooltip" role="status">
      <strong
        >{label(selected.key, true)}{selected.end !== selected.key && !hourly
          ? ` – ${label(selected.end)}`
          : ''}</strong
      >{#each selected.harnesses as harness (harness.name)}<div>
          <span><i style:background={colors[harness.name] ?? '#4DABF7'}></i>{labels[harness.name] ?? harness.name}</span
          ><b>{metric === 'tokens' ? integer.format(harness.tokens) : money.format(harness.costUSD)}</b>
        </div>{/each}
      <div class="tooltip-total">
        <span>Total</span><b>{metric === 'tokens' ? integer.format(selected.tokens) : money.format(selected.costUSD)}</b
        >
      </div>
    </div>{/if}
</div>
