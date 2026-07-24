defmodule TokenTracker.ConfigServiceTest do
  use ExUnit.Case

  alias TokenTracker.{Config, Runtime, Service, Setup}

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

  test "nil and empty config strings remain distinct across a round trip" do
    root = temp_root()
    path = Path.join(root, "config.toml")
    on_exit(fn -> File.rm_rf!(root) end)

    config = %{Config.defaults() | device_name: ""}

    assert :ok = Config.write(config, path)
    assert {:ok, loaded} = Config.load(path)
    assert loaded.device_id == nil
    assert loaded.cluster_cookie == nil
    assert loaded.device_name == ""
    assert File.read!(path) =~ "device_id = null"
    assert File.read!(path) =~ ~s(device_name = "")
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

    invalid_host_address = %{invalid | address: "host.example", host_address: "simple-host"}
    assert {:error, reason} = Config.validate(invalid_host_address)
    assert reason =~ "host_address"

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

    refute File.read!(TokenTracker.Paths.config()) =~
             enrollment["device_token"]
  end

  test "default enrollment names are collision-free and existing outputs are preserved" do
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

    assert {:ok, first} = Setup.enroll("a+b", host)
    assert {:ok, second} = Setup.enroll("a b", host)
    refute first.path == second.path
    assert File.regular?(first.path)
    assert File.regular?(second.path)

    existing = Path.join(root, "existing.json")
    File.write!(existing, "do not replace")
    before_count = TokenTracker.Repo.aggregate(TokenTracker.Device, :count)

    assert {:error, :eexist} = Setup.enroll("third", host, existing)
    assert File.read!(existing) == "do not replace"
    assert TokenTracker.Repo.aggregate(TokenTracker.Device, :count) == before_count
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

    quoted = Service.render_systemd("/opt/token-tracker", ~s(/tmp/tracker "quoted"))
    assert quoted =~ ~s(Environment=TOKEN_TRACKER_HOME="/tmp/tracker \\"quoted\\"")
  end

  test "runtime activation returns an error for an invalid web bind" do
    config =
      Config.defaults()
      |> Map.merge(%{
        role: "host",
        device_id: Config.generate_id(),
        device_name: "host",
        cluster_cookie: Config.generate_secret(),
        web_bind: "not-an-ip"
      })

    assert {:error, reason} = Runtime.activate(config)
    assert reason =~ "invalid web bind"
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
