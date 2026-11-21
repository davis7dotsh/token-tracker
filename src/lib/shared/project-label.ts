export const projectParts = (value: string) =>
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
