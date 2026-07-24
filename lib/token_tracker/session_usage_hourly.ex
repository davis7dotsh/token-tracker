defmodule TokenTracker.SessionUsageHourly do
  use Ecto.Schema

  @primary_key false

  schema "session_usage_hourly" do
    field(:device_id, :string, primary_key: true)
    field(:session_key, :string, primary_key: true)
    field(:hour_utc, :utc_datetime_usec, primary_key: true)
    field(:project, :string, primary_key: true)
    field(:agent, :string, primary_key: true)
    field(:provider, :string, primary_key: true)
    field(:model, :string, primary_key: true)
    field(:pricing_tier, :string, primary_key: true)
    field(:input_tokens, :integer)
    field(:output_tokens, :integer)
    field(:reasoning_tokens, :integer)
    field(:cache_read_tokens, :integer)
    field(:cache_write_tokens, :integer)
    field(:session_starts, :integer)
  end
end
