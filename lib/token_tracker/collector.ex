defmodule TokenTracker.Collector do
  @moduledoc false

  alias TokenTracker.{Claude, Codex, Pi}

  @counter_fields [
    :total_files,
    :scanned_files,
    :skipped_files,
    :failed_files,
    :malformed_lines,
    :added_events,
    :updated_events
  ]

  def collect do
    [
      Codex.Scanner.collect(),
      Claude.Scanner.collect(),
      Pi.Scanner.collect()
    ]
    |> combine()
  end

  def combine(sources) do
    Enum.reduce(sources, %{sources: sources}, fn source, combined ->
      Enum.reduce(@counter_fields, combined, fn field, result ->
        Map.update(result, field, source[field], &(&1 + source[field]))
      end)
    end)
  end
end
