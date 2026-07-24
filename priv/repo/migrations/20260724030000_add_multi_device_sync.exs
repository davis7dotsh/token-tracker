defmodule TokenTracker.Repo.Migrations.AddMultiDeviceSync do
  use Ecto.Migration

  def change do
    create table(:devices, primary_key: false) do
      add(:device_id, :string, primary_key: true)
      add(:name, :string, null: false)
      add(:node_name, :string)
      add(:token_hash, :string)
      add(:local, :boolean, null: false, default: false)
      add(:revoked_at, :utc_datetime_usec)
      add(:last_seen_at, :utc_datetime_usec)
      add(:last_sync_at, :utc_datetime_usec)
      timestamps(type: :utc_datetime_usec)
    end

    create(unique_index(:devices, [:name]))

    create table(:session_snapshots, primary_key: false) do
      add(:device_id, references(:devices, column: :device_id, type: :string), primary_key: true)
      add(:session_key, :string, primary_key: true)
      add(:agent, :string, null: false)
      add(:generation, :integer, null: false)
      add(:digest, :string, null: false)
      add(:started_at, :utc_datetime_usec, null: false)
      add(:last_activity_at, :utc_datetime_usec, null: false)
      add(:quality, :string, null: false, default: "exact")
      add(:received_at, :utc_datetime_usec, null: false)
    end

    create(index(:session_snapshots, [:device_id, :last_activity_at]))
    create(index(:session_snapshots, [:agent]))

    create table(:session_usage_hourly, primary_key: false) do
      add(:device_id, :string, primary_key: true)
      add(:session_key, :string, primary_key: true)
      add(:hour_utc, :utc_datetime_usec, primary_key: true)
      add(:project, :string, primary_key: true)
      add(:agent, :string, primary_key: true)
      add(:provider, :string, primary_key: true, default: "")
      add(:model, :string, primary_key: true)
      add(:pricing_tier, :string, primary_key: true, default: "standard")
      add(:input_tokens, :integer, null: false)
      add(:output_tokens, :integer, null: false)
      add(:reasoning_tokens, :integer, null: false)
      add(:cache_read_tokens, :integer, null: false)
      add(:cache_write_tokens, :integer, null: false)
      add(:session_starts, :integer, null: false)
    end

    create(index(:session_usage_hourly, [:hour_utc]))
    create(index(:session_usage_hourly, [:device_id]))
    create(index(:session_usage_hourly, [:project]))
    create(index(:session_usage_hourly, [:model]))

    create table(:session_outbox, primary_key: false) do
      add(:session_key, :string, primary_key: true)
      add(:generation, :integer, null: false)
      add(:digest, :string, null: false)
      add(:payload, :binary, null: false)
      add(:payload_bytes, :integer, null: false)
      add(:attempt_count, :integer, null: false, default: 0)
      add(:last_attempt_at, :utc_datetime_usec)
      add(:last_error, :text)
      timestamps(type: :utc_datetime_usec)
    end

    create(index(:session_outbox, [:inserted_at]))

    create table(:runtime_state, primary_key: false) do
      add(:key, :string, primary_key: true)
      add(:value, :text)
      add(:updated_at, :utc_datetime_usec, null: false)
    end
  end
end
