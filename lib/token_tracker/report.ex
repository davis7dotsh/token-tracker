defmodule TokenTracker.Report do
  @moduledoc false

  import Ecto.Query

  alias TokenTracker.{Counters, Repo, UsageEvent}

  def print(collection, opts \\ []) do
    all? = Keyword.get(opts, :all, false)
    today = local_today()
    today_counters = counters_for_local_date(today)
    all_time_counters = aggregate()

    IO.puts("Token Tracker")
    IO.puts("")
    print_collection(collection)
    IO.puts("")
    print_counters("Today (#{Date.to_iso8601(today)}, local time)", today_counters)
    IO.puts("")
    print_counters("All time", all_time_counters)
    IO.puts("")
    print_groups("Top models", grouped(:model, all?))
    IO.puts("")
    print_groups("Top projects", grouped(:project, all?))
  end

  def aggregate do
    Repo.one(
      from(event in UsageEvent,
        select: %{
          input_tokens: coalesce(sum(event.input_tokens), 0),
          output_tokens: coalesce(sum(event.output_tokens), 0),
          reasoning_tokens: coalesce(sum(event.reasoning_tokens), 0),
          cache_read_tokens: coalesce(sum(event.cache_read_tokens), 0),
          cache_write_tokens: coalesce(sum(event.cache_write_tokens), 0),
          session_starts: coalesce(sum(event.session_starts), 0)
        }
      )
    )
  end

  def counters_for_local_date(date) do
    earliest = DateTime.add(DateTime.utc_now(), -172_800, :second)

    from(event in UsageEvent,
      where: event.occurred_at >= ^earliest,
      select: %{
        occurred_at: event.occurred_at,
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
    |> Enum.reduce(Counters.zero(), &Counters.add/2)
  end

  def grouped(dimension, all?) when dimension in [:model, :project] do
    from(event in UsageEvent,
      group_by: field(event, ^dimension),
      select: %{
        label: field(event, ^dimension),
        input_tokens: sum(event.input_tokens),
        output_tokens: sum(event.output_tokens),
        reasoning_tokens: sum(event.reasoning_tokens),
        cache_read_tokens: sum(event.cache_read_tokens),
        cache_write_tokens: sum(event.cache_write_tokens),
        session_starts: sum(event.session_starts)
      }
    )
    |> Repo.all()
    |> Enum.sort_by(&Counters.total/1, :desc)
    |> then(fn rows -> if all?, do: rows, else: Enum.take(rows, 10) end)
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

  defp print_collection(result) do
    IO.puts(
      "Collection: #{result.total_files} files found, " <>
        "#{result.scanned_files} scanned, #{result.skipped_files} skipped"
    )

    IO.puts("Events: #{result.added_events} added, #{result.updated_events} refreshed")

    if result.malformed_lines > 0 do
      IO.puts("Warnings: #{result.malformed_lines} malformed lines skipped")
    end

    if result.failed_files > 0 do
      IO.puts("Warnings: #{result.failed_files} files could not be read")
    end
  end

  defp print_counters(title, counters) do
    IO.puts(title)
    IO.puts("  Total        #{number(Counters.total(counters))}")
    IO.puts("  Input        #{number(counters.input_tokens)}")
    IO.puts("  Output       #{number(counters.output_tokens)}")
    IO.puts("  Reasoning    #{number(counters.reasoning_tokens)}")
    IO.puts("  Cache read   #{number(counters.cache_read_tokens)}")
    IO.puts("  Cache write  #{number(counters.cache_write_tokens)}")
    IO.puts("  Sessions     #{number(counters.session_starts)}")
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

      IO.puts("  #{label}  #{number(Counters.total(row))}")
    end)
  end

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
