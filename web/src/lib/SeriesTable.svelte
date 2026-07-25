<script lang="ts">
	import { money, number, type Bar, type Series } from '$lib/api';

	// The visual charts convey values through geometry, which assistive technology
	// cannot read, and SVG <title> tooltips are not reliably announced. Both charts
	// render this table so every plotted value is available as text, including the
	// per-bucket total and cost that the bar rows show alongside the bars.
	let {
		bars,
		series,
		labelOf
	}: {
		bars: Bar[];
		series: Series[];
		labelOf: (key: string) => string;
	} = $props();
</script>

<table class="sr-only">
	<caption>Token usage by period and series</caption>
	<thead>
		<tr>
			<th>Period</th>
			{#each series as item (item.key)}<th>{labelOf(item.key)}</th>{/each}
			<th>Total tokens</th>
			<th>API-equivalent cost</th>
		</tr>
	</thead>
	<tbody>
		{#each bars as bar (bar.key)}
			<tr>
				<th scope="row">{bar.label}</th>
				{#each series as item (item.key)}
					<td>
						{number(
							bar.segments.find((segment) => segment.key === item.key)
								?.tokens ?? 0
						)}
					</td>
				{/each}
				<td>{number(bar.tokens)}</td>
				<td>{money(bar.cost)}</td>
			</tr>
		{/each}
	</tbody>
</table>
