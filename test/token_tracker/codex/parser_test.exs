defmodule TokenTracker.Codex.ParserTest do
  use ExUnit.Case, async: true

  alias TokenTracker.Codex.Parser

  test "separates cached input and reasoning without double-counting" do
    context = %{project: "fallback", model: "fallback", session: "fallback"}

    record = %{
      "type" => "event_msg",
      "timestamp" => "2026-07-23T12:34:56.000Z",
      "payload" => %{
        "type" => "token_count",
        "info" => %{
          "last_token_usage" => %{
            "input_tokens" => 100,
            "cached_input_tokens" => 40,
            "output_tokens" => 50,
            "reasoning_output_tokens" => 20,
            "cache_write_input_tokens" => 7
          }
        }
      }
    }

    usage = Parser.usage(record, context)

    assert usage.counters == %{
             input_tokens: 60,
             output_tokens: 30,
             reasoning_tokens: 20,
             cache_read_tokens: 40,
             cache_write_tokens: 0,
             session_starts: 0
           }

    assert usage.timestamp == "2026-07-23T12:34:56.000Z"
    assert usage.project == "fallback"
    assert usage.model == "fallback"
    assert usage.session == "fallback"
  end

  test "tracks session, cwd, and model context from Codex records" do
    initial = %{project: nil, model: nil, session: nil}

    session =
      Parser.update_context(
        %{
          "type" => "session_meta",
          "payload" => %{"id" => "session-secret", "cwd" => "/work/first"}
        },
        initial
      )

    turn =
      Parser.update_context(
        %{
          "type" => "turn_context",
          "payload" => %{"cwd" => "/work/second", "model" => "gpt-example"}
        },
        session
      )

    assert turn == %{
             project: "/work/second",
             model: "gpt-example",
             session: "session-secret"
           }
  end

  test "ignores cumulative totals without last-token usage" do
    record = %{
      "payload" => %{
        "info" => %{
          "total_token_usage" => %{"input_tokens" => 1_000}
        }
      }
    }

    refute Parser.usage(record, %{project: nil, model: nil, session: nil})
  end
end
