defmodule TokenTracker.History.ScannerTest do
  use ExUnit.Case

  alias TokenTracker.{Claude, Collector, FileCheckpoint, Pi, Repo, UsageEvent}

  setup do
    Repo.delete_all(FileCheckpoint)
    Repo.delete_all(UsageEvent)
    :ok
  end

  test "imports Pi and Claude Code histories with source identity and checkpoints" do
    root =
      Path.join(System.tmp_dir!(), "agent-scanner-#{System.unique_integer([:positive])}")

    pi_root = Path.join(root, "pi")
    claude_root = Path.join(root, "claude")
    private_text = "private transcript content that must not be persisted"
    File.mkdir_p!(pi_root)
    File.mkdir_p!(claude_root)
    on_exit(fn -> File.rm_rf!(root) end)

    File.write!(
      Path.join(pi_root, "session.jsonl"),
      [
        line(%{
          "type" => "session",
          "id" => "pi-private-session",
          "cwd" => pi_root,
          "timestamp" => "2026-07-23T10:00:00.000Z"
        }),
        line(%{"type" => "message", "message" => %{"role" => "user", "content" => private_text}}),
        line(%{
          "type" => "message",
          "id" => "pi-record",
          "timestamp" => "2026-07-23T10:00:01.000Z",
          "message" => %{
            "responseId" => "pi-response",
            "provider" => "openai-codex",
            "model" => "gpt-pi",
            "usage" => %{
              "input" => 100,
              "output" => 30,
              "reasoning" => 10,
              "cacheRead" => 40,
              "cacheWrite" => 5
            }
          }
        })
      ]
    )

    File.write!(
      Path.join(claude_root, "session.jsonl"),
      [
        line(%{"type" => "user", "message" => %{"content" => private_text}}),
        line(%{
          "type" => "assistant",
          "sessionId" => "claude-private-session",
          "uuid" => "claude-record",
          "cwd" => claude_root,
          "timestamp" => "2026-07-23T11:00:00.000Z",
          "message" => %{
            "id" => "claude-response",
            "model" => "claude-test",
            "usage" => %{
              "input_tokens" => 10,
              "output_tokens" => 20,
              "cache_read_input_tokens" => 30,
              "cache_creation_input_tokens" => 40
            }
          }
        })
      ]
    )

    claude = Claude.Scanner.collect([claude_root])
    pi = Pi.Scanner.collect([pi_root])
    combined = Collector.combine([claude, pi])

    assert combined.total_files == 2
    assert combined.scanned_files == 2
    assert combined.added_events == 2

    events = Repo.all(UsageEvent) |> Map.new(&{&1.agent, &1})
    assert events["claude"].model == "claude-test"
    assert events["claude"].provider == "anthropic"
    assert events["claude"].cache_write_tokens == 40
    assert events["pi"].model == "gpt-pi"
    assert events["pi"].provider == "openai"
    assert events["pi"].output_tokens == 20
    assert events["pi"].reasoning_tokens == 10

    assert Claude.Scanner.collect([claude_root]).skipped_files == 1
    assert Pi.Scanner.collect([pi_root]).skipped_files == 1

    Repo.update_all(FileCheckpoint, set: [parser_version: "older-version"])
    assert Claude.Scanner.collect([claude_root]).scanned_files == 1
    assert Pi.Scanner.collect([pi_root]).scanned_files == 1

    database_path = Repo.config() |> Keyword.fetch!(:database)

    database =
      [database_path, database_path <> "-wal"]
      |> Enum.filter(&File.exists?/1)
      |> Enum.map_join(&File.read!/1)

    assert :binary.match(database, private_text) == :nomatch
    assert :binary.match(database, pi_root) == :nomatch
    assert :binary.match(database, claude_root) == :nomatch
  end

  defp line(value), do: Jason.encode!(value) <> "\n"
end
