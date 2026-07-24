defmodule TokenTracker.Counters do
  @moduledoc false

  @fields [
    :input_tokens,
    :output_tokens,
    :reasoning_tokens,
    :cache_read_tokens,
    :cache_write_tokens,
    :session_starts
  ]

  def zero, do: Map.new(@fields, &{&1, 0})

  def add(left, right) do
    Map.new(@fields, &{&1, Map.get(left, &1, 0) + Map.get(right, &1, 0)})
  end

  def total(counters) do
    counters.input_tokens +
      counters.output_tokens +
      counters.reasoning_tokens +
      counters.cache_read_tokens +
      counters.cache_write_tokens
  end

  def fields, do: @fields
end
