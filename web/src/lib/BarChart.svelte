<script lang="ts">
	import { money, number, type Bar, type Series } from '$lib/api';

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

<div class="bars">
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

<table class="sr-only">
	<caption>Token usage by period and series</caption>
	<thead>
		<tr>
			<th>Period</th>
			{#each series as item (item.key)}<th>{labelOf(item.key)}</th>{/each}
		</tr>
	</thead>
	<tbody>
		{#each bars as bar (bar.key)}
			<tr>
				<th scope="row">{bar.label}</th>
				{#each series as item (item.key)}
					<td>
						{bar.segments.find((segment) => segment.key === item.key)?.tokens ??
							0}
					</td>
				{/each}
			</tr>
		{/each}
	</tbody>
</table>

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

	.bar-track {
		display: flex;
		height: 18px;
		min-width: 2px;
		overflow: hidden;
		border-radius: 3px;
		background: color-mix(in srgb, var(--line) 55%, transparent);
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
