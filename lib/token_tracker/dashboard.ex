defmodule TokenTracker.Dashboard do
  @moduledoc false

  import Ecto.Query

  alias TokenTracker.{
    Counters,
    Device,
    Pricing,
    Repo,
    SessionOutbox,
    SessionSnapshot,
    SessionUsageHourly,
    Sessions
  }

  @periods ~w(day week month)
  @views ~w(device project agent model)
  @filter_keys ~w(device project agent model)
  @max_filter_values 10
  @max_filter_length 160
  @series_limit 10

  def report(params, opts \\ []) do
    now = Keyword.get(opts, :now, DateTime.utc_now())

    pricing_loader =
      Keyword.get(
        opts,
        :pricing_loader,
        Application.get_env(:token_tracker, :dashboard_pricing_loader, &Pricing.load/1)
      )

    with {:ok, query} <- validate_params(params),
         {:ok, window} <- time_window(query.period, query.time_zone, now) do
      rows = query_rows(window, query)
      options = query_options(window)
      all_usage? = any_usage?(window)

      pricing =
        rows
        |> Enum.map(&%{provider: &1.provider, model: &1.model})
        |> Enum.uniq()
        |> pricing_loader.()

      report = build_report(rows, options, query, window, pricing, all_usage?)
      stale_devices = stale_devices(query.filters["device"], now)

      {:ok,
       %{
         report: report,
         stale: stale_devices != [],
         staleDevices: stale_devices,
         pricing: pricing_wire(pricing)
       }}
    end
  end

  def system do
    devices = Repo.all(from(device in Device, order_by: [asc: device.name]))

    usage_by_device =
      Repo.all(
        from(row in SessionUsageHourly,
          group_by: row.device_id,
          select: {
            row.device_id,
            count(row.session_key, :distinct),
            sum(
              row.input_tokens + row.output_tokens + row.reasoning_tokens +
                row.cache_read_tokens + row.cache_write_tokens
            )
          }
        )
      )
      |> Map.new(fn {device_id, sessions, tokens} ->
        {device_id, %{sessions: sessions, tokens: tokens || 0}}
      end)

    activity_by_device =
      Repo.all(
        from(snapshot in SessionSnapshot,
          group_by: snapshot.device_id,
          select: {
            snapshot.device_id,
            max(snapshot.last_activity_at),
            max(snapshot.received_at)
          }
        )
      )
      |> Map.new(fn {device_id, last_activity_at, received_at} ->
        {device_id, %{last_activity_at: last_activity_at, received_at: received_at}}
      end)

    device_rows =
      Enum.map(devices, fn device ->
        usage = Map.get(usage_by_device, device.device_id, %{sessions: 0, tokens: 0})
        activity = Map.get(activity_by_device, device.device_id, %{})

        %{
          name: device.name,
          local: device.local,
          state: device_state(device),
          lastSeenAt: iso(device.last_seen_at),
          lastSyncAt: iso(device.last_sync_at),
          lastActivityAt: iso(activity[:last_activity_at]),
          sessions: usage.sessions,
          tokens: usage.tokens
        }
      end)

    %{
      role: "host",
      devices: device_rows,
      counts: %{
        active: Enum.count(device_rows, &(&1.state == "active")),
        local: Enum.count(device_rows, & &1.local),
        revoked: Enum.count(device_rows, &(&1.state == "revoked"))
      },
      pendingSessions: Repo.aggregate(SessionOutbox, :count),
      lastCollectionAt: Sessions.get_state("last_collection_at"),
      lastSyncAt: Sessions.get_state("last_sync_at"),
      lastError: safe_sync_error()
    }
  end

  def validate_params(params) do
    period = Map.get(params, "period", "day")
    view = Map.get(params, "view", "agent")
    time_zone = Map.get(params, "tz", "UTC")

    cond do
      period not in @periods ->
        {:error, "period must be day, week, or month"}

      view not in @views ->
        {:error, "view must be device, project, agent, or model"}

      not valid_time_zone?(time_zone) ->
        {:error, "tz must be a valid IANA time zone"}

      true ->
        case validate_filters(params) do
          {:ok, filters} ->
            {:ok, %{period: period, view: view, time_zone: time_zone, filters: filters}}

          error ->
            error
        end
    end
  end

  defp validate_filters(params) do
    Enum.reduce_while(@filter_keys, {:ok, %{}}, fn key, {:ok, filters} ->
      values =
        params
        |> Map.get(key, [])
        |> filter_values()
        |> Enum.reject(&(&1 == ""))

      cond do
        length(values) > @max_filter_values ->
          {:halt, {:error, "#{key} accepts at most #{@max_filter_values} values"}}

        Enum.any?(values, &(not is_binary(&1) or String.length(&1) > @max_filter_length)) ->
          {:halt,
           {:error, "#{key} filter values must be at most #{@max_filter_length} characters"}}

        true ->
          {:cont, {:ok, Map.put(filters, key, Enum.uniq(values))}}
      end
    end)
  end

  defp filter_values(values) when is_list(values), do: values

  defp filter_values(value) when is_binary(value) do
    case Jason.decode(value) do
      {:ok, values} when is_list(values) -> values
      _ -> [value]
    end
  end

  defp filter_values(value), do: List.wrap(value)

  defp valid_time_zone?(time_zone) when is_binary(time_zone) do
    match?({:ok, _}, DateTime.now(time_zone, Tz.TimeZoneDatabase))
  end

  defp valid_time_zone?(_time_zone), do: false

  defp time_window("day", time_zone, now) do
    end_utc = floor_hour(now)
    start_utc = DateTime.add(end_utc, -23, :hour)
    buckets = Enum.map(0..23, &DateTime.add(start_utc, &1, :hour))

    {:ok,
     %{
       period: "day",
       time_zone: time_zone,
       start_utc: start_utc,
       end_utc: DateTime.add(end_utc, 1, :hour),
       buckets: buckets,
       key: &DateTime.to_iso8601/1,
       label: &hour_label(&1, time_zone)
     }}
  end

  defp time_window(period, time_zone, now) when period in ["week", "month"] do
    count = if period == "week", do: 7, else: 30
    local_now = DateTime.shift_zone!(now, time_zone, Tz.TimeZoneDatabase)
    first_date = Date.add(DateTime.to_date(local_now), -(count - 1))
    end_date = Date.add(DateTime.to_date(local_now), 1)

    with {:ok, start_local} <- local_midnight(first_date, time_zone),
         {:ok, end_local} <- local_midnight(end_date, time_zone) do
      buckets = Enum.map(0..(count - 1), &Date.add(first_date, &1))

      {:ok,
       %{
         period: period,
         time_zone: time_zone,
         start_utc: DateTime.shift_zone!(start_local, "Etc/UTC", Tz.TimeZoneDatabase),
         end_utc: DateTime.shift_zone!(end_local, "Etc/UTC", Tz.TimeZoneDatabase),
         buckets: buckets,
         key: &Date.to_iso8601/1,
         label: &Calendar.strftime(&1, "%b %-d")
       }}
    end
  end

  defp local_midnight(date, time_zone) do
    case DateTime.new(date, ~T[00:00:00], time_zone, Tz.TimeZoneDatabase) do
      {:ok, datetime} -> {:ok, datetime}
      {:ambiguous, first, _second} -> {:ok, first}
      {:gap, _before, after_gap} -> {:ok, after_gap}
      {:error, reason} -> {:error, "could not build local reporting window: #{inspect(reason)}"}
    end
  end

  # Aggregates in SQL down to one row per (bucket, dimension, pricing identity).
  # Filters are applied by the database so the report never materializes rows it
  # will discard, and each row already carries its local bucket key so grouping
  # never repeats a time zone conversion.
  defp query_rows(window, query) do
    dimension = dimension_expr(query.view)

    groups = [
      dynamic([row, _device], row.hour_utc),
      dynamic([row, _device], row.provider),
      dynamic([row, _device], row.model),
      dynamic([row, _device], row.pricing_tier),
      dimension
    ]

    SessionUsageHourly
    |> apply_window(window)
    |> apply_filters(query.filters)
    |> group_by([row, device], ^groups)
    |> select([row, _device], %{
      hour_utc: row.hour_utc,
      provider: row.provider,
      model: row.model,
      pricing_tier: row.pricing_tier,
      input_tokens: sum(row.input_tokens),
      output_tokens: sum(row.output_tokens),
      reasoning_tokens: sum(row.reasoning_tokens),
      cache_read_tokens: sum(row.cache_read_tokens),
      cache_write_tokens: sum(row.cache_write_tokens),
      session_starts: sum(row.session_starts)
    })
    |> select_dimension(query.view)
    |> Repo.all()
    |> Enum.map(&Map.put(&1, :bucket, bucket_key(&1.hour_utc, window)))
  end

  defp select_dimension(queryable, "device"),
    do: select_merge(queryable, [_row, device], %{dimension: device.name})

  defp select_dimension(queryable, "project"),
    do: select_merge(queryable, [row, _device], %{dimension: row.project})

  defp select_dimension(queryable, "agent"),
    do: select_merge(queryable, [row, _device], %{dimension: row.agent})

  defp select_dimension(queryable, "model"),
    do: select_merge(queryable, [row, _device], %{dimension: row.model})

  # A session spans many hourly rows and often several models, so its identity is
  # counted distinctly by the database per dimension. Summing a per-row session
  # column instead would multiply-count the same session.
  defp query_sessions(window, query, view) do
    SessionUsageHourly
    |> apply_window(window)
    |> apply_filters(query.filters)
    |> group_by([row, device], ^[dimension_expr(view)])
    |> select([row, _device], %{
      sessions: count(fragment("DISTINCT ? || ':' || ?", row.device_id, row.session_key))
    })
    |> select_dimension(view)
    |> Repo.all()
    |> Map.new(&{&1.dimension, &1.sessions})
  end

  defp query_total_sessions(window, query) do
    SessionUsageHourly
    |> apply_window(window)
    |> apply_filters(query.filters)
    |> select(
      [row, _device],
      count(fragment("DISTINCT ? || ':' || ?", row.device_id, row.session_key))
    )
    |> Repo.one()
    |> Kernel.||(0)
  end

  # Filter menus list every value available in the window, not just the values
  # that survive the current filters, so a selection can always be widened.
  # One grouped scan yields every distinct combination in the window, which is far
  # smaller than the row count, so the four menus are derived from it in memory
  # rather than from four separate table scans.
  defp query_options(window) do
    combinations =
      SessionUsageHourly
      |> apply_window(window)
      |> group_by([row, device], [device.name, row.project, row.agent, row.model])
      |> select([row, device], {device.name, row.project, row.agent, row.model})
      |> Repo.all()

    %{
      devices: distinct_sorted(combinations, 0),
      projects: distinct_sorted(combinations, 1),
      agents: distinct_sorted(combinations, 2),
      models: distinct_sorted(combinations, 3)
    }
  end

  defp distinct_sorted(combinations, position) do
    combinations
    |> MapSet.new(&elem(&1, position))
    |> Enum.sort()
  end

  defp apply_window(queryable, window) do
    from(row in queryable,
      join: device in Device,
      on: device.device_id == row.device_id,
      where: row.hour_utc >= ^window.start_utc and row.hour_utc < ^window.end_utc
    )
  end

  defp apply_filters(queryable, filters) do
    Enum.reduce(@filter_keys, queryable, fn key, acc ->
      case Map.get(filters, key, []) do
        [] -> acc
        values -> filter_by(acc, key, values)
      end
    end)
  end

  defp filter_by(queryable, "device", values),
    do: where(queryable, [_row, device], device.name in ^values)

  defp filter_by(queryable, "project", values),
    do: where(queryable, [row, _device], row.project in ^values)

  defp filter_by(queryable, "agent", values),
    do: where(queryable, [row, _device], row.agent in ^values)

  defp filter_by(queryable, "model", values),
    do: where(queryable, [row, _device], row.model in ^values)

  # The device dimension lives on the joined devices table while the rest are
  # columns on the usage table, so each is expressed as a dynamic the queries
  # above can reuse for grouping, ordering, selecting, and filtering alike.
  defp dimension_expr("device"), do: dynamic([_row, device], device.name)
  defp dimension_expr("project"), do: dynamic([row, _device], row.project)
  defp dimension_expr("agent"), do: dynamic([row, _device], row.agent)
  defp dimension_expr("model"), do: dynamic([row, _device], row.model)

  defp any_usage?(window) do
    SessionUsageHourly
    |> where([row], row.hour_utc >= ^window.start_utc and row.hour_utc < ^window.end_utc)
    |> select([row], count(row.session_key) > 0)
    |> Repo.one()
  end

  # Walks the aggregated rows once, accumulating every figure the report needs
  # keyed by series and by bucket. The previous implementation rescanned the full
  # row set for each bucket and again for each series within it, which grew as
  # buckets times series times rows.
  defp build_report(rows, options, query, window, pricing, all_usage?) do
    priced = Enum.map(rows, &Map.put(&1, :cost, row_cost(&1, pricing)))

    totals_by_dimension =
      Enum.reduce(priced, %{}, fn row, acc ->
        Map.update(acc, row.dimension, accumulate(zero_bucket(), row), &accumulate(&1, row))
      end)

    top_keys =
      totals_by_dimension
      |> Enum.sort_by(fn {_key, totals} -> Counters.total(totals.counters) end, :desc)
      |> Enum.take(@series_limit)
      |> Enum.map(&elem(&1, 0))

    top_set = MapSet.new(top_keys)
    overflow_keys = Map.keys(totals_by_dimension) |> Enum.reject(&MapSet.member?(top_set, &1))
    series = build_series(totals_by_dimension, top_keys, overflow_keys)
    series_key_by_dimension = series_lookup(series, overflow_keys)

    bucket_totals = accumulate_buckets(priced, series_key_by_dimension)
    session_counts = query_sessions(window, query, query.view)

    bars =
      Enum.map(window.buckets, fn bucket ->
        key = window.key.(bucket)
        totals = Map.get(bucket_totals, key, zero_bucket())

        %{
          key: key,
          label: window.label.(bucket),
          datetime: key,
          tokens: Counters.total(totals.counters),
          cost: totals.cost,
          segments:
            Enum.map(series, fn item ->
              %{key: item.key, tokens: Map.get(totals.segments, item.key, 0)}
            end)
        }
      end)

    %{
      period: query.period,
      view: query.view,
      timeZone: query.time_zone,
      series: Enum.map(series, &Map.take(&1, [:key, :label, :tokens, :isOther, :count])),
      bars: bars,
      totals: Enum.map(series, &total_wire(&1, totals_by_dimension, session_counts)),
      combined: combined_wire(priced, query_total_sessions(window, query)),
      options: options,
      hasUsage: all_usage?,
      hasMatches: rows != [],
      truncated: overflow_keys != []
    }
  end

  defp zero_bucket, do: %{counters: Counters.zero(), cost: 0.0, segments: %{}}

  defp accumulate(totals, row) do
    %{totals | counters: Counters.add(totals.counters, row), cost: totals.cost + row.cost}
  end

  defp accumulate_buckets(rows, series_key_by_dimension) do
    Enum.reduce(rows, %{}, fn row, acc ->
      series_key = Map.fetch!(series_key_by_dimension, row.dimension)
      tokens = Counters.total(row)

      Map.update(acc, row.bucket, seed_bucket(row, series_key, tokens), fn totals ->
        totals
        |> accumulate(row)
        |> Map.update!(:segments, &Map.update(&1, series_key, tokens, fn sum -> sum + tokens end))
      end)
    end)
  end

  defp seed_bucket(row, series_key, tokens) do
    zero_bucket()
    |> accumulate(row)
    |> Map.put(:segments, %{series_key => tokens})
  end

  defp row_cost(row, pricing) do
    case pricing.rates[{row.provider, row.model}] || pricing.rates[row.model] do
      nil -> 0.0
      rates -> Pricing.estimate(row, rates, row.pricing_tier)
    end
  end

  defp series_lookup(series, overflow_keys) do
    overflow_key = Enum.find_value(series, &if(&1.isOther, do: &1.key))

    series
    |> Enum.reject(& &1.isOther)
    |> Map.new(&{&1.dimension, &1.key})
    |> then(fn lookup ->
      Enum.reduce(overflow_keys, lookup, &Map.put(&2, &1, overflow_key))
    end)
  end

  defp build_series(totals_by_dimension, top_keys, overflow_keys) do
    named =
      Enum.map(top_keys, fn key ->
        totals = Map.fetch!(totals_by_dimension, key)

        %{
          dimension: key,
          label: key,
          tokens: Counters.total(totals.counters),
          isOther: false,
          count: 1
        }
      end)

    overflow =
      if overflow_keys == [] do
        []
      else
        tokens =
          Enum.reduce(overflow_keys, 0, fn key, sum ->
            sum + Counters.total(Map.fetch!(totals_by_dimension, key).counters)
          end)

        [
          %{
            dimension: :overflow,
            dimensions: overflow_keys,
            label: "Other",
            tokens: tokens,
            isOther: true,
            count: length(overflow_keys)
          }
        ]
      end

    (named ++ overflow)
    |> Enum.sort_by(& &1.tokens, :desc)
    |> Enum.with_index()
    |> Enum.map(fn {series, index} -> Map.put(series, :key, "series-#{index}") end)
  end

  defp bucket_key(hour_utc, %{period: "day"}), do: DateTime.to_iso8601(floor_hour(hour_utc))

  defp bucket_key(hour_utc, window) do
    hour_utc
    |> DateTime.shift_zone!(window.time_zone, Tz.TimeZoneDatabase)
    |> DateTime.to_date()
    |> Date.to_iso8601()
  end

  # An "Other" series spans several dimension values, so its totals are summed
  # across them and its session count is the sum of theirs.
  defp total_wire(%{isOther: true} = series, totals_by_dimension, session_counts) do
    totals =
      Enum.reduce(series.dimensions, zero_bucket(), fn key, acc ->
        totals = Map.fetch!(totals_by_dimension, key)

        %{
          acc
          | counters: Counters.add(acc.counters, totals.counters),
            cost: acc.cost + totals.cost
        }
      end)

    sessions = Enum.reduce(series.dimensions, 0, &(&2 + Map.get(session_counts, &1, 0)))
    wire(series, totals, sessions)
  end

  defp total_wire(series, totals_by_dimension, session_counts) do
    totals = Map.fetch!(totals_by_dimension, series.dimension)
    wire(series, totals, Map.get(session_counts, series.dimension, 0))
  end

  defp wire(series, totals, sessions) do
    %{
      key: series.key,
      label: series.label,
      counters: counters_wire(totals.counters, sessions),
      tokens: Counters.total(totals.counters),
      cost: totals.cost,
      isOther: series.isOther,
      count: series.count
    }
  end

  defp combined_wire(rows, sessions) do
    totals = Enum.reduce(rows, zero_bucket(), &accumulate(&2, &1))

    %{
      key: "combined",
      label: "Combined",
      counters: counters_wire(totals.counters, sessions),
      tokens: Counters.total(totals.counters),
      cost: totals.cost,
      isOther: false,
      count: 1
    }
  end

  defp counters_wire(counters, sessions) do
    %{
      input: counters.input_tokens,
      output: counters.output_tokens,
      reasoning: counters.reasoning_tokens,
      cacheRead: counters.cache_read_tokens,
      cacheWrite: counters.cache_write_tokens,
      sessions: sessions
    }
  end

  defp stale_devices(selected_names, now) do
    devices =
      Device
      |> where([device], is_nil(device.revoked_at))
      |> then(fn query ->
        if selected_names == [],
          do: query,
          else: where(query, [device], device.name in ^selected_names)
      end)
      |> Repo.all()

    received_by_device =
      SessionSnapshot
      |> group_by([snapshot], snapshot.device_id)
      |> select([snapshot], {snapshot.device_id, max(snapshot.received_at)})
      |> Repo.all()
      |> Map.new()

    collection_at = parse_timestamp(Sessions.get_state("last_collection_at"))

    devices
    |> Enum.filter(fn device ->
      freshest =
        if device.local do
          newest_datetime([collection_at, received_by_device[device.device_id]])
        else
          newest_datetime([device.last_sync_at, received_by_device[device.device_id]])
        end

      is_nil(freshest) or DateTime.diff(now, freshest, :minute) > 15
    end)
    |> Enum.map(& &1.name)
    |> Enum.sort()
  end

  defp pricing_wire(pricing) do
    %{
      source: to_string(pricing.source),
      fetchedAt: pricing.fetched_at,
      missingModels: pricing.missing_models,
      warning: pricing.warning
    }
  end

  defp floor_hour(datetime), do: %{datetime | minute: 0, second: 0, microsecond: {0, 6}}

  defp hour_label(datetime, time_zone),
    do:
      datetime
      |> DateTime.shift_zone!(time_zone, Tz.TimeZoneDatabase)
      |> Calendar.strftime("%-I %p")

  defp iso(nil), do: nil
  defp iso(datetime), do: DateTime.to_iso8601(datetime)

  defp parse_timestamp(nil), do: nil

  defp parse_timestamp(timestamp) do
    case DateTime.from_iso8601(timestamp) do
      {:ok, datetime, _offset} -> datetime
      _ -> nil
    end
  end

  defp newest_datetime(values) do
    values
    |> Enum.reject(&is_nil/1)
    |> case do
      [] -> nil
      datetimes -> Enum.max(datetimes, DateTime)
    end
  end

  defp safe_sync_error do
    if Sessions.get_state("last_sync_error"), do: "Synchronization needs attention", else: nil
  end

  defp device_state(%Device{revoked_at: %DateTime{}}), do: "revoked"
  defp device_state(%Device{local: true}), do: "local"
  defp device_state(_device), do: "active"
end
