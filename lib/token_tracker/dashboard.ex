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
      unfiltered_rows = query_rows(window.start_utc, window.end_utc)
      rows = filter_rows(unfiltered_rows, query.filters)

      all_usage? = any_usage?(window)

      pricing =
        rows
        |> Enum.map(&%{provider: &1.provider, model: &1.model})
        |> Enum.uniq()
        |> pricing_loader.()

      report = build_report(rows, unfiltered_rows, query, window, pricing, all_usage?)
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

  defp query_rows(start_utc, end_utc) do
    base =
      from(row in SessionUsageHourly,
        join: device in Device,
        on: device.device_id == row.device_id,
        join: snapshot in SessionSnapshot,
        on: snapshot.device_id == row.device_id and snapshot.session_key == row.session_key,
        select: %{
          device_id: row.device_id,
          device: device.name,
          session_key: row.session_key,
          hour_utc: row.hour_utc,
          project: row.project,
          agent: row.agent,
          provider: row.provider,
          model: row.model,
          pricing_tier: row.pricing_tier,
          quality: snapshot.quality,
          received_at: snapshot.received_at,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          reasoning_tokens: row.reasoning_tokens,
          cache_read_tokens: row.cache_read_tokens,
          cache_write_tokens: row.cache_write_tokens,
          session_starts: row.session_starts
        }
      )

    query =
      if start_utc && end_utc do
        from(row in base, where: row.hour_utc >= ^start_utc and row.hour_utc < ^end_utc)
      else
        base
      end

    Repo.all(query)
  end

  defp filter_rows(rows, filters) do
    Enum.filter(rows, fn row ->
      filter_match?(filters["device"], row.device) and
        filter_match?(filters["project"], row.project) and
        filter_match?(filters["agent"], row.agent) and
        filter_match?(filters["model"], row.model)
    end)
  end

  defp filter_match?([], _value), do: true
  defp filter_match?(values, value), do: value in values

  defp any_usage?(window) do
    SessionUsageHourly
    |> where([row], row.hour_utc >= ^window.start_utc and row.hour_utc < ^window.end_utc)
    |> select([row], count(row.session_key) > 0)
    |> Repo.one()
  end

  defp build_report(rows, unfiltered_rows, query, window, pricing, all_usage?) do
    top_keys =
      rows
      |> Enum.group_by(&dimension(&1, query.view))
      |> Enum.map(fn {key, grouped} -> {key, token_total(grouped)} end)
      |> Enum.sort_by(&elem(&1, 1), :desc)
      |> Enum.take(@series_limit)
      |> Enum.map(&elem(&1, 0))

    grouped_rows = Enum.group_by(rows, &series_key(&1, query.view, top_keys))
    series = build_series(grouped_rows, query.view)

    bars =
      Enum.map(window.buckets, fn bucket ->
        bucket_rows =
          Enum.filter(
            rows,
            &(bucket_key(&1, query.period, query.time_zone) == window.key.(bucket))
          )

        summary = summarize(bucket_rows, pricing)

        %{
          key: window.key.(bucket),
          label: window.label.(bucket),
          datetime: window.key.(bucket),
          tokens: Counters.total(summary.counters),
          cost: summary.cost,
          segments:
            Enum.map(series, fn item ->
              segment_rows =
                Enum.filter(
                  bucket_rows,
                  &(series_key(&1, query.view, top_keys) == item.internal)
                )

              %{key: item.key, tokens: token_total(segment_rows)}
            end),
          qualities: qualities(bucket_rows)
        }
      end)

    totals =
      series
      |> Enum.map(fn item ->
        grouped = Map.get(grouped_rows, item.internal, [])
        total_wire(item, grouped, pricing)
      end)

    %{
      period: query.period,
      view: query.view,
      timeZone: query.time_zone,
      series: Enum.map(series, &Map.delete(&1, :internal)),
      bars: bars,
      totals: totals,
      combined: combined_wire(rows, pricing),
      options: options(unfiltered_rows),
      hasUsage: all_usage?,
      hasMatches: rows != [],
      truncated: Map.has_key?(grouped_rows, :overflow)
    }
  end

  defp build_series(grouped_rows, view) do
    grouped_rows
    |> Enum.map(fn {internal, rows} ->
      original_count =
        if internal == :overflow do
          rows |> Enum.map(&dimension(&1, view)) |> Enum.uniq() |> length()
        else
          1
        end

      %{
        internal: internal,
        label: series_label(internal),
        tokens: token_total(rows),
        isOther: internal == :overflow,
        count: original_count
      }
    end)
    |> Enum.sort_by(& &1.tokens, :desc)
    |> Enum.with_index()
    |> Enum.map(fn {series, index} ->
      Map.put(series, :key, "series-#{index}")
    end)
  end

  defp series_key(row, view, top_keys) do
    key = dimension(row, view)
    if key in top_keys, do: {:value, key}, else: :overflow
  end

  defp series_label({:value, key}), do: key
  defp series_label(:overflow), do: "Other"

  defp dimension(row, "device"), do: row.device
  defp dimension(row, "project"), do: row.project
  defp dimension(row, "agent"), do: row.agent
  defp dimension(row, "model"), do: row.model

  defp bucket_key(row, "day", _time_zone), do: DateTime.to_iso8601(floor_hour(row.hour_utc))

  defp bucket_key(row, _period, time_zone) do
    row.hour_utc
    |> DateTime.shift_zone!(time_zone, Tz.TimeZoneDatabase)
    |> DateTime.to_date()
    |> Date.to_iso8601()
  end

  defp summarize(rows, pricing) do
    Enum.reduce(rows, %{counters: Counters.zero(), cost: 0.0}, fn row, summary ->
      counters = Counters.add(summary.counters, row)

      cost =
        case pricing.rates[{row.provider, row.model}] || pricing.rates[row.model] do
          nil -> 0.0
          rates -> Pricing.estimate(row, rates, row.pricing_tier)
        end

      %{counters: counters, cost: summary.cost + cost}
    end)
  end

  defp total_wire(series, rows, pricing) do
    summary = summarize(rows, pricing)

    %{
      key: series.key,
      label: series.label,
      counters: counters_wire(summary.counters, distinct_sessions(rows)),
      tokens: Counters.total(summary.counters),
      cost: summary.cost,
      qualities: qualities(rows),
      isOther: series.isOther,
      count: series.count
    }
  end

  defp combined_wire(rows, pricing) do
    summary = summarize(rows, pricing)

    %{
      key: "combined",
      label: "Combined",
      counters: counters_wire(summary.counters, distinct_sessions(rows)),
      tokens: Counters.total(summary.counters),
      cost: summary.cost,
      qualities: qualities(rows),
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

  defp distinct_sessions(rows) do
    rows
    |> MapSet.new(&{&1.device_id, &1.session_key})
    |> MapSet.size()
  end

  defp token_total(rows) do
    rows
    |> Enum.reduce(Counters.zero(), &Counters.add/2)
    |> Counters.total()
  end

  defp qualities(rows), do: rows |> Enum.map(& &1.quality) |> Enum.uniq() |> Enum.sort()

  defp options(rows) do
    %{
      devices: option_values(rows, :device),
      projects: option_values(rows, :project),
      agents: option_values(rows, :agent),
      models: option_values(rows, :model)
    }
  end

  defp option_values(rows, key),
    do: rows |> Enum.map(&Map.fetch!(&1, key)) |> Enum.uniq() |> Enum.sort()

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
