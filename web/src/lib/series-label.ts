import type { Series, View } from './api';

const agentNames: Record<string, string> = {
	codex: 'Codex',
	claude: 'Claude Code',
	'claude-code': 'Claude Code',
	pi: 'Pi'
};

export const displaySeriesLabel = (
	series: Pick<Series, 'label' | 'isOther' | 'count'> | undefined,
	fallback: string,
	view: View
) => {
	if (!series) return fallback;
	if (series.isOther) return `Other (${series.count})`;
	if (view === 'agent')
		return agentNames[series.label.toLowerCase()] ?? series.label;
	return series.label;
};
