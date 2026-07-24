defmodule TokenTracker.Sessions do
  @moduledoc false

  import Ecto.Query

  alias TokenTracker.{
    Counters,
    Device,
    Hash,
    Repo,
    SessionOutbox,
    SessionSnapshot,
    SessionUsageHourly,
    UsageEvent
  }

  @counter_fields Counters.fields()
  @snapshot_fields [
    :device_id,
    :session_key,
    :agent,
    :generation,
    :digest,
    :started_at,
    :last_activity_at,
    :quality,
    :received_at
  ]

  def reconcile_local(config, opts \\ [])

  def reconcile_local(%{device_id: device_id, role: role} = config, _opts)
      when is_binary(device_id) and device_id != "" and role in ["host", "client"] do
    ensure_local_device(config)
    ensure_reconcile_queue(device_id)
    dirty = dirty_sessions()
    events = events_for_sessions(Enum.map(dirty, & &1.session_key))
    grouped = Enum.group_by(events, & &1.session_key)

    result =
      Enum.reduce(dirty, %{changed: 0, unchanged: 0, pending: 0}, fn entry, result ->
        session_events = Map.get(grouped, entry.session_key, [])

        result =
          case session_events do
            [] ->
              case delete_local_snapshot(device_id, entry.session_key) do
                :unchanged -> result
                :changed -> Map.update!(result, :changed, &(&1 + 1))
              end

            events ->
              snapshot = build_snapshot(device_id, events)

              case put_snapshot(snapshot, role == "client") do
                :unchanged -> Map.update!(result, :unchanged, &(&1 + 1))
                :changed -> result |> Map.update!(:changed, &(&1 + 1)) |> pending(role)
              end
          end

        clear_dirty(entry)
        result
      end)

    put_state(reconcile_marker(device_id), "1")
    result
  end

  def reconcile_local(_config, _opts), do: %{changed: 0, unchanged: 0, pending: 0}

  def ensure_local_device(config) do
    now = now()

    row = %{
      device_id: config.device_id,
      name: config.device_name,
      node_name: config |> TokenTracker.Config.local_node() |> to_string(),
      token_hash: nil,
      local: true,
      inserted_at: now,
      updated_at: now
    }

    Repo.insert_all(Device, [row],
      on_conflict: {:replace, [:name, :node_name, :local, :updated_at]},
      conflict_target: :device_id
    )

    :ok
  end

  def build_snapshot(device_id, events, _opts \\ []) do
    events = Enum.sort_by(events, &DateTime.to_unix(&1.occurred_at, :microsecond))
    first = hd(events)
    rows = hourly_rows(device_id, first.session_key, events)

    base = %{
      device_id: device_id,
      session_key: first.session_key,
      agent: first.agent,
      started_at: hd(events).occurred_at,
      last_activity_at: List.last(events).occurred_at,
      quality: "exact",
      rows: rows
    }

    Map.put(base, :digest, digest(base))
  end

  def put_snapshot(snapshot, enqueue?) do
    Repo.transaction(fn ->
      existing = get_snapshot(snapshot.device_id, snapshot.session_key)

      if existing && existing.digest == snapshot.digest do
        :unchanged
      else
        generation = if existing, do: existing.generation + 1, else: 1
        received = now()
        snapshot = Map.merge(snapshot, %{generation: generation, received_at: received})
        replace_snapshot(snapshot)
        if enqueue?, do: put_outbox(snapshot)
        :changed
      end
    end)
    |> case do
      {:ok, result} -> result
      {:error, reason} -> raise "could not reconcile session: #{inspect(reason)}"
    end
  end

  def ingest(device_id, snapshot) do
    with :ok <- validate_snapshot(snapshot, device_id) do
      Repo.transaction(fn ->
        existing = get_snapshot(device_id, snapshot.session_key)

        cond do
          existing && existing.generation > snapshot.generation ->
            {:accepted, :stale}

          existing && existing.generation == snapshot.generation &&
              existing.digest == snapshot.digest ->
            {:accepted, :duplicate}

          existing && existing.generation == snapshot.generation ->
            {:rejected, "generation already exists with a different digest"}

          true ->
            replace_snapshot(Map.put(snapshot, :received_at, now()))
            {:accepted, if(existing, do: :updated, else: :inserted)}
        end
      end)
      |> case do
        {:ok, result} -> result
        {:error, reason} -> {:rejected, "database error: #{inspect(reason)}"}
      end
    else
      {:error, reason} -> {:rejected, reason}
    end
  rescue
    error -> {:rejected, Exception.message(error)}
  end

  def pending_count do
    Repo.aggregate(SessionOutbox, :count)
  end

  def outbox_batches(max_sessions, max_bytes)
      when max_sessions > 0 and max_bytes > 0 do
    outbox_entries()
    |> Enum.reduce([], fn entry, batches ->
      append_to_batch(batches, entry, max_sessions, max_bytes)
    end)
    |> Enum.reverse()
    |> Enum.map(&Enum.reverse/1)
  end

  def outbox_entries do
    SessionOutbox
    |> order_by([row], asc: row.inserted_at, asc: row.session_key)
    |> Repo.all()
  end

  def decode_outbox(%SessionOutbox{payload: payload}) do
    :erlang.binary_to_term(payload, [:safe])
  end

  def mark_attempt(entries, error \\ nil) do
    Enum.each(entries, fn entry ->
      from(
        row in SessionOutbox,
        where: row.session_key == ^entry.session_key and row.generation == ^entry.generation
      )
      |> Repo.update_all(
        inc: [attempt_count: 1],
        set: [last_attempt_at: now(), last_error: error, updated_at: now()]
      )
    end)

    :ok
  end

  def mark_error(entries, error) do
    Enum.each(entries, fn entry ->
      from(
        row in SessionOutbox,
        where: row.session_key == ^entry.session_key and row.generation == ^entry.generation
      )
      |> Repo.update_all(set: [last_error: error, updated_at: now()])
    end)

    :ok
  end

  def acknowledge(accepted) do
    Enum.each(accepted, fn %{session_key: session_key, generation: generation} ->
      from(
        row in SessionOutbox,
        where: row.session_key == ^session_key and row.generation == ^generation
      )
      |> Repo.delete_all()
    end)

    :ok
  end

  def devices do
    Device
    |> order_by([device], asc: device.name)
    |> Repo.all()
  end

  def get_device(device_id), do: Repo.get(Device, device_id)

  def resolve_device_id(identity) when is_binary(identity) do
    case Repo.get(Device, identity) do
      %Device{device_id: device_id} ->
        {:ok, device_id}

      nil ->
        case Repo.one(from(device in Device, where: device.name == ^identity)) do
          %Device{device_id: device_id} -> {:ok, device_id}
          nil -> {:error, :not_found}
        end
    end
  end

  def resolve_device_id(_identity), do: {:error, :not_found}

  def enroll_device(name, node_name \\ nil, opts \\ []) do
    device_id = Keyword.get(opts, :device_id, TokenTracker.Config.generate_id())
    token = Keyword.get(opts, :token, TokenTracker.Config.generate_secret())
    now = now()

    Repo.insert_all(Device, [
      %{
        device_id: device_id,
        name: name,
        node_name: node_name,
        token_hash: token_hash(token),
        local: false,
        inserted_at: now,
        updated_at: now
      }
    ])

    {:ok, %{device_id: device_id, name: name, token: token}}
  rescue
    error -> {:error, Exception.message(error)}
  end

  def revoke_device(identity) do
    with {:ok, device_id} <- resolve_device_id(identity) do
      now = now()

      from(device in Device, where: device.device_id == ^device_id)
      |> Repo.update_all(set: [revoked_at: now, updated_at: now])

      :ok
    end
  end

  def sync_proof(token, device_id, batch_id, snapshots)
      when is_binary(token) and is_binary(device_id) and is_binary(batch_id) and
             is_list(snapshots) do
    token
    |> token_hash()
    |> sync_proof_from_hash(device_id, batch_id, snapshots)
  end

  def authenticate_sync(device_id, proof, batch_id, snapshots)
      when is_binary(device_id) and is_binary(proof) and is_binary(batch_id) and
             is_list(snapshots) do
    case get_device(device_id) do
      %Device{revoked_at: nil, token_hash: expected} when is_binary(expected) ->
        candidate = sync_proof_from_hash(expected, device_id, batch_id, snapshots)

        if byte_size(candidate) == byte_size(proof) &&
             TokenTracker.Sessions.PlugLike.secure_compare(candidate, proof) do
          :ok
        else
          {:error, :invalid_token}
        end

      %Device{revoked_at: %DateTime{}} ->
        {:error, :revoked}

      _ ->
        {:error, :unknown_device}
    end
  end

  def authenticate_sync(_device_id, _proof, _batch_id, _snapshots),
    do: {:error, :invalid_token}

  def touch_device(device_id) do
    now = now()

    from(device in Device, where: device.device_id == ^device_id)
    |> Repo.update_all(set: [last_seen_at: now, last_sync_at: now, updated_at: now])

    :ok
  end

  def put_state(key, value) do
    now = now()

    Repo.insert_all(
      "runtime_state",
      [%{key: key, value: value, updated_at: now}],
      on_conflict: {:replace, [:value, :updated_at]},
      conflict_target: :key
    )

    :ok
  end

  def get_state(key) do
    case Ecto.Adapters.SQL.query(Repo, "SELECT value FROM runtime_state WHERE key = ?", [key]) do
      {:ok, %{rows: [[value]]}} -> value
      _ -> nil
    end
  end

  defp pending(result, "client"), do: Map.update!(result, :pending, &(&1 + 1))
  defp pending(result, _role), do: result

  defp get_snapshot(device_id, session_key) do
    Repo.one(
      from(snapshot in SessionSnapshot,
        where: snapshot.device_id == ^device_id and snapshot.session_key == ^session_key
      )
    )
  end

  defp delete_local_snapshot(device_id, session_key) do
    Repo.transaction(fn ->
      Repo.delete_all(
        from(row in SessionUsageHourly,
          where: row.device_id == ^device_id and row.session_key == ^session_key
        )
      )

      {snapshots, _} =
        Repo.delete_all(
          from(row in SessionSnapshot,
            where: row.device_id == ^device_id and row.session_key == ^session_key
          )
        )

      {outbox, _} =
        Repo.delete_all(from(row in SessionOutbox, where: row.session_key == ^session_key))

      if snapshots + outbox > 0, do: :changed, else: :unchanged
    end)
    |> case do
      {:ok, result} -> result
      {:error, reason} -> raise "could not remove local session: #{inspect(reason)}"
    end
  end

  defp replace_snapshot(snapshot) do
    Repo.delete_all(
      from(row in SessionUsageHourly,
        where: row.device_id == ^snapshot.device_id and row.session_key == ^snapshot.session_key
      )
    )

    header = Map.take(snapshot, @snapshot_fields)

    Repo.insert_all(SessionSnapshot, [header],
      on_conflict:
        {:replace,
         [
           :agent,
           :generation,
           :digest,
           :started_at,
           :last_activity_at,
           :quality,
           :received_at
         ]},
      conflict_target: [:device_id, :session_key]
    )

    rows =
      Enum.map(snapshot.rows, fn row ->
        row
        |> Map.put(:device_id, snapshot.device_id)
        |> Map.put(:session_key, snapshot.session_key)
      end)

    unless rows == [], do: Repo.insert_all(SessionUsageHourly, rows)
  end

  defp put_outbox(snapshot) do
    payload = :erlang.term_to_binary(snapshot, compressed: 6)
    now = now()

    Repo.insert_all(
      SessionOutbox,
      [
        %{
          session_key: snapshot.session_key,
          generation: snapshot.generation,
          digest: snapshot.digest,
          payload: payload,
          payload_bytes: byte_size(payload),
          attempt_count: 0,
          inserted_at: now,
          updated_at: now
        }
      ],
      on_conflict:
        {:replace,
         [
           :generation,
           :digest,
           :payload,
           :payload_bytes,
           :attempt_count,
           :last_attempt_at,
           :last_error,
           :updated_at
         ]},
      conflict_target: :session_key
    )
  end

  defp hourly_rows(_device_id, _session_key, events) do
    events
    |> Enum.group_by(fn event ->
      {
        hour(event.occurred_at),
        event.project,
        event.agent,
        event.provider || "",
        event.model,
        TokenTracker.Pricing.context_key(event)
      }
    end)
    |> Enum.map(fn {{hour_utc, project, agent, provider, model, pricing_tier}, grouped} ->
      counters = Enum.reduce(grouped, Counters.zero(), &Counters.add/2)

      counters
      |> Map.merge(%{
        hour_utc: hour_utc,
        project: project,
        agent: agent,
        provider: provider,
        model: model,
        pricing_tier: pricing_tier
      })
    end)
    |> Enum.sort_by(fn row ->
      {DateTime.to_unix(row.hour_utc), row.project, row.agent, row.provider, row.model,
       row.pricing_tier}
    end)
    |> mark_session_start()
  end

  defp mark_session_start([]), do: []

  defp mark_session_start([first | rest]) do
    [%{first | session_starts: 1} | Enum.map(rest, &%{&1 | session_starts: 0})]
  end

  defp dirty_sessions do
    case Ecto.Adapters.SQL.query(
           Repo,
           "SELECT session_key, version FROM session_reconcile_queue ORDER BY session_key",
           []
         ) do
      {:ok, %{rows: rows}} ->
        Enum.map(rows, fn [session_key, version] ->
          %{session_key: session_key, version: version}
        end)

      _ ->
        []
    end
  end

  defp events_for_sessions([]), do: []

  defp events_for_sessions(keys) do
    keys
    |> Enum.chunk_every(400)
    |> Enum.flat_map(fn chunk ->
      Repo.all(from(event in UsageEvent, where: event.session_key in ^chunk))
    end)
  end

  defp ensure_reconcile_queue(device_id) do
    if is_nil(get_state(reconcile_marker(device_id))) do
      Ecto.Adapters.SQL.query!(
        Repo,
        """
        INSERT INTO session_reconcile_queue (session_key, version, updated_at)
        SELECT DISTINCT session_key, 1, CURRENT_TIMESTAMP FROM usage_events WHERE 1 = 1
        ON CONFLICT(session_key) DO UPDATE SET
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
        """,
        []
      )
    end

    :ok
  end

  defp reconcile_marker(device_id), do: "session_reconcile_initialized:#{device_id}"

  defp clear_dirty(entry) do
    Ecto.Adapters.SQL.query!(
      Repo,
      "DELETE FROM session_reconcile_queue WHERE session_key = ? AND version = ?",
      [entry.session_key, entry.version]
    )

    :ok
  end

  defp digest(snapshot) do
    normalized_rows =
      Enum.map(snapshot.rows, fn row ->
        {
          DateTime.to_iso8601(row.hour_utc),
          row.project,
          row.agent,
          row.provider,
          row.model,
          row.pricing_tier,
          Enum.map(@counter_fields, &Map.fetch!(row, &1))
        }
      end)

    Hash.stable([
      snapshot.device_id,
      snapshot.session_key,
      snapshot.agent,
      DateTime.to_iso8601(snapshot.started_at),
      DateTime.to_iso8601(snapshot.last_activity_at),
      snapshot.quality,
      :erlang.term_to_binary(normalized_rows)
    ])
  end

  defp validate_snapshot(snapshot, device_id) when is_map(snapshot) do
    required = [
      :device_id,
      :session_key,
      :agent,
      :generation,
      :digest,
      :started_at,
      :last_activity_at,
      :quality,
      :rows
    ]

    cond do
      Enum.any?(required, &(not Map.has_key?(snapshot, &1))) ->
        {:error, "snapshot is missing required fields"}

      snapshot.device_id != device_id ->
        {:error, "snapshot device does not match authenticated device"}

      not (is_binary(snapshot.session_key) and byte_size(snapshot.session_key) == 64) ->
        {:error, "invalid session key"}

      not (is_integer(snapshot.generation) and snapshot.generation > 0) ->
        {:error, "invalid generation"}

      not (is_binary(snapshot.digest) and byte_size(snapshot.digest) == 64) ->
        {:error, "invalid digest"}

      not is_list(snapshot.rows) ->
        {:error, "invalid hourly rows"}

      Enum.any?(snapshot.rows, &(not valid_row?(&1))) ->
        {:error, "invalid hourly row"}

      Enum.any?(snapshot.rows, &(&1.agent != snapshot.agent)) ->
        {:error, "hourly row agent does not match session"}

      digest(snapshot) != snapshot.digest ->
        {:error, "snapshot digest does not match its contents"}

      true ->
        :ok
    end
  end

  defp validate_snapshot(_snapshot, _device_id), do: {:error, "snapshot must be a map"}

  defp valid_row?(row) when is_map(row) do
    text_fields = [:project, :agent, :provider, :model, :pricing_tier]

    match?(%DateTime{}, row[:hour_utc]) and
      Enum.all?(text_fields, &is_binary(row[&1])) and
      Enum.all?(@counter_fields, &(is_integer(row[&1]) and row[&1] >= 0))
  end

  defp valid_row?(_row), do: false

  defp append_to_batch([], entry, _max_sessions, _max_bytes), do: [[entry]]

  defp append_to_batch([current | rest] = batches, entry, max_sessions, max_bytes) do
    current_bytes = Enum.reduce(current, 0, &(&1.payload_bytes + &2))

    if length(current) < max_sessions and current_bytes + entry.payload_bytes <= max_bytes do
      [[entry | current] | rest]
    else
      [[entry] | batches]
    end
  end

  defp token_hash(token), do: :crypto.hash(:sha256, token) |> Base.encode16(case: :lower)

  defp sync_proof_from_hash(token_hash, device_id, batch_id, snapshots) do
    payload =
      :erlang.term_to_binary(
        {:sync_sessions, 1, device_id, batch_id, snapshots},
        [:deterministic]
      )

    :crypto.mac(:hmac, :sha256, token_hash, payload)
    |> Base.encode16(case: :lower)
  end

  defp hour(datetime) do
    %{
      datetime
      | minute: 0,
        second: 0,
        microsecond: {0, 6}
    }
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)

  defmodule PlugLike do
    @moduledoc false

    def secure_compare(left, right) do
      left
      |> :crypto.exor(right)
      |> :binary.bin_to_list()
      |> Enum.reduce(0, &Bitwise.bor/2)
      |> Kernel.==(0)
    end
  end
end
