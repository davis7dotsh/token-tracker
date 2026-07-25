<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { useSearchParams } from 'runed/kit';
	import { number } from '$lib/api';
	import {
		effectiveChart,
		effectivePeriod,
		effectiveView,
		filterValues,
		maxFilterValues,
		reportDependency
	} from '$lib/report-query';
	import ReportView from '$lib/ReportView.svelte';
	import { dashboardSearchSchema, type FilterKey } from '$lib/search-params';

	let { data } = $props();

	/**
	 * The URL is the single source of truth for the report being viewed.
	 *
	 * Reads are reactive and writes navigate, so assigning a parameter re-runs the
	 * page's load function and the report follows. The previous implementation kept
	 * its own copy of the query and wrote to the URL with `replaceState`, which does
	 * not re-run `load` — so the address bar changed while the report did not.
	 */
	const params = useSearchParams(dashboardSearchSchema, { noScroll: true });

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

	// Controls show the value the report is actually built from, resolved by the
	// same helpers the request uses, so a hand-edited link cannot leave the buttons
	// describing a different window than the one on screen.
	const period = $derived(effectivePeriod(params.period));
	const view = $derived(effectiveView(params.view));
	const chart = $derived(effectiveChart(params.chart));

	/**
	 * Filters are stored as a JSON array in one parameter. Decoding through
	 * `filterValues` applies the same caps the server enforces, so a hand-edited
	 * link cannot select more values than the UI allows.
	 */
	const selectedValues = (key: FilterKey) => {
		const value = params[key];
		return filterValues(Array.isArray(value) ? JSON.stringify(value) : value);
	};

	function toggleFilter(key: FilterKey, value: string, checked: boolean) {
		const values = selectedValues(key).filter((item) => item !== value);
		if (checked && values.length < maxFilterValues) values.push(value);
		params[key] = values;
	}

	/**
	 * Retries a failed report.
	 *
	 * Resetting the boundary alone would re-await the promise that already rejected,
	 * so the load function has to run again first. Invalidating its declared
	 * dependency produces a fresh request, and only then is it worth rebuilding the
	 * boundary's contents.
	 */
	async function retry(reset: () => void) {
		await invalidate(reportDependency);
		reset();
	}
</script>

<svelte:head><title>Usage · Token Tracker</title></svelte:head>

<!-- The live region stays mounted and only its text changes. A region inserted at
     the same moment as its message is often missed, because assistive technology
     has not yet begun observing it. -->
<div class="sr-only" role="status" aria-live="polite">
	{$effect.pending() > 0 ? 'Updating report…' : ''}
</div>

{#if $effect.pending() > 0}
	<div class="navigation-progress" aria-hidden="true"></div>
{/if}

<main>
	<header class="page-header">
		<div>
			<!-- The zone comes from the report rather than the URL parameter. The
			     server resolves an absent or unusable `tz` to a fallback, so reading the
			     parameter would label the data with a zone it was not grouped by. -->
			<p class="eyebrow">
				USAGE /
				<svelte:boundary>
					{(await data.report).report.timeZone}
					{#snippet pending()}<span class="placeholder">…</span>{/snippet}
					{#snippet failed()}<span class="placeholder">—</span>{/snippet}
				</svelte:boundary>
			</p>
			<h1>Token activity</h1>
			<p class="lede">
				A local view of AI agent work across every synchronized device.
			</p>
		</div>
		<div class="window-total">
			<p class="eyebrow">CURRENT WINDOW</p>
			<div class="window-tokens">
				<svelte:boundary>
					{number((await data.report).report.combined.tokens)} tokens
					{#snippet pending()}<span class="placeholder">—</span>{/snippet}
					{#snippet failed()}<span class="placeholder">—</span>{/snippet}
				</svelte:boundary>
			</div>
		</div>
	</header>

	<section class="controls" aria-label="Report controls">
		<div class="control-group" role="group" aria-label="Period">
			{#each periods as option (option.key)}
				<button
					type="button"
					class:active={period === option.key}
					aria-pressed={period === option.key}
					onclick={() => (params.period = option.key)}>{option.label}</button
				>
			{/each}
		</div>
		<div class="control-group" role="group" aria-label="Group by">
			{#each views as option (option)}
				<button
					type="button"
					class:active={view === option}
					aria-pressed={view === option}
					onclick={() => (params.view = option)}
					>{option[0].toUpperCase() + option.slice(1)}</button
				>
			{/each}
		</div>
		<div class="control-group" role="group" aria-label="Chart style">
			{#each ['bars', 'lines'] as style (style)}
				<button
					type="button"
					class:active={chart === style}
					aria-pressed={chart === style}
					onclick={() => (params.chart = style)}
					>{style[0].toUpperCase() + style.slice(1)}</button
				>
			{/each}
		</div>

		<div class="filters">
			{#each filters as filter (filter.key)}
				{@const selected = selectedValues(filter.key)}
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
								onclick={() => (params[filter.key] = [])}>Clear all</button
							>
						{/if}
						<svelte:boundary>
							{@const options = [
								...selected,
								...(await data.report).report.options[filter.options]
							]
								.filter(
									(value, index, values) => values.indexOf(value) === index
								)
								.sort()}
							{#if options.length === 0}
								<div class="filter-option">No values in this window</div>
							{:else}
								{#each options as option (option)}
									<label class="filter-option">
										<input
											type="checkbox"
											checked={selected.includes(option)}
											disabled={selected.length >= maxFilterValues &&
												!selected.includes(option)}
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

							{#snippet pending()}
								<div class="filter-option">Loading values…</div>
							{/snippet}
							{#snippet failed()}
								<div class="filter-option">Values are unavailable</div>
							{/snippet}
						</svelte:boundary>
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

	<!-- The boundary owns the report's pending and failed states. `pending` covers
	     only the first resolution; later updates keep the previous report on screen
	     and are signalled by `$effect.pending()` above. -->
	<svelte:boundary>
		<ReportView
			response={await data.report}
			{chart}
			pending={$effect.pending() > 0}
		/>

		{#snippet pending()}
			<section class="skeleton" aria-hidden="true">
				<div class="skeleton-legend"></div>
				{#each Array(8), row (row)}
					<div class="skeleton-row"></div>
				{/each}
			</section>
		{/snippet}

		{#snippet failed(error, reset)}
			<!-- Inline rather than a full error page: the controls stay usable, so the
			     window that failed can be changed or simply retried. -->
			<p class="notice" role="alert">
				{error instanceof Error
					? error.message
					: 'The report could not be loaded.'}
				<button class="retry" type="button" onclick={() => retry(reset)}>
					Try again
				</button>
			</p>
		{/snippet}
	</svelte:boundary>
</main>

<style>
	.window-tokens {
		font: 1.2rem var(--font-mono);
		font-variant-numeric: tabular-nums;
	}

	.placeholder {
		color: var(--muted);
	}

	.retry {
		margin-left: 10px;
		border: 1px solid var(--line-strong);
		background: var(--surface);
		color: var(--ink);
		padding: 4px 10px;
		cursor: pointer;
		font: 0.72rem var(--font-mono);
	}

	.skeleton {
		padding: 40px 0 80px;
		display: grid;
		gap: 10px;
	}

	.skeleton-legend,
	.skeleton-row {
		height: 18px;
		border-radius: 3px;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--line) 60%, transparent),
			color-mix(in srgb, var(--line) 25%, transparent)
		);
		animation: skeleton-pulse 1.1s ease-in-out infinite alternate;
	}

	.skeleton-legend {
		width: min(420px, 60%);
		margin-bottom: 24px;
	}

	@keyframes skeleton-pulse {
		from {
			opacity: 0.45;
		}
		to {
			opacity: 0.9;
		}
	}
</style>
