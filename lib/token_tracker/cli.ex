defmodule TokenTracker.CLI do
  @moduledoc false

  alias TokenTracker.{
    Collector,
    Config,
    Network,
    Paths,
    Pricing,
    Report,
    Runtime,
    Scheduler,
    Service,
    Sessions,
    Setup,
    Storage
  }

  @version Mix.Project.config()[:version]

  def main_from_env do
    count =
      "TOKEN_TRACKER_CLI_ARG_COUNT"
      |> System.fetch_env!()
      |> String.to_integer()

    args =
      if count == 0 do
        []
      else
        Enum.map(0..(count - 1), &System.fetch_env!("TOKEN_TRACKER_CLI_ARG_#{&1}"))
      end

    main(args)
  end

  def main(args) do
    case args do
      ["collect" | rest] -> collect(rest)
      ["summary" | rest] -> summary(rest)
      ["sync", "--once" | rest] -> sync_once(rest)
      ["status" | rest] -> status(rest)
      ["setup", role | rest] when role in ["host", "client"] -> setup(role, rest)
      ["host", command | rest] -> host(command, rest)
      ["service", command | rest] -> service(command, rest)
      ["daemon"] -> daemon()
      ["--version"] -> IO.puts("token-tracker #{@version}")
      ["-v"] -> IO.puts("token-tracker #{@version}")
      ["help"] -> help()
      ["--help"] -> help()
      ["-h"] -> help()
      [] -> help()
      _ -> fail("unknown command")
    end
  end

  defp collect(args) do
    with {:ok, opts} <- parse(args, strict: [all: :boolean, home: :string], aliases: [a: :all]) do
      use_home(opts)
      ensure_storage()
      collection = Collector.collect()
      Sessions.put_state("last_collection_at", DateTime.utc_now() |> DateTime.to_iso8601())
      config = Config.load!()
      pricing = Report.models() |> Pricing.load()
      Sessions.reconcile_local(config)
      Report.print(collection, all: opts[:all] || false, pricing: pricing)
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp summary(args) do
    with {:ok, opts} <-
           parse(args,
             strict: [all: :boolean, device: :string, home: :string],
             aliases: [a: :all]
           ) do
      use_home(opts)
      ensure_storage()
      config = Config.load!()

      if config.role == "host" do
        Report.print_combined(all: opts[:all] || false, device: opts[:device])
      else
        pricing = Report.models() |> Pricing.load()
        Report.print_local(all: opts[:all] || false, pricing: pricing)
      end
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp sync_once(args) do
    with {:ok, opts} <- parse(args, strict: [home: :string]) do
      use_home(opts)
      ensure_storage()
      config = Config.load!()
      result = Scheduler.run_cycle(config, node_name: Config.transient_node(config))
      print_sync_result(result)
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp setup("host", args) do
    with {:ok, opts} <-
           parse(args,
             strict: [
               non_interactive: :boolean,
               force: :boolean,
               name: :string,
               address: :string,
               name_mode: :string,
               home: :string
             ]
           ) do
      use_home(opts)
      existing = existing_config_for_setup!(opts)
      {name, address, name_mode} = host_setup_values(opts, existing)

      {:ok, config} =
        Setup.host(
          name: name,
          address: address,
          name_mode: name_mode,
          device_id: existing && existing.device_id,
          cluster_cookie: existing && existing.cluster_cookie
        )

      ensure_storage()
      Sessions.ensure_local_device(config)
      IO.puts("Configured host #{config.device_name} at #{Config.local_node(config)}")
      IO.puts("Config: #{Paths.config()}")
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp setup("client", args) do
    with {:ok, opts} <-
           parse(args,
             strict: [
               non_interactive: :boolean,
               force: :boolean,
               enrollment: :string,
               address: :string,
               home: :string
             ]
           ) do
      use_home(opts)
      existing_config_for_setup!(opts)
      {enrollment, address} = client_setup_values(opts)
      {:ok, config} = Setup.client(enrollment, address: address)
      IO.puts("Configured client #{config.device_name} as #{Config.local_node(config)}")
      IO.puts("Config: #{Paths.config()}")
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp host("enroll", args) do
    {opts, positional, invalid} =
      OptionParser.parse(args, strict: [output: :string, home: :string])

    cond do
      invalid != [] ->
        fail("invalid options: #{inspect(invalid)}")

      length(positional) != 1 ->
        fail("host enroll requires exactly one device name")

      true ->
        use_home(opts)
        ensure_storage()
        config = require_host!()
        [name] = positional
        {:ok, enrollment} = Setup.enroll(name, config, opts[:output])
        IO.puts("Enrolled #{name} as #{enrollment.device_id}")
        IO.puts("Private enrollment file: #{enrollment.path}")
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp host("revoke", args) do
    with {:ok, opts, [identity]} <- parse_positional(args, 1, strict: [home: :string]) do
      use_home(opts)
      ensure_storage()
      require_host!()

      case Sessions.revoke_device(identity) do
        :ok -> IO.puts("Revoked #{identity}")
        {:error, :not_found} -> fail("device not found")
      end
    else
      _ -> fail("host revoke requires exactly one device name or ID")
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp host("devices", args) do
    with {:ok, opts} <- parse(args, strict: [home: :string]) do
      use_home(opts)
      ensure_storage()
      require_host!()
      print_devices(Sessions.devices())
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp host(_command, _args), do: fail("unknown host command")

  defp status(args) do
    with {:ok, opts} <- parse(args, strict: [home: :string]) do
      use_home(opts)
      ensure_storage()
      config = Config.load!()
      IO.puts("Token Tracker status")
      IO.puts("  Role: #{config.role}")
      IO.puts("  Device: #{config.device_name || "not configured"}")
      IO.puts("  Device ID: #{config.device_id || "not configured"}")
      IO.puts("  Configured node identity: #{Config.local_node(config) || "not configured"}")
      IO.puts("  Service: #{Service.state()}")
      IO.puts("  Last collection: #{Sessions.get_state("last_collection_at") || "never"}")
      IO.puts("  Pending sessions: #{Sessions.pending_count()}")
      IO.puts("  Last sync: #{Sessions.get_state("last_sync_at") || "never"}")
      IO.puts("  Last error: #{Sessions.get_state("last_sync_error") || "none"}")

      if config.role == "host" and config.web_enabled do
        IO.puts("  Dashboard: http://#{config.web_bind}:#{config.web_port}")
      end

      if config.role == "client" do
        reachable =
          with :ok <- Network.start(config, node_name: Config.transient_node(config)),
               :ok <- Network.connect(config),
               do: "reachable",
               else: (_ -> "unreachable")

        IO.puts("  Host: #{Config.host_node(config)} (#{reachable})")
      end

      if config.role == "host" do
        counts =
          Enum.frequencies_by(Sessions.devices(), fn device ->
            cond do
              device.local -> :local
              device.revoked_at -> :revoked
              true -> :active
            end
          end)

        IO.puts("  Local devices: #{Map.get(counts, :local, 0)}")
        IO.puts("  Active remote devices: #{Map.get(counts, :active, 0)}")
        IO.puts("  Revoked remote devices: #{Map.get(counts, :revoked, 0)}")
      end
    end
  rescue
    error -> fail(Exception.message(error))
  end

  defp service(command, args) when command in ["install", "start", "stop", "status"] do
    with {:ok, opts} <- parse(args, strict: [home: :string]) do
      use_home(opts)

      result =
        case command do
          "install" -> Service.install()
          "start" -> Service.start()
          "stop" -> Service.stop()
          "status" -> Service.status()
        end

      case result do
        {:ok, ""} -> IO.puts("Service #{command} succeeded")
        {:ok, output} -> IO.puts(output)
        {:error, reason} -> fail(reason)
      end
    end
  end

  defp service(_command, _args), do: fail("unknown service command")

  defp daemon do
    Paths.ensure_home!()
    {:ok, _applications} = Application.ensure_all_started(:token_tracker)
    config = Config.load!()

    case Runtime.activate(config) do
      :ok ->
        IO.puts("Token Tracker #{config.role} service running as #{Config.local_node(config)}")
        Process.sleep(:infinity)

      {:error, reason} ->
        fail(inspect(reason))
    end
  end

  defp ensure_storage do
    Paths.ensure_home!()
    {:ok, _applications} = Application.ensure_all_started(:token_tracker)
    :ok = Storage.migrate()
  end

  defp require_host! do
    config = Config.load!()
    if config.role != "host", do: raise("command requires host role")
    config
  end

  defp host_setup_values(opts, existing) do
    default_name = (existing && existing.device_name) || hostname()
    default_address = (existing && existing.address) || "127.0.0.1"
    default_mode = (existing && existing.name_mode) || "long"

    if opts[:non_interactive] do
      {
        opts[:name] || default_name,
        opts[:address] || default_address,
        opts[:name_mode] || default_mode
      }
    else
      {
        prompt("Device name", opts[:name] || default_name),
        prompt("Network address", opts[:address] || default_address),
        prompt("BEAM name mode (long or short)", opts[:name_mode] || default_mode)
      }
    end
  end

  defp client_setup_values(opts) do
    if opts[:non_interactive] do
      enrollment =
        opts[:enrollment] ||
          raise "--enrollment FILE (or - for stdin) is required with --non-interactive"

      {enrollment, opts[:address]}
    else
      address = opts[:address] || prompt("This device's network address", "automatic")

      {
        opts[:enrollment] || prompt("Enrollment file", nil),
        if(address == "automatic", do: nil, else: address)
      }
    end
  end

  defp prompt(label, nil) do
    case IO.gets("#{label}: ") do
      nil -> raise "input ended before setup completed"
      value -> String.trim(value)
    end
  end

  defp prompt(label, default) do
    case IO.gets("#{label} [#{default}]: ") do
      nil -> raise "input ended before setup completed"
      value -> value |> String.trim() |> then(&if(&1 == "", do: default, else: &1))
    end
  end

  defp hostname do
    case :inet.gethostname() do
      {:ok, value} -> to_string(value)
      _ -> "token-tracker"
    end
  end

  defp existing_config_for_setup!(opts) do
    if File.exists?(Paths.config()) do
      existing = Config.load!()

      cond do
        opts[:force] ->
          existing

        opts[:non_interactive] ->
          raise "config already exists; pass --force to replace it"

        true ->
          answer = IO.gets("Replace existing config at #{Paths.config()}? [y/N]: ")

          unless answer && String.downcase(String.trim(answer)) in ["y", "yes"] do
            raise "setup cancelled"
          end

          existing
      end
    else
      nil
    end
  end

  defp use_home(opts) do
    if home = opts[:home], do: System.put_env("TOKEN_TRACKER_HOME", home)
  end

  defp parse(args, options) do
    {opts, positional, invalid} = OptionParser.parse(args, options)

    cond do
      positional != [] -> {:error, "unexpected arguments: #{Enum.join(positional, " ")}"}
      invalid != [] -> {:error, "invalid options: #{inspect(invalid)}"}
      true -> {:ok, opts}
    end
    |> case do
      {:ok, parsed} -> {:ok, parsed}
      {:error, reason} -> fail(reason)
    end
  end

  defp parse_positional(args, count, options) do
    {opts, positional, invalid} = OptionParser.parse(args, options)

    if invalid == [] and length(positional) == count do
      {:ok, opts, positional}
    else
      {:error, :invalid}
    end
  end

  defp print_sync_result(result) do
    IO.puts(
      "Sync: #{Map.get(result, :accepted, 0)} accepted, " <>
        "#{Map.get(result, :rejected, 0)} rejected, " <>
        "#{Map.get(result, :pending, Sessions.pending_count())} pending"
    )

    if result[:error], do: IO.puts("Sync deferred: #{result.error}")
  end

  defp print_devices([]), do: IO.puts("No enrolled devices")

  defp print_devices(devices) do
    Enum.each(devices, fn device ->
      state =
        cond do
          device.local -> "local"
          device.revoked_at -> "revoked"
          true -> "enrolled"
        end

      last_sync = device.last_sync_at || "never"
      IO.puts("#{device.name}\t#{device.device_id}\t#{state}\tlast sync: #{last_sync}")
    end)
  end

  defp help do
    IO.puts("""
    Usage:
      token-tracker setup host|client [options]
      token-tracker host enroll DEVICE_NAME [--output FILE]
      token-tracker host revoke DEVICE_NAME_OR_ID
      token-tracker host devices
      token-tracker service install|start|stop|status
      token-tracker collect [--all]
      token-tracker sync --once
      token-tracker summary [--device DEVICE_NAME_OR_ID] [--all]
      token-tracker status
      token-tracker --version

    Common options:
      --home PATH          Override TOKEN_TRACKER_HOME
      --non-interactive    Run setup without prompts
      --force              Replace an existing config during setup

    Client setup reads a private enrollment file:
      token-tracker setup client --non-interactive --enrollment FILE
      token-tracker setup client --non-interactive --enrollment - < enrollment.json
    """)
  end

  defp fail(message) do
    IO.puts(:stderr, "token-tracker: #{message}")
    System.halt(1)
  end
end
