import type { SqlClient } from 'effect/sql';
import { Effect } from 'effect';

// On Bun even a read-only withTransaction starts with BEGIN IMMEDIATE. Inspect
// committed schema first so an already migrated hub can restart during an upload.
// Only skip the install when all three maintenance triggers still exist.
export const schemaInventory = (sql: SqlClient.SqlClient) =>
  sql<{ type: string; name: string }>`SELECT type, name FROM sqlite_master
    WHERE (type = 'table' AND name IN ('usage_migrations', 'usage_dimensions', 'usage_cross_window_ids', 'usage_copied_ids', 'usage_day_packs_v1'))
       OR (type = 'trigger' AND tbl_name = 'usage_events')`.pipe(
    Effect.map((rows) => {
      const tables = new Set(rows.filter((r) => r.type === 'table').map((r) => r.name));
      const triggers = new Set(rows.filter((r) => r.type === 'trigger').map((r) => r.name.toLowerCase()));
      return {
        tables,
        complete: (table: string) =>
          tables.has(table) && ['insert', 'delete', 'update'].every((op) => triggers.has(`${table}_${op}`)),
      };
    }),
  );
