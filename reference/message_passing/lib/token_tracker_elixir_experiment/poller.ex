# Preserved reference code. This directory is not part of the active compiler paths.
defmodule TokenTrackerElixirExperiment.Poller do
  @moduledoc """
  Periodically asks leaf nodes for their current state.

  The latest successful response replaces the root's cached view. Timeouts are
  logged and forgotten; the following poll is the retry.
  """

  use GenServer

  require Logger

  alias TokenTrackerElixirExperiment.StateSource

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    targets =
      opts
      |> Keyword.fetch!(:targets)
      |> Enum.map(&String.to_atom/1)

    state = %{
      targets: targets,
      poll_interval_ms: Keyword.fetch!(opts, :poll_interval_ms),
      request_timeout_ms: Keyword.fetch!(opts, :request_timeout_ms),
      pending: %{},
      latest: %{}
    }

    send(self(), :poll)
    {:ok, state}
  end

  @impl true
  def handle_info(:poll, state) do
    pending =
      Enum.reduce(state.targets, state.pending, fn target, pending ->
        reference = make_ref()

        send({StateSource, target}, {:state_request, self(), reference})
        Process.send_after(self(), {:request_timeout, reference}, state.request_timeout_ms)

        Logger.info("state requested", target: target)
        Map.put(pending, reference, target)
      end)

    Process.send_after(self(), :poll, state.poll_interval_ms)
    {:noreply, %{state | pending: pending}}
  end

  def handle_info({:state_response, reference, source_node, snapshot}, state) do
    case Map.pop(state.pending, reference) do
      {nil, _pending} ->
        {:noreply, state}

      {_target, pending} ->
        Logger.info("state received",
          source: source_node,
          processes: snapshot.process_count,
          memory_bytes: snapshot.memory_bytes
        )

        {:noreply,
         %{
           state
           | pending: pending,
             latest: Map.put(state.latest, source_node, snapshot)
         }}
    end
  end

  def handle_info({:request_timeout, reference}, state) do
    case Map.pop(state.pending, reference) do
      {nil, _pending} ->
        {:noreply, state}

      {target, pending} ->
        Logger.info("state request timed out; next poll will try again", target: target)
        {:noreply, %{state | pending: pending}}
    end
  end
end
