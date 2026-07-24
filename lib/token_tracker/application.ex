defmodule TokenTracker.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [TokenTracker.Repo]

    Supervisor.start_link(children,
      strategy: :one_for_one,
      name: TokenTracker.Supervisor
    )
  end
end
