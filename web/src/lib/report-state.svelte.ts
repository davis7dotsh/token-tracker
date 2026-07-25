import { replaceState } from '$app/navigation';
import { resolve } from '$app/paths';
import type { Chart, Period, ReportResponse, View } from './api';
import {
	filterValues,
	maxFilterValues,
	reportSearch,
	reportTarget,
	syncDecision,
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
	/** The last load result adopted by `sync`, compared by identity. */
	#synced: ReportResponse | null = null;
	/** The query whose report is currently rendered, for rolling back a failure. */
	#shown = '';
	// Deliberately a plain Map: it is a request cache read only inside methods, so
	// making it reactive would invalidate the report on every unrelated insert.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	#cache = new Map<string, ReportResponse>();
	/** Queries with a prefetch already in flight, so hover does not refire them. */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	#prefetching = new Set<string>();
	#inFlight: AbortController | null = null;
	#generation = 0;
	#settled = $state(true);

	/** True once a request has been outstanding long enough to be worth reporting. */
	loading = $state(false);
	error = $state<string | null>(null);

	constructor(url: URL, data: ReportResponse) {
		this.#href = url.href;
		this.#synced = data;
		this.#show(data, url.href);
		this.#cache.set(this.#key(url), data);
	}

	/**
	 * Adopts a result delivered by SvelteKit's load function.
	 *
	 * The caller runs inside an effect that observes both the URL and the load data,
	 * so it re-runs for two quite different reasons and this method has to tell them
	 * apart:
	 *
	 * - This class rewrote the query via `replaceState`. The load function did not
	 *   re-run, so the same `data` arrives against a URL this class already knows.
	 *   Adopting it would overwrite a newer report — including one just restored
	 *   from cache — with the entry the page was originally loaded with.
	 * - A real navigation, such as a link or the Back button. Here the URL differs
	 *   from what this class last recorded, and it must be adopted even when
	 *   SvelteKit hands back an unchanged `data` object (which it may do when
	 *   restoring a cached history entry), or the report would keep describing the
	 *   query the user just left.
	 *
	 * So the guard compares the URL as well as the data, and a navigation abandons
	 * anything in flight rather than letting it land on top of the new entry.
	 */
	sync(url: URL, data: ReportResponse) {
		const search = this.#key(url);
		const decision = syncDecision({
			data,
			href: url.href,
			synced: this.#synced,
			currentHref: this.#href,
			cached: this.#cache.has(search)
		});

		if (decision === 'ignore') return;

		// A fresh load result is authoritative for its own query. When the result is
		// unchanged the URL must have moved, so the report comes from the cache.
		const report = data === this.#synced ? this.#cache.get(search) : data;

		this.#synced = data;
		this.#inFlight?.abort();
		this.#inFlight = null;
		this.#generation += 1;
		this.#href = url.href;
		this.error = null;

		if (decision === 'fetch' || !report) {
			void this.#load(search);
			return;
		}

		this.#show(report, url.href);
		this.loading = false;
		this.#cache.set(search, report);
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

	/**
	 * Chart style is presentation only, so it never triggers a request. It still
	 * goes through `reportTarget` so the rule for eliding a default value lives in
	 * one place.
	 */
	setChart(value: Chart) {
		const target = reportTarget(this.#url, 'chart', value);
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

	/**
	 * Warms the cache so a hovered control resolves instantly when clicked.
	 *
	 * Hovering fires repeatedly as the pointer moves, so a query already cached or
	 * already being fetched is skipped rather than requested again.
	 */
	prefetch(key: ReportParamKey, value: string | string[]) {
		const target = reportTarget(this.#url, key, value);
		const search = this.#key(target);
		if (this.#cache.has(search) || this.#prefetching.has(search)) return;

		this.#prefetching.add(search);

		void fetch(`/api/report${search}`)
			.then((response) => (response.ok ? response.json() : null))
			.then((data: ReportResponse | null) => {
				if (data) this.#cache.set(search, data);
			})
			.catch(() => {
				// A failed prefetch is not worth surfacing; the click will retry.
			})
			.finally(() => this.#prefetching.delete(search));
	}

	#apply(key: ReportParamKey, value: string | string[]) {
		const target = reportTarget(this.#url, key, value);
		if (target.href === this.#href) return;

		this.#href = target.href;
		this.error = null;
		replaceState(this.#path(target), {});

		const search = this.#key(target);
		const cached = this.#cache.get(search);

		if (cached) {
			this.#inFlight?.abort();
			this.#inFlight = null;
			this.#generation += 1;
			this.#show(cached, target.href);
			this.loading = false;
			return;
		}

		void this.#load(search);
	}

	/** Records which query the displayed report belongs to alongside the report. */
	#show(data: ReportResponse, href: string) {
		this.#data = data;
		this.#shown = href;
		this.#settled = true;
	}

	async #load(search: string) {
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
			this.#show(data, this.#href);
			this.error = null;
		} catch (error) {
			if (controller.signal.aborted || generation !== this.#generation) return;

			// Roll the controls back to the query whose report is still on screen —
			// which is not necessarily the previous URL, since that query's own request
			// may have been abandoned before it ever rendered. Restoring `#shown` keeps
			// the URL and the buttons describing what is actually rendered.
			this.#href = this.#shown;
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
