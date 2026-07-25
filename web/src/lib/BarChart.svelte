<script lang="ts">
	import { money, number, type Bar, type Series } from '$lib/api';
	import SeriesTable from '$lib/SeriesTable.svelte';

	let {
		bars,
		series,
		colorOf,
		labelOf
	}: {
		bars: Bar[];
		series: Series[];
		colorOf: (key: string) => string;
		labelOf: (key: string) => string;
	} = $props();

	const maxTokens = $derived(Math.max(...bars.map((bar) => bar.tokens), 1));

	// Segment widths are expressed as percentages of the largest bar and animated
	// by CSS, so a data change slides the existing bars to their new lengths rather
	// than replacing them.
	const width = (tokens: number) => `${(tokens / maxTokens) * 100}%`;
</script>

<!-- The table below is the accessible equivalent, so the visual bars are hidden
     from assistive technology rather than announcing every figure twice. -->
<div class="bars" aria-hidden="true">
	{#each bars as bar (bar.key)}
		<div class="bar-row">
			<span class="bar-label">{bar.label}</span>
			<div class="bar-track">
				{#each bar.segments as segment (segment.key)}
					<div
						class="bar-segment"
						style:background={colorOf(segment.key)}
						style:width={width(segment.tokens)}
						title={`${labelOf(segment.key)}: ${number(segment.tokens)} tokens`}
					></div>
				{/each}
			</div>
			<span class="bar-value">{number(bar.tokens)}</span>
			<span class="bar-value bar-cost">{money(bar.cost)}</span>
		</div>
	{/each}
</div>

<SeriesTable {bars} {series} {labelOf} />

<style>
	.bars {
		display: grid;
		gap: 10px;
	}

	.bar-row {
		display: grid;
		grid-template-columns: 72px minmax(120px, 1fr) 96px 96px;
		align-items: center;
		gap: 14px;
		min-height: 32px;
		font: 0.72rem var(--font-mono);
	}

	.bar-label {
		color: var(--muted);
	}

	/* A hairline baseline marks the track without competing with the bars: a filled
	   track reads as a full-width bar on days with no usage. */
	.bar-track {
		display: flex;
		height: 18px;
		min-width: 2px;
		overflow: hidden;
		border-radius: 3px;
		background: linear-gradient(var(--line), var(--line)) left center / 100% 1px
			no-repeat;
	}

	.bar-segment {
		height: 100%;
		min-width: 0;
		transition:
			width 420ms cubic-bezier(0.22, 1, 0.36, 1),
			background-color 220ms ease;
	}

	.bar-value {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 800px) {
		.bar-row {
			grid-template-columns: 58px 1fr 80px;
		}

		.bar-cost {
			display: none;
		}
	}
</style>
