import { createSearchParamsSchema } from 'runed/kit';

export const dashboardSearchSchema = createSearchParamsSchema({
	period: { type: 'string', default: 'day' },
	view: { type: 'string', default: 'agent' },
	chart: { type: 'string', default: 'bars' },
	tz: { type: 'string', default: '' },
	device: { type: 'array', default: [], arrayType: '' },
	project: { type: 'array', default: [], arrayType: '' },
	agent: { type: 'array', default: [], arrayType: '' },
	model: { type: 'array', default: [], arrayType: '' }
});

export type FilterKey = 'device' | 'project' | 'agent' | 'model';
