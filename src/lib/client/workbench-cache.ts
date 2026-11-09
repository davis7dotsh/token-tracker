import type { UsageQuery } from '../shared/domain';
import { groups } from './usage-workbench';

export const usageScopeKey = (q: UsageQuery) =>
  JSON.stringify([q.range, q.timezone, ...[...groups, 'excludedProjects' as const].map((g) => q[g]?.toSorted())]);

// Per mounted workbench: no disk persistence, cross-login data or stale Settings writes.
// Only completed, recent pages are eligible. A large six-month response can be displayed
// without evicting every useful result or being retained when the user leaves that scope.
export function makeWorkbenchCache<T>(weight: (value: T) => number) {
  const maxWeight = 8 * 1024 * 1024;
  const pages = new Map<string, { value: T; bytes: number; expires: number; day: string }>();
  let bytes = 0;
  const remove = (key: string) => {
    const current = pages.get(key);
    if (current) bytes -= current.bytes;
    pages.delete(key);
  };
  return {
    get(key: string, now = new Date()) {
      const hit = pages.get(key);
      if (!hit) return;
      if (hit.expires <= now.getTime() || hit.day !== now.toDateString()) {
        remove(key);
        return;
      }
      pages.delete(key);
      pages.set(key, hit);
      return hit.value;
    },
    put(key: string, value: T, now = new Date()) {
      remove(key);
      const size = weight(value);
      if (size > maxWeight) return;
      pages.set(key, { value, bytes: size, expires: now.getTime() + 60_000, day: now.toDateString() });
      bytes += size;
      for (const oldest of pages.keys()) {
        if (pages.size <= 8 && bytes <= maxWeight) break;
        remove(oldest);
      }
    },
    clear() {
      bytes = 0;
      pages.clear();
    },
  };
}
