import { replaceState } from '$app/navigation';
import { resolve } from '$app/paths';
import type { Chart, Period, ReportResponse, View } from './api';
import {
	filterValues,
	maxFilterValues,
	reportSearch,
	reportTarget,
	validChart,
	type ReportParamKey
} from './report-query';
import type { FilterKey } from './search-params';

/**
 * Owns the dashboard's report state.
 *
 * Controls read from `params`, which is updated synchronously when the user
 * clicks, so a selection registers on the next frame no matter how long the
 * request behind it takes. Responses are cached per query, so returning to a
 * window already visited swaps back with no request and no loading state at all.
 */
export class ReportState {
	/**
	 * The query is held as an href rather than a URL instance so that reading a
	 * control's value is a pure derivation of one immutable string, and so an
	 * accidental in-place mutation cannot leave the state and the URL disagreeing.
	 */
	#href = $state.raw('http://localhost/');
	#data: ReportResponse = $state.raw() as ReportResponse;
	// Deliberately a plain Map: it is a request cache read only inside methods, so
	// making it reactive would invalidate the report on every unrelated insert.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	#cache = new Map<string, ReportResponse>();
	#inFlight: AbortController | null = null;
	#generation = 0;
	#settled = $state(true);

	/** True once a request has been outstanding long enough to be worth reporting. */
	loading = $state(false);
	error = $state<string | null>(null);

	constructor(url: URL, data: ReportResponse) {
		this.#href = url.href;
		this.#data = data;
		this.#cache.set(this.#key(url), data);
	}

	/** Keeps the entry loaded by SvelteKit authoritative across a full navigation. */
	sync(url: URL, data: ReportResponse) {
		if (this.#inFlight) return;
		this.#href = url.href;
		this.#data = data;
		this.#cache.set(this.#key(url), data);
	}

	/**
	 * A throwaway URL parsed from the href each time it is needed. Nothing retains
	 * it, so it needs no reactivity of its own: the reactive value is `#href`.
	 */
	get #url() {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		return new URL(this.#href);
	}

	get report() {
		return this.#data.report;
	}

	get response() {
		return this.#data;
	}

	/** True while the shown data belongs to a query the user has already moved on from. */
	get stale() {
		return !this.#settled;
	}

	get period(): Period {
		const value = this.#params.get('period') ?? 'day';
		return value === 'week' || value === 'month' ? value : 'day';
	}

	get view(): View {
		const value = this.#params.get('view') ?? 'agent';
		return value === 'device' || value === 'project' || value === 'model'
			? value
			: 'agent';
	}

	get chart(): Chart {
		return validChart(this.#params.get('chart'));
	}

	get #params() {
		return this.#url.searchParams;
	}

	selected(key: FilterKey) {
		return filterValues(this.#params.get(key));
	}

	setPeriod(value: Period) {
		this.#apply('period', value);
	}

	setView(value: View) {
		this.#apply('view', value);
	}

	/** Chart style is presentation only, so it never triggers a request. */
	setChart(value: Chart) {
		const target = this.#url;
		if (value === 'bars') target.searchParams.delete('chart');
		else target.searchParams.set('chart', value);
		this.#href = target.href;
		replaceState(this.#path(target), {});
	}

	toggleFilter(key: FilterKey, value: string, checked: boolean) {
		const values = this.selected(key).filter((item) => item !== value);
		if (checked && values.length < maxFilterValues) values.push(value);
		this.#apply(key, values);
	}

	clearFilter(key: FilterKey) {
		this.#apply(key, []);
	}

	/** Warms the cache so a hovered control resolves instantly when clicked. */
	prefetch(key: ReportParamKey, value: string | string[]) {
		const target = reportTarget(this.#url, key, value);
		const search = this.#key(target);
		if (this.#cache.has(search)) return;

		void fetch(`/api/report${search}`)
			.then((response) => (response.ok ? response.json() : null))
			.then((data: ReportResponse | null) => {
				if (data) this.#cache.set(search, data);
			})
			.catch(() => {
				// A failed prefetch is not worth surfacing; the click will retry.
			});
	}

	#apply(key: ReportParamKey, value: string | string[]) {
		const previous = this.#href;
		const target = reportTarget(this.#url, key, value);
		if (target.href === previous) return;

		this.#href = target.href;
		this.error = null;
		replaceState(this.#path(target), {});

		const search = this.#key(target);
		const cached = this.#cache.get(search);

		if (cached) {
			this.#inFlight?.abort();
			this.#inFlight = null;
			this.#generation += 1;
			this.#data = cached;
			this.#settled = true;
			this.loading = false;
			return;
		}

		void this.#load(search, previous);
	}

	async #load(search: string, previous: string) {
		const generation = ++this.#generation;
		this.#inFlight?.abort();
		const controller = new AbortController();
		this.#inFlight = controller;
		this.#settled = false;

		// Only announce loading if the request outlives a frame or two. Cheap
		// windows resolve faster than a spinner would be readable, and flashing one
		// reads as jitter rather than progress.
		const announce = setTimeout(() => {
			if (generation === this.#generation) this.loading = true;
		}, 120);

		try {
			const response = await fetch(`/api/report${search}`, {
				signal: controller.signal
			});

			if (!response.ok) {
				throw new Error(`Unable to update the report (${response.status}).`);
			}

			const data: ReportResponse = await response.json();
			if (generation !== this.#generation) return;

			this.#cache.set(search, data);
			this.#data = data;
			this.#settled = true;
			this.error = null;
		} catch (error) {
			if (controller.signal.aborted || generation !== this.#generation) return;

			// Roll the controls back to the query whose data is still on screen, so
			// what the URL and the buttons claim keeps matching what is rendered.
			this.#href = previous;
			this.#settled = true;
			replaceState(this.#path(this.#url), {});
			this.error =
				error instanceof Error ? error.message : 'Unable to update the report.';
		} finally {
			clearTimeout(announce);
			if (generation === this.#generation) {
				this.loading = false;
				this.#inFlight = null;
			}
		}
	}

	#key(url: URL) {
		return reportSearch(url, Intl.DateTimeFormat().resolvedOptions().timeZone);
	}

	#path(target: URL) {
		if (target.search) {
			return resolve(
				`/?${target.search.slice(1)}${target.hash}` as `/?${string}`
			);
		}
		if (target.hash)
			return resolve(`/#${target.hash.slice(1)}` as `/#${string}`);
		return resolve('/');
	}
}
