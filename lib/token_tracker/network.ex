defmodule TokenTracker.Network do
  @moduledoc false

  alias TokenTracker.Config

  def start(config, opts \\ [])

  def start(config, opts) when config.role in ["host", "client"] do
    if Node.alive?() do
      Node.set_cookie(String.to_atom(config.cluster_cookie))
      :ok
    else
      distribution_port =
        if Keyword.get(opts, :transient, false), do: 0, else: config.distribution_port

      System.put_env("ERL_EPMD_PORT", Integer.to_string(config.epmd_port))
      Application.put_env(:kernel, :inet_dist_listen_min, distribution_port)
      Application.put_env(:kernel, :inet_dist_listen_max, distribution_port)

      options = %{
        name_domain: Config.name_domain(config),
        hidden: config.role == "client",
        dist_listen: config.role == "host" and not Keyword.get(opts, :transient, false)
      }

      with :ok <- ensure_epmd(),
           {:ok, _pid} <-
             :net_kernel.start(Keyword.get(opts, :node_name, Config.local_node(config)), options) do
        Node.set_cookie(String.to_atom(config.cluster_cookie))
        :ok
      end
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def start(_config, _opts), do: :ok

  def connect(config) do
    host = Config.host_node(config)

    if host == Node.self() or :net_kernel.hidden_connect_node(host) do
      :ok
    else
      {:error, :unreachable}
    end
  end

  defp ensure_epmd do
    case :os.find_executable(~c"epmd") do
      false ->
        {:error, "epmd executable was not found"}

      path ->
        case System.cmd(to_string(path), ["-daemon"], stderr_to_stdout: true) do
          {_output, 0} ->
            :ok

          {output, status} ->
            {:error, "epmd exited with status #{status}: #{String.trim(output)}"}
        end
    end
  end
end
