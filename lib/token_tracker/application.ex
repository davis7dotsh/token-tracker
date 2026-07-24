defmodule TokenTracker.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      TokenTracker.Repo,
      {DynamicSupervisor, name: TokenTracker.RuntimeSupervisor, strategy: :one_for_one}
    ]

    Supervisor.start_link(children,
      strategy: :one_for_one,
      name: TokenTracker.Supervisor
    )
  end

  @impl true
  def start_phase(:portable_cli, _start_type, _phase_args) do
    start_portable_cli()
    :ok
  end

  defp start_portable_cli do
    if Burrito.Util.running_standalone?() do
      Task.start(fn ->
        Burrito.Util.Args.argv()
        |> TokenTracker.CLI.main()

        System.halt(0)
      end)
    end
  end
end
