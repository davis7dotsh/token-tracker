defmodule TokenTracker.Scheduler do
  @moduledoc false

  use GenServer

  alias TokenTracker.{Collector, Sessions, Sync}

  def start_link(config) do
    GenServer.start_link(__MODULE__, config, name: __MODULE__)
  end

  @impl true
  def init(config) do
    send(self(), :run)
    {:ok, config}
  end

  @impl true
  def handle_info(:run, config) do
    run_cycle(config)
    schedule(config)
    {:noreply, config}
  end

  def run_cycle(config, opts \\ []) do
    collector = Keyword.get(opts, :collector, &Collector.collect/0)
    reconciler = Keyword.get(opts, :reconciler, &Sessions.reconcile_local/1)

    collector.()
    Sessions.put_state("last_collection_at", DateTime.utc_now() |> DateTime.to_iso8601())

    reconciler.(config)

    if config.role == "client" do
      Sync.Client.sync_once(config, opts)
    else
      Sessions.put_state("last_sync_error", nil)
      %{batches: 0, accepted: 0, rejected: 0, pending: 0, error: nil}
    end
  rescue
    error ->
      Sessions.put_state("last_sync_error", Exception.message(error))
      %{error: Exception.message(error)}
  end

  defp schedule(config) do
    base = config.sync_interval_seconds * 1_000
    jitter = config.sync_jitter_seconds * 1_000
    offset = if jitter > 0, do: :rand.uniform(jitter * 2 + 1) - jitter - 1, else: 0
    Process.send_after(self(), :run, max(1_000, base + offset))
  end
end
