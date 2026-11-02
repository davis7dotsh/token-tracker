import { describe, expect, test } from 'bun:test';
import { CursorApiError, fetchCursorUsage } from '../../src/lib/cursor/cloud';

const first = '2026-05-04T12:30:00.000Z';
const later = '2026-05-05T12:30:00.000Z';
const secretText = 'not-for-the-snapshot';
const agent = (id: string, type = 'cloud') => ({ id, name: secretText, createdAt: first, env: { type } });
const run = (id: string) => ({ id, agentId: 'bc-a', createdAt: later, result: secretText });
const usage = (inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
});
const agents = '/v1/agents?limit=100&includeArchived=true';
const details = '/v1/agents/bc-a/usage';
const runs = '/v1/agents/bc-a/runs?limit=100';
const mockApi = (routes: Record<string, unknown>) => {
  const paths: string[] = [];
  const request = (url: URL, init: RequestInit) => {
    expect(url.origin).toBe('https://api.cursor.com');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture');
    const path = url.pathname + url.search;
    paths.push(path);
    if (!Object.hasOwn(routes, path)) throw new Error(`unexpected request: ${path}`);
    return Promise.resolve(Response.json(routes[path]));
  };
  return { request, paths };
};

describe('Cursor cloud accounting', () => {
  test('follows agent and run pages; counts disjoint cache buckets, archived agents and only the extra usage', async () => {
    const next = 'opaque+/token';
    const routes = {
      [agents]: { items: [agent('bc-a'), agent('bc-host', 'machine')], nextCursor: next },
      [`${agents}&cursor=opaque%2B%2Ftoken`]: { items: [agent('bc-a'), { ...agent('bc-b'), status: 'ARCHIVED' }] },
      [runs]: { items: [run('one')], nextCursor: 'page2' },
      [`${runs}&cursor=page2`]: { items: [run('two')] },
      [details]: {
        totalUsage: usage(6, 5, 5, 7),
        runs: [
          { id: 'one', usage: usage(2, 3, 1, 3) },
          { id: 'two', usage: usage(4, 1, 4, 2) },
        ],
      },
      '/v1/agents/bc-b/usage': { totalUsage: usage(0, 0, 0, 0), runs: [{ id: 'waiting', usage: usage(0, 0, 0, 0) }] },
    };
    const api = mockApi(routes);
    const completed: number[] = [];
    const parsed = await fetchCursorUsage('fixture', { ...api, onAgentComplete: (n) => completed.push(n) });
    expect(completed).toEqual([1, 2]);
    expect(parsed.agentIds).toEqual(['bc-a', 'bc-b']);
    expect(api.paths).toHaveLength(6);
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[0]).toMatchObject({
      id: 'cursor:bc-a:run:one',
      sessionId: 'bc-a',
      timestamp: later,
      harness: 'cursor',
      inputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 3,
      model: 'cursor/unknown',
      costKnown: false,
      requests: 0,
    });
    expect(parsed.events[2]).toMatchObject({
      id: 'cursor:bc-a:unattributed',
      timestamp: first,
      inputTokens: 0,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 2,
    });
    expect(JSON.stringify(parsed)).not.toContain(secretText);
    const update = mockApi({
      ...routes,
      [details]: { totalUsage: usage(7, 3, 1, 3), runs: [{ id: 'one', usage: usage(7, 3, 1, 3) }] },
    });
    const fresh = await fetchCursorUsage('fixture', update);
    expect(fresh.events.map((e) => [e.id, e.inputTokens])).toEqual([[parsed.events[0].id, 7]]);
  });

  test('rejects inconsistent counts, missing run dates and unsafe agent IDs without publishing partial results', async () => {
    const valid = usage(1, 0, 0, 0);
    for (const response of [
      { totalUsage: { ...valid, totalTokens: 0 }, runs: [] },
      { totalUsage: valid, runs: [{ id: 'one', usage: { ...valid, cacheReadTokens: -1 } }] },
      { totalUsage: valid, runs: [{ id: 'one', usage: usage(2, 0, 0, 0) }] },
      { totalUsage: valid, runs: [{ id: 'missing', usage: valid }] },
    ]) {
      const api = mockApi({
        [agents]: { items: [agent('bc-a')] },
        [details]: response,
        [runs]: { items: [run('one')] },
      });
      expect(fetchCursorUsage('fixture', api)).rejects.toThrow('inconsistent or unsupported');
    }
    const api = mockApi({ [agents]: { items: [agent('../bad/secret')] } });
    expect(fetchCursorUsage('fixture', api)).rejects.toThrow(CursorApiError);
    expect(api.paths).toEqual([agents]);
  });

  test('handles repeat cursors, rate limits, denied auth and sensitive transport diagnostics', async () => {
    const repeated = { items: [], nextCursor: 'same' };
    expect(
      fetchCursorUsage('fixture', mockApi({ [agents]: repeated, [`${agents}&cursor=same`]: repeated })),
    ).rejects.toThrow(CursorApiError);
    let attempts = 0;
    const waits: number[] = [];
    const result = await fetchCursorUsage('fixture', {
      onRateLimit: (wait) => waits.push(wait),
      request: async () =>
        ++attempts === 1
          ? new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
          : Response.json({ items: [] }),
    });
    expect(attempts).toBe(2);
    expect(waits).toEqual([0]);
    expect(result.events).toEqual([]);
    expect(
      fetchCursorUsage('fixture', { request: async () => new Response(secretText, { status: 401 }) }),
    ).rejects.toThrow('Check your personal API key');
    let reads = 0;
    let lists = 0;
    const retries: string[] = [];
    const imported = await fetchCursorUsage('fixture', {
      onRetry: (reason) => retries.push(reason),
      request: async (url) => {
        if (url.pathname === '/v1/agents') {
          lists++;
          return Response.json({ items: [agent('bc-a')] });
        }
        if (++reads === 1) throw new Error(secretText);
        return Response.json({ totalUsage: usage(0, 0, 0, 0), runs: [] });
      },
    });
    expect(imported.agentIds).toEqual(['bc-a']);
    expect([lists, reads]).toEqual([1, 2]);
    expect(retries).toEqual(['connection or response interrupted']);
  });
});
