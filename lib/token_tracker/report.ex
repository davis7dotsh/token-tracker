defmodule TokenTracker.Report do
  @moduledoc false

  import Ecto.Query

  alias TokenTracker.{Counters, Pricing, Repo, UsageEvent}

  def print(collection, opts \\ []) do
    all? = Keyword.get(opts, :all, false)
    pricing = Keyword.get(opts, :pricing, empty_pricing())
    today = local_today()
    all_time_rows = aggregate_rows()
    today_rows = rows_for_local_date(today)

    IO.puts("Token Tracker")
    IO.puts("")
    print_collection(collection)
    print_pricing(pricing)
    IO.puts("")
    print_summary("Today (#{Date.to_iso8601(today)}, local time)", summarize(today_rows, pricing))
    IO.puts("")
    print_summary("All time", summarize(all_time_rows, pricing))
    IO.puts("")
    print_groups("Agents", grouped_rows(all_time_rows, :agent, pricing, true))
    IO.puts("")
    print_groups("Top models", grouped_rows(all_time_rows, :model, pricing, all?))
    IO.puts("")
    print_groups("Top projects", grouped_rows(all_time_rows, :project, pricing, all?))
  end

  def models do
    Repo.all(
      from(event in UsageEvent,
        distinct: true,
        select: %{provider: event.provider, model: event.model}
      )
    )
  end

  def aggregate do
    aggregate_rows()
    |> Enum.reduce(Counters.zero(), &Counters.add/2)
  end

  def counters_for_local_date(date) do
    date
    |> rows_for_local_date()
    |> Enum.reduce(Counters.zero(), &Counters.add/2)
  end

  def grouped(dimension, all?) when dimension in [:agent, :model, :project] do
    aggregate_rows()
    |> Enum.group_by(&Map.fetch!(&1, dimension))
    |> Enum.map(fn {label, rows} ->
      rows
      |> Enum.reduce(Counters.zero(), &Counters.add/2)
      |> Map.put(:label, label)
    end)
    |> Enum.sort_by(&Counters.total/1, :desc)
    |> take_limit(all?)
  end

  def local_today do
    {{year, month, day}, _time} = :calendar.local_time()
    Date.new!(year, month, day)
  end

  def local_date(datetime) do
    {{year, month, day}, _time} =
      datetime
      |> DateTime.to_naive()
      |> NaiveDateTime.to_erl()
      |> :calendar.universal_time_to_local_time()

    Date.new!(year, month, day)
  end

  defp aggregate_rows do
    Repo.all(
      from(event in UsageEvent,
        select: %{
          project: event.project,
          agent: event.agent,
          provider: event.provider,
          model: event.model,
          input_tokens: event.input_tokens,
          output_tokens: event.output_tokens,
          reasoning_tokens: event.reasoning_tokens,
          cache_read_tokens: event.cache_read_tokens,
          cache_write_tokens: event.cache_write_tokens,
          session_starts: event.session_starts
        }
      )
    )
  end

  defp rows_for_local_date(date) do
    earliest = DateTime.add(DateTime.utc_now(), -172_800, :second)

    from(event in UsageEvent,
      where: event.occurred_at >= ^earliest,
      select: %{
        occurred_at: event.occurred_at,
        project: event.project,
        agent: event.agent,
        provider: event.provider,
        model: event.model,
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        reasoning_tokens: event.reasoning_tokens,
        cache_read_tokens: event.cache_read_tokens,
        cache_write_tokens: event.cache_write_tokens,
        session_starts: event.session_starts
      }
    )
    |> Repo.all()
    |> Enum.filter(&(local_date(&1.occurred_at) == date))
  end

  defp summarize(rows, pricing) do
    Enum.reduce(rows, empty_summary(), fn row, summary ->
      summary = %{summary | counters: Counters.add(summary.counters, row)}

      case pricing.rates[{row.provider, row.model}] || pricing.rates[row.model] do
        nil ->
          %{
            summary
            | unpriced_tokens: summary.unpriced_tokens + Counters.total(row),
              unpriced_models: MapSet.put(summary.unpriced_models, row.model)
          }

        rates ->
          %{summary | cost: summary.cost + Pricing.estimate(row, rates)}
      end
    end)
  end

  defp grouped_rows(rows, dimension, pricing, all?) do
    rows
    |> Enum.group_by(&Map.fetch!(&1, dimension))
    |> Enum.map(fn {label, grouped} ->
      grouped
      |> summarize(pricing)
      |> Map.put(:label, label)
    end)
    |> Enum.sort_by(&Counters.total(&1.counters), :desc)
    |> take_limit(all?)
  end

  defp take_limit(rows, true), do: rows
  defp take_limit(rows, false), do: Enum.take(rows, 10)

  defp empty_summary do
    %{
      counters: Counters.zero(),
      cost: 0.0,
      unpriced_tokens: 0,
      unpriced_models: MapSet.new()
    }
  end

  defp empty_pricing do
    %{
      rates: %{},
      missing_models: [],
      fetched_at: nil,
      source: :none,
      warning: nil
    }
  end

  defp print_collection(result) do
    IO.puts(
      "Collection: #{result.total_files} files found, " <>
        "#{result.scanned_files} scanned, #{result.skipped_files} skipped"
    )

    IO.puts("Events: #{result.added_events} added, #{result.updated_events} refreshed")

    Enum.each(Map.get(result, :sources, []), fn source ->
      IO.puts(
        "  #{source.label}: #{source.total_files} found, " <>
          "#{source.scanned_files} scanned, #{source.skipped_files} skipped"
      )
    end)

    if result.malformed_lines > 0 do
      IO.puts("Warnings: #{result.malformed_lines} malformed lines skipped")
    end

    if result.failed_files > 0 do
      IO.puts("Warnings: #{result.failed_files} files could not be read")
    end
  end

  defp print_pricing(pricing) do
    source =
      case pricing.source do
        :downloaded -> "downloaded"
        :validated -> "validated"
        :cache -> "cached"
        :stale -> "stale cache"
        _ -> "unavailable"
      end

    fetched = if pricing.fetched_at, do: " at #{pricing.fetched_at}", else: ""
    IO.puts("Pricing: models.dev #{source}#{fetched} (24-hour TTL)")

    if pricing.warning, do: IO.puts("Pricing warning: #{pricing.warning}")

    if pricing.missing_models != [] do
      IO.puts("Missing pricing: #{Enum.join(pricing.missing_models, ", ")}")
    end
  end

  defp print_summary(title, summary) do
    counters = summary.counters

    IO.puts(title)
    IO.puts("  Total               #{number(Counters.total(counters))}")
    IO.puts("  Input               #{number(counters.input_tokens)}")
    IO.puts("  Output              #{number(counters.output_tokens)}")
    IO.puts("  Reasoning           #{number(counters.reasoning_tokens)}")
    IO.puts("  Cache read          #{number(counters.cache_read_tokens)}")
    IO.puts("  Cache write         #{number(counters.cache_write_tokens)}")
    IO.puts("  Sessions            #{number(counters.session_starts)}")
    IO.puts("  Estimated API cost  #{money(summary.cost)}")

    if summary.unpriced_tokens > 0 do
      models = summary.unpriced_models |> Enum.sort() |> Enum.join(", ")
      IO.puts("  Unpriced tokens     #{number(summary.unpriced_tokens)} (#{models})")
    end
  end

  defp print_groups(title, []) do
    IO.puts(title)
    IO.puts("  No usage found")
  end

  defp print_groups(title, rows) do
    width =
      rows
      |> Enum.map(&String.length(&1.label))
      |> Enum.max()
      |> min(48)

    IO.puts(title)

    Enum.each(rows, fn row ->
      label =
        row.label
        |> String.slice(0, width)
        |> String.pad_trailing(width)

      IO.puts("  #{label}  #{number(Counters.total(row.counters))} tokens  #{cost_label(row)}")
    end)
  end

  defp cost_label(%{unpriced_tokens: 0, cost: cost}), do: money(cost)

  defp cost_label(%{unpriced_tokens: unpriced, cost: cost}) when cost == 0 do
    "#{number(unpriced)} unpriced"
  end

  defp cost_label(%{unpriced_tokens: unpriced, cost: cost}) do
    "#{money(cost)} + #{number(unpriced)} unpriced"
  end

  defp money(value), do: "$" <> :erlang.float_to_binary(value, decimals: 2)

  defp number(value) do
    value
    |> Integer.to_string()
    |> String.reverse()
    |> String.codepoints()
    |> Enum.chunk_every(3)
    |> Enum.map_join(",", &Enum.join/1)
    |> String.reverse()
  end
end
