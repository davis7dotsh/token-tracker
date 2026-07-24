export type Period = 'day' | 'week' | 'month';
export type View = 'device' | 'project' | 'agent' | 'model';
export type Chart = 'bars' | 'lines';

export interface Counters {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	sessions: number;
}

export interface Filters {
	devices: string[];
	projects: string[];
	agents: string[];
	models: string[];
}

export interface Series {
	key: string;
	label: string;
	tokens: number;
	isOther: boolean;
	count: number;
}

export interface Segment {
	key: string;
	tokens: number;
}

export interface Bar {
	key: string;
	label: string;
	datetime: string;
	tokens: number;
	cost: number;
	segments: Segment[];
	qualities: string[];
}

export interface Total {
	key: string;
	label: string;
	counters: Counters;
	tokens: number;
	cost: number;
	qualities: string[];
	isOther: boolean;
	count: number;
}

export interface Report {
	period: Period;
	view: View;
	timeZone: string;
	series: Series[];
	bars: Bar[];
	totals: Total[];
	combined: Total;
	options: Filters;
	hasUsage: boolean;
	hasMatches: boolean;
	truncated: boolean;
}

export interface ReportResponse {
	report: Report;
	stale: boolean;
	staleDevices: string[];
	pricing: {
		source: string;
		fetchedAt: string | null;
		missingModels: string[];
		warning: string | null;
	};
}

export interface SystemDevice {
	name: string;
	local: boolean;
	state: string;
	lastSeenAt: string | null;
	lastSyncAt: string | null;
	lastActivityAt: string | null;
	sessions: number;
	tokens: number;
}

export interface SystemResponse {
	role: string;
	devices: SystemDevice[];
	counts: { active: number; local: number; revoked: number };
	pendingSessions: number;
	lastCollectionAt: string | null;
	lastSyncAt: string | null;
	lastError: string | null;
}

export const number = (value: number) =>
	new Intl.NumberFormat(undefined, {
		notation: value >= 1_000_000 ? 'compact' : 'standard'
	}).format(value);

export const money = (value: number) => {
	const precision = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;

	return new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: precision,
		maximumFractionDigits: precision
	}).format(value);
};
