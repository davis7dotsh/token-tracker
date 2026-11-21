import type { Session } from '../shared/domain';
import { projectLabel, projectLabels } from '../shared/project-label';

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

// Build a first-party link from the opaque ID, not an API-supplied redirect or share token.
export const cursorAgentUrl = (session: Pick<Session, 'harness' | 'id'>) =>
  session.harness === 'cursor' && /^[a-zA-Z0-9_-]{1,256}$/.test(session.id)
    ? `https://cursor.com/agents/${session.id}`
    : undefined;

export const repositoryWebUrl = (repository: string | null) => {
  if (!repository || repository.startsWith('local:')) return undefined;
  const value = safeWebUrl(`https://${repository}`);
  if (!value) return undefined;
  const url = new URL(value);
  return url.pathname !== '/' && !url.search && !url.hash ? value : undefined;
};

export { projectLabel, projectLabels };

export const sessionDisplayName = (
  session: Pick<Session, 'sessionTitle' | 'projectName' | 'project'> & { repository?: string | null },
) => session.sessionTitle?.trim() || session.projectName?.trim() || projectLabel(session.repository ?? session.project);
