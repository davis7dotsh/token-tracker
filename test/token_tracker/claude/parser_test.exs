defmodule TokenTracker.Claude.ParserTest do
  use ExUnit.Case, async: true

  alias TokenTracker.Claude.Parser

  test "parses Claude Code usage and context" do
    record = %{
      "type" => "assistant",
      "timestamp" => "2026-07-23T12:34:56.000Z",
      "sessionId" => "session-private",
      "cwd" => "/work/project",
      "uuid" => "record-id",
      "message" => %{
        "id" => "response-id",
        "model" => "claude-example",
        "usage" => %{
          "input_tokens" => 10,
          "output_tokens" => 20,
          "cache_read_input_tokens" => 30,
          "cache_creation_input_tokens" => 40
        }
      }
    }

    context =
      Parser.update_context(record, %{project: nil, model: nil, session: nil})

    usage = Parser.usage(record, context)

    assert context == %{
             project: "/work/project",
             model: "claude-example",
             session: "session-private"
           }

    assert usage.counters == %{
             input_tokens: 10,
             output_tokens: 20,
             reasoning_tokens: 0,
             cache_read_tokens: 30,
             cache_write_tokens: 40,
             session_starts: 0
           }

    assert usage.message == "response-id"
    assert usage.provider == "anthropic"
  end

  test "ignores records without token usage" do
    refute Parser.usage(
             %{"type" => "user", "message" => %{"content" => "private"}},
             %{project: nil, model: nil, session: nil}
           )
  end
end
