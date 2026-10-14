import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { deduplicate, parseMuse, tokenTotal } from '../../src/lib/server/usage/parsers';
import { buildDashboard, collectUsage } from '../../src/lib/server/usage';
import { estimateCost } from '../../src/lib/server/usage/pricing';
import { provider } from '../../src/lib/shared/provider';

const micros = (iso: string) => Date.parse(iso) * 1000;
const envelope = (sessionId: string, recordedAt: string, payloadType: string, payload: unknown, id?: string) => ({
  schema_version: 1,
  ...(id ? { id } : {}),
  stream: { kind: 'session', id: sessionId },
  recorded_at: micros(recordedAt),
  record_type: 'event',
  payload_type: payloadType,
  payload,
});
const metadata = (sessionId: string, workspaceRoot?: string, modelId = 'fixture-model') =>
  envelope(sessionId, '2026-10-11T06:40:00.000Z', 'runtime.session.metadata', {
    kind: 'metadata',
    record: {
      model_id: modelId,
      provider_id: 'meta',
      ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
    },
  });
const completed = (
  sessionId: string,
  recordedAt: string,
  usage: Record<string, number>,
  nativeId = 'run-record-1',
  model: string | undefined = 'fixture-model',
) =>
  envelope(
    sessionId,
    recordedAt,
    'runtime.session',
    {
      kind: 'run',
      run_id: 'run-1',
      source_run_record_id: nativeId,
      event: { kind: 'model_completed', ...(model ? { model } : {}), duration_ms: 10, usage },
    },
    `envelope-${nativeId}`,
  );
const goal = (sessionId: string, recordedAt: string, quantity: Record<string, unknown>, family = 'provider') =>
  envelope(sessionId, recordedAt, 'runtime.session', {
    kind: 'run',
    run_id: 'run-1',
    event: {
      kind: 'goal_usage_attribution',
      record: { usage_id: `usage-${recordedAt}`, usage_family: family, quantity },
    },
  });
const contents = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
const sessionFile = (sessionId: string) =>
  `/home/user/.local/share/muse/sessions/2026/10/11/${sessionId}/session.jsonl`;
const usage = {
  input_tokens: 1000,
  output_tokens: 40,
  cached_tokens: 600,
  cache_read_tokens: 600,
  cache_write_tokens: 100,
  reasoning_tokens: 12,
};

describe('Muse accounting', () => {
  test('separates cached input, converts microsecond timestamps, and keeps native identity', () => {
    const parsed = parseMuse(
      contents([metadata('session-1', '/work/app'), completed('session-1', '2026-10-11T06:40:02.811Z', usage)]),
      sessionFile('session-1'),
    );
    expect(parsed.sessionId).toBe('session-1');
    expect(parsed.events).toHaveLength(1);
    const [entry] = parsed.events;
    expect(entry.event).toMatchObject({
      id: 'muse:record:run-record-1',
      harness: 'muse',
      timestamp: '2026-10-11T06:40:02.811Z',
      model: 'fixture-model',
      project: '/work/app',
      inputTokens: 300,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
      outputTokens: 40,
      reasoningTokens: 12,
    });
    expect(tokenTotal(entry.event)).toBe(1040);
  });

  test('paired goal usage rows are not counted a second time', () => {
    const parsed = parseMuse(
      contents([
        metadata('session-1', '/work/app'),
        goal('session-1', '2026-10-11T06:40:02.810Z', {
          input_tokens: 1000,
          output_tokens: 40,
          cached_tokens: 600,
          reasoning_tokens: 12,
          reported: true,
        }),
        completed('session-1', '2026-10-11T06:40:02.811Z', usage),
        goal(
          'session-1',
          '2026-10-11T06:40:02.812Z',
          { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, reported: false },
          'tool',
        ),
      ]),
      sessionFile('session-1'),
    );
    expect(parsed.events).toHaveLength(1);
    expect(tokenTotal(parsed.events[0].event)).toBe(1040);
  });

  test('approval-review streams and zero-token completions produce no events', () => {
    const approval = {
      ...completed('judge-1', '2026-10-11T06:40:02.811Z', usage, 'judge-record'),
      stream: { kind: 'approval.review.runtime', id: 'judge-1' },
    };
    const parsed = parseMuse(
      contents([
        approval,
        completed(
          'session-1',
          '2026-10-11T06:40:03.000Z',
          {
            ...usage,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
          'empty',
        ),
      ]),
      '/home/user/.local/share/muse/sessions/2026/10/11/session-1/approval-review/judge-1.jsonl',
    );
    expect(parsed.events).toEqual([]);
    expect(parsed.malformed).toBe(0);
  });

  test('a completion without a usable timestamp is malformed, not silently dated', () => {
    const broken = completed('session-1', '2026-10-11T06:40:02.811Z', usage);
    const parsed = parseMuse(`${contents([{ ...broken, recorded_at: 'not-a-time' }])}\n`, sessionFile('session-1'));
    expect(parsed.events).toEqual([]);
    expect(parsed.malformed).toBe(1);
  });

  test('out-of-range finite timestamps are malformed rather than throwing', () => {
    const broken = completed('session-1', '2026-10-11T06:40:02.811Z', usage);
    const parsed = parseMuse(`${contents([{ ...broken, recorded_at: 1e30 }])}\n`, sessionFile('session-1'));
    expect(parsed.events).toEqual([]);
    expect(parsed.malformed).toBe(1);
  });

  test('nanosecond-scale timestamps normalize to the same instant', () => {
    const row = completed('session-1', '2026-10-11T06:40:02.811Z', usage);
    const parsed = parseMuse(
      contents([{ ...row, recorded_at: micros('2026-10-11T06:40:02.811Z') * 1000 }]),
      sessionFile('session-1'),
    );
    expect(parsed.events[0]?.event.timestamp).toBe('2026-10-11T06:40:02.811Z');
  });

  test('retained frame children are unwrapped and copied files deduplicate by native record', () => {
    const row = completed('session-1', '2026-10-11T06:40:02.811Z', usage);
    const framed = parseMuse(
      contents([
        {
          retained_frame: 'transaction',
          children: [
            { child_index: 0, record_json: JSON.stringify(row) },
            { child_index: 1, record_json: '{broken' },
          ],
        },
      ]),
      sessionFile('session-1'),
    );
    expect(framed.malformed).toBe(1);
    const plain = parseMuse(contents([metadata('session-1', '/work/app'), row]), sessionFile('session-1'));
    const entries = deduplicate([framed, plain]);
    expect(entries).toHaveLength(1);
    expect(entries[0].event.id).toBe('muse:record:run-record-1');
  });

  test('retained frame completions without native IDs keep distinct fallback identities', () => {
    const anonymous = (outputTokens: number) =>
      envelope('session-1', '2026-10-11T06:40:02.811Z', 'runtime.session', {
        kind: 'run',
        run_id: 'run-1',
        event: {
          kind: 'model_completed',
          model: 'fixture-model',
          usage: { ...usage, output_tokens: outputTokens },
        },
      });
    const framed = parseMuse(
      contents([
        {
          retained_frame: 'transaction',
          children: [
            { child_index: 0, record_json: JSON.stringify(anonymous(40)) },
            { child_index: 1, record_json: JSON.stringify(anonymous(50)) },
          ],
        },
      ]),
      sessionFile('session-1'),
    );
    expect(framed.events).toHaveLength(2);
    expect(new Set(framed.events.map(({ event }) => event.id)).size).toBe(2);
    expect(deduplicate([framed])).toHaveLength(2);
  });

  test('child sessions inherit the enclosing project', () => {
    const parent = parseMuse(
      contents([
        metadata('session-1', '/work/app'),
        completed('session-1', '2026-10-11T06:40:02.811Z', usage, 'parent-record'),
      ]),
      sessionFile('session-1'),
    );
    const child = parseMuse(
      contents([
        metadata('child-1'),
        completed(
          'child-1',
          '2026-10-11T06:40:04.000Z',
          { ...usage, input_tokens: 200, cached_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
          'child-record',
          undefined,
        ),
      ]),
      '/home/user/.local/share/muse/sessions/2026/10/11/session-1/subagent/child-1/session.jsonl',
    );
    expect(child.parentId).toBe('session-1');
    expect(child.events[0].event).toMatchObject({ project: 'Unknown project', model: 'fixture-model' });
    const entries = deduplicate([child, parent]);
    expect(entries).toHaveLength(2);
    expect(entries.find(({ event }) => event.sessionId === 'child-1')?.event.project).toBe('/work/app');
  });

  test('metadata-only parent sessions pass their workspace to child sessions', () => {
    const parent = parseMuse(contents([metadata('session-1', '/work/app')]), sessionFile('session-1'));
    const child = parseMuse(
      contents([completed('child-1', '2026-10-11T06:40:04.000Z', usage, 'child-record')]),
      '/home/user/.local/share/muse/sessions/2026/10/11/session-1/subagent/child-1/session.jsonl',
    );
    expect(parent.events).toEqual([]);
    expect(parent.workspaceRoot).toBe('/work/app');
    const entries = deduplicate([child, parent]);
    expect(entries).toHaveLength(1);
    expect(entries[0].event.project).toBe('/work/app');
  });

  test('grandchild sessions resolve projects through metadata-only intermediate sessions', () => {
    const parent = parseMuse(contents([metadata('session-1', '/work/app')]), sessionFile('session-1'));
    const child = parseMuse(
      contents([metadata('child-1')]),
      '/home/user/.local/share/muse/sessions/2026/10/11/session-1/subagent/child-1/session.jsonl',
    );
    const grandchild = parseMuse(
      contents([completed('grandchild-1', '2026-10-11T06:40:04.000Z', usage, 'grandchild-record')]),
      '/home/user/.local/share/muse/sessions/2026/10/11/session-1/subagent/child-1/subagent/grandchild-1/session.jsonl',
    );
    expect(child.events).toEqual([]);
    expect(child.workspaceRoot).toBeUndefined();
    expect(grandchild.parentId).toBe('child-1');
    const entries = deduplicate([grandchild, child, parent]);
    expect(entries).toHaveLength(1);
    expect(entries[0].event.project).toBe('/work/app');
  });

  test('family model IDs resolve to Meta and price through the catalog namespace', () => {
    expect(provider('muse-fixture-1.0')).toBe('meta');
    expect(provider('meta/muse-fixture-1.0')).toBe('meta');
    const [entry] = parseMuse(
      contents([
        completed(
          'session-1',
          '2026-10-12T10:00:00.000Z',
          { ...usage, cache_write_tokens: 0 },
          'family-record',
          'muse-fixture-1.0',
        ),
      ]),
      sessionFile('session-1'),
    ).events;
    const cost = estimateCost(entry.event, entry.cacheWrite1h, entry.tier, {
      revision: 'fixture-pricing',
      rules: [],
      catalog: {
        source: 'fixture-pricing',
        updatedAt: '2026-10-12',
        models: {
          'meta/muse-fixture-1.0': {
            input_cost_per_token: 0.000004,
            output_cost_per_token: 0.00002,
            cache_read_input_token_cost: 0.0000002,
          },
        },
      },
    });
    expect(cost.costKnown).toBe(true);
    expect(cost.costUsd).toBeCloseTo(0.00252, 10);
  });
});

describe('Muse collection', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  test('default XDG data location feeds sources, events, and the dashboard', async () => {
    const home = await mkdtemp(join(tmpdir(), 'token-tracker-muse-'));
    temporary.push(home);
    const write = async (relative: string, rows: readonly unknown[]) => {
      const file = join(home, relative);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, contents(rows));
    };
    await write('.local/share/muse/sessions/2026/10/11/session-1/session.jsonl', [
      metadata('session-1', '/work/app'),
      completed('session-1', '2026-10-11T06:40:02.811Z', usage, 'parent-record'),
    ]);
    await write('.local/share/muse/sessions/2026/10/11/session-1/subagent/child-1/session.jsonl', [
      completed('child-1', '2026-10-11T06:40:04.000Z', usage, 'child-record'),
    ]);
    const collected = await Effect.runPromise(
      collectUsage({ home, claudeDirs: [], codexDirs: [], piDirs: [], grokDirs: [], deviceId: 'muse-machine' }).pipe(
        Effect.provide(BunServices.layer),
      ),
    );
    expect(collected.sources.find((source) => source.harness === 'muse')).toMatchObject({
      path: join(home, '.local/share/muse/sessions'),
      files: 2,
      events: 2,
      status: 'ready',
    });
    expect(collected.events).toHaveLength(2);
    expect(collected.events.every((event) => event.harness === 'muse' && event.project === '/work/app')).toBe(true);
    expect(collected.warnings.join('\n')).toContain('fixture-model');

    const dashboard = buildDashboard(
      collected,
      { range: 'all', timezone: 'UTC' },
      new Date('2026-10-12T00:00:00Z'),
      'muse-machine',
    );
    expect(dashboard.harnesses).toEqual([expect.objectContaining({ name: 'muse', tokens: 2080, sessions: 2 })]);
    expect(dashboard.providers).toEqual([expect.objectContaining({ name: 'unknown', tokens: 2080 })]);
    expect(dashboard.totals).toMatchObject({ tokens: 2080, unpricedTokens: 2080, costUSD: 0 });
  });

  test('cached metadata-only parents still provide child projects on warm collection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'token-tracker-muse-cache-'));
    temporary.push(home);
    const cacheDirectory = join(home, 'cache');
    const write = async (relative: string, rows: readonly unknown[]) => {
      const file = join(home, relative);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, contents(rows));
    };
    await write('.local/share/muse/sessions/2026/10/11/session-1/session.jsonl', [metadata('session-1', '/work/app')]);
    await write('.local/share/muse/sessions/2026/10/11/session-1/subagent/child-1/session.jsonl', [
      completed('child-1', '2026-10-11T06:40:04.000Z', usage, 'child-record'),
    ]);
    const collect = () =>
      Effect.runPromise(
        collectUsage({
          home,
          cacheDirectory,
          claudeDirs: [],
          codexDirs: [],
          piDirs: [],
          grokDirs: [],
          deviceId: 'muse-machine',
        }).pipe(Effect.provide(BunServices.layer)),
      );
    const first = await collect();
    const warm = await collect();
    expect(first.events).toHaveLength(1);
    expect(first.events[0].project).toBe('/work/app');
    expect(warm.events).toEqual(first.events);
  });
});
