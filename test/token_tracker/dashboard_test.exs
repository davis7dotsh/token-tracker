defmodule TokenTracker.DashboardTest do
  use ExUnit.Case

  import Plug.Conn
  import Plug.Test

  alias TokenTracker.{
    Dashboard,
    Device,
    Repo,
    SessionOutbox,
    SessionSnapshot,
    SessionUsageHourly,
    Runtime
  }

  setup do
    previous_loader = Application.get_env(:token_tracker, :dashboard_pricing_loader)
    Application.put_env(:token_tracker, :dashboard_pricing_loader, &__MODULE__.test_pricing/1)

    on_exit(fn ->
      if previous_loader do
        Application.put_env(:token_tracker, :dashboard_pricing_loader, previous_loader)
      else
        Application.delete_env(:token_tracker, :dashboard_pricing_loader)
      end
    end)

    Repo.delete_all(SessionOutbox)
    Repo.delete_all(SessionUsageHourly)
    Repo.delete_all(SessionSnapshot)
    Repo.delete_all(Device)
    Ecto.Adapters.SQL.query!(Repo, "DELETE FROM runtime_state", [])

    now = ~U[2026-11-01 12:00:00.000000Z]

    Repo.insert_all(Device, [
      %{
        device_id: "device-1",
        name: "host-device",
        local: true,
        inserted_at: now,
        updated_at: now
      }
    ])

    insert_session("session-a", ~U[2026-11-01 08:00:00.000000Z], "alpha", "codex", 100)
    insert_session("session-b", ~U[2026-11-01 09:00:00.000000Z], "beta", "claude-code", 200)
    :ok
  end

  test "day report preserves repeated DST hours and distinct filtered sessions" do
    pricing = fn _models -> pricing() end

    assert {:ok, response} =
             Dashboard.report(
               %{
                 "period" => "day",
                 "view" => "project",
                 "tz" => "America/Los_Angeles",
                 "project" => ["beta"]
               },
               now: ~U[2026-11-01 12:30:00Z],
               pricing_loader: pricing
             )

    report = response.report
    assert length(report.bars) == 24
    assert Enum.count(report.bars, &(&1.label == "1 AM")) == 2
    assert report.combined.counters.sessions == 1
    assert report.combined.tokens == 200
    assert report.timeZone == "America/Los_Angeles"
    assert response.pricing.missingModels == []
  end

  test "report rejects invalid and unbounded parameters" do
    assert {:error, "tz must be a valid IANA time zone"} =
             Dashboard.report(%{"tz" => "Not/AZone"})

    assert {:error, reason} =
             Dashboard.report(%{"device" => Enum.map(1..11, &"device-#{&1}")})

    assert reason =~ "at most 10"

    assert {:ok, parsed} =
             Dashboard.validate_params(%{"device" => Jason.encode!(["host-device"])})

    assert parsed.filters["device"] == ["host-device"]
  end

  test "more than ten series collapse without colliding with a real Other value" do
    insert_session(
      "literal-other",
      ~U[2026-11-01 10:00:00.000000Z],
      "Other",
      "codex",
      500
    )

    Enum.each(1..11, fn index ->
      insert_session(
        "extra-#{index}",
        ~U[2026-11-01 10:00:00.000000Z],
        "project-#{index}",
        "codex",
        index
      )
    end)

    assert {:ok, response} =
             Dashboard.report(
               %{"period" => "day", "view" => "project", "tz" => "UTC"},
               now: ~U[2026-11-01 12:30:00Z],
               pricing_loader: fn _ -> pricing() end
             )

    assert response.report.truncated
    assert length(response.report.series) == 11

    assert Enum.count(response.report.series, &(&1.label == "Other")) == 2
    assert Enum.uniq_by(response.report.series, & &1.key) == response.report.series
    assert Enum.any?(response.report.series, &(&1.label == "Other" and not &1.isOther))
    assert Enum.any?(response.report.series, &(&1.label == "Other" and &1.isOther))
  end

  test "staleness follows the applicable device rather than fresh host collection" do
    now = ~U[2026-11-01 12:30:00.000000Z]
    TokenTracker.Sessions.put_state("last_collection_at", DateTime.to_iso8601(now))

    Repo.insert_all(Device, [
      %{
        device_id: "device-remote",
        name: "remote-device",
        local: false,
        last_sync_at: ~U[2026-11-01 11:00:00.000000Z],
        inserted_at: now,
        updated_at: now
      }
    ])

    assert {:ok, all_response} =
             Dashboard.report(
               %{"period" => "day", "view" => "agent", "tz" => "UTC"},
               now: now,
               pricing_loader: fn _ -> pricing() end
             )

    assert all_response.stale
    assert all_response.staleDevices == ["remote-device"]

    assert {:ok, local_response} =
             Dashboard.report(
               %{
                 "period" => "day",
                 "view" => "agent",
                 "tz" => "UTC",
                 "device" => ["host-device"]
               },
               now: now,
               pricing_loader: fn _ -> pricing() end
             )

    refute local_response.stale
    assert local_response.staleDevices == []
  end

  test "API routes return JSON and never expose session identifiers" do
    report_conn =
      conn(:get, "/api/report?period=week&view=model&tz=UTC")
      |> TokenTrackerWeb.Router.call(TokenTrackerWeb.Router.init([]))

    assert report_conn.status == 200
    report_body = Jason.decode!(report_conn.resp_body)
    assert report_body["report"]["period"] == "week"
    assert report_body["report"]["view"] == "model"
    assert length(report_body["report"]["bars"]) == 7
    refute report_conn.resp_body =~ "session-a"
    refute report_conn.resp_body =~ "session_key"

    missing_conn =
      conn(:get, "/api/does-not-exist")
      |> TokenTrackerWeb.Router.call(TokenTrackerWeb.Router.init([]))

    assert missing_conn.status == 404
    assert get_resp_header(missing_conn, "content-type") |> hd() =~ "application/json"
  end

  test "endpoint keeps API responses private and separate from the SPA" do
    start_supervised!(TokenTrackerWeb.Endpoint)

    report_conn =
      conn(:get, "/api/report?period=week&view=model&tz=UTC")
      |> TokenTrackerWeb.Endpoint.call([])

    assert report_conn.status == 200
    report_body = Jason.decode!(report_conn.resp_body)
    assert report_body["report"]["period"] == "week"
    assert report_body["report"]["view"] == "model"
    assert length(report_body["report"]["bars"]) == 7

    invalid_report_conn =
      conn(:get, "/api/report?period=not-a-period&view=model&tz=UTC")
      |> TokenTrackerWeb.Endpoint.call([])

    assert invalid_report_conn.status == 400
    assert Jason.decode!(invalid_report_conn.resp_body)["error"] =~ "period must be"

    malformed_report_conn =
      conn(:get, "/api/report?period=%FF")
      |> TokenTrackerWeb.Endpoint.call([])

    assert malformed_report_conn.status == 400
    assert Jason.decode!(malformed_report_conn.resp_body) == %{"error" => "malformed query"}

    api_conn =
      conn(:get, "/api/healthz")
      |> TokenTrackerWeb.Endpoint.call([])

    assert api_conn.status == 200
    assert get_resp_header(api_conn, "cache-control") == ["no-store"]
    assert get_resp_header(api_conn, "x-content-type-options") == ["nosniff"]
    assert get_resp_header(api_conn, "content-security-policy") != []

    missing_api_conn =
      conn(:get, "/api/not-real")
      |> TokenTrackerWeb.Endpoint.call([])

    assert missing_api_conn.status == 404
    assert get_resp_header(missing_api_conn, "content-type") |> hd() =~ "application/json"

    index_path =
      Path.join(
        System.tmp_dir!(),
        "token-tracker-index-#{System.unique_integer([:positive])}.html"
      )

    inline_script = "\n\twindow.tokenTrackerBooted = true;\n"

    File.write!(
      index_path,
      """
      <!doctype html>
      <title>Token Tracker test</title>
      <script src="/theme.js"></script>
      <script>#{inline_script}</script>
      """
    )

    Application.put_env(:token_tracker, :static_index_path, index_path)

    on_exit(fn ->
      Application.delete_env(:token_tracker, :static_index_path)
      File.rm(index_path)
    end)

    spa_conn =
      conn(:get, "/dashboard")
      |> TokenTrackerWeb.Endpoint.call([])

    assert spa_conn.status == 200
    assert get_resp_header(spa_conn, "cache-control") == ["no-cache"]
    assert get_resp_header(spa_conn, "content-type") |> hd() =~ "text/html"

    content_security_policy =
      get_resp_header(spa_conn, "content-security-policy")
      |> List.first()

    inline_script_hash =
      inline_script
      |> then(&:crypto.hash(:sha256, &1))
      |> Base.encode64()

    assert content_security_policy =~ "script-src 'self' 'sha256-#{inline_script_hash}'"
    assert content_security_policy =~ "font-src 'self' data:"

    File.rm!(index_path)

    missing_spa_conn =
      conn(:get, "/dashboard")
      |> TokenTrackerWeb.Endpoint.call([])

    assert missing_spa_conn.status == 503
    assert missing_spa_conn.resp_body =~ "assets are not built"

    static_root = Application.app_dir(:token_tracker, "priv/static")

    case Path.wildcard(Path.join([static_root, "_app", "**", "*.js"])) do
      [asset | _rest] ->
        asset_path = "/" <> Path.relative_to(asset, static_root)
        asset_conn = conn(:get, asset_path) |> TokenTrackerWeb.Endpoint.call([])
        assert asset_conn.status == 200

        assert get_resp_header(asset_conn, "cache-control") == [
                 "public, max-age=31536000, immutable"
               ]

      [] ->
        :ok
    end
  end

  test "system response contains only aggregate device status" do
    TokenTracker.Sessions.put_state(
      "last_sync_error",
      "/private/path/session-secret failed to sync"
    )

    response = Dashboard.system()
    assert [%{name: "host-device", sessions: 2, tokens: 300}] = response.devices
    refute Map.has_key?(hd(response.devices), :id)
    assert response.lastError == "Synchronization needs attention"
    refute inspect(response) =~ "session-a"
    refute inspect(response) =~ "/private/path"
  end

  test "system aggregation remains bounded as device count grows" do
    now = ~U[2026-11-01 12:00:00.000000Z]

    Repo.insert_all(
      Device,
      Enum.map(1..50, fn index ->
        %{
          device_id: "bulk-device-#{index}",
          name: "bulk-#{index}",
          local: false,
          inserted_at: now,
          updated_at: now
        }
      end)
    )

    {:ok, counter} = Agent.start_link(fn -> 0 end)
    handler = "dashboard-query-count-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler,
        [:token_tracker, :repo, :query],
        fn _event, _measurements, _metadata, agent -> Agent.update(agent, &(&1 + 1)) end,
        counter
      )

    on_exit(fn -> :telemetry.detach(handler) end)
    response = Dashboard.system()

    assert length(response.devices) == 51
    assert Agent.get(counter, & &1) <= 8
  end

  test "web endpoint is supervised only for an enabled host" do
    host = %{role: "host", web_enabled: true}
    client = %{role: "client", web_enabled: true}

    assert TokenTrackerWeb.Endpoint in Runtime.child_specs(host)
    refute TokenTrackerWeb.Endpoint in Runtime.child_specs(%{host | web_enabled: false})
    refute TokenTrackerWeb.Endpoint in Runtime.child_specs(client)
  end

  defp insert_session(session_key, hour, project, agent, input_tokens) do
    now = ~U[2026-11-01 12:00:00.000000Z]

    Repo.insert_all(SessionSnapshot, [
      %{
        device_id: "device-1",
        session_key: session_key,
        agent: agent,
        generation: 1,
        digest: String.duplicate("a", 64),
        started_at: hour,
        last_activity_at: hour,
        quality: "exact",
        received_at: now
      }
    ])

    Repo.insert_all(SessionUsageHourly, [
      %{
        device_id: "device-1",
        session_key: session_key,
        hour_utc: hour,
        project: project,
        agent: agent,
        provider: "openai",
        model: "gpt-5",
        pricing_tier: "standard",
        input_tokens: input_tokens,
        output_tokens: 0,
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        session_starts: 1
      }
    ])
  end

  defp pricing do
    %{
      rates: %{
        {"openai", "gpt-5"} => %{
          input: 1.0,
          output: 1.0,
          reasoning: 1.0,
          cache_read: 1.0,
          cache_write: 1.0,
          tiers: []
        }
      },
      source: :cache,
      fetched_at: "2026-11-01T12:00:00Z",
      missing_models: [],
      warning: nil
    }
  end

  def test_pricing(_models), do: pricing()
end
