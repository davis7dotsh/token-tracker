import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { buildDashboard, collectUsage, tokenTotal } from '../../src/lib/server/usage';
import { parseAntigravityDatabase } from '../../src/lib/server/usage/antigravity';
import { decodeModelUsageStats, decodeStepMetadata } from '../../src/lib/server/usage/antigravity-proto';
import { estimateCost } from '../../src/lib/server/usage/pricing';
import { usageRevision } from '../../src/lib/server/usage/revision';

const encoder = new TextEncoder();
const temporary: string[] = [];

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const concat = (parts: readonly Uint8Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const varint = (value: number | bigint) => {
  let n = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0n);
  return new Uint8Array(bytes);
};

const fieldVarint = (field: number, value: number | bigint) => concat([varint((field << 3) | 0), varint(value)]);
const fieldBytes = (field: number, bytes: Uint8Array) =>
  concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
const fieldString = (field: number, value: string) => fieldBytes(field, encoder.encode(value));

const encodeTimestamp = (iso: string) => {
  const ms = Date.parse(iso);
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1_000_000;
  return concat([fieldVarint(1, seconds), ...(nanos ? [fieldVarint(2, nanos)] : [])]);
};

const encodeUsage = (usage: {
  modelEnum?: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  thinkingOutputTokens?: number;
  responseOutputTokens?: number;
  messageId?: string;
  responseId?: string;
  serviceTier?: string;
  extraFields?: Uint8Array[];
}) =>
  concat([
    ...(usage.modelEnum ? [fieldVarint(1, usage.modelEnum)] : []),
    fieldVarint(2, usage.inputTokens),
    fieldVarint(3, usage.outputTokens),
    ...(usage.cacheWriteTokens ? [fieldVarint(4, usage.cacheWriteTokens)] : []),
    ...(usage.cacheReadTokens ? [fieldVarint(5, usage.cacheReadTokens)] : []),
    ...(usage.thinkingOutputTokens ? [fieldVarint(9, usage.thinkingOutputTokens)] : []),
    ...(usage.responseOutputTokens ? [fieldVarint(10, usage.responseOutputTokens)] : []),
    ...(usage.messageId
      ? [fieldString(7, usage.messageId)]
      : usage.responseId
        ? [fieldString(7, usage.responseId)]
        : []),
    ...(usage.responseId ? [fieldString(11, usage.responseId)] : []),
    ...(usage.serviceTier ? [fieldString(13, usage.serviceTier)] : []),
    ...(usage.extraFields ?? []),
  ]);

const encodeGenMetadata = (input: {
  modelEnum?: number;
  responseModel?: string;
  usage: Parameters<typeof encodeUsage>[0];
  stepIndices?: number[];
  executionId?: string;
  extraChatFields?: Uint8Array[];
}) => {
  const chatModel = concat([
    ...(input.modelEnum ? [fieldVarint(3, input.modelEnum)] : []),
    fieldBytes(4, encodeUsage(input.usage)),
    ...(input.responseModel ? [fieldString(19, input.responseModel)] : []),
    ...(input.extraChatFields ?? []),
  ]);
  const packedSteps = input.stepIndices?.length ? [fieldBytes(2, concat(input.stepIndices.map(varint)))] : [];
  return concat([
    fieldBytes(1, chatModel),
    ...packedSteps,
    ...(input.executionId ? [fieldString(4, input.executionId)] : []),
  ]);
};

const encodeStepMetadata = (input: {
  createdAt?: string;
  completedAt?: string;
  modelUsage?: Parameters<typeof encodeUsage>[0];
  rawModelUsage?: Uint8Array;
  generatorModelEnum?: number;
  executionId?: string;
  extraFields?: Uint8Array[];
}) =>
  concat([
    ...(input.createdAt ? [fieldBytes(1, encodeTimestamp(input.createdAt))] : []),
    ...(input.completedAt ? [fieldBytes(8, encodeTimestamp(input.completedAt))] : []),
    ...(input.modelUsage ? [fieldBytes(9, encodeUsage(input.modelUsage))] : []),
    ...(input.rawModelUsage ? [fieldBytes(9, input.rawModelUsage)] : []),
    ...(input.generatorModelEnum ? [fieldVarint(11, input.generatorModelEnum)] : []),
    ...(input.executionId ? [fieldString(12, input.executionId)] : []),
    ...(input.extraFields ?? []),
  ]);

const encodeTrajectoryMetadata = (input: {
  workspaces?: { folderUri?: string; gitRootUri?: string; remoteUrl?: string; branchName?: string }[];
  createdAt?: string;
  parentConversationId?: string;
  subagentRole?: string;
  subagentPromptSentinel?: string;
  nestingDepth?: number;
}) =>
  concat([
    ...(input.workspaces ?? []).map((ws) =>
      fieldBytes(
        1,
        concat([
          ...(ws.folderUri ? [fieldString(1, ws.folderUri)] : []),
          ...(ws.gitRootUri ? [fieldString(2, ws.gitRootUri)] : []),
          ...(ws.remoteUrl ? [fieldBytes(3, fieldString(2, ws.remoteUrl))] : []),
          ...(ws.branchName ? [fieldString(4, ws.branchName)] : []),
        ]),
      ),
    ),
    ...(input.createdAt ? [fieldBytes(2, encodeTimestamp(input.createdAt))] : []),
    ...(input.parentConversationId ? [fieldString(5, input.parentConversationId)] : []),
    ...(input.subagentRole || input.subagentPromptSentinel
      ? [
          fieldBytes(
            8,
            concat([
              ...(input.subagentRole ? [fieldString(2, input.subagentRole)] : []),
              ...(input.subagentPromptSentinel ? [fieldString(3, input.subagentPromptSentinel)] : []),
            ]),
          ),
        ]
      : []),
    ...(input.nestingDepth ? [fieldVarint(17, input.nestingDepth)] : []),
  ]);

const encodeExecutorMetadata = (executionId: string, modelName: string) =>
  concat([fieldString(9, executionId), fieldBytes(10, fieldBytes(1, fieldString(28, modelName)))]);

const initConversationDb = (file: string, conversationId: string, wal = false, minimalTrajectoryMeta = false) => {
  const db = new Database(file);
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE trajectory_meta (${minimalTrajectoryMeta ? 'cascade_id text PRIMARY KEY' : 'trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer'});
    CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob);
    CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
    CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob);
    CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main' PRIMARY KEY, data blob);
  `);
  if (minimalTrajectoryMeta) db.query('INSERT INTO trajectory_meta VALUES (?)').run(conversationId);
  else db.query('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(`traj-${conversationId}`, conversationId);
  return db;
};

describe('Antigravity accounting', () => {
  test('never reads excluded prompt/tool-argument byte ranges from SQLite blobs into JS memory', async () => {
    const dir = await tempDir('token-tracker-ag-privacy-');
    const file = join(dir, 'privacy.db');
    const systemPromptSentinel = 'SECRET_SYSTEM_PROMPT_'.repeat(30);
    const toolArgSentinel = 'SECRET_TOOL_ARGUMENTS_'.repeat(30);
    const subagentPromptSentinel = 'SECRET_SUBAGENT_INITIAL_PROMPT_'.repeat(30);

    const trajectoryBlob = encodeTrajectoryMetadata({
      workspaces: [{ folderUri: 'file:///work/safe-repo' }],
      createdAt: '2026-11-19T12:00:00.000Z',
      subagentRole: 'Safe Role',
      subagentPromptSentinel,
    });
    const stepBlob = encodeStepMetadata({
      completedAt: '2026-11-19T12:00:05.000Z',
      extraFields: [fieldString(20, toolArgSentinel)],
    });
    const genBlob = encodeGenMetadata({
      modelEnum: 1467,
      responseModel: 'gemini-4-neon',
      stepIndices: [1],
      extraChatFields: [fieldString(14, systemPromptSentinel)],
      usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 1_000, responseId: 'resp-priv' },
    });

    const db = initConversationDb(file, 'privacy-conv', true);
    db.query('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', trajectoryBlob);
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(1, stepBlob, encoder.encode('SECRET_PAYLOAD'));
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(0, genBlob);
    db.close();

    const findRange = (haystack: Uint8Array, needle: string) => {
      const target = encoder.encode(needle);
      const start = Buffer.from(haystack).indexOf(target);
      expect(start).toBeGreaterThan(-1);
      return { start, end: start + target.length };
    };
    const forbidden = {
      trajectory_metadata_blob: findRange(trajectoryBlob, subagentPromptSentinel),
      steps: findRange(stepBlob, toolArgSentinel),
      gen_metadata: findRange(genBlob, systemPromptSentinel),
    };

    const reads: { table: string; offset: number; length: number }[] = [];
    const { parsed } = parseAntigravityDatabase(file, 'privacy-conv', {
      onSliceRead: (table, offset, length) => reads.push({ table, offset, length }),
    });

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].event.sessionTitle).toBe('Safe Role');
    expect(reads.length).toBeGreaterThan(0);

    // Confirm ZERO SQLite substr() reads ever touched the payload bytes of any secret field.
    for (const read of reads) {
      const range = forbidden[read.table as keyof typeof forbidden];
      if (!range) continue;
      const overlaps = read.offset < range.end && read.offset + read.length > range.start;
      expect(overlaps).toBe(false);
    }

    // Confirm reading a cleanly closed WAL database left zero sidecars in the source dir.
    expect(await readdir(dir)).toEqual(['privacy.db']);
  });

  test('reconciles gen_metadata and steps by native call identity, handles zero-token generators, two-pass enums, execution matching, tiers, and schema drift', async () => {
    const dir = await tempDir('token-tracker-ag-reconcile-');
    const file = join(dir, 'reconcile.db');
    // Minimal trajectory_meta without trajectory_id column (schema drift check)
    const db = initConversationDb(file, 'reconcile-conv', false, true);

    // Execution A uses gemini-3.8-flash; Execution B uses gemini-4-neon.
    db.query('INSERT INTO executor_metadata VALUES (?, ?)').run(
      0,
      encodeExecutorMetadata('exec-a', 'gemini-3.8-flash-high'),
    );
    db.query('INSERT INTO executor_metadata VALUES (?, ?)').run(
      1,
      encodeExecutorMetadata('exec-b', 'gemini-4-neon-high'),
    );

    // Step 1: has valid usage, paired with a zero-token generator AND two distinct responses sharing primary step 1.
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      1,
      encodeStepMetadata({
        completedAt: '2026-11-19T12:00:01.000Z',
        executionId: 'exec-a',
        modelUsage: { inputTokens: 100, outputTokens: 10, responseId: 'resp-step-only' },
      }),
      null,
    );
    // Step 2: usage matching generator with stepIndices=[1, 2]
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      2,
      encodeStepMetadata({
        completedAt: '2026-11-19T12:00:02.000Z',
        modelUsage: { modelEnum: 1467, inputTokens: 200, outputTokens: 20, responseId: 'resp-multi-step' },
      }),
      null,
    );
    // Step 3: usage matching generator with empty stepIndices=[]
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      3,
      encodeStepMetadata({
        completedAt: '2026-11-19T12:00:03.000Z',
        modelUsage: { modelEnum: 1467, inputTokens: 300, outputTokens: 30, responseId: 'resp-no-indices' },
      }),
      null,
    );
    // Step 4: malformed nested model_usage (should count as malformed)
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      4,
      encodeStepMetadata({
        completedAt: '2026-11-19T12:00:04.000Z',
        rawModelUsage: new Uint8Array([0x08, 0xff, 0xff]), // truncated varint
      }),
      null,
    );
    // Step 50005: far past 50,000 rows, pruned gen_metadata, matches exec-a (NOT latest exec-b)
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      50_005,
      encodeStepMetadata({
        completedAt: '2026-11-19T12:00:05.000Z',
        executionId: 'exec-a',
        modelUsage: { inputTokens: 400, outputTokens: 40, responseId: 'resp-high-idx', serviceTier: 'priority' },
      }),
      null,
    );

    // Gen 0: zero-token generator referencing step 1 (must NOT suppress step 1's valid usage!)
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        stepIndices: [1],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    // Gen 1: unnamed generator with enum 1467 sharing stepIndices=[1, 2] (enum name supplied later by Gen 2!)
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      1,
      encodeGenMetadata({
        modelEnum: 1467,
        stepIndices: [1, 2],
        usage: { modelEnum: 1467, inputTokens: 200, outputTokens: 20, responseId: 'resp-multi-step' },
      }),
    );
    // Gen 2: second distinct response also referencing primary step 1, supplies enum 1467 -> gemini-4-neon
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      2,
      encodeGenMetadata({
        modelEnum: 1467,
        responseModel: 'gemini-4-neon',
        stepIndices: [1],
        usage: { modelEnum: 1467, inputTokens: 250, outputTokens: 25, responseId: 'resp-second-on-step-1' },
      }),
    );
    // Gen 3: empty stepIndices=[] matching step 3 by responseId
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      3,
      encodeGenMetadata({
        modelEnum: 1467,
        responseModel: 'gemini-4-neon',
        stepIndices: [],
        usage: { modelEnum: 1467, inputTokens: 300, outputTokens: 30, responseId: 'resp-no-indices' },
      }),
    );
    db.close();

    const { parsed, incomplete } = parseAntigravityDatabase(file, 'reconcile-conv');
    expect(incomplete).toBe(false);
    expect(parsed.malformed).toBe(1); // malformed step 4 usage
    expect(parsed.events).toHaveLength(5);

    const byId = new Map(parsed.events.map((entry) => [entry.event.id, entry]));
    expect(byId.get('antigravity:reconcile-conv:response:resp-multi-step')?.event).toMatchObject({
      model: 'gemini-4-neon', // resolved via two-pass enum map!
      inputTokens: 200,
      outputTokens: 20,
    });
    expect(byId.get('antigravity:reconcile-conv:response:resp-second-on-step-1')?.event).toMatchObject({
      model: 'gemini-4-neon',
      inputTokens: 250,
      outputTokens: 25,
    });
    expect(byId.get('antigravity:reconcile-conv:response:resp-no-indices')?.event).toMatchObject({
      model: 'gemini-4-neon',
      inputTokens: 300,
      outputTokens: 30,
    });
    expect(byId.get('antigravity:reconcile-conv:response:resp-step-only')?.event).toMatchObject({
      model: 'gemini-3.8-flash',
      inputTokens: 100,
      outputTokens: 10,
    });
    const highIdx = byId.get('antigravity:reconcile-conv:response:resp-high-idx');
    expect(highIdx?.tier).toBe('priority');
    expect(highIdx?.event).toMatchObject({
      model: 'gemini-3.8-flash', // matched exec-a, not latest exec-b
      inputTokens: 400,
      outputTokens: 40,
    });
  });

  test('auto-discovers roots, filters descendant attachments & relative paths, inherits from zero-event parent, and keeps child own project separate', async () => {
    const home = await tempDir('token-tracker-ag-');
    const customT3 = join(home, 'custom-t3');
    const parentWorkspace = join(home, 'work', 'parent-repo');
    const childWorkspace = join(home, 'work', 'other-local-folder');
    const cliRoot = join(home, '.gemini', 'antigravity-cli');
    const acpRoot = join(customT3, 'providers', 'antigravity', 'profile-hash', 'antigravity-acp');
    await mkdir(join(cliRoot, 'conversations'), { recursive: true });
    await mkdir(join(acpRoot, 'conversations'), { recursive: true });

    // Parent with workspace metadata + remote URL but ZERO billed events
    const parentDb = initConversationDb(join(acpRoot, 'conversations', 'zero-parent.db'), 'zero-parent');
    parentDb.query('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run(
      'main',
      encodeTrajectoryMetadata({
        workspaces: [
          { folderUri: pathToFileURL(join(customT3, 'attachments', 'thread-1')).href },
          { folderUri: 'relative/path/ignored' },
          {
            folderUri: pathToFileURL(parentWorkspace).href,
            gitRootUri: pathToFileURL(parentWorkspace).href,
            remoteUrl: 'https://github.com/davis7dotsh/token-tracker.git',
            branchName: 'main',
          },
        ],
        createdAt: '2026-11-19T12:00:00.000Z',
      }),
    );
    parentDb.close();

    // Child 1: no workspace -> inherits parent's project AND repository
    const childInherit = initConversationDb(join(acpRoot, 'conversations', 'child-inherit.db'), 'child-inherit');
    childInherit.query('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run(
      'main',
      encodeTrajectoryMetadata({
        createdAt: '2026-11-19T12:01:00.000Z',
        parentConversationId: 'zero-parent',
        subagentRole: 'Inherited Researcher',
        nestingDepth: 1,
      }),
    );
    childInherit
      .query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)')
      .run(1, encodeStepMetadata({ completedAt: '2026-11-19T12:01:05.000Z' }), null);
    childInherit.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        responseModel: 'gemini-3.8-flash',
        stepIndices: [1],
        usage: {
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 3_000,
          thinkingOutputTokens: 50,
          responseId: 'r1',
        },
      }),
    );
    childInherit.close();

    // Child 2: has its OWN workspace (no remote) -> must NOT inherit parent's unrelated repository
    const childOwn = initConversationDb(join(acpRoot, 'conversations', 'child-own.db'), 'child-own');
    childOwn.query('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run(
      'main',
      encodeTrajectoryMetadata({
        workspaces: [{ folderUri: pathToFileURL(childWorkspace).href }],
        createdAt: '2026-11-19T12:02:00.000Z',
        parentConversationId: 'zero-parent',
        subagentRole: 'Independent Worker',
        nestingDepth: 1,
      }),
    );
    childOwn
      .query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)')
      .run(1, encodeStepMetadata({ completedAt: '2026-11-19T12:02:05.000Z' }), null);
    childOwn.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        responseModel: 'gemini-4-neon',
        stepIndices: [1],
        usage: { inputTokens: 500, outputTokens: 100, responseId: 'r2' },
      }),
    );
    childOwn.close();

    const cacheDirectory = join(home, 'cache');
    const collectOptions = {
      home,
      t3DataDirectory: customT3,
      cacheDirectory,
      claudeDirs: [],
      codexDirs: [],
      piDirs: [],
      grokDirs: [],
      museDirs: [],
      deviceId: 'enceladus',
    };
    const previousHome = process.env.ANTIGRAVITY_HOME;
    delete process.env.ANTIGRAVITY_HOME;
    let usage: Awaited<ReturnType<typeof collect>>;
    let warmUsage: Awaited<ReturnType<typeof collect>>;
    const collect = () => Effect.runPromise(collectUsage(collectOptions).pipe(Effect.provide(BunServices.layer)));
    try {
      usage = await collect();
      warmUsage = await collect();
    } finally {
      if (previousHome === undefined) delete process.env.ANTIGRAVITY_HOME;
      else process.env.ANTIGRAVITY_HOME = previousHome;
    }

    for (const snapshot of [usage, warmUsage]) {
      expect(snapshot.events).toHaveLength(2);
      const inherited = snapshot.events.find((e) => e.sessionId === 'child-inherit');
      expect(inherited).toMatchObject({
        project: parentWorkspace,
        repository: 'github.com/davis7dotsh/token-tracker',
        sessionTitle: 'Inherited Researcher',
        costKnown: true,
      });
      expect(tokenTotal(inherited!)).toBe(4_200);

      const own = snapshot.events.find((e) => e.sessionId === 'child-own');
      expect(own).toMatchObject({
        project: childWorkspace,
        repository: null,
        sessionTitle: 'Independent Worker',
      });
    }

    const dashboard = buildDashboard(usage, { range: 'all', timezone: 'UTC' }, new Date('2026-11-20T00:00:00Z'));
    expect(dashboard.harnesses).toEqual([expect.objectContaining({ name: 'antigravity', sessions: 2, requests: 2 })]);
    expect(dashboard.providers).toEqual([expect.objectContaining({ name: 'google', tokens: 4_800 })]);
  });

  test('WAL writes invalidate parsed cache and revision fingerprints on active databases', async () => {
    const home = await tempDir('token-tracker-ag-wal-');
    const root = join(home, 'antigravity');
    const cacheDirectory = join(home, 'cache');
    await mkdir(join(root, 'conversations'), { recursive: true });
    const dbFile = join(root, 'conversations', 'live-session.db');

    const db = initConversationDb(dbFile, 'live-session', true);
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      1,
      encodeStepMetadata({ completedAt: '2026-11-20T01:00:00.000Z' }),
      null,
    );
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        modelEnum: 1467,
        responseModel: 'gemini-4-neon',
        stepIndices: [1],
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, thinkingOutputTokens: 10, responseId: 'w1' },
      }),
    );

    const options = {
      home,
      cacheDirectory,
      claudeDirs: [],
      codexDirs: [],
      piDirs: [],
      grokDirs: [],
      museDirs: [],
      antigravityDirs: [root],
    };

    try {
      const rev1 = await Effect.runPromise(usageRevision(options)().pipe(Effect.provide(BunServices.layer)));
      const first = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
      expect(first.events).toHaveLength(1);
      expect(tokenTotal(first.events[0])).toBe(620);

      // Append a new step while keeping the WAL writer open
      db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
        2,
        encodeStepMetadata({ completedAt: '2026-11-20T01:01:00.000Z' }),
        null,
      );
      db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
        1,
        encodeGenMetadata({
          modelEnum: 1467,
          responseModel: 'gemini-4-neon',
          stepIndices: [2],
          usage: {
            inputTokens: 200,
            outputTokens: 40,
            cacheReadTokens: 1_000,
            thinkingOutputTokens: 15,
            responseId: 'w2',
          },
        }),
      );

      const rev2 = await Effect.runPromise(usageRevision(options)(first).pipe(Effect.provide(BunServices.layer)));
      expect(rev2).not.toBe(rev1);

      const second = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
      expect(second.events).toHaveLength(2);
      expect(second.events.reduce((sum, e) => sum + tokenTotal(e), 0)).toBe(1_860);
    } finally {
      db.close();
    }
  });

  test('protobuf wire decoder validates 64-bit varint width, tolerates large unknown fields, and pricing stays fail-closed on conflicting bare names', () => {
    // Unknown field 99 with max uint64 (valid 10-byte varint with 0x01 in byte 10) must be skipped cleanly
    const validWithUnknownUint64 = encodeUsage({
      inputTokens: 10,
      outputTokens: 5,
      extraFields: [fieldVarint(99, (1n << 64n) - 1n)],
    });
    expect(decodeModelUsageStats(validWithUnknownUint64)).toMatchObject({ inputTokens: 10, outputTokens: 5 });

    // Invalid 10th byte (> 0x01) in 64-bit varint must be rejected
    const invalidTenthByte = new Uint8Array([(2 << 3) | 0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02]);
    expect(decodeModelUsageStats(invalidTenthByte)).toBeNull();

    // Conflicting bare model (free gemini/ vs paid vertex_ai/) must remain unpriced rather than $0.00
    const bareGemma = estimateCost({
      id: 'gemma',
      timestamp: '2026-11-20T00:00:00.000Z',
      harness: 'antigravity',
      model: 'gemma-4-26b-a4b-it',
      project: '/work',
      repository: null,
      sessionId: 's',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      costKnown: false,
    });
    expect(bareGemma.costKnown).toBe(false);

    // Present zero-length protobuf Timestamp encodes Unix epoch 1970-01-01T00:00:00.000Z
    const epochStep = decodeStepMetadata(fieldBytes(8, new Uint8Array(0)));
    expect(epochStep?.completedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  test('asymmetric generator/step identity merges step responseId, model, and tier without double-billing, and surfaces schema drift', async () => {
    const dir = await tempDir('token-tracker-ag-asym-');
    const file = join(dir, 'asym.db');
    const db = initConversationDb(file, 'asym-conv');
    // Step 1 carries responseId, resolvable model enum 1467, and priority tier.
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      1,
      encodeStepMetadata({
        completedAt: '2026-11-19T12:00:00.000Z',
        modelUsage: {
          modelEnum: 1467,
          inputTokens: 100,
          outputTokens: 30,
          responseId: 'resp-only-on-step',
          serviceTier: 'priority',
        },
      }),
      null,
    );
    // Generator 0 references step 1 without its own responseId, model, or tier.
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        stepIndices: [1],
        usage: { inputTokens: 100, outputTokens: 30 },
      }),
    );
    // Generator 1 supplies the enum 1467 -> gemini-4-neon mapping on another step.
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      2,
      encodeStepMetadata({ completedAt: '2026-11-19T12:01:00.000Z' }),
      null,
    );
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      1,
      encodeGenMetadata({
        modelEnum: 1467,
        responseModel: 'gemini-4-neon',
        stepIndices: [2],
        usage: { modelEnum: 1467, inputTokens: 50, outputTokens: 10, responseId: 'resp-enum-donor' },
      }),
    );
    db.close();

    const { parsed } = parseAntigravityDatabase(file, 'asym-conv');
    expect(parsed.events).toHaveLength(2);
    const merged = parsed.events.find((e) => e.event.id === 'antigravity:asym-conv:response:resp-only-on-step');
    expect(merged?.tier).toBe('priority');
    expect(merged?.event).toMatchObject({ model: 'gemini-4-neon', inputTokens: 100, outputTokens: 30 });

    // Schema drift: populated steps table lacking metadata column flags incomplete + malformed
    const driftFile = join(dir, 'drift.db');
    const drift = new Database(driftFile);
    drift.exec('CREATE TABLE steps (idx integer PRIMARY KEY, unknown_col blob); INSERT INTO steps VALUES (1, NULL);');
    drift.close();
    const drifted = parseAntigravityDatabase(driftFile, 'drift-conv');
    expect(drifted.incomplete).toBe(true);
    expect(drifted.parsed.malformed).toBe(1);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'unreadable WAL file fails collection as partial instead of silently caching zero events',
    async () => {
      const home = await tempDir('token-tracker-ag-unreadable-wal-');
      const root = join(home, 'antigravity');
      const cacheDirectory = join(home, 'cache');
      await mkdir(join(root, 'conversations'), { recursive: true });
      const dbFile = join(root, 'conversations', 'wal-only.db');
      const db = initConversationDb(dbFile, 'wal-only', true);
      // Checkpoint the empty schema into the main DB so the subsequent usage
      // inserts remain exclusively inside the WAL file.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('PRAGMA wal_autocheckpoint = 0');
      db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
        1,
        encodeStepMetadata({ completedAt: '2026-11-20T01:00:00.000Z' }),
        null,
      );
      db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
        0,
        encodeGenMetadata({
          responseModel: 'gemini-4-neon',
          stepIndices: [1],
          usage: { inputTokens: 100, outputTokens: 20, responseId: 'wal-call' },
        }),
      );
      // Snapshot both the pre-checkpoint main DB and WAL before closing so
      // db.close()'s checkpoint cannot copy the usage into the main DB file.
      const walFile = `${dbFile}-wal`;
      const shmFile = `${dbFile}-shm`;
      const savedMain = await Bun.file(dbFile).bytes();
      const savedWal = await Bun.file(walFile).bytes();
      db.close();
      await Bun.write(dbFile, savedMain);
      await rm(walFile, { force: true });
      await rm(shmFile, { force: true });

      // Control check: main DB alone contains zero usage (proving usage lives only in the WAL).
      const mainOnly = parseAntigravityDatabase(dbFile, 'wal-only');
      expect(mainOnly.incomplete).toBe(false);
      expect(mainOnly.parsed.events).toHaveLength(0);

      await Bun.write(walFile, savedWal);

      const options = {
        home,
        cacheDirectory,
        claudeDirs: [],
        codexDirs: [],
        piDirs: [],
        grokDirs: [],
        museDirs: [],
        antigravityDirs: [root],
      };

      await chmod(walFile, 0);
      try {
        const failed = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
        expect(failed.events).toHaveLength(0);
        expect(failed.sources.find((s) => s.harness === 'antigravity')?.status).toBe('partial');
      } finally {
        await chmod(walFile, 0o600);
      }

      // Once WAL becomes readable again, collection succeeds (was NOT poisoned in cache)
      const recovered = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
      expect(recovered.events).toHaveLength(1);
      expect(tokenTotal(recovered.events[0])).toBe(120);
    },
  );

  test('reconciles shared messageId with step responseId, isolates conflicting-ID step pricing metadata, and flags non-integer step indices', async () => {
    const dir = await tempDir('token-tracker-ag-aliases-');
    const file = join(dir, 'aliases.db');
    const db = initConversationDb(file, 'alias-conv');

    // Case 1: generator has messageId only; step has BOTH messageId and responseId -> must emit ONE 101-token event.
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      1,
      encodeStepMetadata({
        completedAt: '2026-11-19T12:00:00.000Z',
        modelUsage: { inputTokens: 80, outputTokens: 21, messageId: 'msg-shared', responseId: 'resp-canonical' },
      }),
      null,
    );
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        responseModel: 'gemini-4-neon',
        stepIndices: [1],
        usage: { inputTokens: 80, outputTokens: 21, messageId: 'msg-shared' },
      }),
    );

    // Case 2: generator with resp-b + shared messageId references step 2 which holds resp-a + SAME messageId
    // (with model enum 1467 + priority tier). Differing explicit responseIds must take precedence:
    // both calls survive (120 + 60 = 180 tokens) with their own tiers and models.
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      2,
      encodeStepMetadata({
        completedAt: '2026-11-19T12:01:00.000Z',
        modelUsage: {
          modelEnum: 1467,
          inputTokens: 100,
          outputTokens: 20,
          messageId: 'msg-conflict',
          responseId: 'resp-a',
          serviceTier: 'priority',
        },
      }),
      null,
    );
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      1,
      encodeGenMetadata({
        stepIndices: [2],
        usage: { inputTokens: 50, outputTokens: 10, messageId: 'msg-conflict', responseId: 'resp-b' },
      }),
    );
    // Provide enum 1467 -> gemini-4-neon on step 3
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      3,
      encodeStepMetadata({ completedAt: '2026-11-19T12:02:00.000Z' }),
      null,
    );
    db.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      2,
      encodeGenMetadata({
        modelEnum: 1467,
        responseModel: 'gemini-4-neon',
        stepIndices: [3],
        usage: { modelEnum: 1467, inputTokens: 10, outputTokens: 5, responseId: 'resp-donor' },
      }),
    );
    db.close();

    const { parsed } = parseAntigravityDatabase(file, 'alias-conv');
    expect(parsed.events).toHaveLength(4);
    const shared = parsed.events.find((e) => e.event.id === 'antigravity:alias-conv:response:resp-canonical');
    expect(shared?.event).toMatchObject({ inputTokens: 80, outputTokens: 21, model: 'gemini-4-neon' });
    expect(parsed.events.find((e) => e.event.id === 'antigravity:alias-conv:response:msg-shared')).toBeUndefined();

    const respA = parsed.events.find((e) => e.event.id === 'antigravity:alias-conv:response:resp-a');
    expect(respA?.tier).toBe('priority');
    expect(respA?.event.model).toBe('gemini-4-neon');

    const respB = parsed.events.find((e) => e.event.id === 'antigravity:alias-conv:response:resp-b');
    expect(respB?.tier).toBe('');
    expect(respB?.event.model).toBe('unknown');
    expect(tokenTotal(respA!.event) + tokenTotal(respB!.event)).toBe(180);

    // Case 3: text idx in steps table must flag incomplete + malformed instead of silently returning ready/empty
    const textIdxFile = join(dir, 'text-idx.db');
    const textDb = new Database(textIdxFile);
    textDb.exec('CREATE TABLE steps (idx text PRIMARY KEY, metadata blob);');
    textDb.query('INSERT INTO steps VALUES (?, ?)').run(
      '1',
      encodeStepMetadata({
        completedAt: '2026-11-19T12:00:00.000Z',
        modelUsage: { inputTokens: 10, outputTokens: 5, responseId: 'r-text' },
      }),
    );
    textDb.close();
    const textResult = parseAntigravityDatabase(textIdxFile, 'text-idx-conv');
    expect(textResult.incomplete).toBe(true);
    expect(textResult.parsed.malformed).toBe(1);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'searchable-but-unlistable (0111) T3 provider directory surfaces an error source and warning',
    async () => {
      const home = await tempDir('token-tracker-ag-0111-');
      const t3DataDirectory = join(home, '.t3', 'userdata');
      const providersDir = join(t3DataDirectory, 'providers', 'antigravity');
      await mkdir(providersDir, { recursive: true });
      await chmod(providersDir, 0o111);
      const previousHome = process.env.ANTIGRAVITY_HOME;
      delete process.env.ANTIGRAVITY_HOME;
      try {
        const usage = await Effect.runPromise(
          collectUsage({
            home,
            t3DataDirectory,
            claudeDirs: [],
            codexDirs: [],
            piDirs: [],
            grokDirs: [],
            museDirs: [],
          }).pipe(Effect.provide(BunServices.layer)),
        );
        const agSource = usage.sources.find((s) => s.harness === 'antigravity' && s.path === providersDir);
        expect(agSource?.status).toBe('error');
        expect(usage.warnings.some((w) => w.startsWith('antigravity:'))).toBe(true);
      } finally {
        if (previousHome === undefined) delete process.env.ANTIGRAVITY_HOME;
        else process.env.ANTIGRAVITY_HOME = previousHome;
        await chmod(providersDir, 0o700);
      }
    },
  );

  test('keeps canonical ID stable across generator arrival and pruning and retracts superseded fallback IDs across warm caches', async () => {
    const home = await tempDir('token-tracker-ag-retract-');
    const root = join(home, 'antigravity');
    const cacheDirectory = join(home, 'cache');
    await mkdir(join(root, 'conversations'), { recursive: true });
    const dbFile = join(root, 'conversations', 'trans-conv.db');

    const options = {
      home,
      cacheDirectory,
      claudeDirs: [],
      codexDirs: [],
      piDirs: [],
      grokDirs: [],
      museDirs: [],
      antigravityDirs: [root],
    };

    // Phase 1: step 1 has messageId only; step 2 has no native ID at all (emits step:2)
    const db = initConversationDb(dbFile, 'trans-conv');
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      1,
      encodeStepMetadata({
        completedAt: '2026-11-20T02:00:00.000Z',
        modelUsage: { inputTokens: 100, outputTokens: 20, messageId: 'msg-1' },
      }),
      null,
    );
    db.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      2,
      encodeStepMetadata({
        completedAt: '2026-11-20T02:01:00.000Z',
        modelUsage: { inputTokens: 60, outputTokens: 15 },
      }),
      null,
    );
    db.close();

    const phase1 = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
    expect(phase1.events.map((e) => e.id).sort()).toEqual([
      'antigravity:trans-conv:response:msg-1',
      'antigravity:trans-conv:step:2',
    ]);

    // Phase 2: generators arrive with resp-1 (matching msg-1) and resp-2 (matching ID-less step 2)
    const db2 = new Database(dbFile);
    db2.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        responseModel: 'gemini-4-neon',
        stepIndices: [1],
        usage: { inputTokens: 100, outputTokens: 20, messageId: 'msg-1', responseId: 'resp-1' },
      }),
    );
    db2.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      1,
      encodeGenMetadata({
        responseModel: 'gemini-4-neon',
        stepIndices: [2],
        usage: { inputTokens: 60, outputTokens: 15, responseId: 'resp-2' },
      }),
    );
    db2.close();

    const phase2Cold = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
    const phase2Warm = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
    for (const snapshot of [phase2Cold, phase2Warm]) {
      expect(snapshot.events.map((e) => e.id).sort()).toEqual([
        'antigravity:trans-conv:response:msg-1',
        'antigravity:trans-conv:response:resp-2',
      ]);
      expect(snapshot.retractedIds).toContain('antigravity:trans-conv:step:2');
      expect(snapshot.retractedIds).toContain('antigravity:trans-conv:response:resp-1');
    }

    // Phase 3: generator 0 is pruned -> step 1 still emits the EXACT same durable msg-1 ID
    const db3 = new Database(dbFile);
    db3.query('DELETE FROM gen_metadata WHERE idx = 0').run();
    db3.close();

    const phase3 = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
    expect(phase3.events.map((e) => e.id).sort()).toEqual([
      'antigravity:trans-conv:response:msg-1',
      'antigravity:trans-conv:response:resp-2',
    ]);

    // Separate calls sharing a messageId with different responseIds must stay distinct
    // and retain the matching step's timestamp even when stepIndices is empty and the
    // conversation has no creation timestamp.
    const multiFile = join(root, 'conversations', 'multi-resp.db');
    const multiDb = initConversationDb(multiFile, 'multi-resp');
    multiDb.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      1,
      encodeStepMetadata({
        completedAt: '2026-11-20T03:00:00.000Z',
        modelUsage: { inputTokens: 80, outputTokens: 20, messageId: 'msg-shared', serviceTier: 'priority' },
      }),
      null,
    );
    multiDb.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        responseModel: 'gemini-4-neon',
        stepIndices: [],
        usage: {
          inputTokens: 80,
          outputTokens: 20,
          messageId: 'msg-shared',
          responseId: 'resp-first',
          serviceTier: 'priority',
        },
      }),
    );
    multiDb.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      1,
      encodeGenMetadata({
        responseModel: 'gemini-4-neon',
        stepIndices: [],
        usage: { inputTokens: 160, outputTokens: 40, messageId: 'msg-shared', responseId: 'resp-second' },
      }),
    );
    multiDb.close();

    const multi = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
    const multiEvents = multi.events.filter((e) => e.sessionId === 'multi-resp');
    expect(multiEvents.map((e) => e.id).sort()).toEqual([
      'antigravity:multi-resp:response:resp-first',
      'antigravity:multi-resp:response:resp-second',
    ]);
    expect(multiEvents.map((e) => e.timestamp)).toEqual(['2026-11-20T03:00:00.000Z', '2026-11-20T03:00:00.000Z']);
    expect(multiEvents.reduce((sum, e) => sum + tokenTotal(e), 0)).toBe(300);
    expect(multi.retractedIds).toContain('antigravity:multi-resp:response:msg-shared');
    const multiDirect = parseAntigravityDatabase(multiFile, 'multi-resp');
    expect(
      multiDirect.parsed.events.find((e) => e.event.id === 'antigravity:multi-resp:response:resp-first')?.tier,
    ).toBe('priority');
    expect(
      multiDirect.parsed.events.find((e) => e.event.id === 'antigravity:multi-resp:response:resp-second')?.tier,
    ).toBe('');

    // Reconcile generator rows across split steps: one generator with messageId=M matching
    // a messageId-only step and another with messageId=M + responseId=R matching a responseId-only
    // step must merge into a single response:R event and retract M.
    const splitFile = join(root, 'conversations', 'split-steps.db');
    const splitDb = initConversationDb(splitFile, 'split-steps');
    splitDb.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      1,
      encodeStepMetadata({
        completedAt: '2026-11-20T04:00:00.000Z',
        modelUsage: { inputTokens: 90, outputTokens: 10, messageId: 'msg-split', serviceTier: 'priority' },
      }),
      null,
    );
    splitDb.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      2,
      encodeStepMetadata({
        completedAt: '2026-11-20T04:00:01.000Z',
        modelUsage: { inputTokens: 90, outputTokens: 10, responseId: 'resp-split' },
      }),
      null,
    );
    splitDb.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        stepIndices: [1],
        usage: { inputTokens: 90, outputTokens: 10, messageId: 'msg-split' },
      }),
    );
    splitDb.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      1,
      encodeGenMetadata({
        responseModel: 'gemini-4-neon',
        stepIndices: [2],
        usage: { inputTokens: 90, outputTokens: 10, messageId: 'msg-split', responseId: 'resp-split' },
      }),
    );
    splitDb.close();

    const splitDirect = parseAntigravityDatabase(splitFile, 'split-steps');
    expect(splitDirect.parsed.events.map((e) => e.event.id)).toEqual(['antigravity:split-steps:response:resp-split']);
    expect(splitDirect.parsed.events[0]?.event.model).toBe('gemini-4-neon');
    expect(splitDirect.parsed.events[0]?.tier).toBe('priority');
    expect(tokenTotal(splitDirect.parsed.events[0]!.event)).toBe(100);
    expect(splitDirect.parsed.retractedIds).toContain('antigravity:split-steps:response:msg-split');
    expect(splitDirect.parsed.retractedIds).toContain('antigravity:split-steps:step:1');
    expect(splitDirect.parsed.retractedIds).toContain('antigravity:split-steps:step:2');

    // Distinct referenced steps sharing a messageId must retain their own step model and tier.
    const distinctStepsFile = join(root, 'conversations', 'distinct-ref-steps.db');
    const distinctDb = initConversationDb(distinctStepsFile, 'distinct-ref-steps');
    distinctDb.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      1,
      encodeStepMetadata({
        completedAt: '2026-11-20T05:00:00.000Z',
        modelUsage: {
          modelEnum: 1467,
          inputTokens: 50,
          outputTokens: 10,
          messageId: 'msg-distinct',
          serviceTier: 'priority',
        },
      }),
      null,
    );
    distinctDb.query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)').run(
      2,
      encodeStepMetadata({
        completedAt: '2026-11-20T05:00:05.000Z',
        modelUsage: {
          modelEnum: 1468,
          inputTokens: 70,
          outputTokens: 15,
          messageId: 'msg-distinct',
        },
      }),
      null,
    );
    distinctDb
      .query('INSERT INTO steps VALUES (?, 15, 3, ?, ?)')
      .run(3, encodeStepMetadata({ completedAt: '2026-11-20T05:00:10.000Z' }), null);
    distinctDb.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      0,
      encodeGenMetadata({
        stepIndices: [1],
        usage: { inputTokens: 50, outputTokens: 10, messageId: 'msg-distinct', responseId: 'resp-step1' },
      }),
    );
    distinctDb.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      1,
      encodeGenMetadata({
        stepIndices: [2],
        usage: { inputTokens: 70, outputTokens: 15, messageId: 'msg-distinct', responseId: 'resp-step2' },
      }),
    );
    distinctDb.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      2,
      encodeGenMetadata({
        modelEnum: 1467,
        responseModel: 'gemini-4-neon',
        stepIndices: [3],
        usage: { modelEnum: 1467, inputTokens: 1, outputTokens: 1, responseId: 'resp-donor-1' },
      }),
    );
    distinctDb.query('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(
      3,
      encodeGenMetadata({
        modelEnum: 1468,
        responseModel: 'gemini-3-flash',
        stepIndices: [3],
        usage: { modelEnum: 1468, inputTokens: 1, outputTokens: 1, responseId: 'resp-donor-2' },
      }),
    );
    distinctDb.close();

    const distinctParsed = parseAntigravityDatabase(distinctStepsFile, 'distinct-ref-steps').parsed;
    const step1Ev = distinctParsed.events.find(
      (e) => e.event.id === 'antigravity:distinct-ref-steps:response:resp-step1',
    );
    const step2Ev = distinctParsed.events.find(
      (e) => e.event.id === 'antigravity:distinct-ref-steps:response:resp-step2',
    );
    expect(step1Ev?.event.model).toBe('gemini-4-neon');
    expect(step1Ev?.tier).toBe('priority');
    expect(step2Ev?.event.model).toBe('gemini-3-flash');
    expect(step2Ev?.tier).toBe('');
  });
});
