# Preserved reference code. This directory is not part of the active compiler paths.
defmodule TokenTrackerElixirExperiment.StateSource do
  @moduledoc """
  Owns the current state of one leaf node.

  Requests are ordinary messages containing a caller PID and unique reference.
  A missing request or reply has no recovery protocol: the root asks again on
  its next interval.
  """

  use GenServer

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  end

  def current_state(server \\ __MODULE__) do
    GenServer.call(server, :current_state)
  end

  @impl true
  def init(_opts) do
    {:ok, %{started_at_ms: System.monotonic_time(:millisecond)}}
  end

  @impl true
  def handle_call(:current_state, _from, state) do
    {:reply, snapshot(state), state}
  end

  @impl true
  def handle_info({:state_request, reply_to, reference}, state)
      when is_pid(reply_to) and is_reference(reference) do
    send(reply_to, {:state_response, reference, Node.self(), snapshot(state)})
    {:noreply, state}
  end

  defp snapshot(state) do
    %{
      node: Node.self(),
      observed_at_ms: System.system_time(:millisecond),
      uptime_ms: System.monotonic_time(:millisecond) - state.started_at_ms,
      process_count: :erlang.system_info(:process_count),
      memory_bytes: :erlang.memory(:total)
    }
  end
end
