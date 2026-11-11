import { projectLabel } from './project-label';
import type { Session, SessionSort } from './domain';

// Effect-free so the browser bundle can share it; domain.ts builds the schema.
export const sessionSortKeys = ['active', 'started', 'project', 'model', 'device', 'tokens', 'cost'] as const;
export type { SessionSort };
export type SessionSortKey = SessionSort['by'];

// The hub's natural order: most recently active first.
export const defaultSessionSort: SessionSort = { by: 'active', order: 'desc' };
export const isDefaultSessionSort = (sort: SessionSort | undefined) =>
  !sort || (sort.by === defaultSessionSort.by && sort.order === defaultSessionSort.order);
// Text columns read naturally A→Z; dates and amounts largest first.
export const initialOrder = (by: SessionSortKey): SessionSort['order'] =>
  by === 'project' || by === 'model' || by === 'device' ? 'asc' : 'desc';

const text = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const value = (by: SessionSortKey, s: Session, device: (id: string) => string): string | number => {
  switch (by) {
    case 'active':
      return s.lastActiveAt;
    case 'started':
      return s.startedAt;
    case 'project':
      return projectLabel(s.repository ?? s.project);
    case 'model':
      return s.model;
    case 'device':
      return device(s.deviceId);
    case 'tokens':
      return s.tokens;
    case 'cost':
      return s.costUSD;
  }
};

export const sortSessions = (
  sessions: readonly Session[],
  sort: SessionSort,
  device: (id: string) => string = (id) => id,
) => {
  const sign = sort.order === 'asc' ? 1 : -1;
  return sessions
    .map((s) => ({ s, v: value(sort.by, s, device) }))
    .sort((a, b) => {
      const d =
        typeof a.v === 'number' && typeof b.v === 'number'
          ? a.v - b.v
          : sort.by === 'active' || sort.by === 'started'
            ? String(a.v).localeCompare(String(b.v))
            : text.compare(String(a.v), String(b.v));
      // Ties fall back to recency so paging stays stable.
      return sign * d || b.s.lastActiveAt.localeCompare(a.s.lastActiveAt) || a.s.id.localeCompare(b.s.id);
    })
    .map(({ s }) => s);
};
