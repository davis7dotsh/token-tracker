defmodule TokenTracker.FileCheckpoint do
  use Ecto.Schema

  @primary_key {:path_hash, :string, autogenerate: false}

  schema "file_checkpoints" do
    field(:size, :integer)
    field(:mtime_ms, :integer)
    field(:parser_version, :string)
    timestamps(updated_at: false, type: :utc_datetime_usec)
  end
end
