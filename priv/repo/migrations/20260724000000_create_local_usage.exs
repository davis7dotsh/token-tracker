defmodule TokenTracker.Repo.Migrations.CreateLocalUsage do
  use Ecto.Migration

  def change do
    create table(:usage_events, primary_key: false) do
      add(:event_key, :string, primary_key: true)
      add(:session_key, :string, null: false)
      add(:occurred_at, :utc_datetime_usec, null: false)
      add(:project, :string, null: false)
      add(:model, :string, null: false)
      add(:input_tokens, :integer, null: false)
      add(:output_tokens, :integer, null: false)
      add(:reasoning_tokens, :integer, null: false)
      add(:cache_read_tokens, :integer, null: false)
      add(:cache_write_tokens, :integer, null: false)
      add(:session_starts, :integer, null: false)
    end

    create(index(:usage_events, [:occurred_at]))
    create(index(:usage_events, [:project]))
    create(index(:usage_events, [:model]))

    create table(:file_checkpoints, primary_key: false) do
      add(:path_hash, :string, primary_key: true)
      add(:size, :integer, null: false)
      add(:mtime_ms, :integer, null: false)
      add(:parser_version, :string, null: false)
      timestamps(updated_at: false, type: :utc_datetime_usec)
    end
  end
end
