# Preserved reference tests. This directory is not part of the active test paths.
defmodule TokenTrackerElixirExperimentTest do
  use ExUnit.Case

  alias TokenTrackerElixirExperiment.StateSource

  test "says hello" do
    assert TokenTrackerElixirExperiment.hello() == :world
  end

  test "returns a replaceable current-state snapshot" do
    snapshot = StateSource.current_state()

    assert snapshot.node == Node.self()
    assert snapshot.process_count > 0
    assert snapshot.memory_bytes > 0
    assert snapshot.uptime_ms >= 0
  end

  test "answers an asynchronous state request" do
    reference = make_ref()
    send(StateSource, {:state_request, self(), reference})

    assert_receive {:state_response, ^reference, source_node, snapshot}
    assert source_node == Node.self()
    assert snapshot.observed_at_ms > 0
  end
end
