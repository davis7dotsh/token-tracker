import type { SessionMetadata } from '../../shared/domain';

export type T3Metadata = SessionMetadata & { repositoryPaths: string[] };
export type T3DatabaseInput = { filenames: string[]; environmentId?: string; baseUrl: string };

// Keep all runtime dependencies inside this function: its source is embedded
// in a child Bun process, including in the minified standalone CLI.
export const queryT3Databases = async (input: T3DatabaseInput) => {
  const { Database } = await import('bun:sqlite');
  const text = (value: unknown, maximum = 1024) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value.trim() : undefined;
  const harness = (driver: unknown) => {
    if (driver === 'claudeAgent' || driver === 'claude') return 'claude';
    if (driver === 'codex' || driver === 'grok' || driver === 'pi') return driver;
    return undefined;
  };
  // This is the shared web/mobile route, including the environment that owns the
  // thread. A harness session UUID alone cannot address a T3 conversation.
  const threadUrl = (base: string, environmentId: string | undefined, threadId: string) => {
    if (!environmentId) return undefined;
    try {
      const url = new URL(base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        return undefined;
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
      return url.toString();
    } catch {
      return undefined;
    }
  };

  const metadataTables = [
    'orchestration_v2_projection_provider_threads',
    'orchestration_v2_projection_threads',
    'projection_projects',
    'projection_threads',
    'projection_thread_sessions',
    'provider_session_runtime',
  ] as const;
  const maximumRows = 20_000;

  const readDatabase = (
    filename: string,
    environmentId: string | undefined,
    baseUrl: string,
    deletedThreadIds: Set<string>,
  ) => {
    const database = new Database(filename, { readonly: true, create: false });
    const metadata = new Map<string, T3Metadata>();
    try {
      // Bound lock contention. No schema migrations, journal changes, or writes
      // are allowed against the application's live database.
      database.exec('PRAGMA busy_timeout = 100');
      const tables = new Set(
        database
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      const columns = new Map(
        metadataTables
          .filter((table) => tables.has(table))
          .map((table) => [
            table,
            new Set(
              database
                .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
                .all()
                .map((row) => row.name),
            ),
          ]),
      );
      const has = (table: (typeof metadataTables)[number], required: string[]) =>
        required.every((column) => columns.get(table)?.has(column));
      // V2 deletion is authoritative over migration-era projections, including
      // the older state.sqlite file read later in this collection.
      if (has('orchestration_v2_projection_threads', ['thread_id', 'deleted_at'])) {
        for (const row of database
          .query<{ threadId: unknown }, []>(`
          SELECT thread_id AS threadId FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NOT NULL LIMIT ${maximumRows}
        `)
          .all()) {
          const threadId = text(row.threadId, 512);
          if (threadId) deletedThreadIds.add(threadId);
        }
      }
      const insert = (row: Record<string, unknown>) => {
        const provider = harness(row.driver);
        const nativeId = text(row.nativeId, 512);
        const threadId = text(row.threadId, 512);
        if (!provider || !nativeId || !threadId) return;
        const key = `${provider}:${nativeId}`;
        // A newer V2 binding wins over migrated legacy runtime metadata.
        if (metadata.has(key)) return;
        if (row.deletedAt !== null && row.deletedAt !== undefined) deletedThreadIds.add(threadId);
        if (deletedThreadIds.has(threadId)) {
          // An explicit empty URL clears a previously uploaded link. Omitting
          // metadata would preserve it during the store's transient-error merge.
          metadata.set(key, { t3ThreadId: threadId, t3ThreadUrl: '', repositoryPaths: [] });
          return;
        }
        const title = text(row.title);
        const projectName = text(row.projectName);
        const url = threadUrl(baseUrl, environmentId, threadId);
        const repositoryPaths = [
          ...new Set(
            [text(row.worktreePath, 4096), text(row.workspaceRoot, 4096)].filter((value) => value !== undefined),
          ),
        ];
        metadata.set(key, {
          ...(title ? { sessionTitle: title } : {}),
          ...(projectName && projectName !== 'No project' ? { projectName } : {}),
          t3ThreadId: threadId,
          ...(url ? { t3ThreadUrl: url } : {}),
          repositoryPaths,
        });
      };
      const projectsAvailable = has('projection_projects', ['project_id', 'title', 'workspace_root']);
      const projectFields = projectsAvailable
        ? 'p.title AS projectName, p.workspace_root AS workspaceRoot'
        : 'NULL AS projectName, NULL AS workspaceRoot';
      const projectJoin = projectsAvailable ? 'LEFT JOIN projection_projects p ON p.project_id = t.project_id' : '';

      if (
        has('orchestration_v2_projection_provider_threads', ['thread_id', 'payload_json']) &&
        has('orchestration_v2_projection_threads', ['thread_id', 'project_id', 'title', 'payload_json'])
      ) {
        const deleted = columns.get('orchestration_v2_projection_threads')?.has('deleted_at')
          ? 't.deleted_at AS deletedAt'
          : 'NULL AS deletedAt';
        const ordering = columns.get('orchestration_v2_projection_provider_threads')?.has('updated_at')
          ? 'ORDER BY pt.updated_at DESC'
          : '';
        // Extract only the allowlisted JSON properties inside SQLite. Entire
        // payloads, transcripts, runtime output, and credentials never enter JS.
        for (const row of database
          .query<Record<string, unknown>, []>(`
          SELECT substr(json_extract(pt.payload_json, '$.nativeThreadRef.nativeId'), 1, 513) AS nativeId,
            json_extract(pt.payload_json, '$.nativeThreadRef.driver') AS driver,
            t.thread_id AS threadId, t.title AS title, ${deleted}, ${projectFields},
            CASE WHEN length(t.payload_json) <= 262144 AND json_valid(t.payload_json)
              THEN substr(json_extract(t.payload_json, '$.worktreePath'), 1, 4097) END AS worktreePath
          FROM (SELECT thread_id, payload_json ${ordering ? ', updated_at' : ''}
            FROM orchestration_v2_projection_provider_threads ${ordering.replace('pt.', '')}
            LIMIT ${maximumRows}) pt
          JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
          ${projectJoin}
          WHERE length(pt.payload_json) <= 262144 AND json_valid(pt.payload_json)
          ${ordering} LIMIT ${maximumRows}
        `)
          .all()) {
          const threadId = text(row.threadId, 512);
          if (threadId && row.deletedAt !== null) deletedThreadIds.add(threadId);
          insert(row);
        }
      }
      // If the bounded tombstone read fills up, legacy links are optional and
      // cannot safely be restored from an incomplete deletion index.
      if (deletedThreadIds.size < maximumRows && has('projection_threads', ['thread_id', 'project_id', 'title'])) {
        const deleted = columns.get('projection_threads')?.has('deleted_at')
          ? 't.deleted_at AS deletedAt'
          : 'NULL AS deletedAt';
        const worktree = columns.get('projection_threads')?.has('worktree_path') ? 't.worktree_path' : 'NULL';
        const common = `t.thread_id AS threadId, t.title AS title, ${deleted}, ${projectFields}, ${worktree} AS worktreePath`;
        if (has('provider_session_runtime', ['thread_id', 'provider_name', 'resume_cursor_json'])) {
          for (const row of database
            .query<Record<string, unknown>, []>(`
            SELECT COALESCE(json_extract(r.resume_cursor_json, '$.threadId'), json_extract(r.resume_cursor_json, '$.sessionId')) AS nativeId,
              r.provider_name AS driver, ${common}
            FROM provider_session_runtime r JOIN projection_threads t ON t.thread_id = r.thread_id ${projectJoin}
            WHERE json_valid(r.resume_cursor_json) LIMIT ${maximumRows}
          `)
            .all())
            insert(row);
        }
        if (
          has('projection_thread_sessions', ['thread_id', 'provider_name', 'provider_thread_id', 'provider_session_id'])
        ) {
          for (const row of database
            .query<Record<string, unknown>, []>(`
            SELECT COALESCE(s.provider_thread_id, s.provider_session_id) AS nativeId, s.provider_name AS driver, ${common}
            FROM projection_thread_sessions s JOIN projection_threads t ON t.thread_id = s.thread_id ${projectJoin}
            WHERE COALESCE(s.provider_thread_id, s.provider_session_id) IS NOT NULL LIMIT ${maximumRows}
          `)
            .all())
            insert(row);
        }
      }
      return metadata;
    } finally {
      database.close();
    }
  };

  const metadata = new Map<string, T3Metadata>();
  const deletedThreadIds = new Set<string>();
  for (const filename of input.filenames) {
    if (deletedThreadIds.size >= maximumRows) break;
    try {
      const result = readDatabase(filename, input.environmentId, input.baseUrl, deletedThreadIds);
      for (const [key, value] of result) if (!metadata.has(key)) metadata.set(key, value);
    } catch {
      // Optional metadata may disappear during a T3 upgrade or transient read.
    }
  }
  return [...metadata.entries()];
};
