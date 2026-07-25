<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		money,
		number,
		type Chart,
		type Period,
		type ReportResponse,
		type View
	} from '$lib/api';
	import {
		maxFilterValueLength,
		maxFilterValues,
		reportDependency,
		type ReportParamKey,
		updateReportParam,
		validChart
	} from '$lib/report-query';
	import { dashboardSearchSchema, type FilterKey } from '$lib/search-params';
	import { displaySeriesLabel } from '$lib/series-label';
	import { useSearchParams } from 'runed/kit';

	let { data }: { data: ReportResponse } = $props();
	const params = useSearchParams(dashboardSearchSchema, {
		noScroll: true,
		pushHistory: false
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
	const periods: Array<{ key: Period; label: string }> = [
		{ key: 'day', label: '1D' },
		{ key: 'week', label: '1W' },
		{ key: 'month', label: '1M' }
	];
	const views: View[] = ['agent', 'device', 'project', 'model'];
	const filters = [
		{ key: 'device', label: 'device', options: 'devices' },
		{ key: 'project', label: 'project', options: 'projects' },
		{ key: 'agent', label: 'agent', options: 'agents' },
		{ key: 'model', label: 'model', options: 'models' }
	] as const;
	let pendingFilters = $state<Partial<Record<FilterKey, string[]>>>({});
	let pendingReportUrl: URL | null = null;
	const report = $derived(data.report);
	const chart = $derived(validChart(params.chart) as Chart);
	const maxTokens = $derived(
		Math.max(...report.bars.map((bar) => bar.tokens), 1)
	);
	const lineMaximum = $derived(
		Math.max(
			...report.bars.flatMap((bar) =>
				bar.segments.map((segment) => segment.tokens)
			),
			1
		)
	);
	const seriesByKey = $derived(
		new Map(report.series.map((series) => [series.key, series]))
	);

	const selected = (key: FilterKey) =>
		(pendingFilters[key] ?? params[key])
			.filter(
				(value) => value.length > 0 && value.length <= maxFilterValueLength
			)
			.slice(0, maxFilterValues);
	const filterOptions = (
		key: (typeof filters)[number]['options'],
		filterKey: FilterKey
	) =>
		[...selected(filterKey), ...report.options[key]]
			.filter((value, index, values) => values.indexOf(value) === index)
			.sort();

	function hash(value: string) {
		let result = 0;
		for (const character of value)
			result = (result * 31 + character.charCodeAt(0)) >>> 0;
		return result;
	}

	function seriesColor(key: string) {
		const series = seriesByKey.get(key);
		if (series?.isOther) return 'var(--muted)';
		const identity = series?.label ?? key;
		if (report.view === 'agent' && identity.toLowerCase() === 'codex')
			return '#43b7a5';
		return palette[hash(identity) % palette.length];
	}

	function seriesFill(key: string) {
		return seriesColor(key);
	}

	function seriesDash(key: string) {
		if (seriesByKey.get(key)?.isOther) return '1 4';
		const patterns = ['', '8 3', '3 3', '10 3 2 3', '2 4'];
		const identity = seriesByKey.get(key)?.label ?? key;
		return patterns[hash(identity) % patterns.length];
	}

	function displayLabel(key: string) {
		return displaySeriesLabel(seriesByKey.get(key), key, report.view);
	}

	function setPeriod(value: Period) {
		reloadReport('period', value);
	}

	function setView(value: View) {
		reloadReport('view', value);
	}

	function setChart(value: Chart) {
		params.chart = value;
	}

	function toggleFilter(key: FilterKey, value: string, checked: boolean) {
		const values = selected(key).filter((item) => item !== value);
		if (checked && values.length < maxFilterValues) values.push(value);
		setFilter(key, values);
	}

	function clearFilter(key: FilterKey) {
		setFilter(key, []);
	}

	function setFilter(key: FilterKey, values: string[]) {
		pendingFilters[key] = values;
		void reloadReport(key, values);
	}

	async function reloadReport(key: ReportParamKey, value: string | string[]) {
		const current = pendingReportUrl ?? page.url;
		const changed = await updateReportParam(
			current,
			key,
			value,
			async (target) => {
				pendingReportUrl = target;

				try {
					await goto(
						resolve(
							`/?${target.searchParams.toString()}${target.hash}` as `/?${string}`
						),
						{
							replaceState: true,
							noScroll: true,
							keepFocus: true,
							invalidate: [reportDependency]
						}
					);
				} finally {
					if (pendingReportUrl?.href === target.href) {
						pendingReportUrl = null;
						pendingFilters = {};
					}
				}
			}
		);

		if (!changed && pendingReportUrl === null) pendingFilters = {};
	}

	function linePoints(seriesKey: string) {
		const last = Math.max(report.bars.length - 1, 1);
		return report.bars
			.map((bar, index) => {
				const value =
					bar.segments.find((segment) => segment.key === seriesKey)?.tokens ??
					0;
				const x = 40 + (index / last) * 920;
				const y = 320 - (value / lineMaximum) * 280;
				return `${x},${y}`;
			})
			.join(' ');
	}

	function linePoint(seriesKey: string, index: number, tokens: number) {
		const last = Math.max(report.bars.length - 1, 1);
		return {
			x: 40 + (index / last) * 920,
			y: 320 - (tokens / lineMaximum) * 280,
			label: displayLabel(seriesKey)
		};
	}
</script>

<svelte:head><title>Usage · Token Tracker</title></svelte:head>

<main>
	<header class="page-header">
		<div>
			<p class="eyebrow">USAGE / {report.timeZone}</p>
			<h1>Token activity</h1>
			<p class="lede">
				A local view of AI agent work across every synchronized device.
			</p>
		</div>
		<div>
			<p class="eyebrow">CURRENT WINDOW</p>
			<div style="font: 1.2rem var(--font-mono)">
				{number(report.combined.tokens)} tokens
			</div>
		</div>
	</header>

	<section class="controls" aria-label="Report controls">
		<div class="control-group" role="group" aria-label="Period">
			{#each periods as period (period.key)}
				<button
					type="button"
					class:active={report.period === period.key}
					aria-pressed={report.period === period.key}
					onclick={() => setPeriod(period.key)}>{period.label}</button
				>
			{/each}
		</div>
		<div class="control-group" role="group" aria-label="Group by">
			{#each views as view (view)}
				<button
					type="button"
					class:active={report.view === view}
					aria-pressed={report.view === view}
					onclick={() => setView(view)}
					>{view[0].toUpperCase() + view.slice(1)}</button
				>
			{/each}
		</div>
		<div class="control-group" role="group" aria-label="Chart style">
			{#each ['bars', 'lines'] as style (style)}
				<button
					type="button"
					class:active={chart === style}
					aria-pressed={chart === style}
					onclick={() => setChart(style as Chart)}
					>{style[0].toUpperCase() + style.slice(1)}</button
				>
			{/each}
		</div>

		<div class="filters">
			{#each filters as filter (filter.key)}
				<details class="filter">
					<summary
						>{filter.label}
						{selected(filter.key).length
							? `· ${selected(filter.key).length}`
							: '+'}</summary
					>
					<div class="filter-panel">
						{#if selected(filter.key).length}
							<button
								class="filter-clear"
								type="button"
								onclick={() => clearFilter(filter.key)}>Clear all</button
							>
						{/if}
						{#if filterOptions(filter.options, filter.key).length === 0}
							<div class="filter-option">No values in this window</div>
						{:else}
							{#each filterOptions(filter.options, filter.key) as option (option)}
								<label class="filter-option">
									<input
										type="checkbox"
										checked={selected(filter.key).includes(option)}
										disabled={selected(filter.key).length >= maxFilterValues &&
											!selected(filter.key).includes(option)}
										onchange={(event) =>
											toggleFilter(
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
							{selected(filter.key).length}/{maxFilterValues} selected
							{#if selected(filter.key).length >= maxFilterValues}
								· Clear a value to choose another.
							{/if}
						</p>
					</div>
				</details>
			{/each}
		</div>
	</section>

	{#if data.stale}
		<p class="notice">
			Usage may be incomplete because {data.staleDevices.join(', ')}
			{data.staleDevices.length === 1 ? 'has' : 'have'} not reported recently.
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
		<section class="dashboard">
			<div class="chart-shell">
				<div class="legend" aria-label="Chart legend">
					{#each report.series as series (series.key)}
						<span
							><i class="swatch" style:background={seriesFill(series.key)}
							></i>{displayLabel(series.key)}</span
						>
					{/each}
				</div>
				{#if report.truncated}
					<p class="truncation-note">
						Only the ten largest series are shown individually; the remaining
						series are combined as Other.
					</p>
				{/if}

				{#if chart === 'bars'}
					<div class="bars" aria-hidden="true">
						{#each report.bars as bar (bar.key)}
							<div class="bar-row">
								<span>{bar.label}</span>
								<div class="bar-track">
									{#each bar.segments as segment (segment.key)}
										<div
											class="bar-segment"
											style:background={seriesFill(segment.key)}
											style:width={`${(segment.tokens / maxTokens) * 100}%`}
											title={`${displayLabel(segment.key)}: ${number(segment.tokens)} tokens`}
										></div>
									{/each}
								</div>
								<span class="bar-value">{number(bar.tokens)}</span>
								<span class="bar-value bar-cost">{money(bar.cost)}</span>
							</div>
						{/each}
					</div>
				{:else}
					<svg
						class="line-chart"
						viewBox="0 0 1000 340"
						role="img"
						aria-label="Token usage line chart"
					>
						{#each [0, 0.5, 1] as fraction (fraction)}
							<line
								class="grid"
								x1="40"
								y1={320 - fraction * 280}
								x2="960"
								y2={320 - fraction * 280}
							></line>
							<text
								class="axis-label"
								x="34"
								y={324 - fraction * 280}
								text-anchor="end">{number(lineMaximum * fraction)}</text
							>
						{/each}
						{#each report.series as series (series.key)}
							<polyline
								style:--series-color={seriesColor(series.key)}
								stroke-dasharray={seriesDash(series.key)}
								points={linePoints(series.key)}
							></polyline>
							{#each report.bars as bar, barIndex (bar.key)}
								{@const tokens =
									bar.segments.find((segment) => segment.key === series.key)
										?.tokens ?? 0}
								{@const point = linePoint(series.key, barIndex, tokens)}
								<g>
									<circle
										cx={point.x}
										cy={point.y}
										r="3.5"
										fill={seriesColor(series.key)}
									></circle>
									<title
										>{point.label}, {bar.label}: {number(tokens)} tokens</title
									>
								</g>
							{/each}
						{/each}
					</svg>
					<div class="line-labels">
						<span>{report.bars[0]?.label}</span>
						<span>{report.bars.at(-1)?.label}</span>
					</div>
				{/if}

				<table class="sr-only">
					<caption>Token usage by period and series</caption>
					<thead>
						<tr
							><th>Period</th>{#each report.series as series (series.key)}<th
									>{displayLabel(series.key)}</th
								>{/each}</tr
						>
					</thead>
					<tbody>
						{#each report.bars as bar (bar.key)}
							<tr>
								<th scope="row">{bar.label}</th>
								{#each report.series as series (series.key)}
									<td
										>{bar.segments.find((segment) => segment.key === series.key)
											?.tokens ?? 0}</td
									>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
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
										><i class="swatch" style:background={seriesFill(total.key)}
										></i>{displayLabel(total.key)}</span
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
