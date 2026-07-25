<script lang="ts">
	import { Tween } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';
	import { number, type Bar, type Series } from '$lib/api';

	let {
		bars,
		series,
		colorOf,
		dashOf,
		labelOf
	}: {
		bars: Bar[];
		series: Series[];
		colorOf: (key: string) => string;
		dashOf: (key: string) => string;
		labelOf: (key: string) => string;
	} = $props();

	const left = 40;
	const right = 960;
	const top = 40;
	const bottom = 320;

	const maximum = $derived(
		Math.max(
			...bars.flatMap((bar) => bar.segments.map((segment) => segment.tokens)),
			1
		)
	);

	/** Series tokens per bucket, as a flat matrix the tween can interpolate over. */
	const values = $derived(
		series.map((item) =>
			bars.map(
				(bar) =>
					bar.segments.find((segment) => segment.key === item.key)?.tokens ?? 0
			)
		)
	);

	// The y axis is tweened rather than snapped, so when a filter changes the scale
	// the whole chart rescales smoothly instead of jumping to a new axis.
	const scale = Tween.of(() => maximum, {
		duration: (from, to) =>
			prefersReducedMotion.current || from === to ? 0 : 420,
		easing: cubicOut
	});

	const axis = $derived(Math.max(scale.current, 1));

	function x(index: number) {
		const last = Math.max(bars.length - 1, 1);
		return left + (index / last) * (right - left);
	}

	function y(tokens: number) {
		return bottom - (tokens / axis) * (bottom - top);
	}

	function points(row: number[]) {
		return row.map((tokens, index) => `${x(index)},${y(tokens)}`).join(' ');
	}

	function area(row: number[]) {
		if (row.length === 0) return '';
		const line = row
			.map(
				(tokens, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(tokens)}`
			)
			.join(' ');
		return `${line} L${x(row.length - 1)},${bottom} L${x(0)},${bottom} Z`;
	}
</script>

<svg
	class="line-chart"
	viewBox="0 0 1000 340"
	role="img"
	aria-label="Token usage line chart"
>
	{#each [0, 0.25, 0.5, 0.75, 1] as fraction (fraction)}
		<line
			class="grid"
			x1={left}
			y1={bottom - fraction * (bottom - top)}
			x2={right}
			y2={bottom - fraction * (bottom - top)}
		></line>
		<text
			class="axis-label"
			x={left - 6}
			y={bottom + 4 - fraction * (bottom - top)}
			text-anchor="end">{number(Math.round(axis * fraction))}</text
		>
	{/each}

	{#each series as item, index (item.key)}
		{@const row = values[index] ?? []}
		{#if series.length <= 3}
			<path class="area" d={area(row)} fill={colorOf(item.key)}></path>
		{/if}
		<polyline
			style:--series-color={colorOf(item.key)}
			stroke-dasharray={dashOf(item.key)}
			points={points(row)}
		></polyline>
		{#each row as tokens, barIndex (bars[barIndex]?.key ?? barIndex)}
			<g>
				<circle cx={x(barIndex)} cy={y(tokens)} r="3.5" fill={colorOf(item.key)}
				></circle>
				<title
					>{labelOf(item.key)}, {bars[barIndex]?.label}: {number(tokens)} tokens</title
				>
			</g>
		{/each}
	{/each}
</svg>

<div class="line-labels">
	<span>{bars[0]?.label}</span>
	<span>{bars.at(-1)?.label}</span>
</div>

<style>
	.line-chart {
		width: 100%;
		height: 360px;
		overflow: visible;
	}

	.grid {
		stroke: var(--line);
		stroke-width: 1;
	}

	polyline {
		fill: none;
		stroke: var(--series-color);
		stroke-width: 3;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
		transition: stroke 220ms ease;
	}

	.area {
		opacity: 0.09;
	}

	circle {
		stroke: var(--chart-outline);
		stroke-width: 2;
	}

	.axis-label {
		fill: var(--muted);
		font: 15px var(--font-mono);
	}

	.line-labels {
		display: flex;
		justify-content: space-between;
		color: var(--muted);
		font: 0.68rem var(--font-mono);
	}
</style>
