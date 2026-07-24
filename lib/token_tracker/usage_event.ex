defmodule TokenTracker.UsageEvent do
  use Ecto.Schema

  @primary_key {:event_key, :string, autogenerate: false}
  @derive {Inspect, except: [:session_key]}

  schema "usage_events" do
    field(:session_key, :string)
    field(:occurred_at, :utc_datetime_usec)
    field(:project, :string)
    field(:model, :string)
    field(:input_tokens, :integer)
    field(:output_tokens, :integer)
    field(:reasoning_tokens, :integer)
    field(:cache_read_tokens, :integer)
    field(:cache_write_tokens, :integer)
    field(:session_starts, :integer)
  end
end
