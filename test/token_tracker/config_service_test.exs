defmodule TokenTracker.ConfigServiceTest do
  use ExUnit.Case

  alias TokenTracker.{Config, Service, Setup}

  setup do
    TokenTracker.Repo.delete_all(TokenTracker.SessionOutbox)
    TokenTracker.Repo.delete_all(TokenTracker.SessionUsageHourly)
    TokenTracker.Repo.delete_all(TokenTracker.SessionSnapshot)
    TokenTracker.Repo.delete_all(TokenTracker.Device)
    TokenTracker.Repo.delete_all(TokenTracker.UsageEvent)
    Ecto.Adapters.SQL.query!(TokenTracker.Repo, "DELETE FROM session_reconcile_queue", [])
    :ok
  end

  test "config round trips through private TOML without inventing atom keys" do
    root = temp_root()
    path = Path.join(root, "config.toml")
    on_exit(fn -> File.rm_rf!(root) end)

    config =
      Config.defaults()
      |> Map.merge(%{
        role: "client",
        device_id: Config.generate_id(),
        device_name: "client-node",
        address: "10.0.0.2",
        host_address: "10.0.0.1",
        cluster_cookie: Config.generate_secret(),
        device_token: Config.generate_secret(),
        sync_interval_seconds: 120
      })

    assert :ok = Config.write(config, path)
    assert {:ok, loaded} = Config.load(path)
    assert loaded == config
    assert File.stat!(path).mode |> Bitwise.band(0o777) == 0o600
    assert Config.local_node(loaded) |> to_string() =~ "token_tracker_client_"
    assert Config.host_node(loaded) == :"token_tracker_host@10.0.0.1"
    refute Config.transient_node(loaded) == Config.transient_node(loaded)
  end

  test "known malformed config values and incompatible name modes are rejected" do
    root = temp_root()
    path = Path.join(root, "config.toml")
    on_exit(fn -> File.rm_rf!(root) end)

    File.write!(path, """
    version = 1
    role = "client"
    [network]
    name_mode = "sometimes"
    """)

    assert {:error, reason} = Config.load(path)
    assert reason =~ "name_mode"

    File.write!(path, """
    version = 1
    role = "standalone"
    [sync]
    interval_seconds = nope
    """)

    assert {:error, reason} = Config.load(path)
    assert reason =~ "sync.interval_seconds"

    File.write!(path, """
    version = 1
    role = "standalone"
    [sync]
    interval_secondz = 300
    """)

    assert {:error, reason} = Config.load(path)
    assert reason =~ "unknown config key sync.interval_secondz"
    assert reason =~ "line 4"

    File.write!(path, """
    version = 1
    role = "standalone"
    [synk]
    interval_seconds = 300
    """)

    assert {:error, reason} = Config.load(path)
    assert reason =~ "unknown config section [synk]"
    assert reason =~ "line 3"

    invalid =
      Config.defaults()
      |> Map.merge(%{
        role: "host",
        device_id: Config.generate_id(),
        device_name: "host",
        address: "simple-host",
        host_address: "simple-host",
        name_mode: "long",
        cluster_cookie: Config.generate_secret()
      })

    assert {:error, reason} = Config.validate(invalid)
    assert reason =~ "fully qualified"

    assert {:error, reason} =
             Config.defaults()
             |> Map.put(:web_bind, "0.0.0.0")
             |> Config.validate()

    assert reason =~ "loopback"

    assert :ok =
             Config.defaults()
             |> Map.put(:web_bind, "127.1.2.3")
             |> Config.validate()
  end

  test "forced host setup can preserve its permanent device identity" do
    root = temp_root()
    previous = System.get_env("TOKEN_TRACKER_HOME")
    System.put_env("TOKEN_TRACKER_HOME", root)

    on_exit(fn ->
      restore_env("TOKEN_TRACKER_HOME", previous)
      File.rm_rf!(root)
    end)

    {:ok, first} = Setup.host(name: "host", address: "127.0.0.1")

    {:ok, replaced} =
      Setup.host(name: "renamed-host", address: "127.0.0.1", device_id: first.device_id)

    assert replaced.device_id == first.device_id
  end

  test "host enrollment produces a private client input file with no command-line secret" do
    root = temp_root()
    previous = System.get_env("TOKEN_TRACKER_HOME")
    System.put_env("TOKEN_TRACKER_HOME", root)

    on_exit(fn ->
      restore_env("TOKEN_TRACKER_HOME", previous)
      File.rm_rf!(root)
    end)

    {:ok, host} = Setup.host(name: "host", address: "10.0.0.1")
    :ok = TokenTracker.Storage.migrate()
    TokenTracker.Sessions.ensure_local_device(host)
    output = Path.join(root, "enrollment.json")
    assert {:ok, result} = Setup.enroll("client", host, output)
    assert result.path == output
    assert File.stat!(output).mode |> Bitwise.band(0o777) == 0o600

    enrollment = Jason.decode!(File.read!(output))
    assert enrollment["cluster_cookie"] == host.cluster_cookie
    assert is_binary(enrollment["device_token"])

    refute File.read!(Config |> then(fn _ -> TokenTracker.Paths.config() end)) =~
             enrollment["device_token"]
  end

  test "service definitions keep the daemon supervised by the operating system" do
    launchd = Service.render_launchd("/opt/token tracker/bin/token-tracker", "/tmp/tracker home")
    systemd = Service.render_systemd("/opt/token-tracker", "/tmp/tracker")

    assert launchd =~ "KeepAlive"
    assert launchd =~ "<string>daemon</string>"
    assert launchd =~ "TOKEN_TRACKER_HOME"
    assert systemd =~ "ExecStart=/opt/token-tracker daemon"
    assert systemd =~ "Restart=on-failure"
    assert systemd =~ "WantedBy=default.target"
  end

  defp temp_root do
    root =
      Path.join(System.tmp_dir!(), "token-tracker-config-#{System.unique_integer([:positive])}")

    File.mkdir_p!(root)
    root
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
