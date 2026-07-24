defmodule TokenTracker.Device do
  use Ecto.Schema

  @primary_key {:device_id, :string, autogenerate: false}

  schema "devices" do
    field(:name, :string)
    field(:node_name, :string)
    field(:token_hash, :string, redact: true)
    field(:local, :boolean)
    field(:revoked_at, :utc_datetime_usec)
    field(:last_seen_at, :utc_datetime_usec)
    field(:last_sync_at, :utc_datetime_usec)
    timestamps(type: :utc_datetime_usec)
  end
end
