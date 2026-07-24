defmodule TokenTracker.SessionSnapshot do
  use Ecto.Schema

  @primary_key false

  schema "session_snapshots" do
    field(:device_id, :string, primary_key: true)
    field(:session_key, :string, primary_key: true)
    field(:agent, :string)
    field(:generation, :integer)
    field(:digest, :string)
    field(:started_at, :utc_datetime_usec)
    field(:last_activity_at, :utc_datetime_usec)
    field(:quality, :string)
    field(:received_at, :utc_datetime_usec)
  end
end
