import type { Breakdown, DashboardResponse } from '../shared/domain';
import { projectLabels } from './session-links';

type ProjectData = Pick<DashboardResponse, 'projects' | 'sessions' | 'projectInsights'> & {
  filters: Pick<DashboardResponse['filters'], 'projects'>;
};
export type ProjectSort = 'tokens' | 'cost' | 'recent' | 'name';

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;

export const buildProjectIndex = (data: ProjectData | undefined, extraKeys: readonly string[] = []) => {
  const breakdowns = new Map((data?.projectInsights ?? data?.projects ?? []).map((row) => [row.name, row]));
  const metadata = new Map<
    string,
    {
      paths: Set<string>;
      names: Set<string>;
      repository: string | null;
      lastActiveAt: string | undefined;
      lastActiveMillis: number;
    }
  >();
  for (const session of data?.sessions ?? []) {
    const key = session.repository ?? session.project;
    let entry = metadata.get(key);
    if (!entry) {
      entry = {
        paths: new Set(),
        names: new Set(),
        repository: session.repository,
        lastActiveAt: undefined,
        lastActiveMillis: -Infinity,
      };
      metadata.set(key, entry);
    }
    entry.paths.add(session.project);
    if (session.projectName?.trim()) entry.names.add(session.projectName.trim());
    const millis = Date.parse(session.lastActiveAt);
    if (millis > entry.lastActiveMillis) {
      entry.lastActiveAt = session.lastActiveAt;
      entry.lastActiveMillis = millis;
    }
  }
  for (const insight of data?.projectInsights ?? []) {
    const millis = insight.lastActiveAt ? Date.parse(insight.lastActiveAt) : -Infinity;
    metadata.set(insight.name, {
      paths: new Set(insight.paths),
      names: new Set(insight.projectNames.map((name) => name.trim()).filter(Boolean)),
      repository: metadata.get(insight.name)?.repository ?? null,
      lastActiveAt: insight.lastActiveAt,
      lastActiveMillis: Number.isFinite(millis) ? millis : -Infinity,
    });
  }
  const keys = new Set([...(data?.filters.projects ?? []), ...breakdowns.keys(), ...metadata.keys(), ...extraKeys]);
  const labels = projectLabels([...keys]);
  return [...keys].map((key) => {
    const label = labels.get(key) || 'Unknown project';
    const details = metadata.get(key);
    const paths = [...(details?.paths ?? [])];
    const projectNames = [...(details?.names ?? [])];
    const row = breakdowns.get(key);
    // Insights ignore project inclusion/exclusion, so comparisons retain the
    // complete range + other-filter context. Older payloads fall back to the
    // current view's breakdowns. A missing row never implies an all-time zero.
    const metrics: Pick<Breakdown, 'tokens' | 'costUSD' | 'sessions' | 'unpricedTokens'> | undefined = row && {
      tokens: row.tokens,
      costUSD: row.costUSD,
      sessions: row.sessions,
      unpricedTokens: row.unpricedTokens,
    };
    return {
      key,
      label,
      paths,
      projectNames,
      repository: details?.repository ?? null,
      lastActiveAt: details?.lastActiveAt,
      lastActiveMillis: details?.lastActiveMillis ?? -Infinity,
      metrics,
      searchFields: [...new Set([label, key, ...paths, ...projectNames].map(normalize))],
      fuzzyFields: [...new Set([basename(key), ...paths.map(basename), ...projectNames.map(basename)].map(normalize))],
    };
  });
};
export type ProjectEntry = ReturnType<typeof buildProjectIndex>[number];

const substringScore = (field: string, term: string) => {
  if (field === term) return 100;
  if (field.startsWith(term)) return 80;
  const index = field.indexOf(term);
  return index >= 0 ? 60 - Math.min(index, 20) : -1;
};

const fuzzyScore = (field: string, term: string) => {
  // Short terms and paths require literal matches. Abbreviations only search
  // actual names/basenames, never letters scattered across parent directories.
  if (term.length < 3 || /[\\/]/.test(term)) return -1;
  let best = -1;
  for (let start = field.indexOf(term[0]); start >= 0; start = field.indexOf(term[0], start + 1)) {
    let cursor = start + 1;
    for (let index = 1; index < term.length; index++) {
      cursor = field.indexOf(term[index], cursor);
      if (cursor < 0) break;
      cursor++;
    }
    if (cursor < 0) break;
    const span = cursor - start;
    if (span <= term.length * 3 + 1) best = Math.max(best, 10 + term.length / span);
  }
  return best;
};

const compareProjects = (left: ProjectEntry, right: ProjectEntry, sort: ProjectSort) => {
  const difference =
    sort === 'tokens'
      ? (right.metrics?.tokens ?? -1) - (left.metrics?.tokens ?? -1)
      : sort === 'cost'
        ? (right.metrics?.costUSD ?? -1) - (left.metrics?.costUSD ?? -1)
        : sort === 'recent'
          ? right.lastActiveMillis - left.lastActiveMillis
          : 0;
  return difference || left.label.localeCompare(right.label) || left.key.localeCompare(right.key);
};

export const searchProjects = (entries: readonly ProjectEntry[], text: string, sort: ProjectSort = 'tokens') => {
  const query = normalize(text.trim());
  if (!query) return [...entries].sort((left, right) => compareProjects(left, right, sort));
  const terms = query.split(/\s+/);
  return entries
    .map((entry) => {
      let score = 0;
      for (const term of terms) {
        const literal = entry.searchFields.reduce((maximum, field, index) => {
          const match = substringScore(field, term);
          return match < 0 ? maximum : Math.max(maximum, match + (index === 0 ? 20 : 0));
        }, -1);
        const best =
          literal >= 0
            ? literal
            : entry.fuzzyFields.reduce((maximum, field) => Math.max(maximum, fuzzyScore(field, term)), -1);
        if (best < 0) return { entry, score: -1 };
        score += best;
      }
      if (entry.searchFields.some((field) => field.includes(query))) score += 50;
      return { entry, score };
    })
    .filter((match) => match.score >= 0)
    .sort((left, right) => right.score - left.score || compareProjects(left.entry, right.entry, sort))
    .map((match) => match.entry);
};
