defmodule TokenTracker.Codex.ScannerTest do
  use ExUnit.Case

  import ExUnit.CaptureIO

  alias TokenTracker.{Codex.Scanner, FileCheckpoint, Repo, Report, UsageEvent}

  setup do
    Repo.delete_all(FileCheckpoint)
    Repo.delete_all(UsageEvent)
    :ok
  end

  test "imports history, skips unchanged files, and upserts a changed file" do
    root = Path.join(System.tmp_dir!(), "codex-scanner-#{System.unique_integer([:positive])}")
    session_id = "private-session-#{System.unique_integer([:positive])}"
    transcript_text = "private transcript text that must never be stored"
    file = Path.join(root, "history.jsonl")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)

    File.write!(
      file,
      [
        json_line(%{
          "type" => "session_meta",
          "timestamp" => "2026-07-23T10:00:00.000Z",
          "payload" => %{"id" => session_id, "cwd" => root}
        }),
        json_line(%{
          "type" => "turn_context",
          "timestamp" => "2026-07-23T10:00:01.000Z",
          "payload" => %{"model" => "gpt-test", "cwd" => root}
        }),
        json_line(%{
          "type" => "event_msg",
          "timestamp" => "2026-07-23T10:00:02.000Z",
          "payload" => %{
            "type" => "user_message",
            "message" => transcript_text
          }
        }),
        json_line(token_record("2026-07-23T10:00:03.000Z", 100, 20, 30, 10)),
        "{malformed\n"
      ]
    )

    first = Scanner.collect([root])

    assert first.total_files == 1
    assert first.scanned_files == 1
    assert first.skipped_files == 0
    assert first.malformed_lines == 1
    assert first.added_events == 1
    assert Repo.aggregate(UsageEvent, :count) == 1

    [stored] = Repo.all(UsageEvent)
    assert stored.input_tokens == 80
    assert stored.output_tokens == 20
    assert stored.reasoning_tokens == 10
    assert stored.cache_read_tokens == 20
    assert stored.session_starts == 1
    assert stored.agent == "codex"
    assert stored.provider == "openai"
    refute stored.session_key == session_id

    second = Scanner.collect([root])

    assert second.scanned_files == 0
    assert second.skipped_files == 1
    assert second.added_events == 0
    assert second.updated_events == 0

    File.write!(
      file,
      json_line(token_record("2026-07-23T10:00:04.000Z", 50, 5, 12, 2)),
      [:append]
    )

    third = Scanner.collect([root])

    assert third.scanned_files == 1
    assert third.added_events == 1
    assert third.updated_events == 1
    assert Repo.aggregate(UsageEvent, :count) == 2

    database_path = Repo.config() |> Keyword.fetch!(:database)

    database =
      [database_path, database_path <> "-wal"]
      |> Enum.filter(&File.exists?/1)
      |> Enum.map_join(&File.read!/1)

    assert :binary.match(database, session_id) == :nomatch
    assert :binary.match(database, transcript_text) == :nomatch
    assert :binary.match(database, root) == :nomatch
  end

  test "prints collection, local-day, all-time, model, and project summaries" do
    root = Path.join(System.tmp_dir!(), "codex-report-#{System.unique_integer([:positive])}")
    file = Path.join(root, "history.jsonl")
    now = DateTime.utc_now() |> DateTime.to_iso8601()
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)

    File.write!(
      file,
      [
        json_line(%{"type" => "session_meta", "payload" => %{"id" => "report-session"}}),
        json_line(%{
          "type" => "turn_context",
          "payload" => %{"model" => "gpt-report", "cwd" => root}
        }),
        json_line(token_record(now, 90, 40, 20, 5))
      ]
    )

    result = Scanner.collect([root])

    pricing = %{
      rates: %{
        "gpt-report" => %{
          input: 1.0,
          output: 2.0,
          reasoning: 2.0,
          cache_read: 0.1,
          cache_write: 1.0,
          tiers: []
        }
      },
      missing_models: [],
      fetched_at: "2026-07-23T12:00:00Z",
      source: :cache,
      warning: nil
    }

    output =
      capture_io(fn ->
        Report.print(result, pricing: pricing)
      end)

    assert output =~ "Collection: 1 files found, 1 scanned, 0 skipped"
    assert output =~ "Pricing: models.dev cached"
    assert output =~ "Today (#{Date.to_iso8601(Report.local_today())}, local time)"
    assert output =~ "Estimated API cost"
    assert output =~ "All time"
    assert output =~ "Agents"
    assert output =~ "codex"
    assert output =~ "Top models"
    assert output =~ "gpt-report"
    assert output =~ "Top projects"
  end

  test "database schema contains hashes and counters but no transcript fields" do
    columns =
      Repo
      |> Ecto.Adapters.SQL.query!("PRAGMA table_info(usage_events)", [])
      |> Map.fetch!(:rows)
      |> Enum.map(&Enum.at(&1, 1))

    assert "event_key" in columns
    assert "session_key" in columns
    assert "agent" in columns
    assert "provider" in columns
    assert "input_tokens" in columns
    refute "path" in columns
    refute "session_id" in columns
    refute "prompt" in columns
    refute "transcript" in columns
    refute "content" in columns
  end

  defp token_record(timestamp, input, cached, output, reasoning) do
    %{
      "type" => "event_msg",
      "timestamp" => timestamp,
      "payload" => %{
        "type" => "token_count",
        "info" => %{
          "last_token_usage" => %{
            "input_tokens" => input,
            "cached_input_tokens" => cached,
            "output_tokens" => output,
            "reasoning_output_tokens" => reasoning
          }
        }
      }
    }
  end

  defp json_line(value), do: Jason.encode!(value) <> "\n"
end
