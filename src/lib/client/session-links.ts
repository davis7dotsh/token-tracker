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

export const repositoryWebUrl = (repository: string | null) => {
  if (!repository || repository.startsWith('local:')) return undefined;
  const value = safeWebUrl(`https://${repository}`);
  if (!value) return undefined;
  const url = new URL(value);
  return url.pathname !== '/' && !url.search && !url.hash ? value : undefined;
};

export const projectLabel = (value: string) =>
  value
    .replace(/^local:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-2)
    .join('/') || value;

export const sessionDisplayName = (session: Pick<Session, 'sessionTitle' | 'projectName' | 'repository' | 'project'>) =>
  session.sessionTitle?.trim() || session.projectName?.trim() || projectLabel(session.repository ?? session.project);
