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

	/**
	 * Assigns each series a colour, keyed on its identity rather than its rank so a
	 * series keeps its colour when the ordering changes and the transition reads as
	 * movement.
	 *
	 * Ten series over eleven colours makes hash collisions likely rather than rare,
	 * and two series drawn in the same colour is indistinguishable from one. Where a
	 * slot is already taken, the next free slot is used instead. Assignment walks
	 * the series in report order, so it stays stable for as long as the set does.
	 */
	const seriesColors = $derived.by(() => {
		// Both are rebuilt from scratch whenever the series change and are never
		// mutated afterwards, so they need no reactivity of their own.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const assigned = new Map<string, string>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const taken = new Set<string>();

		const claim = (identity: string, preferred: number) => {
			for (let step = 0; step < palette.length; step += 1) {
				const colour = palette[(preferred + step) % palette.length];
				if (!taken.has(colour)) {
					taken.add(colour);
					assigned.set(identity, colour);
					return;
				}
			}
			// More series than colours: fall back to the hashed slot and allow a repeat.
			assigned.set(identity, palette[preferred]);
		};

		for (const series of report.series) {
			if (series.isOther) continue;
			const identity = series.label;
			if (assigned.has(identity)) continue;

			// Codex keeps its established teal, and claiming it here stops another
			// series from being given the same colour.
			const preferred =
				report.view === 'agent' && identity.toLowerCase() === 'codex'
					? 0
					: hash(identity) % palette.length;

			claim(identity, preferred);
		}

		return assigned;
	});

	function colorOf(key: string) {
		const series = seriesByKey.get(key);
		if (series?.isOther) return 'var(--muted)';
		const identity = series?.label ?? key;
		return (
			seriesColors.get(identity) ?? palette[hash(identity) % palette.length]
		);
	}

	// Dash patterns are a secondary cue on the line chart, where colour already
	// separates the series; a repeat here is not ambiguous on its own.
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

<!-- The live region stays mounted and only its text changes. A region inserted at
     the same moment as its message is often missed, because assistive technology
     has not yet begun observing it. -->
<div class="sr-only" role="status" aria-live="polite">
	{state.loading ? 'Updating report…' : ''}
</div>

{#if state.loading}
	<div class="navigation-progress" aria-hidden="true"></div>
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

	<!-- A failed update is worth interrupting for: the figures on screen are not the
	     ones the controls now describe. -->
	{#if state.error}
		<p class="notice" role="alert">
			{state.error} The previous data is still shown.
		</p>
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
