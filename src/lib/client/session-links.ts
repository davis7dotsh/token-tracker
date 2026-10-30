import type { Session } from '../shared/domain';

export const safeWebUrl = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};

// Collected web routes end in the owning environment and exact T3 thread ID,
// even when a private web base includes a path prefix. Never use a harness ID.
export const nativeThreadUrl = (session: Pick<Session, 't3ThreadId' | 't3ThreadUrl'>) => {
  const webUrl = safeWebUrl(session.t3ThreadUrl);
  if (!webUrl || !session.t3ThreadId) return undefined;
  try {
    const url = new URL(webUrl);
    if (url.search || url.hash) return undefined;
    const parts = url.pathname.split('/');
    const environment = decodeURIComponent(parts.at(-2) ?? '');
    const thread = decodeURIComponent(parts.at(-1) ?? '');
    const identifier = /^[a-zA-Z0-9:_-]{1,512}$/;
    if (!identifier.test(environment) || !identifier.test(thread) || thread !== session.t3ThreadId) return undefined;
    // Colons are native thread namespace separators, as in mcp:<uuid>.
    return `t3code://threads/${environment}/${thread}`;
  } catch {
    return undefined;
  }
};

export const repositoryWebUrl = (repository: string | null) => {
  if (!repository || repository.startsWith('local:')) return undefined;
  const value = safeWebUrl(`https://${repository}`);
  if (!value) return undefined;
  const url = new URL(value);
  return url.pathname !== '/' && !url.search && !url.hash ? value : undefined;
};

const projectParts = (value: string) =>
  value
    .replace(/^local:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .split(/[\\/]/)
    .filter(Boolean);

export const projectLabel = (value: string) => projectParts(value).slice(-2).join('/') || value;

export const projectLabels = (values: readonly string[]) => {
  const entries = [...new Set(values)].map((key) => ({
    key,
    parts: projectParts(key),
    depth: 2,
    label: projectLabel(key),
  }));
  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const group = groups.get(entry.label);
      if (group) group.push(entry);
      else groups.set(entry.label, [entry]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const expandable = group.filter((entry) => entry.depth < entry.parts.length);
      for (const entry of expandable.length ? expandable : group) {
        if (expandable.length) entry.depth++;
        const label = expandable.length ? entry.parts.slice(-entry.depth).join('/') : entry.key;
        if (entry.label === label) continue;
        entry.label = label;
        changed = true;
      }
    }
  }
  return new Map(entries.map((entry) => [entry.key, entry.label]));
};

export const sessionDisplayName = (session: Pick<Session, 'sessionTitle' | 'projectName' | 'repository' | 'project'>) =>
  session.sessionTitle?.trim() || session.projectName?.trim() || projectLabel(session.repository ?? session.project);
