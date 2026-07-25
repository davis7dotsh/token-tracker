<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { money, number, type Chart, type ReportResponse } from '$lib/api';
	import BarChart from '$lib/BarChart.svelte';
	import LineChart from '$lib/LineChart.svelte';
	import { maxFilterValues, type ReportParamKey } from '$lib/report-query';
	import { ReportState } from '$lib/report-state.svelte';
	import type { FilterKey } from '$lib/search-params';
	import { displaySeriesLabel } from '$lib/series-label';

	let { data }: { data: ReportResponse } = $props();

	// Seeded from the load function's first result. Reading `data` here is
	// deliberately a one-time snapshot: later results are adopted by the effect
	// below, which is what keeps the state authoritative after a navigation.
	const state = untrack(() => new ReportState(page.url, data));

	// A full navigation (a link, or the back button) delivers new load data; adopt it
	// so the URL and the rendered report cannot drift apart.
	$effect(() => {
		state.sync(page.url, data);
	});

	const palette = [
		'#43b7a5',
		'#8b63e6',
		'#efa91f',
		'#e1666b',
		'#398ad7',
		'#9aaa40',
		'#d373ba',
		'#84776b',
		'#25a8bd',
		'#b56b20',
		'#858585'
	];
	const periods = [
		{ key: 'day', label: '1D' },
		{ key: 'week', label: '1W' },
		{ key: 'month', label: '1M' }
	] as const;
	const views = ['agent', 'device', 'project', 'model'] as const;
	const filters = [
		{ key: 'device', label: 'device', options: 'devices' },
		{ key: 'project', label: 'project', options: 'projects' },
		{ key: 'agent', label: 'agent', options: 'agents' },
		{ key: 'model', label: 'model', options: 'models' }
	] as const;

	const report = $derived(state.report);
	const seriesByKey = $derived(
		new Map(report.series.map((series) => [series.key, series]))
	);

	function hash(value: string) {
		let result = 0;
		for (const character of value)
			result = (result * 31 + character.charCodeAt(0)) >>> 0;
		return result;
	}

	// Colour follows the series identity rather than its rank, so a series keeps its
	// colour when the ordering changes and the transition reads as movement.
	function colorOf(key: string) {
		const series = seriesByKey.get(key);
		if (series?.isOther) return 'var(--muted)';
		const identity = series?.label ?? key;
		if (report.view === 'agent' && identity.toLowerCase() === 'codex')
			return '#43b7a5';
		return palette[hash(identity) % palette.length];
	}

	function dashOf(key: string) {
		if (seriesByKey.get(key)?.isOther) return '1 4';
		const patterns = ['', '8 3', '3 3', '10 3 2 3', '2 4'];
		const identity = seriesByKey.get(key)?.label ?? key;
		return patterns[hash(identity) % patterns.length];
	}

	function labelOf(key: string) {
		return displaySeriesLabel(seriesByKey.get(key), key, report.view);
	}

	const filterOptions = (
		key: (typeof filters)[number]['options'],
		filterKey: FilterKey
	) =>
		[...state.selected(filterKey), ...report.options[key]]
			.filter((value, index, values) => values.indexOf(value) === index)
			.sort();

	const prefetch = (key: ReportParamKey, value: string | string[]) => () =>
		state.prefetch(key, value);
</script>

<svelte:head><title>Usage · Token Tracker</title></svelte:head>

{#if state.loading}
	<div class="navigation-progress" role="status" aria-live="polite">
		<span class="sr-only">Updating report…</span>
	</div>
{/if}

<main>
	<header class="page-header">
		<div>
			<p class="eyebrow">USAGE / {report.timeZone}</p>
			<h1>Token activity</h1>
			<p class="lede">
				A local view of AI agent work across every synchronized device.
			</p>
		</div>
		<div class="window-total">
			<p class="eyebrow">CURRENT WINDOW</p>
			<div class="window-tokens">{number(report.combined.tokens)} tokens</div>
		</div>
	</header>

	<section class="controls" aria-label="Report controls">
		<div class="control-group" role="group" aria-label="Period">
			{#each periods as period (period.key)}
				<button
					type="button"
					class:active={state.period === period.key}
					aria-pressed={state.period === period.key}
					onmouseenter={prefetch('period', period.key)}
					onfocus={prefetch('period', period.key)}
					onclick={() => state.setPeriod(period.key)}>{period.label}</button
				>
			{/each}
		</div>
		<div class="control-group" role="group" aria-label="Group by">
			{#each views as view (view)}
				<button
					type="button"
					class:active={state.view === view}
					aria-pressed={state.view === view}
					onmouseenter={prefetch('view', view)}
					onfocus={prefetch('view', view)}
					onclick={() => state.setView(view)}
					>{view[0].toUpperCase() + view.slice(1)}</button
				>
			{/each}
		</div>
		<div class="control-group" role="group" aria-label="Chart style">
			{#each ['bars', 'lines'] as style (style)}
				<button
					type="button"
					class:active={state.chart === style}
					aria-pressed={state.chart === style}
					onclick={() => state.setChart(style as Chart)}
					>{style[0].toUpperCase() + style.slice(1)}</button
				>
			{/each}
		</div>

		<div class="filters">
			{#each filters as filter (filter.key)}
				{@const selected = state.selected(filter.key)}
				<details class="filter">
					<summary
						>{filter.label}
						{selected.length ? `· ${selected.length}` : '+'}</summary
					>
					<div class="filter-panel">
						{#if selected.length}
							<button
								class="filter-clear"
								type="button"
								onclick={() => state.clearFilter(filter.key)}>Clear all</button
							>
						{/if}
						{#if filterOptions(filter.options, filter.key).length === 0}
							<div class="filter-option">No values in this window</div>
						{:else}
							{#each filterOptions(filter.options, filter.key) as option (option)}
								<label class="filter-option">
									<input
										type="checkbox"
										checked={selected.includes(option)}
										disabled={selected.length >= maxFilterValues &&
											!selected.includes(option)}
										onchange={(event) =>
											state.toggleFilter(
												filter.key,
												option,
												event.currentTarget.checked
											)}
									/>
									<span>{option}</span>
								</label>
							{/each}
						{/if}
						<p class="filter-limit">
							{selected.length}/{maxFilterValues} selected
							{#if selected.length >= maxFilterValues}
								· Clear a value to choose another.
							{/if}
						</p>
					</div>
				</details>
			{/each}
		</div>
	</section>

	{#if state.error}
		<p class="notice">{state.error} The previous data is still shown.</p>
	{/if}

	{#if state.response.stale}
		<p class="notice">
			Usage may be incomplete because {state.response.staleDevices.join(', ')}
			{state.response.staleDevices.length === 1 ? 'has' : 'have'} not reported recently.
		</p>
	{/if}

	{#if !report.hasUsage}
		<section class="empty-state">
			<p class="eyebrow">NO DATA / WINDOW</p>
			<h2>No usage yet</h2>
			<p class="lede">
				Collect or synchronize sessions, then this report will fill in
				automatically.
			</p>
		</section>
	{:else if !report.hasMatches}
		<section class="empty-state">
			<p class="eyebrow">FILTER / EMPTY</p>
			<h2>No matching usage</h2>
			<p class="lede">Remove one or more filters to widen the report.</p>
		</section>
	{:else}
		<!-- The report stays mounted and dims while a slower window loads, so the
		     charts animate from the old figures to the new ones instead of
		     collapsing to a placeholder and back. -->
		<section
			class="dashboard"
			class:pending={state.loading}
			aria-busy={state.loading}
		>
			<div class="chart-shell">
				<div class="legend" aria-label="Chart legend">
					{#each report.series as series (series.key)}
						<span
							><i class="swatch" style:background={colorOf(series.key)}
							></i>{labelOf(series.key)}</span
						>
					{/each}
				</div>
				{#if report.truncated}
					<p class="truncation-note">
						Only the ten largest series are shown individually; the remaining
						series are combined as Other.
					</p>
				{/if}

				{#if state.chart === 'bars'}
					<BarChart
						bars={report.bars}
						series={report.series}
						{colorOf}
						{labelOf}
					/>
				{:else}
					<LineChart
						bars={report.bars}
						series={report.series}
						{colorOf}
						{dashOf}
						{labelOf}
					/>
				{/if}
			</div>

			<section class="totals">
				<h2>{report.view[0].toUpperCase() + report.view.slice(1)} totals</h2>
				<table class="data-table">
					<thead>
						<tr>
							<th>{report.view}</th>
							<th>Sessions</th>
							<th>Input</th>
							<th>Output</th>
							<th>Cache read</th>
							<th>Tokens</th>
							<th>API-equivalent cost</th>
						</tr>
					</thead>
					<tbody>
						{#each report.totals as total (total.key)}
							<tr>
								<th scope="row">
									<span class="total-label"
										><i class="swatch" style:background={colorOf(total.key)}
										></i>{labelOf(total.key)}</span
									>
								</th>
								<td>{number(total.counters.sessions)}</td>
								<td>{number(total.counters.input)}</td>
								<td>{number(total.counters.output)}</td>
								<td>{number(total.counters.cacheRead)}</td>
								<td>{number(total.tokens)}</td>
								<td>{money(total.cost)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		</section>
	{/if}
</main>

<style>
	.window-tokens {
		font: 1.2rem var(--font-mono);
		font-variant-numeric: tabular-nums;
	}

	.dashboard {
		padding: 40px 0 80px;
		transition: opacity 180ms ease;
	}

	/* Held well above invisible: the point is to signal that figures are being
	   replaced, while leaving the previous ones readable meanwhile. */
	.dashboard.pending {
		opacity: 0.62;
	}
</style>
