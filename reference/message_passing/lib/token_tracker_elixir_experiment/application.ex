# Preserved reference code. This directory is not part of the active compiler paths.
defmodule TokenTrackerElixirExperiment.Application do
  @moduledoc false

  use Application

  alias TokenTrackerElixirExperiment.{Poller, StateSource}

  @impl true
  def start(_type, _args) do
    config = Application.get_all_env(:token_tracker_elixir_experiment)

    children =
      case Keyword.get(config, :role, "leaf") do
        "leaf" ->
          [StateSource]

        "root" ->
          [
            {Poller,
             targets: Keyword.get(config, :targets, []),
             poll_interval_ms: Keyword.get(config, :poll_interval_ms, 5_000),
             request_timeout_ms: Keyword.get(config, :request_timeout_ms, 1_500)}
          ]

        "both" ->
          [
            StateSource,
            {Poller,
             targets: Keyword.get(config, :targets, []),
             poll_interval_ms: Keyword.get(config, :poll_interval_ms, 5_000),
             request_timeout_ms: Keyword.get(config, :request_timeout_ms, 1_500)}
          ]

        role ->
          raise "unknown TTEX_ROLE #{inspect(role)}; expected leaf, root, or both"
      end

    Supervisor.start_link(children,
      strategy: :one_for_one,
      name: TokenTrackerElixirExperiment.Supervisor
    )
  end
end
