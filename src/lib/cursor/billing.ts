import { parse } from 'csv-parse/sync';
import type { UsageEvent } from '../shared/domain';

const columns = ['Product', 'Charge Category', 'Billing Item ID', 'Event Time', 'Model', 'Usage'] as const;
const buckets = new Map<string, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'>([
  ['prompt-text-tokens', 'inputTokens'],
  ['cached-prompt-text-tokens', 'cacheReadTokens'],
  ['cache-write-text-tokens', 'cacheWriteTokens'],
  ['completion-text-tokens', 'outputTokens'],
]);

export function parseCursorBilling(csv: string) {
  // Do not propagate csv-parse diagnostics: they can include raw account rows.
  let records: string[][];
  try {
    records = parse(csv, { bom: true, skip_empty_lines: true });
  } catch {
    throw new Error('Invalid unified usage CSV. No rows were imported.');
  }
  const [header, ...rows] = records;
  if (!header || !columns.every((name) => header.includes(name)) || new Set(header).size !== header.length)
    throw new Error('Expected a personal unified usage CSV with billing IDs and token counters.');
  const indexes = columns.map((name) => header.indexOf(name));
  const events = new Map<string, UsageEvent>();
  for (const [i, row] of rows.entries()) {
    const [product, category, item, time, model, text] = indexes.map((index) => row[index]);
    if (product !== 'cursor' || category !== 'usage') continue;
    const invalid = () => new Error(`Invalid or unsupported Cursor billing record ${i + 1}. Nothing was imported.`);
    if (
      !/^[a-z0-9_-]{1,200}$/i.test(item) ||
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(time) ||
      !Number.isFinite(Date.parse(time))
    )
      throw invalid();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
    const counts = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    const entries = Object.entries(parsed);
    if (!entries.length) throw invalid();
    for (const [name, raw] of entries) {
      const bucket = buckets.get(name);
      if (
        !bucket ||
        !((typeof raw === 'string' && /^\d+$/.test(raw)) || typeof raw === 'number') ||
        !Number.isSafeInteger(Number(raw)) ||
        Number(raw) < 0
      )
        throw invalid();
      counts[bucket] = Number(raw);
    }
    const id = `cursor:billing-item:${item}`;
    const event: UsageEvent = {
      id,
      timestamp: new Date(time).toISOString(),
      harness: 'cursor',
      model: model.trim() || 'cursor/unknown',
      project: 'Cursor billing',
      repository: null,
      sessionId: '',
      requests: 0,
      reasoningTokens: 0,
      costKnown: false,
      costUsd: 0,
      ...counts,
    };
    const previous = events.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw invalid();
    events.set(id, event);
  }
  if (!events.size) throw new Error('No Cursor usage items in this report. The existing history was not changed.');
  return [...events.values()];
}
