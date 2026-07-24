defmodule TokenTracker.Repo.Migrations.AddSessionReconcileQueue do
  use Ecto.Migration

  def up do
    create table(:session_reconcile_queue, primary_key: false) do
      add(:session_key, :string, primary_key: true)
      add(:version, :integer, null: false, default: 1)
      add(:updated_at, :utc_datetime_usec, null: false)
    end

    execute("""
    INSERT INTO session_reconcile_queue (session_key, version, updated_at)
    SELECT DISTINCT session_key, 1, CURRENT_TIMESTAMP FROM usage_events
    """)

    execute("""
    CREATE TRIGGER usage_events_reconcile_insert
    AFTER INSERT ON usage_events
    BEGIN
      INSERT INTO session_reconcile_queue (session_key, version, updated_at)
      VALUES (NEW.session_key, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(session_key) DO UPDATE SET
        version = version + 1,
        updated_at = CURRENT_TIMESTAMP;
    END
    """)

    execute("""
    CREATE TRIGGER usage_events_reconcile_update
    AFTER UPDATE ON usage_events
    BEGIN
      INSERT INTO session_reconcile_queue (session_key, version, updated_at)
      VALUES (NEW.session_key, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(session_key) DO UPDATE SET
        version = version + 1,
        updated_at = CURRENT_TIMESTAMP;
      INSERT INTO session_reconcile_queue (session_key, version, updated_at)
      SELECT OLD.session_key, 1, CURRENT_TIMESTAMP
      WHERE OLD.session_key != NEW.session_key
      ON CONFLICT(session_key) DO UPDATE SET
        version = version + 1,
        updated_at = CURRENT_TIMESTAMP;
    END
    """)

    execute("""
    CREATE TRIGGER usage_events_reconcile_delete
    AFTER DELETE ON usage_events
    BEGIN
      INSERT INTO session_reconcile_queue (session_key, version, updated_at)
      VALUES (OLD.session_key, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(session_key) DO UPDATE SET
        version = version + 1,
        updated_at = CURRENT_TIMESTAMP;
    END
    """)
  end

  def down do
    execute("DROP TRIGGER IF EXISTS usage_events_reconcile_delete")
    execute("DROP TRIGGER IF EXISTS usage_events_reconcile_update")
    execute("DROP TRIGGER IF EXISTS usage_events_reconcile_insert")
    drop(table(:session_reconcile_queue))
  end
end
