defmodule TokenTracker.SessionOutbox do
  use Ecto.Schema

  @primary_key {:session_key, :string, autogenerate: false}

  schema "session_outbox" do
    field(:generation, :integer)
    field(:digest, :string)
    field(:payload, :binary)
    field(:payload_bytes, :integer)
    field(:attempt_count, :integer)
    field(:last_attempt_at, :utc_datetime_usec)
    field(:last_error, :string)
    timestamps(type: :utc_datetime_usec)
  end
end
