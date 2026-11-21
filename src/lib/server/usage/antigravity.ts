import { Database } from 'bun:sqlite';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem, Path, Result } from 'effect';
import type { SourceStatus, UsageEvent } from '../../shared/domain';
import {
  decodeExecutorMetadataFromReader,
  decodeGeneratorMetadataFromReader,
  decodeStepMetadataFromReader,
  decodeTrajectoryMetadataFromReader,
  type AntigravityGeneratorMetadata,
  type AntigravityModelUsage,
  type AntigravityStepMetadata,
  type AntigravityTrajectoryMetadata,
  type BlobSliceReader,
} from './antigravity-proto';
import { fileSignature, parsedCachePath, prepareParsedCache, readParsedCache, writeParsedCache } from './cache';
import { readUsageDirectory } from './files';
import type { ParsedFile } from './parsers';
import { canonicalRepository } from './repository';

type MutableSource = { -readonly [K in keyof SourceStatus]: SourceStatus[K] };
type SummaryRow = {
  title: string;
  project: string;
  parentId: string;
};
type ConversationMeta = {
  project: string;
  repository: string | null;
};

const CACHE_PREFIX = 'antigravity-v4';
const DEFAULT_ATTACHMENT_SEGMENT = /[\\/]\.t3[\\/]userdata[\\/]attachments(?:[\\/]|$)/i;
const EFFORT_SUFFIX = /-(?:low|medium|high|xhigh)$/i;
const MODEL_PATH_PREFIX = /^(?:publishers\/[^/]+\/)?models\//i;
const SUMMARY_TITLE_MAX = 1024;
const PAGE_SIZE = 500;
const MAX_TOTAL_ROWS = 1_000_000;

export type AntigravityParseOptions = {
  sourceIndex?: number;
  attachmentsDir?: string;
  onSliceRead?: (table: string, offset: number, length: number) => void;
};

const asBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
};

const cleanText = (value: unknown, maximum = SUMMARY_TITLE_MAX) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value.trim() : '';

const normalizeFilePath = (value: string) => {
  const normalized = normalize(value).replace(/[\\/]+$/, '');
  return normalized || value;
};

const uriToPath = (uri: string) => {
  const trimmed = uri.trim();
  if (!trimmed) return '';
  if (!trimmed.includes('://')) return isAbsolute(trimmed) ? normalizeFilePath(trimmed) : '';
  if (!trimmed.toLowerCase().startsWith('file://')) return '';
  try {
    const resolved = fileURLToPath(trimmed);
    return isAbsolute(resolved) ? normalizeFilePath(resolved) : '';
  } catch {
    return '';
  }
};

const isAttachmentPath = (candidate: string, attachmentsDir?: string) => {
  const normalized = normalizeFilePath(candidate);
  if (DEFAULT_ATTACHMENT_SEGMENT.test(normalized)) return true;
  if (!attachmentsDir) return false;
  const root = normalizeFilePath(attachmentsDir);
  if (process.platform === 'win32') {
    const lowerCandidate = normalized.toLowerCase();
    const lowerRoot = root.toLowerCase();
    return lowerCandidate === lowerRoot || lowerCandidate.startsWith(`${lowerRoot}${sep}`);
  }
  return normalized === root || normalized.startsWith(`${root}${sep}`);
};

const pickWorkspaceFromUris = (uris: readonly string[], attachmentsDir?: string) => {
  const paths = uris.map(uriToPath).filter(Boolean);
  return paths.find((candidate) => !isAttachmentPath(candidate, attachmentsDir)) ?? '';
};

const pickWorkspace = (trajectory: AntigravityTrajectoryMetadata | null, attachmentsDir?: string) => {
  if (!trajectory) return { project: '', repository: null as string | null };
  const candidates = trajectory.workspaces
    .map((workspace) => ({
      folder: uriToPath(workspace.folderUri),
      gitRoot: uriToPath(workspace.gitRootUri),
      remoteUrl: workspace.remoteUrl,
      branchName: workspace.branchName,
    }))
    .filter((workspace) => {
      const target = workspace.folder || workspace.gitRoot;
      return Boolean(target) && !isAttachmentPath(target, attachmentsDir);
    });
  const preferred =
    candidates.find((workspace) => Boolean(workspace.gitRoot || workspace.branchName || workspace.remoteUrl)) ??
    candidates[0];
  if (preferred) {
    return {
      project: preferred.folder || preferred.gitRoot,
      repository: preferred.remoteUrl ? canonicalRepository(preferred.remoteUrl) : null,
    };
  }
  return {
    project: pickWorkspaceFromUris(trajectory.workspaceUris, attachmentsDir),
    repository: null as string | null,
  };
};

const normalizeResponseModel = (value: string) => value.trim().replace(MODEL_PATH_PREFIX, '');
const normalizeFallbackModel = (value: string) => normalizeResponseModel(value).replace(EFFORT_SUFFIX, '');
const normalizeServiceTier = (value: string) => value.trim().toLowerCase();

const responseAliases = (usage: AntigravityModelUsage) => {
  const aliases: string[] = [];
  for (const value of [usage.responseId, usage.messageId, usage.providerAssignedMessageId]) {
    if (value && !aliases.includes(value)) aliases.push(value);
  }
  return aliases;
};

const responseIdentity = (usage: AntigravityModelUsage) => responseAliases(usage)[0] ?? '';

// Resolve a call's canonical durable native identity across steps and generators:
// 1. Prefer a durable step's responseId when present so generators matching a
//    messageId-only step and a responseId-only step reconcile to the same ID.
// 2. Otherwise prefer an unambiguous durable step alias (e.g. step messageId) so
//    identity stays stable across both generator arrival and generator pruning.
// 3. Fall back to an explicit/promoted responseId, keeping distinct responseIds
//    separate when multiple calls share a messageId.
const canonicalResponseIdentity = (
  primary: AntigravityModelUsage,
  compatibleStep?: AntigravityModelUsage | null,
  ambiguousAliases?: ReadonlySet<string>,
  uniqueResponseIdByAlias?: ReadonlyMap<string, string>,
  stepResponseIds?: ReadonlySet<string>,
  stepsByAlias?: ReadonlyMap<string, unknown>,
) => {
  const aliases = responseAliases(primary);
  if (compatibleStep) {
    for (const alias of responseAliases(compatibleStep)) {
      if (!aliases.includes(alias)) aliases.push(alias);
    }
  }
  const explicitResponseId = primary.responseId || compatibleStep?.responseId || '';
  const promotedResponseId =
    explicitResponseId ||
    aliases.map((alias) => uniqueResponseIdByAlias?.get(alias)).find((id): id is string => Boolean(id)) ||
    '';
  if (promotedResponseId && stepResponseIds?.has(promotedResponseId)) return promotedResponseId;

  const stepId = compatibleStep ? responseIdentity(compatibleStep) : '';
  if (stepId && !(primary.responseId && ambiguousAliases?.has(stepId))) return stepId;
  for (const alias of aliases) {
    if (alias === primary.responseId) continue;
    if (stepsByAlias?.has(alias) && !(primary.responseId && ambiguousAliases?.has(alias))) return alias;
  }

  if (promotedResponseId) return promotedResponseId;
  return responseIdentity(primary);
};

const compatibleUsage = (left: AntigravityModelUsage, right: AntigravityModelUsage) => {
  if (left.responseId && right.responseId) return left.responseId === right.responseId;
  const leftAliases = responseAliases(left);
  const rightAliases = responseAliases(right);
  if (!leftAliases.length || !rightAliases.length) return true;
  return leftAliases.some((alias) => rightAliases.includes(alias));
};

const matchesCoveredUsage = (covered: readonly AntigravityModelUsage[], candidate: AntigravityModelUsage) => {
  const candidateAliases = responseAliases(candidate);
  if (!candidateAliases.length) return false;
  return covered.some(
    (emitted) =>
      compatibleUsage(emitted, candidate) && responseAliases(emitted).some((a) => candidateAliases.includes(a)),
  );
};

const stepTimestamp = (step: AntigravityStepMetadata | undefined, fallback: string) =>
  step?.completedAt || step?.finishedGeneratingAt || step?.createdAt || step?.startedAt || fallback;

// Detect WAL journal mode from the 20-byte SQLite header (bytes 18 and 19 == 2).
const isWalDatabase = (file: string) => {
  const fd = openSync(file, 'r');
  try {
    const header = new Uint8Array(20);
    const bytesRead = readSync(fd, header, 0, 20, 0);
    return bytesRead >= 20 && header[18] === 2 && header[19] === 2;
  } finally {
    closeSync(fd);
  }
};

const missingErrno = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && String(error.code) === 'ENOENT';

const optionalStatTag = (file: string) => {
  try {
    const info = statSync(file, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (missingErrno(error)) return 'missing';
    throw error;
  }
};

// Opening a cleanly closed WAL-mode DB read-only causes SQLite to create
// -wal/-shm sidecars that a read-only handle cannot clean up on close.
// When WAL mode is set and no -shm exists, copy via kernel copyFileSync into a
// private temp dir so source directories are never mutated and no raw DB bytes
// enter JS memory. Active writers (where -shm already exists) are read directly.
const withReadonlyDatabase = <T>(file: string, fn: (database: Database) => T): T => {
  const needsSnapshot = isWalDatabase(file) && !existsSync(`${file}-shm`);
  let tempDir: string | undefined;
  let database: Database | undefined;
  try {
    let target = file;
    if (needsSnapshot) {
      tempDir = mkdtempSync(join(tmpdir(), 'token-tracker-ag-snap-'));
      target = join(tempDir, 'snapshot.db');
      const walFile = `${file}-wal`;
      let copied = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const beforeDb = optionalStatTag(file);
        const beforeWal = optionalStatTag(walFile);
        copyFileSync(file, target);
        if (beforeWal !== 'missing') {
          try {
            const walInfo = statSync(walFile);
            if (walInfo.size > 0) copyFileSync(walFile, `${target}-wal`);
            else rmSync(`${target}-wal`, { force: true });
          } catch (error) {
            if (!missingErrno(error)) throw error;
            rmSync(`${target}-wal`, { force: true });
          }
        } else {
          rmSync(`${target}-wal`, { force: true });
        }
        const afterDb = optionalStatTag(file);
        const afterWal = optionalStatTag(walFile);
        if (beforeDb === afterDb && beforeWal === afterWal) {
          copied = true;
          break;
        }
      }
      if (!copied) throw new Error('Antigravity database changed while creating a read snapshot.');
    }
    database = new Database(target, { readonly: true, create: false });
    database.exec('PRAGMA busy_timeout = 100');
    return fn(database);
  } finally {
    database?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
};

const tableColumns = (database: Database, table: string) =>
  new Set(
    database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );

const makeSqliteBlobReader = <K extends number | string>(
  statement: ReturnType<Database['query']>,
  key: K,
  totalLength: number,
  table: string,
  onSliceRead?: (table: string, offset: number, length: number) => void,
): BlobSliceReader => ({
  length: totalLength,
  read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > totalLength) return null;
    if (length === 0) return new Uint8Array(0);
    onSliceRead?.(table, offset, length);
    const row = statement.get(key, offset + 1, length) as { slice: unknown } | null;
    return asBytes(row?.slice);
  },
});

const deriveOutputTokens = (usage: AntigravityModelUsage): number | null => {
  if (usage.outputTokens > 0) return usage.outputTokens;
  const combined = usage.thinkingOutputTokens + usage.responseOutputTokens;
  if (!Number.isSafeInteger(combined) || combined < 0) return null;
  return combined;
};

const makeEvent = (
  conversationId: string,
  eventId: string,
  timestamp: string,
  model: string,
  project: string,
  repository: string | null,
  sessionTitle: string,
  usage: AntigravityModelUsage,
  serviceTier: string,
  sourceIndex: number,
) => {
  const outputTokens = deriveOutputTokens(usage);
  if (outputTokens === null) return { kind: 'malformed' as const };
  const inputTokens = usage.inputTokens;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheWriteTokens = usage.cacheWriteTokens;
  const reasoningTokens = Math.min(outputTokens, usage.thinkingOutputTokens);
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) return { kind: 'empty' as const };
  const event: UsageEvent = {
    id: eventId,
    timestamp,
    harness: 'antigravity',
    model: model || 'unknown',
    project: project || 'Unknown project',
    repository,
    sessionId: conversationId,
    ...(sessionTitle ? { sessionTitle } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    costUsd: 0,
    costKnown: false,
  };
  return {
    kind: 'event' as const,
    entry: {
      event,
      source: sourceIndex,
      sidechain: false,
      cacheWrite1h: 0,
      tier: normalizeServiceTier(serviceTier),
    },
  };
};

const tableHasRows = (database: Database, table: string) =>
  database.query<{ present: number }, []>(`SELECT 1 AS present FROM ${table} LIMIT 1`).get() !== null;

const tableHasInvalidIndices = (database: Database, table: string) =>
  database
    .query<{ present: number }, []>(
      `SELECT 1 AS present FROM ${table} WHERE typeof(idx) != 'integer' OR idx < 0 LIMIT 1`,
    )
    .get() !== null;

export const parseAntigravityDatabase = (
  file: string,
  conversationIdFromFile: string,
  options: AntigravityParseOptions = {},
): { parsed: ParsedFile; incomplete: boolean; repository: string | null } => {
  const sourceIndex = options.sourceIndex ?? 0;
  return withReadonlyDatabase(file, (database) => {
    database.exec('BEGIN');
    try {
      const tables = new Set(
        database
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      let conversationId = conversationIdFromFile;
      if (tables.has('trajectory_meta')) {
        const columns = tableColumns(database, 'trajectory_meta');
        if (columns.has('cascade_id')) {
          const meta = database
            .query<{ cascade_id: unknown }, []>('SELECT cascade_id FROM trajectory_meta LIMIT 1')
            .get();
          conversationId = cleanText(meta?.cascade_id, 512) || conversationId;
        }
      }

      let trajectory: AntigravityTrajectoryMetadata | null = null;
      let malformed = 0;
      let incomplete = false;
      if (tables.has('trajectory_metadata_blob')) {
        const columns = tableColumns(database, 'trajectory_metadata_blob');
        if (columns.has('id') && columns.has('data')) {
          const meta = database
            .query<{ len: unknown }, []>(
              "SELECT length(data) AS len FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1",
            )
            .get();
          const length = typeof meta?.len === 'number' && Number.isSafeInteger(meta.len) ? meta.len : 0;
          if (length > 0) {
            const sliceStmt = database.query<{ slice: unknown }, [string, number, number]>(
              'SELECT substr(data, ?2, ?3) AS slice FROM trajectory_metadata_blob WHERE id = ?1 LIMIT 1',
            );
            const reader = makeSqliteBlobReader(
              sliceStmt,
              'main',
              length,
              'trajectory_metadata_blob',
              options.onSliceRead,
            );
            trajectory = decodeTrajectoryMetadataFromReader(reader);
            if (!trajectory) malformed++;
          }
        }
      }

      const { project, repository } = pickWorkspace(trajectory, options.attachmentsDir);
      const fallbackTitle = cleanText(trajectory?.subagentRole);
      const fallbackStamp = trajectory?.createdAt || '';
      const parsed: ParsedFile = {
        events: [],
        malformed,
        sessionId: conversationId,
        parentId: trajectory?.parentConversationId || '',
        forkedAt: '',
        retractedIds: [],
        ...(project ? { workspaceRoot: project } : {}),
        ...(repository ? { workspaceRepository: repository } : {}),
      };
      const retractedIds = new Set<string>();

      // 1. Keyset-page steps metadata (allowlisted fields only via SQLite substr).
      const steps = new Map<number, AntigravityStepMetadata>();
      const stepsByAlias = new Map<string, { idx: number; step: AntigravityStepMetadata }[]>();
      if (tables.has('steps')) {
        const columns = tableColumns(database, 'steps');
        if (columns.has('idx') && columns.has('metadata')) {
          const pageStmt = database.query<{ idx: unknown; len: unknown }, [number, number]>(
            "SELECT idx, length(metadata) AS len FROM steps WHERE typeof(idx) = 'integer' AND idx > ?1 ORDER BY idx LIMIT ?2",
          );
          const sliceStmt = database.query<{ slice: unknown }, [number, number, number]>(
            'SELECT substr(metadata, ?2, ?3) AS slice FROM steps WHERE idx = ?1',
          );
          let cursor = -1;
          let scanned = 0;
          while (true) {
            const page = pageStmt.all(cursor, PAGE_SIZE);
            if (page.length === 0) break;
            let advanced = false;
            for (const row of page) {
              if (typeof row.idx !== 'number' || !Number.isSafeInteger(row.idx) || row.idx <= cursor) continue;
              cursor = row.idx;
              advanced = true;
              scanned++;
              const length = typeof row.len === 'number' && Number.isSafeInteger(row.len) ? row.len : 0;
              if (length <= 0) continue;
              const reader = makeSqliteBlobReader(sliceStmt, row.idx, length, 'steps', options.onSliceRead);
              const decoded = decodeStepMetadataFromReader(reader);
              if (!decoded) {
                parsed.malformed++;
                continue;
              }
              if (decoded.malformedUsage) parsed.malformed++;
              steps.set(row.idx, decoded);
              if (decoded.modelUsage) {
                for (const alias of responseAliases(decoded.modelUsage)) {
                  const bucket = stepsByAlias.get(alias);
                  if (bucket) bucket.push({ idx: row.idx, step: decoded });
                  else stepsByAlias.set(alias, [{ idx: row.idx, step: decoded }]);
                }
              }
            }
            if (!advanced) {
              incomplete = true;
              break;
            }
            if (page.length < PAGE_SIZE) break;
            if (scanned >= MAX_TOTAL_ROWS) {
              incomplete = true;
              break;
            }
          }
          if (tableHasInvalidIndices(database, 'steps')) {
            incomplete = true;
            parsed.malformed++;
          }
        } else if (tableHasRows(database, 'steps')) {
          incomplete = true;
          parsed.malformed++;
        }
      }

      // 2. Keyset-page executor_metadata keyed by execution_id.
      const executorByExecutionId = new Map<string, string>();
      if (tables.has('executor_metadata')) {
        const columns = tableColumns(database, 'executor_metadata');
        if (columns.has('idx') && columns.has('data')) {
          const pageStmt = database.query<{ idx: unknown; len: unknown }, [number, number]>(
            "SELECT idx, length(data) AS len FROM executor_metadata WHERE typeof(idx) = 'integer' AND idx > ?1 ORDER BY idx LIMIT ?2",
          );
          const sliceStmt = database.query<{ slice: unknown }, [number, number, number]>(
            'SELECT substr(data, ?2, ?3) AS slice FROM executor_metadata WHERE idx = ?1',
          );
          let cursor = -1;
          let scanned = 0;
          while (true) {
            const page = pageStmt.all(cursor, PAGE_SIZE);
            if (page.length === 0) break;
            let advanced = false;
            for (const row of page) {
              if (typeof row.idx !== 'number' || !Number.isSafeInteger(row.idx) || row.idx <= cursor) continue;
              cursor = row.idx;
              advanced = true;
              scanned++;
              const length = typeof row.len === 'number' && Number.isSafeInteger(row.len) ? row.len : 0;
              if (length <= 0) continue;
              const reader = makeSqliteBlobReader(sliceStmt, row.idx, length, 'executor_metadata', options.onSliceRead);
              const decoded = decodeExecutorMetadataFromReader(reader);
              const model = normalizeFallbackModel(decoded.modelName);
              if (decoded.executionId && model) executorByExecutionId.set(decoded.executionId, model);
            }
            if (!advanced) {
              incomplete = true;
              break;
            }
            if (page.length < PAGE_SIZE) break;
            if (scanned >= MAX_TOTAL_ROWS) {
              incomplete = true;
              break;
            }
          }
        }
      }

      // 3. Keyset-page gen_metadata (first pass collects all rows & model enum mappings).
      const generators: { idx: number; gen: AntigravityGeneratorMetadata }[] = [];
      const modelByEnum = new Map<number, string>();
      if (tables.has('gen_metadata')) {
        const columns = tableColumns(database, 'gen_metadata');
        if (columns.has('idx') && columns.has('data')) {
          const pageStmt = database.query<{ idx: unknown; len: unknown }, [number, number]>(
            "SELECT idx, length(data) AS len FROM gen_metadata WHERE typeof(idx) = 'integer' AND idx > ?1 ORDER BY idx LIMIT ?2",
          );
          const sliceStmt = database.query<{ slice: unknown }, [number, number, number]>(
            'SELECT substr(data, ?2, ?3) AS slice FROM gen_metadata WHERE idx = ?1',
          );
          let cursor = -1;
          let scanned = 0;
          while (true) {
            const page = pageStmt.all(cursor, PAGE_SIZE);
            if (page.length === 0) break;
            let advanced = false;
            for (const row of page) {
              if (typeof row.idx !== 'number' || !Number.isSafeInteger(row.idx) || row.idx <= cursor) continue;
              cursor = row.idx;
              advanced = true;
              scanned++;
              const length = typeof row.len === 'number' && Number.isSafeInteger(row.len) ? row.len : 0;
              if (length <= 0) continue;
              const reader = makeSqliteBlobReader(sliceStmt, row.idx, length, 'gen_metadata', options.onSliceRead);
              const gen = decodeGeneratorMetadataFromReader(reader);
              if (!gen) {
                parsed.malformed++;
                continue;
              }
              const explicitModel =
                normalizeResponseModel(gen.responseModel) ||
                normalizeResponseModel(gen.responseModelFull) ||
                normalizeFallbackModel(gen.plannerModelName);
              const modelEnum = gen.modelEnum || gen.usage?.modelEnum || 0;
              if (explicitModel && modelEnum > 0 && !modelByEnum.has(modelEnum))
                modelByEnum.set(modelEnum, explicitModel);
              generators.push({ idx: row.idx, gen });
            }
            if (!advanced) {
              incomplete = true;
              break;
            }
            if (page.length < PAGE_SIZE) break;
            if (scanned >= MAX_TOTAL_ROWS) {
              incomplete = true;
              break;
            }
          }
          if (tableHasInvalidIndices(database, 'gen_metadata')) {
            incomplete = true;
            parsed.malformed++;
          }
        } else if (tableHasRows(database, 'gen_metadata')) {
          incomplete = true;
          parsed.malformed++;
        }
      }

      // 4. Reconcile gen_metadata and steps.metadata by canonical native call identity.
      const responseIdsByAlias = new Map<string, Set<string>>();
      const stepResponseIds = new Set<string>();
      const registerResponseAliases = (usage: AntigravityModelUsage | null | undefined) => {
        if (!usage?.responseId) return;
        for (const alias of responseAliases(usage)) {
          if (alias === usage.responseId) continue;
          let set = responseIdsByAlias.get(alias);
          if (!set) {
            set = new Set();
            responseIdsByAlias.set(alias, set);
          }
          set.add(usage.responseId);
        }
      };
      for (const step of steps.values()) {
        if (step.modelUsage?.responseId) stepResponseIds.add(step.modelUsage.responseId);
        registerResponseAliases(step.modelUsage);
      }
      for (const { gen } of generators) registerResponseAliases(gen.usage);
      const ambiguousAliases = new Set<string>();
      const uniqueResponseIdByAlias = new Map<string, string>();
      for (const [alias, ids] of responseIdsByAlias) {
        if (ids.size > 1) ambiguousAliases.add(alias);
        else if (ids.size === 1) uniqueResponseIdByAlias.set(alias, [...ids][0]);
      }

      const eventsById = new Map<string, ParsedFile['events'][number]>();
      const recordEvent = (entry: ParsedFile['events'][number]) => {
        const existing = eventsById.get(entry.event.id);
        if (!existing) {
          eventsById.set(entry.event.id, entry);
          return;
        }
        const incomingTotal =
          entry.event.inputTokens +
          entry.event.outputTokens +
          entry.event.cacheReadTokens +
          entry.event.cacheWriteTokens;
        const existingTotal =
          existing.event.inputTokens +
          existing.event.outputTokens +
          existing.event.cacheReadTokens +
          existing.event.cacheWriteTokens;
        const preferIncoming =
          incomingTotal > existingTotal ||
          (incomingTotal === existingTotal &&
            ((existing.event.model === 'unknown' && entry.event.model !== 'unknown') ||
              (!existing.tier && Boolean(entry.tier))));
        if (preferIncoming) eventsById.set(entry.event.id, entry);
      };

      const coveredUsagesByAlias = new Map<string, AntigravityModelUsage[]>();
      const coveredSteps = new Set<number>();
      const recordCoveredUsage = (usage: AntigravityModelUsage, extra?: AntigravityModelUsage | null) => {
        const merged: AntigravityModelUsage = {
          ...usage,
          responseId: usage.responseId || extra?.responseId || '',
          messageId: usage.messageId || extra?.messageId || '',
          providerAssignedMessageId: usage.providerAssignedMessageId || extra?.providerAssignedMessageId || '',
        };
        for (const alias of responseAliases(merged)) {
          const bucket = coveredUsagesByAlias.get(alias);
          if (bucket) bucket.push(merged);
          else coveredUsagesByAlias.set(alias, [merged]);
        }
      };
      const isCoveredByAlias = (candidate: AntigravityModelUsage) => {
        for (const alias of responseAliases(candidate)) {
          const bucket = coveredUsagesByAlias.get(alias);
          if (bucket && matchesCoveredUsage(bucket, candidate)) return true;
        }
        return false;
      };

      const responseIdsByStep = new Map<number, Set<string>>();
      const matchedGenerators: {
        genIdx: number;
        gen: AntigravityGeneratorMetadata;
        usage: AntigravityModelUsage;
        aliases: string[];
        matchedStepIdx: number | undefined;
        matchedStep: AntigravityStepMetadata | undefined;
        fallbackStepIdx: number | undefined;
        compatibleStepUsage: AntigravityModelUsage | null;
      }[] = [];
      for (const { idx: genIdx, gen } of generators) {
        const usage = gen.usage;
        if (!usage) continue;
        const aliases = responseAliases(usage);
        let matchedStepIdx: number | undefined;
        let matchedStep: AntigravityStepMetadata | undefined;
        const referencedSteps = new Set(gen.stepIndices);
        // Prefer an exact responseId match first; for shared aliases, prefer
        // a step explicitly referenced by gen.stepIndices, falling back to a
        // unique alias match when no step indices disambiguate it.
        if (usage.responseId) {
          const exactHits = stepsByAlias.get(usage.responseId);
          const exact =
            exactHits?.find(
              (candidate) =>
                candidate.step.modelUsage?.responseId === usage.responseId && referencedSteps.has(candidate.idx),
            ) ?? exactHits?.find((candidate) => candidate.step.modelUsage?.responseId === usage.responseId);
          if (exact) {
            matchedStepIdx = exact.idx;
            matchedStep = exact.step;
          }
        }
        if (matchedStep === undefined) {
          for (const alias of aliases) {
            const candidates = stepsByAlias.get(alias);
            if (!candidates) continue;
            const compatible = candidates.filter(
              (candidate) => candidate.step.modelUsage && compatibleUsage(usage, candidate.step.modelUsage),
            );
            const hit =
              compatible.find((candidate) => referencedSteps.has(candidate.idx)) ??
              (compatible.length === 1 ? compatible[0] : undefined);
            if (hit) {
              matchedStepIdx = hit.idx;
              matchedStep = hit.step;
              break;
            }
          }
        }
        let fallbackStepIdx: number | undefined;
        if (matchedStep === undefined) {
          for (const candidateIdx of gen.stepIndices) {
            const candidate = steps.get(candidateIdx);
            if (!candidate) continue;
            if (fallbackStepIdx === undefined) fallbackStepIdx = candidateIdx;
            if (candidate.modelUsage) {
              if (compatibleUsage(usage, candidate.modelUsage)) {
                matchedStepIdx = candidateIdx;
                matchedStep = candidate;
                break;
              }
            } else if (matchedStep === undefined) {
              matchedStepIdx = candidateIdx;
              matchedStep = candidate;
            }
          }
        }
        const compatibleStepUsage =
          matchedStep?.modelUsage && compatibleUsage(usage, matchedStep.modelUsage) ? matchedStep.modelUsage : null;
        if (matchedStepIdx !== undefined && compatibleStepUsage) {
          const stepResponseId = usage.responseId || compatibleStepUsage.responseId;
          if (stepResponseId) {
            let set = responseIdsByStep.get(matchedStepIdx);
            if (!set) {
              set = new Set();
              responseIdsByStep.set(matchedStepIdx, set);
            }
            set.add(stepResponseId);
          }
        }
        matchedGenerators.push({
          genIdx,
          gen,
          usage,
          aliases,
          matchedStepIdx,
          matchedStep,
          fallbackStepIdx,
          compatibleStepUsage,
        });
      }

      for (const {
        genIdx,
        gen,
        usage,
        aliases,
        matchedStepIdx,
        matchedStep,
        fallbackStepIdx,
        compatibleStepUsage,
      } of matchedGenerators) {
        const stepSharedAcrossResponses =
          matchedStepIdx !== undefined && (responseIdsByStep.get(matchedStepIdx)?.size ?? 0) > 1;
        const effectiveResponseKey = canonicalResponseIdentity(
          usage,
          compatibleStepUsage,
          ambiguousAliases,
          uniqueResponseIdByAlias,
          stepResponseIds,
          stepsByAlias,
        );
        let stamp = stepTimestamp(matchedStep, '');
        if (!stamp) {
          for (const candidateIdx of gen.stepIndices) {
            stamp = stepTimestamp(steps.get(candidateIdx), '');
            if (stamp) break;
          }
        }
        stamp = stamp || fallbackStamp;
        if (!stamp) {
          parsed.malformed++;
          continue;
        }
        const compatibleStep =
          matchedStep && (!matchedStep.modelUsage || compatibleStepUsage !== null) ? matchedStep : undefined;
        const pricingStep = stepSharedAcrossResponses ? undefined : compatibleStep;
        const pricingStepUsage = stepSharedAcrossResponses ? null : compatibleStepUsage;
        const modelEnum =
          gen.modelEnum || usage.modelEnum || pricingStepUsage?.modelEnum || pricingStep?.generatorModelEnum || 0;
        const executionId = gen.executionId || pricingStep?.executionId || '';
        const model =
          normalizeResponseModel(gen.responseModel) ||
          normalizeResponseModel(gen.responseModelFull) ||
          normalizeFallbackModel(gen.plannerModelName) ||
          modelByEnum.get(modelEnum) ||
          (executionId ? executorByExecutionId.get(executionId) : undefined) ||
          '';
        const serviceTier = usage.serviceTier || pricingStepUsage?.serviceTier || '';
        const stepIdFallback = matchedStepIdx ?? fallbackStepIdx;
        const eventId = effectiveResponseKey
          ? `antigravity:${encodeURIComponent(conversationId)}:response:${encodeURIComponent(effectiveResponseKey)}`
          : stepIdFallback !== undefined
            ? `antigravity:${encodeURIComponent(conversationId)}:step:${stepIdFallback}`
            : `antigravity:${encodeURIComponent(conversationId)}:gen:${genIdx}`;
        const created = makeEvent(
          conversationId,
          eventId,
          stamp,
          model,
          project,
          repository,
          fallbackTitle,
          usage,
          serviceTier,
          sourceIndex,
        );
        if (created.kind === 'malformed') {
          parsed.malformed++;
          continue;
        }
        if (created.kind === 'empty') continue;

        recordEvent(created.entry);
        // Withdraw superseded fallback IDs (alternate aliases and step/gen fallbacks)
        // when reconciling a call under its canonical identity so prior syncs do not
        // double-bill after metadata arrives or changes.
        const mergedAliases = new Set([
          ...aliases,
          ...(compatibleStepUsage ? responseAliases(compatibleStepUsage) : []),
        ]);
        if (effectiveResponseKey) {
          for (const alias of mergedAliases) {
            if (alias !== effectiveResponseKey)
              retractedIds.add(
                `antigravity:${encodeURIComponent(conversationId)}:response:${encodeURIComponent(alias)}`,
              );
          }
          if (matchedStepIdx !== undefined && compatibleStep !== undefined)
            retractedIds.add(`antigravity:${encodeURIComponent(conversationId)}:step:${matchedStepIdx}`);
          retractedIds.add(`antigravity:${encodeURIComponent(conversationId)}:gen:${genIdx}`);
        } else if (stepIdFallback !== undefined && compatibleStep !== undefined) {
          retractedIds.add(`antigravity:${encodeURIComponent(conversationId)}:gen:${genIdx}`);
        }
        // Mark coverage ONLY after accepting a valid non-zero generator event.
        recordCoveredUsage(usage, compatibleStepUsage);
        if (aliases.length > 0 || compatibleStepUsage) {
          if (matchedStepIdx !== undefined && compatibleStep !== undefined) coveredSteps.add(matchedStepIdx);
          for (const stepIdx of gen.stepIndices) {
            const candidateUsage = steps.get(stepIdx)?.modelUsage;
            if (!candidateUsage) continue;
            if (responseAliases(candidateUsage).length === 0 || isCoveredByAlias(candidateUsage))
              coveredSteps.add(stepIdx);
          }
        } else {
          if (matchedStepIdx !== undefined && compatibleStep !== undefined) coveredSteps.add(matchedStepIdx);
          for (const stepIdx of gen.stepIndices) {
            const candidateUsage = steps.get(stepIdx)?.modelUsage;
            if (!candidateUsage || responseAliases(candidateUsage).length === 0) coveredSteps.add(stepIdx);
          }
        }
      }

      // 5. Fallback for steps with modelUsage not already emitted by gen_metadata.
      for (const [stepIndex, step] of steps.entries()) {
        const usage = step.modelUsage;
        if (!usage) continue;
        const aliases = responseAliases(usage);
        if (aliases.length ? isCoveredByAlias(usage) : coveredSteps.has(stepIndex)) continue;
        const stamp = stepTimestamp(step, fallbackStamp);
        if (!stamp) {
          parsed.malformed++;
          continue;
        }
        const modelEnum = usage.modelEnum || step.generatorModelEnum;
        const model =
          modelByEnum.get(modelEnum) ||
          (step.executionId ? executorByExecutionId.get(step.executionId) : undefined) ||
          '';
        const responseKey = canonicalResponseIdentity(
          usage,
          null,
          ambiguousAliases,
          uniqueResponseIdByAlias,
          stepResponseIds,
          stepsByAlias,
        );
        const eventId = responseKey
          ? `antigravity:${encodeURIComponent(conversationId)}:response:${encodeURIComponent(responseKey)}`
          : `antigravity:${encodeURIComponent(conversationId)}:step:${stepIndex}`;
        const created = makeEvent(
          conversationId,
          eventId,
          stamp,
          model,
          project,
          repository,
          fallbackTitle,
          usage,
          usage.serviceTier,
          sourceIndex,
        );
        if (created.kind === 'malformed') {
          parsed.malformed++;
          continue;
        }
        if (created.kind === 'empty') continue;
        recordEvent(created.entry);
        if (responseKey) {
          for (const alias of aliases) {
            if (alias !== responseKey)
              retractedIds.add(
                `antigravity:${encodeURIComponent(conversationId)}:response:${encodeURIComponent(alias)}`,
              );
          }
          retractedIds.add(`antigravity:${encodeURIComponent(conversationId)}:step:${stepIndex}`);
        }
        recordCoveredUsage(usage);
        coveredSteps.add(stepIndex);
      }

      parsed.events = [...eventsById.values()];
      for (const id of eventsById.keys()) retractedIds.delete(id);
      parsed.retractedIds = [...retractedIds];
      database.exec('COMMIT');
      return { parsed, incomplete, repository };
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure on read error.
      }
      throw error;
    }
  });
};

const readSummaries = (file: string, attachmentsDir?: string): Map<string, SummaryRow> | null => {
  try {
    return withReadonlyDatabase(file, (database) => {
      const tables = new Set(
        database
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      if (!tables.has('conversation_summaries')) return new Map();
      const columns = tableColumns(database, 'conversation_summaries');
      if (!columns.has('conversation_id')) return new Map();
      const titleColumn = columns.has('title') ? 'title' : "'' AS title";
      const workspaceColumn = columns.has('workspace_uris') ? 'workspace_uris' : "'' AS workspace_uris";
      const parentColumn = columns.has('parent_conversation_id')
        ? 'parent_conversation_id'
        : "'' AS parent_conversation_id";
      // Never select preview or raw_summary: they can include prompt snippets.
      const rows = database
        .query<
          { conversation_id: unknown; title: unknown; workspace_uris: unknown; parent_conversation_id: unknown },
          []
        >(`SELECT conversation_id, ${titleColumn}, ${workspaceColumn}, ${parentColumn} FROM conversation_summaries`)
        .all();
      const map = new Map<string, SummaryRow>();
      for (const row of rows) {
        const id = cleanText(row.conversation_id, 512);
        if (!id) continue;
        let uris: string[] = [];
        if (typeof row.workspace_uris === 'string' && row.workspace_uris.trim()) {
          try {
            const parsed: unknown = JSON.parse(row.workspace_uris);
            if (Array.isArray(parsed)) uris = parsed.filter((item): item is string => typeof item === 'string');
          } catch {
            // Ignore malformed workspace URI JSON.
          }
        }
        map.set(id, {
          title: cleanText(row.title),
          project: pickWorkspaceFromUris(uris, attachmentsDir),
          parentId: cleanText(row.parent_conversation_id, 512),
        });
      }
      return map;
    });
  } catch {
    return null;
  }
};

const applyAntigravityParentProjects = (
  files: readonly ParsedFile[],
  metadataBySession: ReadonlyMap<string, ConversationMeta>,
) => {
  const parents = new Map<string, string>();
  const projects = new Map<string, ConversationMeta>();
  for (const file of files) {
    if (file.sessionId && file.parentId && file.parentId !== file.sessionId) parents.set(file.sessionId, file.parentId);
    const meta = file.sessionId ? metadataBySession.get(file.sessionId) : undefined;
    const knownProject =
      (meta?.project && meta.project !== 'Unknown project' ? meta.project : '') ||
      (file.workspaceRoot && file.workspaceRoot !== 'Unknown project' ? file.workspaceRoot : '') ||
      file.events.find(({ event }) => event.project !== 'Unknown project')?.event.project ||
      '';
    const knownRepo =
      meta?.repository ??
      file.workspaceRepository ??
      file.events.find(({ event }) => event.repository !== null)?.event.repository ??
      null;
    if (file.sessionId && knownProject && !projects.has(file.sessionId))
      projects.set(file.sessionId, { project: knownProject, repository: knownRepo });
  }
  for (const file of files) {
    if (!file.parentId) continue;
    let parent: string | undefined = file.parentId;
    let inherited: ConversationMeta | undefined;
    const visited = new Set([file.sessionId]);
    while (parent && !inherited && !visited.has(parent)) {
      visited.add(parent);
      inherited = projects.get(parent);
      parent = parents.get(parent);
    }
    if (!inherited) continue;
    for (const { event } of file.events) {
      if (event.project === 'Unknown project') {
        event.project = inherited.project;
        if (event.repository === null && inherited.repository !== null) event.repository = inherited.repository;
      }
    }
  }
};

export const collectAntigravityFiles = Effect.fn('usage.collectAntigravityFiles')(function* (
  sources: readonly { source: MutableSource; index: number }[],
  options: {
    home: string;
    t3DataDirectory?: string;
    cacheDirectory?: string;
    retainedCacheFiles?: Set<string>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache =
    options.cacheDirectory && (yield* prepareParsedCache(options.cacheDirectory)) ? options.cacheDirectory : undefined;
  const configuredT3 = options.t3DataDirectory ?? process.env.TOKEN_TRACKER_T3_DATA_DIR;
  const t3Root = configuredT3?.trim() || path.join(options.home, '.t3', 'userdata');
  const t3Directory = path.resolve(
    t3Root === '~' ? options.home : t3Root.startsWith('~/') ? path.join(options.home, t3Root.slice(2)) : t3Root,
  );
  const attachmentsDir = path.join(t3Directory, 'attachments');

  const warnings: string[] = [];
  const files: ParsedFile[] = [];
  const metadataBySession = new Map<string, ConversationMeta>();
  let incomplete = false;

  const optionalSignature = Effect.fn('usage.antigravity.optionalSignature')(function* (file: string) {
    const info = yield* Effect.result(fileSignature(file));
    if (Result.isSuccess(info)) return info.success.signature;
    const exists = yield* Effect.result(fs.stat(file));
    if (Result.isFailure(exists) && exists.failure.reason._tag === 'NotFound') return 'missing';
    incomplete = true;
    return null;
  });

  const databaseSignature = Effect.fn('usage.antigravity.databaseSignature')(function* (file: string) {
    const main = yield* Effect.result(fileSignature(file));
    if (Result.isFailure(main)) {
      incomplete = true;
      return null;
    }
    const wal = yield* optionalSignature(`${file}-wal`);
    const journal = yield* optionalSignature(`${file}-journal`);
    if (wal === null || journal === null) return null;
    return `${CACHE_PREFIX}:${attachmentsDir}:${main.success.signature}:${wal}:${journal}`;
  });

  const regularFile = Effect.fn('usage.antigravity.regularFile')(function* (file: string) {
    if (Result.isSuccess(yield* Effect.result(fs.readLink(file)))) return false;
    const info = yield* Effect.result(fs.stat(file));
    if (Result.isFailure(info) && info.failure.reason._tag !== 'NotFound') incomplete = true;
    return Result.isSuccess(info) && info.success.type === 'File';
  });

  for (const { source, index } of sources) {
    source.files = 0;
    delete source.error;
    source.status = 'missing';
    const root = yield* Effect.result(fs.realPath(source.path));
    if (Result.isFailure(root)) {
      if (root.failure.reason._tag !== 'NotFound') {
        incomplete = true;
        source.status = 'error';
        source.error = 'Antigravity usage directory could not be read.';
        warnings.push(`antigravity: ${source.error}`);
      }
      continue;
    }
    const rootInfo = yield* Effect.result(fs.stat(root.success));
    if (Result.isFailure(rootInfo) || rootInfo.success.type !== 'Directory') {
      if (Result.isFailure(rootInfo)) incomplete = true;
      source.status = 'error';
      source.error = 'Antigravity usage source is not a readable directory.';
      warnings.push(`antigravity: ${source.error}`);
      continue;
    }

    const listed = yield* Effect.result(readUsageDirectory(root.success));
    if (Result.isFailure(listed)) {
      incomplete = true;
      source.status = 'error';
      source.error = 'Antigravity usage directory could not be read.';
      warnings.push(`antigravity: ${source.error}`);
      continue;
    }

    const paths: string[] = [];
    for (const entry of listed.success) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.db')) paths.push(path.join(root.success, entry.name));
    }
    paths.sort();
    source.files = paths.length;
    source.status = paths.length ? 'ready' : 'empty';

    let summaries = new Map<string, SummaryRow>();
    let summaryFailed = false;
    const summaryPath = path.join(path.dirname(root.success), 'conversation_summaries.db');
    if (yield* regularFile(summaryPath)) {
      const read = readSummaries(summaryPath, attachmentsDir);
      if (read) summaries = read;
      else {
        incomplete = true;
        summaryFailed = true;
      }
    }

    let malformed = 0;
    let unreadable = 0;
    let truncated = 0;
    for (const file of paths) {
      const signature = yield* databaseSignature(file);
      if (!signature) {
        unreadable++;
        continue;
      }
      const cachePath = cache ? parsedCachePath(cache, 'antigravity', file) : undefined;
      if (cachePath) options.retainedCacheFiles?.add(path.basename(cachePath));
      let parsed: ParsedFile | null = cachePath ? yield* readParsedCache(cachePath, signature) : null;
      let parsedRepo: string | null = null;
      if (!parsed) {
        const conversationId = path.basename(file, '.db');
        const read = yield* Effect.result(
          Effect.try({
            try: () => parseAntigravityDatabase(file, conversationId, { sourceIndex: index, attachmentsDir }),
            catch: () => new Error('Antigravity database could not be read.'),
          }),
        );
        if (Result.isFailure(read)) {
          incomplete = true;
          unreadable++;
          continue;
        }
        parsed = read.success.parsed;
        parsedRepo = read.success.repository;
        if (read.success.incomplete) {
          incomplete = true;
          truncated++;
        }
        if (cachePath && !read.success.incomplete) {
          const after = yield* databaseSignature(file);
          if (after && after === signature) yield* writeParsedCache(cachePath, signature, parsed);
        }
      }

      const summary = summaries.get(parsed.sessionId);
      if (summary) {
        if (!parsed.parentId && summary.parentId) parsed.parentId = summary.parentId;
        if (!parsed.workspaceRoot && summary.project) parsed.workspaceRoot = summary.project;
        for (const entry of parsed.events) {
          if (summary.title) entry.event.sessionTitle = summary.title;
          if (entry.event.project === 'Unknown project' && summary.project) entry.event.project = summary.project;
        }
      }

      const effectiveRepo = parsedRepo ?? parsed.workspaceRepository ?? null;
      if (parsed.sessionId && (parsed.workspaceRoot || effectiveRepo)) {
        const existing = metadataBySession.get(parsed.sessionId);
        metadataBySession.set(parsed.sessionId, {
          project: parsed.workspaceRoot || existing?.project || '',
          repository: effectiveRepo ?? existing?.repository ?? null,
        });
      }

      malformed += parsed.malformed;
      for (const entry of parsed.events) entry.source = index;
      files.push(parsed);
    }

    if (malformed || unreadable || truncated || summaryFailed) {
      source.status = 'partial';
      source.error = `Skipped ${malformed} malformed records; ${unreadable} files could not be read.${truncated ? ` ${truncated} files were partially scanned.` : ''}${summaryFailed ? ' Conversation summaries could not be read.' : ''}`;
      warnings.push(`antigravity: ${source.error}`);
    }
  }

  applyAntigravityParentProjects(files, metadataBySession);
  return { files, warnings, incomplete };
});
