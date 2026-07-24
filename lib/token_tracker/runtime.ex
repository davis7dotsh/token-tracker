defmodule TokenTracker.Runtime do
  @moduledoc false

  alias TokenTracker.{Config, Network, Scheduler, Storage}

  def activate(config \\ Config.load!()) do
    :ok = Storage.migrate()

    with :ok <- validate(config),
         :ok <- configure_web(config),
         :ok <- Network.start(config) do
      children = child_specs(config)

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

  def child_specs(%{role: "host", web_enabled: true} = config) do
    [{TokenTracker.Sync.Server, config}, {Scheduler, config}, TokenTrackerWeb.Endpoint]
  end

  def child_specs(%{role: "host"} = config) do
    [{TokenTracker.Sync.Server, config}, {Scheduler, config}]
  end

  def child_specs(config), do: [{Scheduler, config}]

  defp configure_web(%{role: "host", web_enabled: true} = config) do
    with {:ok, ip} <- parse_ip(config.web_bind) do
      Application.put_env(:token_tracker, TokenTrackerWeb.Endpoint,
        adapter: Bandit.PhoenixAdapter,
        http: [ip: ip, port: config.web_port],
        render_errors: [formats: [json: TokenTrackerWeb.ErrorJSON]],
        secret_key_base: String.duplicate("token-tracker-local-only-", 4),
        server: true,
        url: [host: config.web_bind, port: config.web_port]
      )

      :ok
    end
  end

  defp configure_web(_config), do: :ok

  defp parse_ip(address) do
    case :inet.parse_ipv4_address(String.to_charlist(address)) do
      {:ok, parsed} -> {:ok, parsed}
      _ -> {:error, "invalid web bind address #{inspect(address)}"}
    end
  end
end
