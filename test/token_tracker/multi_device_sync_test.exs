defmodule TokenTracker.MultiDeviceSyncTest do
  use ExUnit.Case

  import Ecto.Query
  import ExUnit.CaptureIO

  alias TokenTracker.{
    Config,
    Device,
    FileCheckpoint,
    Repo,
    Report,
    SessionOutbox,
    SessionSnapshot,
    SessionUsageHourly,
    Sessions,
    UsageEvent
  }

  alias TokenTracker.Sync.{Client, Server}

  setup do
    Repo.delete_all(SessionOutbox)
    Repo.delete_all(SessionUsageHourly)
    Repo.delete_all(SessionSnapshot)
    Repo.delete_all(Device)
    Repo.delete_all(FileCheckpoint)
    Repo.delete_all(UsageEvent)
    Ecto.Adapters.SQL.query!(Repo, "DELETE FROM session_reconcile_queue", [])
    Ecto.Adapters.SQL.query!(Repo, "DELETE FROM runtime_state", [])
    :ok
  end

  test "local sessions become hourly revisioned snapshots and coalesced outbox entries" do
    config = client_config()
    insert_event("session-a", "event-1", ~U[2026-07-23 10:15:00.000000Z], 10, 1)
    insert_event("session-a", "event-2", ~U[2026-07-23 11:20:00.000000Z], 20, 0)

    assert Sessions.reconcile_local(config) == %{changed: 1, unchanged: 0, pending: 1}

    snapshot = Repo.one!(SessionSnapshot)
    assert snapshot.generation == 1
    assert snapshot.device_id == config.device_id
    assert Repo.aggregate(SessionUsageHourly, :count) == 2
    assert Repo.aggregate(SessionOutbox, :count) == 1
    generation_one = Repo.one!(SessionOutbox)

    assert Sessions.reconcile_local(config) == %{changed: 0, unchanged: 0, pending: 0}

    insert_event("session-a", "event-3", ~U[2026-07-23 11:25:00.000000Z], 30, 0)
    assert Sessions.reconcile_local(config) == %{changed: 1, unchanged: 0, pending: 1}

    assert Repo.one!(SessionSnapshot).generation == 2
    assert Repo.one!(SessionOutbox).generation == 2
    assert Repo.aggregate(SessionOutbox, :count) == 1
    Sessions.mark_attempt([generation_one], "obsolete")
    assert Repo.one!(SessionOutbox).attempt_count == 0

    eleven_hour = ~U[2026-07-23 11:00:00.000000Z]

    eleven_tokens =
      Repo.one!(
        from(row in SessionUsageHourly,
          where: row.hour_utc == ^eleven_hour,
          select: sum(row.input_tokens)
        )
      )

    assert eleven_tokens == 50

    Repo.update_all(
      from(event in UsageEvent, where: event.event_key == ^TokenTracker.Hash.stable(["event-1"])),
      set: [input_tokens: 99]
    )

    assert Sessions.reconcile_local(config) == %{changed: 1, unchanged: 0, pending: 1}
    assert Repo.one!(SessionSnapshot).generation == 3
    assert Sessions.reconcile_local(config) == %{changed: 0, unchanged: 0, pending: 0}
  end

  test "host accepts new and duplicate revisions and harmlessly acknowledges stale ones" do
    host = host_config()
    Sessions.ensure_local_device(host)
    {:ok, enrolled} = Sessions.enroll_device("remote")

    remote = %{client_config() | device_id: enrolled.device_id, device_token: enrolled.token}
    insert_event("session-b", "event-1", ~U[2026-07-23 10:15:00.000000Z], 10, 1)
    Sessions.reconcile_local(remote)
    [entry] = Sessions.outbox_entries()
    snapshot = Sessions.decode_outbox(entry)
    Repo.delete_all(SessionUsageHourly)
    Repo.delete_all(SessionSnapshot)

    assert Sessions.ingest(enrolled.device_id, snapshot) == {:accepted, :inserted}
    assert Sessions.ingest(enrolled.device_id, snapshot) == {:accepted, :duplicate}

    newer =
      snapshot
      |> Map.put(:generation, snapshot.generation + 1)
      |> redigest()

    assert Sessions.ingest(enrolled.device_id, newer) == {:accepted, :updated}
    assert Sessions.ingest(enrolled.device_id, snapshot) == {:accepted, :stale}
    assert Repo.one!(SessionSnapshot).generation == newer.generation
  end

  test "protocol authenticates a device and acknowledges sessions individually" do
    config = host_config()
    {:ok, enrolled} = Sessions.enroll_device("remote")
    server = start_supervised!({Server, config})

    snapshot = snapshot(enrolled.device_id, "session-c")
    batch_id = Config.generate_id()

    assert {:sync_error, 1, ^batch_id, "authentication failed: invalid_token"} =
             GenServer.call(
               server,
               {:sync_sessions, 1, enrolled.device_id, "wrong", batch_id, [snapshot]}
             )

    invalid =
      Map.put(snapshot(enrolled.device_id, "session-d"), :digest, String.duplicate("0", 64))

    assert {:sync_ack, 1, ^batch_id, [accepted], [rejected]} =
             GenServer.call(
               server,
               {:sync_sessions, 1, enrolled.device_id, enrolled.token, batch_id,
                [snapshot, invalid]}
             )

    assert accepted.session_key == snapshot.session_key
    assert accepted.status == :inserted
    assert rejected.session_key == invalid.session_key
    assert rejected.reason =~ "digest"
  end

  test "protocol rejects a non-string device identity without restarting the server" do
    config = host_config()
    server = start_supervised!({Server, config})
    batch_id = Config.generate_id()

    assert {:sync_error, 1, ^batch_id, "device_id must be a string"} =
             GenServer.call(
               server,
               {:sync_sessions, 1, %{malformed: true}, "token", batch_id, []}
             )

    assert Process.alive?(server)
  end

  test "malformed non-map snapshot is rejected without blocking a valid sibling" do
    config = host_config()
    {:ok, enrolled} = Sessions.enroll_device("remote")
    server = start_supervised!({Server, config})
    valid = snapshot(enrolled.device_id, "session-valid")
    batch_id = Config.generate_id()

    assert {:sync_ack, 1, ^batch_id, [accepted], [rejected]} =
             GenServer.call(
               server,
               {:sync_sessions, 1, enrolled.device_id, enrolled.token, batch_id,
                [
                  "not-a-map",
                  valid
                ]}
             )

    assert accepted.session_key == valid.session_key
    assert rejected.session_key == nil
    assert rejected.reason == "snapshot must be a map"
    assert Process.alive?(server)
  end

  test "client clears accepted revisions, retains rejected ones, and retains all on outage" do
    config = client_config()
    insert_event("session-e", "event-1", ~U[2026-07-23 10:00:00.000000Z], 10, 1)
    insert_event("session-f", "event-2", ~U[2026-07-23 11:00:00.000000Z], 20, 1)
    Sessions.reconcile_local(config)

    partial = fn _config, {:sync_sessions, 1, _id, _token, batch_id, snapshots}, _timeout ->
      [accepted, rejected] = snapshots

      {:ok,
       {:sync_ack, 1, batch_id,
        [
          %{
            session_key: accepted.session_key,
            generation: accepted.generation,
            status: :inserted
          }
        ],
        [
          %{
            session_key: rejected.session_key,
            generation: rejected.generation,
            reason: "test rejection"
          }
        ]}}
    end

    result = Client.sync_once(config, call: partial)
    assert result.accepted == 1
    assert result.rejected == 1
    assert result.pending == 1
    assert Repo.one!(SessionOutbox).last_error =~ "test rejection"
    assert Repo.one!(SessionOutbox).attempt_count == 1
    assert Sessions.get_state("last_sync_error") =~ "test rejection"

    offline = Client.sync_once(config, call: fn _, _, _ -> {:error, :unreachable} end)
    assert offline.error == "unreachable"
    assert offline.pending == 1
    assert Repo.one!(SessionOutbox).attempt_count == 2
    assert Sessions.get_state("last_sync_error") == "unreachable"
  end

  test "removing the last local event clears local aggregates without a remote tombstone" do
    config = client_config()
    insert_event("removed-session", "removed-event", ~U[2026-07-23 10:00:00.000000Z], 10, 1)
    assert Sessions.reconcile_local(config).changed == 1
    assert Repo.aggregate(SessionSnapshot, :count) == 1
    assert Repo.aggregate(SessionUsageHourly, :count) == 1
    assert Repo.aggregate(SessionOutbox, :count) == 1

    Repo.delete_all(UsageEvent)

    assert Sessions.reconcile_local(config) == %{changed: 1, unchanged: 0, pending: 0}
    assert Repo.aggregate(SessionSnapshot, :count) == 0
    assert Repo.aggregate(SessionUsageHourly, :count) == 0
    assert Repo.aggregate(SessionOutbox, :count) == 0
  end

  test "a successful host cycle clears an earlier synchronization error" do
    Sessions.put_state("last_sync_error", "temporary failure")

    assert TokenTracker.Scheduler.run_cycle(host_config(),
             collector: fn -> :ok end,
             reconciler: fn _config -> %{changed: 0, unchanged: 0, pending: 0} end
           ).error == nil

    assert Sessions.get_state("last_sync_error") == nil
  end

  test "hourly aggregation preserves per-event context pricing tiers" do
    rates = %{
      input: 1.0,
      output: 1.0,
      reasoning: 1.0,
      cache_read: 1.0,
      cache_write: 1.0,
      tiers: [
        %{
          context_size: 100,
          input: 10.0,
          output: 10.0,
          reasoning: 10.0,
          cache_read: 10.0,
          cache_write: 10.0
        }
      ]
    }

    config = host_config()
    insert_event("tier-session", "tier-1", ~U[2026-07-23 10:01:00.000000Z], 60, 1)
    insert_event("tier-session", "tier-2", ~U[2026-07-23 10:02:00.000000Z], 60, 0)
    insert_event("tier-session", "tier-3", ~U[2026-07-23 10:03:00.000000Z], 120, 0)

    Sessions.reconcile_local(config, pricing: %{rates: %{}})
    rows = Repo.all(SessionUsageHourly) |> Map.new(&{&1.pricing_tier, &1})

    assert rows["tokens:60"].input_tokens == 120
    assert rows["tokens:120"].input_tokens == 120

    cost =
      Enum.reduce(Map.values(rows), 0.0, fn row, total ->
        total + TokenTracker.Pricing.estimate(row, rates, row.pricing_tier)
      end)

    assert_in_delta cost, 0.00132, 0.0000001
  end

  test "missing reconcile marker repopulates every session when queue is partly populated" do
    config = host_config()
    insert_event("recovery-a", "recovery-event-a", ~U[2026-07-23 10:00:00.000000Z], 10, 1)
    insert_event("recovery-b", "recovery-event-b", ~U[2026-07-23 11:00:00.000000Z], 20, 1)
    missing_key = TokenTracker.Hash.stable(["recovery-b"])

    Ecto.Adapters.SQL.query!(
      Repo,
      "DELETE FROM session_reconcile_queue WHERE session_key = ?",
      [missing_key]
    )

    assert %{rows: [[1]]} =
             Ecto.Adapters.SQL.query!(Repo, "SELECT COUNT(*) FROM session_reconcile_queue", [])

    assert Sessions.reconcile_local(config).changed == 2
    assert Repo.aggregate(SessionSnapshot, :count) == 2
  end

  test "client chunks messages by session count and exact encoded size" do
    config = client_config()

    for index <- 1..3 do
      insert_event(
        "session-#{index}",
        "event-#{index}",
        DateTime.add(~U[2026-07-23 10:00:00.000000Z], index, :hour),
        index * 10,
        1
      )
    end

    Sessions.reconcile_local(config)
    entries = Sessions.outbox_entries()
    one = Sessions.decode_outbox(hd(entries))
    two = Enum.take(entries, 2) |> Enum.map(&Sessions.decode_outbox/1)
    one_size = message_size(config, [one])
    two_size = message_size(config, two)
    limit = div(one_size + two_size, 2)
    limited = %{config | batch_max_bytes: limit}

    {batches, oversized} = Client.build_batches(limited)

    assert oversized == []
    assert length(batches) == 3

    Enum.each(batches, fn {_entries, message, _batch_id} ->
      assert :erlang.external_size(message) <= limit
    end)

    {count_batches, []} = Client.build_batches(%{config | batch_max_sessions: 2})
    assert length(count_batches) == 2
  end

  test "oversized snapshot remains pending without counting a network attempt" do
    config = client_config()
    insert_event("oversized-session", "oversized-event", ~U[2026-07-23 10:00:00.000000Z], 10, 1)
    Sessions.reconcile_local(config)
    tiny = %{config | batch_max_bytes: 10}

    result =
      Client.sync_once(tiny,
        call: fn _, _, _ -> flunk("an oversized snapshot must not be sent") end
      )

    assert result.pending == 1
    assert result.error =~ "exceed"
    entry = Repo.one!(SessionOutbox)
    assert entry.attempt_count == 0
    assert entry.last_error =~ "exceeds"
  end

  test "combined reporting can filter and group by device" do
    host = host_config()
    Sessions.ensure_local_device(host)
    insert_event("session-g", "event-1", ~U[2026-07-23 10:00:00.000000Z], 10, 1)
    Sessions.reconcile_local(host)

    pricing = %{
      rates: %{},
      missing_models: ["gpt-test"],
      fetched_at: nil,
      source: :none,
      warning: nil
    }

    output =
      capture_io(fn ->
        Report.print_combined(device: host.device_name, pricing: pricing)
      end)

    assert output =~ "Combined host summary"
    assert output =~ "Device filter: #{host.device_name}"
    assert output =~ "Devices"
    assert output =~ host.device_name
    assert output =~ "Agents"
    assert output =~ "Top projects"
  end

  defp client_config do
    Config.defaults()
    |> Map.merge(%{
      role: "client",
      device_id: Config.generate_id(),
      device_name: "test-client",
      cluster_cookie: "test-cookie",
      device_token: "test-token",
      batch_max_bytes: 1_048_576
    })
  end

  defp host_config do
    Config.defaults()
    |> Map.merge(%{
      role: "host",
      device_id: Config.generate_id(),
      device_name: "test-host",
      cluster_cookie: "test-cookie"
    })
  end

  defp insert_event(session, event, occurred_at, input, session_starts) do
    Repo.insert_all(UsageEvent, [
      event_struct(session, event, occurred_at, input, session_starts)
      |> Map.take([
        :event_key,
        :session_key,
        :occurred_at,
        :project,
        :agent,
        :provider,
        :model,
        :input_tokens,
        :output_tokens,
        :reasoning_tokens,
        :cache_read_tokens,
        :cache_write_tokens,
        :session_starts
      ])
    ])
  end

  defp event_struct(session, event, occurred_at, input, session_starts) do
    %UsageEvent{
      event_key: TokenTracker.Hash.stable([event]),
      session_key: TokenTracker.Hash.stable([session]),
      occurred_at: occurred_at,
      project: "project",
      agent: "codex",
      provider: "openai",
      model: "gpt-test",
      input_tokens: input,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      session_starts: session_starts
    }
  end

  defp snapshot(device_id, session) do
    event = %UsageEvent{
      event_key: TokenTracker.Hash.stable(["event", session]),
      session_key: TokenTracker.Hash.stable([session]),
      occurred_at: ~U[2026-07-23 10:00:00.000000Z],
      project: "project",
      agent: "codex",
      provider: "openai",
      model: "gpt-test",
      input_tokens: 10,
      output_tokens: 1,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      session_starts: 1
    }

    device_id
    |> Sessions.build_snapshot([event])
    |> Map.merge(%{generation: 1, received_at: DateTime.utc_now()})
  end

  defp redigest(snapshot) do
    event = %UsageEvent{
      event_key: "ignored",
      session_key: snapshot.session_key,
      occurred_at: snapshot.started_at,
      project: hd(snapshot.rows).project,
      agent: snapshot.agent,
      provider: hd(snapshot.rows).provider,
      model: hd(snapshot.rows).model,
      input_tokens: hd(snapshot.rows).input_tokens,
      output_tokens: hd(snapshot.rows).output_tokens,
      reasoning_tokens: hd(snapshot.rows).reasoning_tokens,
      cache_read_tokens: hd(snapshot.rows).cache_read_tokens,
      cache_write_tokens: hd(snapshot.rows).cache_write_tokens,
      session_starts: hd(snapshot.rows).session_starts
    }

    rebuilt = Sessions.build_snapshot(snapshot.device_id, [event])
    %{snapshot | digest: rebuilt.digest}
  end

  defp message_size(config, snapshots) do
    :erlang.external_size(
      {:sync_sessions, 1, config.device_id, config.device_token,
       "00000000-0000-4000-8000-000000000000", snapshots}
    )
  end
end
