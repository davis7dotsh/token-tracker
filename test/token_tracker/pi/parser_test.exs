defmodule TokenTracker.Pi.ParserTest do
  use ExUnit.Case, async: true

  alias TokenTracker.Pi.Parser

  test "tracks session context and separates reasoning from output" do
    initial = %{project: nil, model: nil, session: nil}

    context =
      Parser.update_context(
        %{
          "type" => "session",
          "id" => "session-private",
          "cwd" => "/work/project"
        },
        initial
      )

    record = %{
      "type" => "message",
      "id" => "local-message-id",
      "timestamp" => "2026-07-23T12:34:56.000Z",
      "message" => %{
        "responseId" => "response-id",
        "provider" => "openai-codex",
        "model" => "gpt-example",
        "usage" => %{
          "input" => 100,
          "output" => 50,
          "reasoning" => 20,
          "cacheRead" => 30,
          "cacheWrite" => 40
        }
      }
    }

    usage = Parser.usage(record, context)

    assert usage.counters == %{
             input_tokens: 100,
             output_tokens: 30,
             reasoning_tokens: 20,
             cache_read_tokens: 30,
             cache_write_tokens: 40,
             session_starts: 0
           }

    assert usage.project == "/work/project"
    assert usage.session == "session-private"
    assert usage.model == "gpt-example"
    assert usage.provider == "openai"
    assert usage.message == "response-id"
  end

  test "ignores failed responses with zero usage" do
    refute Parser.usage(
             %{"message" => %{"model" => "example", "usage" => %{"input" => 0}}},
             %{project: nil, model: nil, session: nil}
           )
  end
end
