defmodule TokenTracker.Runtime do
  @moduledoc false

  alias TokenTracker.{Config, Network, Scheduler, Storage}

  def activate(config \\ Config.load!()) do
    :ok = Storage.migrate()

    with :ok <- validate(config),
         :ok <- Network.start(config) do
      children =
        if config.role == "host" do
          [
            {TokenTracker.Sync.Server, config},
            {Scheduler, config}
          ]
        else
          [{Scheduler, config}]
        end

      Enum.reduce_while(children, :ok, fn child, :ok ->
        case DynamicSupervisor.start_child(TokenTracker.RuntimeSupervisor, child) do
          {:ok, _pid} -> {:cont, :ok}
          {:error, {:already_started, _pid}} -> {:cont, :ok}
          {:error, reason} -> {:halt, {:error, reason}}
        end
      end)
    end
  end

  defp validate(%{role: role, device_id: id, cluster_cookie: cookie})
       when role in ["host", "client"] and is_binary(id) and id != "" and is_binary(cookie) and
              cookie != "",
       do: :ok

  defp validate(%{role: role}) when role in ["host", "client"],
    do: {:error, "setup is incomplete; device identity or cluster cookie is missing"}

  defp validate(_config), do: {:error, "standalone role does not run a network service"}
end
