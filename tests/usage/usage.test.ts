import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BunServices } from '@effect/platform-bun';
import { Effect, Schema } from 'effect';
import { DashboardResponse, type UsageEvent, type UsageResult } from '../../src/lib/shared/domain';
import {
  buildDashboard,
  canonicalRepository,
  collectUsage,
  resolveRepository,
  tokenTotal,
} from '../../src/lib/server/usage';
import { deduplicate, parseCodex, parsePi } from '../../src/lib/server/usage/parsers';
import { estimateCost } from '../../src/lib/server/usage/pricing';

const fixture = (name: string) => readFile(join(import.meta.dir, 'testdata', name), 'utf8');
const temporary: string[] = [];
const temporaryHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-tracker-usage-'));
  temporary.push(home);
  return home;
};
const writeLog = async (home: string, relative: string, contents: string) => {
  const file = join(home, relative);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, contents);
  return file;
};
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'event',
  timestamp: '2026-10-03T10:00:00.000Z',
  harness: 'codex',
  model: 'gpt-6.1-sol',
  project: '/work/app',
  repository: null,
  sessionId: 'one',
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 5,
  cacheWriteTokens: 0,
  reasoningTokens: 1,
  costUsd: 0.01,
  costKnown: true,
  ...overrides,
});
const result = (events: UsageEvent[]): UsageResult => ({
  events,
  sources: [],
  warnings: [],
  pricingUpdatedAt: '2026-10-02',
});

describe('accounting adapters', () => {
  test('Claude streaming and copied files deduplicate while cache TTL costs and privacy survive', async () => {
    const home = await temporaryHome();
    const contents = await fixture('claude.jsonl');
    await writeLog(home, '.claude/projects/alpha/session.jsonl', contents);
    await writeLog(home, '.claude/projects/backup/session.jsonl', contents);
    const usage = await Effect.runPromise(
      collectUsage({
        home,
        claudeDirs: [join(home, '.claude')],
        codexDirs: [],
        piDirs: [],
        deviceId: 'fixture-machine',
      }).pipe(Effect.provide(BunServices.layer)),
    );
    expect(usage.events).toHaveLength(3);
    expect(usage.events[0]).toMatchObject({
      inputTokens: 2,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      outputTokens: 9,
      reasoningTokens: 3,
      deviceId: 'fixture-machine',
      costKnown: true,
    });
    expect(usage.events[0].costUsd).toBeCloseTo(0.000835, 12);
    expect(usage.sources[0]).toMatchObject({ files: 2, events: 3, status: 'ready' });
    expect(JSON.stringify(usage)).not.toContain('private-prompt');
    expect(JSON.stringify(usage)).not.toContain('private-reply');
  });

  test('Codex legacy counter deltas, duplicate totals, resets, clamps and model changes preserve 525 tokens', async () => {
    const entries = deduplicate([parseCodex(await fixture('codex-legacy.jsonl'), 'legacy.jsonl')]);
    expect(entries).toHaveLength(4);
    expect(
      entries.map(({ event: e }) => [
        e.inputTokens,
        e.cacheReadTokens,
        e.cacheWriteTokens,
        e.outputTokens,
        e.reasoningTokens,
      ]),
    ).toEqual([
      [20, 60, 20, 20, 10],
      [50, 140, 10, 40, 10],
      [10, 30, 10, 10, 4],
      [0, 100, 0, 5, 5],
    ]);
    expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(525);
    expect(entries[1].event).toMatchObject({ model: 'gpt-5.6-sol', project: '/work/beta' });
  });

  test('Codex responses remain authoritative across fork metadata, archives and out-of-order turn models', async () => {
    const contents = await fixture('codex-modern.jsonl');
    const entries = deduplicate([
      parseCodex(contents, '/sessions/child.jsonl'),
      parseCodex(contents, '/archive/copied.jsonl'),
    ]);
    expect(entries).toHaveLength(3);
    expect(entries.map(({ event: e }) => e.sessionId)).toEqual(['codex-child', 'codex-child', 'codex-child']);
    expect(entries.map(({ event: e }) => e.model)).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6-astra']);
    expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(385);
    expect(entries.every(({ event: e }) => e.project === '/work/child')).toBe(true);
  });

  test('remote compaction adds request usage without suppressing later cumulative requests', () => {
    const records = [
      { type: 'session_meta', timestamp: '2026-10-01T10:00:00Z', payload: { id: 'compact' } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      {
        type: 'event_msg',
        timestamp: '2026-10-01T10:00:01Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } },
      },
      {
        type: 'token_usage_record',
        timestamp: '2026-10-01T10:00:02Z',
        payload: {
          response_id: 'remote-compaction',
          model: 'gpt-6-astra',
          usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30 },
        },
      },
      { type: 'compacted', payload: { compaction_response_id: 'remote-compaction' } },
      {
        type: 'event_msg',
        timestamp: '2026-10-01T10:00:04Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150, output_tokens: 30 } } },
      },
      {
        type: 'token_usage_record',
        timestamp: '2026-10-01T10:00:05Z',
        payload: { response_id: 'unmatched-record', usage: { input_tokens: 999, output_tokens: 999 } },
      },
    ];
    const entries = deduplicate([
      parseCodex(records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'compact.jsonl'),
    ]).sort((left, right) => left.event.timestamp.localeCompare(right.event.timestamp));
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => tokenTotal(entry.event))).toEqual([120, 330, 60]);
    expect(entries.map((entry) => entry.event.model)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
  });

  test('local compaction already covered by an advancing snapshot retains native ID and counts once', () => {
    const records = [
      { type: 'session_meta', timestamp: '2026-10-01T10:00:00Z', payload: { id: 'compact' } },
      {
        type: 'event_msg',
        timestamp: '2026-10-01T10:00:01Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } },
      },
      {
        type: 'token_usage_record',
        timestamp: '2026-10-01T10:00:02Z',
        payload: {
          response_id: 'local-compaction',
          usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30 },
          thread_token_usage: { input_tokens: 400, cached_input_tokens: 200, output_tokens: 50 },
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-10-01T10:00:03Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 400, cached_input_tokens: 200, output_tokens: 50 },
            last_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30 },
          },
        },
      },
      { type: 'compacted', payload: { compaction_response_id: 'local-compaction' } },
    ];
    const entries = deduplicate([
      parseCodex(records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'compact.jsonl'),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(450);
    expect(entries[1].event.id).toBe('codex:response:local-compaction');
  });

  test('a compaction marker before its record counts once and copied responses deduplicate', () => {
    const records = [
      { type: 'session_meta', timestamp: '2026-10-01T10:00:00Z', payload: { id: 'compact' } },
      { type: 'compacted', payload: { compaction_response_id: 'out-of-order' } },
      {
        type: 'token_usage_record',
        timestamp: '2026-10-01T10:00:02Z',
        payload: { response_id: 'out-of-order', usage: { input_tokens: 300, output_tokens: 30 } },
      },
    ];
    const contents = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    const entries = deduplicate([parseCodex(contents, 'session.jsonl'), parseCodex(contents, 'copied.jsonl')]);
    expect(entries).toHaveLength(1);
    expect(tokenTotal(entries[0].event)).toBe(330);
  });

  test('Pi input excludes cache and unknown models retain token totals without guessed prices', async () => {
    const entries = deduplicate([parsePi(await fixture('pi.jsonl'), 'pi.jsonl')]);
    expect(entries).toHaveLength(2);
    expect(tokenTotal(entries[0].event)).toBe(180);
    expect(estimateCost(entries[0].event).costKnown).toBe(true);
    expect(estimateCost(entries[1].event)).toEqual({ costUsd: 0, costKnown: false });
  });

  test('long context, native aliases and unavailable priority prices never silently borrow rates', () => {
    const e = event({ inputTokens: 200_000, cacheReadTokens: 100_000, outputTokens: 100 });
    expect(estimateCost(e, 0, 'standard').costUsd).toBeCloseTo(0.8215, 12);
    expect(estimateCost(e, 0, 'priority').costUsd).toBeCloseTo(1.643, 12);
    expect(estimateCost(event({ model: 'grok-4.6' })).costKnown).toBe(true);
    expect(estimateCost(event({ model: 'quasar-alpha' })).costKnown).toBe(false);
    expect(estimateCost(event({ model: 'claude-fable-5-1' }), 0, 'priority').costKnown).toBe(false);
  });

  test('a malformed complete record is reported without leaking content; an unfinished append is ignored', async () => {
    const home = await temporaryHome();
    const contents =
      '{"type":"assistant","timestamp":"2026-10-01T00:00:00Z","message":{"id":"one","model":"claude-fable-5-1","usage":{"input_tokens":1,"output_tokens":2}}}\n{private-corrupt-content}\n{"type":"assistant"';
    await writeLog(home, 'claude/projects/one.jsonl', contents);
    const usage = await Effect.runPromise(
      collectUsage({ home, claudeDirs: [join(home, 'claude')], codexDirs: [], piDirs: [] }).pipe(
        Effect.provide(BunServices.layer),
      ),
    );
    expect(usage.events).toHaveLength(1);
    expect(usage.sources[0].status).toBe('partial');
    expect(usage.sources[0].error).toContain('1 malformed');
    expect(JSON.stringify(usage)).not.toContain('private-corrupt-content');
  });

  test('canonical repositories merge HTTPS/SSH clones and linked worktrees without credentials', async () => {
    expect(canonicalRepository('https://user:password@github.com/Davis7/App.git')).toBe('github.com/davis7/app');
    expect(canonicalRepository('git@github.com:Davis7/App.git')).toBe('github.com/davis7/app');
    const home = await temporaryHome();
    await writeLog(home, 'app/.git/config', '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
    await writeLog(home, 'app/.git/worktrees/feature/commondir', '../..\n');
    await writeLog(home, 'feature/.git', 'gitdir: ../app/.git/worktrees/feature\n');
    const repo = await Effect.runPromise(
      resolveRepository(join(home, 'feature')).pipe(Effect.provide(BunServices.layer)),
    );
    expect(repo).toBe('github.com/davis7/app');
  });
});

describe('dashboard aggregation', () => {
  test('the default is a rolling 30-day machine report; future events and old events are excluded', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const response = buildDashboard(
      result([
        event({ timestamp: '2026-09-03T12:00:00Z' }),
        event({ timestamp: '2026-09-03T11:59:59Z', inputTokens: 999 }),
        event({ timestamp: '2026-10-03T12:00:01Z', inputTokens: 999 }),
      ]),
      {},
      now,
      'machine',
    );
    expect(response.range).toBe('30d');
    expect(response.totals.tokens).toBe(17);
    expect(response.daily.reduce((sum, day) => sum + day.tokens, 0)).toBe(response.totals.tokens);
    expect(response.previous?.tokens).toBe(1006);
    expect(Schema.decodeUnknownSync(DashboardResponse)(response).totals.tokens).toBe(17);
  });

  test.each([
    ['spring', '2026-03-08T23:30:00-07:00', 23, '2026-03-08T09:59:59Z', '2026-03-08T10:00:00Z'],
    ['fall', '2026-11-01T23:30:00-08:00', 25, '2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z'],
  ])('%s DST day keeps elapsed hours distinct and conserves tokens and cost', (_name, now, hours, first, second) => {
    const response = buildDashboard(
      result([
        event({ timestamp: first, inputTokens: 11, costUsd: 0.125 }),
        event({ timestamp: second, harness: 'pi', model: 'grok-4.6', inputTokens: 22, costKnown: false, costUsd: 0 }),
      ]),
      { range: 'today', timezone: 'America/Los_Angeles' },
      new Date(now),
    );
    expect(response.hourly).toHaveLength(hours);
    expect(response.hourly[1].tokens).toBe(18);
    expect(response.hourly[2].tokens).toBe(29);
    expect(response.hourly.reduce((sum, hour) => sum + hour.tokens, 0)).toBe(response.totals.tokens);
    expect(response.hourly.reduce((sum, hour) => sum + hour.costUSD, 0)).toBeCloseTo(response.totals.costUSD, 12);
    expect(new Date(response.hourly[2].start).getTime() - new Date(response.hourly[1].start).getTime()).toBe(3_600_000);
    for (const dimension of ['providers', 'models'] as const) {
      expect(response.hourly[1][dimension]).toEqual([
        { name: dimension === 'providers' ? 'openai' : 'gpt-6.1-sol', tokens: 18, costUSD: 0.125, unpricedTokens: 0 },
      ]);
      expect(response.hourly[2][dimension]).toEqual([
        { name: dimension === 'providers' ? 'xai' : 'grok-4.6', tokens: 29, costUSD: 0, unpricedTokens: 29 },
      ]);
      const chart = response.hourly.flatMap((hour) => hour[dimension] ?? []);
      expect(chart.reduce((sum, group) => sum + group.tokens, 0)).toBe(response.totals.tokens);
      expect(chart.reduce((sum, group) => sum + group.costUSD, 0)).toBe(response.totals.costUSD);
      expect(chart.reduce((sum, group) => sum + (group.unpricedTokens ?? 0), 0)).toBe(response.totals.unpricedTokens);
    }
  });

  test('provider and model chart buckets conserve filtered accounting, including missing prices', () => {
    const response = buildDashboard(
      result([
        event({ timestamp: '2026-10-03T10:00:00Z', costUsd: 0.125 }),
        event({ timestamp: '2026-10-03T10:20:00Z', deviceId: 'mac', inputTokens: 20, costUsd: 0.25 }),
        event({
          timestamp: '2026-10-03T11:00:00Z',
          model: 'claude-fable-5-1',
          harness: 'claude',
          inputTokens: 30,
          costUsd: 0.5,
        }),
        event({ timestamp: '2026-10-03T11:20:00Z', model: 'grok-4.6', harness: 'pi', inputTokens: 40, costUsd: 0.125 }),
        event({
          timestamp: '2026-10-03T11:30:00Z',
          model: 'xai/grok-4.6',
          harness: 'pi',
          inputTokens: 50,
          costUsd: 0.125,
        }),
        event({
          timestamp: '2026-10-03T11:40:00Z',
          model: 'quasar-alpha',
          inputTokens: 60,
          costKnown: false,
          costUsd: 0,
        }),
        event({ timestamp: '2026-10-03T12:00:01Z', inputTokens: 999 }),
        event({ timestamp: '2026-10-02T23:59:59Z', inputTokens: 999 }),
      ]),
      { range: 'today', timezone: 'UTC' },
      new Date('2026-10-03T12:00:00Z'),
    );
    expect(response.totals).toMatchObject({ tokens: 252, costUSD: 1.125, unpricedTokens: 67 });
    for (const buckets of [response.daily, response.hourly]) {
      for (const bucket of buckets) {
        for (const dimension of ['providers', 'models'] as const) {
          const chart = bucket[dimension] ?? [];
          expect(chart.reduce((sum, group) => sum + group.tokens, 0)).toBe(bucket.tokens);
          expect(chart.reduce((sum, group) => sum + group.costUSD, 0)).toBe(bucket.costUSD);
          expect(chart.reduce((sum, group) => sum + (group.unpricedTokens ?? 0), 0)).toBe(
            bucket.harnesses.reduce((sum, group) => sum + group.unpricedTokens, 0),
          );
        }
      }
      for (const dimension of ['providers', 'models'] as const) {
        for (const group of response[dimension]) {
          const chart = buckets.flatMap((bucket) => bucket[dimension] ?? []).filter(({ name }) => name === group.name);
          expect(chart.reduce((sum, item) => sum + item.tokens, 0)).toBe(group.tokens);
          expect(chart.reduce((sum, item) => sum + item.costUSD, 0)).toBe(group.costUSD);
          expect(chart.reduce((sum, item) => sum + (item.unpricedTokens ?? 0), 0)).toBe(group.unpricedTokens);
        }
      }
    }
    expect(response.daily[0].providers?.find(({ name }) => name === 'xai')).toEqual({
      name: 'xai',
      tokens: 104,
      costUSD: 0.25,
      unpricedTokens: 0,
    });
    expect(Schema.decodeUnknownSync(DashboardResponse)(response).daily[0].models).toEqual(response.daily[0].models);
  });

  test('empty chart buckets retain zero series and older responses can omit chart dimensions', () => {
    const response = buildDashboard(
      result([event()]),
      { range: 'today', models: [] },
      new Date('2026-10-03T12:00:00Z'),
    );
    expect(response.totals.tokens).toBe(0);
    expect(
      [...response.daily, ...response.hourly].every(
        (bucket) => bucket.providers?.length === 0 && bucket.models?.length === 0,
      ),
    ).toBe(true);
    const legacy = {
      ...response,
      daily: response.daily.map(({ date, tokens, costUSD, harnesses }) => ({ date, tokens, costUSD, harnesses })),
      hourly: response.hourly.map(({ start, end, tokens, costUSD, harnesses }) => ({
        start,
        end,
        tokens,
        costUSD,
        harnesses,
      })),
    };
    expect(Schema.decodeUnknownSync(DashboardResponse)(legacy).daily[0].providers).toBeUndefined();
  });

  test('half-hour timezone buckets start at local midnight', () => {
    const response = buildDashboard(
      result([event({ timestamp: '2026-10-02T18:35:00Z' })]),
      { range: 'today', timezone: 'Asia/Kolkata' },
      new Date('2026-10-03T12:00:00+05:30'),
    );
    expect(response.hourly[0].start).toBe('2026-10-02T18:30:00.000Z');
    expect(response.hourly[0].tokens).toBe(17);
  });

  test('six calendar months clamp month-end and explicit empty filters retain zero buckets', () => {
    const data = result([event({ timestamp: '2025-02-28T00:00:00Z' })]);
    const response = buildDashboard(data, { range: '6m' }, new Date('2025-08-30T12:00:00Z'));
    expect(response.period.start).toBe('2025-02-28');
    expect(response.daily).toHaveLength(184);
    const empty = buildDashboard(data, { range: '6m', harnesses: [] }, new Date('2025-08-30T12:00:00Z'));
    expect(empty.daily).toHaveLength(184);
    expect(empty.totals.tokens).toBe(0);
    expect(empty.previous?.tokens).toBe(0);
  });

  test('repository grouping combines machines while sessions and device filtering stay distinct', () => {
    const data = result([
      event({ repository: 'github.com/davis7/app', deviceId: 'linux' }),
      event({ repository: 'github.com/davis7/app', project: '/Users/ben/app', deviceId: 'mac' }),
    ]);
    const response = buildDashboard(data, { projects: ['github.com/davis7/app'] }, new Date('2026-10-03T12:00:00Z'));
    expect(response.projects).toHaveLength(1);
    expect(response.projects[0].tokens).toBe(34);
    expect(response.totals.sessions).toBe(2);
    expect(buildDashboard(data, { devices: ['mac'] }, new Date('2026-10-03T12:00:00Z')).totals.tokens).toBe(17);
  });
});
