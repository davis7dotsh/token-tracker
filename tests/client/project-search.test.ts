import { expect, test } from 'bun:test';
import { buildProjectIndex, searchProjects } from '../../src/lib/client/project-search';

const totals = {
  tokens: 100,
  inputTokens: 50,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUSD: 2,
  unpricedTokens: 0,
  sessions: 1,
  requests: 1,
  cacheHitRate: 0,
};
const session = (
  project: string,
  repository: string | null,
  projectName = 'Token tracker',
  lastActiveAt = '2026-10-30T10:00:00Z',
) => ({
  ...totals,
  id: project,
  harness: 'codex' as const,
  model: 'gpt-6.1-sol',
  provider: 'openai',
  project,
  repository,
  projectName,
  deviceId: 'local',
  startedAt: '2026-10-30T09:00:00Z',
  lastActiveAt,
});

test('project index keeps canonical repository keys and searches every worktree path and project name', () => {
  const key = 'github.com/davis/token-tracker';
  const entries = buildProjectIndex({
    filters: { projects: [key] },
    projects: [{ name: key, ...totals, sessions: 2 }],
    sessions: [
      session('/home/davis/.t3/worktrees/search-menu', key),
      session('/work/performance', key, 'Usage insights', '2026-10-30T11:00:00Z'),
    ],
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    key,
    label: 'davis/token-tracker',
    repository: key,
    paths: ['/home/davis/.t3/worktrees/search-menu', '/work/performance'],
    projectNames: ['Token tracker', 'Usage insights'],
    lastActiveAt: '2026-10-30T11:00:00Z',
    metrics: { tokens: 100, costUSD: 2, sessions: 2, unpricedTokens: 0 },
  });
  expect(searchProjects(entries, 'worktrees search-menu')[0]?.key).toBe(key);
  expect(searchProjects(entries, 'usage insights')[0]?.key).toBe(key);
});

test('catalogue entries outside this view retain identity without inventing zero usage or stale metrics', () => {
  const entries = buildProjectIndex(
    {
      filters: { projects: ['github.com/team/active', 'github.com/team/other'] },
      projects: [{ name: 'github.com/team/active', ...totals }],
      sessions: [],
    },
    ['github.com/team/hidden', 'github.com/team/active'],
  );
  expect(entries).toHaveLength(3);
  expect(entries.find((entry) => entry.key === 'github.com/team/active')?.metrics?.tokens).toBe(100);
  expect(entries.find((entry) => entry.key === 'github.com/team/other')?.metrics).toBeUndefined();
  expect(entries.find((entry) => entry.key === 'github.com/team/hidden')?.metrics).toBeUndefined();
  expect(buildProjectIndex(undefined, ['kept-selection'])[0]?.key).toBe('kept-selection');
});

test('search combines case insensitive words and aliases, folds accents, and rejects missing words', () => {
  const entries = buildProjectIndex({
    filters: { projects: ['local:/work/Café-insights'] },
    projects: [],
    sessions: [session('/work/Café-insights', 'local:/work/Café-insights', 'Revenue dashboard')],
  });
  expect(searchProjects(entries, '  CAFE  DASHBOARD ')).toHaveLength(1);
  expect(searchProjects(entries, 'dashboard cafe')).toHaveLength(1);
  expect(searchProjects(entries, 'cafe nonexistent')).toHaveLength(0);
  expect(searchProjects(entries, 'zzq')).toHaveLength(0);
});

test('exact project names outrank substring and fuzzy matches regardless of usage', () => {
  const entries = buildProjectIndex({
    filters: { projects: ['tracker', 'tracker-old', 'token-tracker'] },
    projects: [
      { name: 'tracker', ...totals, tokens: 1 },
      { name: 'tracker-old', ...totals, tokens: 10_000 },
      { name: 'token-tracker', ...totals, tokens: 1_000_000 },
    ],
    sessions: [],
  });
  expect(searchProjects(entries, 'tracker').map((entry) => entry.key)).toEqual([
    'tracker',
    'tracker-old',
    'token-tracker',
  ]);
  expect(searchProjects(entries, 'ttkr').map((entry) => entry.key)).toEqual(['token-tracker']);
});

test('sorts use current view metrics and chronological instants while preserving the input index', () => {
  const entries = buildProjectIndex({
    filters: { projects: ['beta', 'alpha', 'missing'] },
    projects: [
      { name: 'alpha', ...totals, tokens: 900, costUSD: 1 },
      { name: 'beta', ...totals, tokens: 10, costUSD: 8 },
    ],
    sessions: [
      session('alpha', null, 'Alpha', '2026-10-30T12:00:00+03:00'),
      session('beta', null, 'Beta', '2026-10-30T10:00:00Z'),
    ],
  });
  const keys = (sort: Parameters<typeof searchProjects>[2]) =>
    searchProjects(entries, '', sort).map((entry) => entry.key);
  expect(keys('tokens')).toEqual(['alpha', 'beta', 'missing']);
  expect(keys('cost')).toEqual(['beta', 'alpha', 'missing']);
  expect(keys('recent')).toEqual(['beta', 'alpha', 'missing']);
  expect(keys('name')).toEqual(['alpha', 'beta', 'missing']);
  expect(entries.map((entry) => entry.key)).toEqual(['beta', 'alpha', 'missing']);
});

test('colliding project labels gain enough parent context and full paths remain searchable', () => {
  const entries = buildProjectIndex(undefined, ['/one/team/app', '/two/team/app']);
  expect(entries.map((entry) => entry.label)).toEqual(['one/team/app', 'two/team/app']);
  expect(searchProjects(entries, '/two/').map((entry) => entry.key)).toEqual(['/two/team/app']);
});

test('abbreviations stay useful without fuzzy matches across unrelated parent directories', () => {
  const key = 'github.com/davis/token-tracker';
  const scratch = 'local:/tmp/scratch-v2';
  const entries = buildProjectIndex({
    filters: { projects: [key, scratch] },
    projects: [],
    sessions: [
      session('/source/cache/read/access/toolchain', key),
      session('/teams/project/insights', key),
      session('/versions/2026/token-tracker', key),
      session('/tmp/scratch-v2', scratch, 'Scratch'),
    ],
  });
  for (const query of ['scratch', '/tmp', 'tmp', 'v2'])
    expect(searchProjects(entries, query).map((entry) => entry.key)).toEqual([scratch]);
  for (const query of ['tkn trck', 'ttkr'])
    expect(searchProjects(entries, query).map((entry) => entry.key)).toEqual([key]);
  expect(searchProjects(entries, 'versions/2026').map((entry) => entry.key)).toEqual([key]);
  expect(searchProjects(entries, 'sourcachreadaccess')).toHaveLength(0);
});

test('complete project insights override filtered metrics and retain aliases for unselected projects', () => {
  const active = 'github.com/team/active';
  const other = 'github.com/team/other';
  const entries = buildProjectIndex({
    filters: { projects: [active, other] },
    projects: [{ name: active, ...totals, tokens: 2, costUSD: 0.01 }],
    sessions: [session('/filtered/path', active, 'Filtered name', '2026-10-30T09:00:00Z')],
    projectInsights: [
      {
        name: active,
        tokens: 5_000,
        costUSD: 50,
        sessions: 5,
        unpricedTokens: 10,
        paths: ['/complete/active'],
        projectNames: ['Complete project'],
        lastActiveAt: '2026-10-30T11:00:00Z',
      },
      {
        name: other,
        tokens: 8_000,
        costUSD: 80,
        sessions: 8,
        unpricedTokens: 0,
        paths: ['/work/other-insights'],
        projectNames: ['Revenue analysis'],
        lastActiveAt: '2026-10-30T12:00:00Z',
      },
    ],
  });
  expect(entries.find((entry) => entry.key === active)).toMatchObject({
    paths: ['/complete/active'],
    projectNames: ['Complete project'],
    metrics: { tokens: 5_000, costUSD: 50, sessions: 5, unpricedTokens: 10 },
    lastActiveAt: '2026-10-30T11:00:00Z',
  });
  expect(searchProjects(entries, 'revenue other-insights')[0]?.key).toBe(other);
  expect(searchProjects(entries, '', 'tokens')[0]?.key).toBe(other);
  expect(searchProjects(entries, '', 'recent')[0]?.key).toBe(other);
});

test('an explicitly empty insights context never falls back to query metrics from another scope', () => {
  const entries = buildProjectIndex({
    filters: { projects: ['outside-context'] },
    projects: [{ name: 'outside-context', ...totals }],
    sessions: [],
    projectInsights: [],
  });
  expect(entries[0]?.metrics).toBeUndefined();
});
