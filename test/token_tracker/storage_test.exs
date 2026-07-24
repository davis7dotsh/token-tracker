defmodule TokenTracker.StorageTest do
  use ExUnit.Case

  alias TokenTracker.{Hash, Repo, Storage, UsageEvent}

  setup do
    Repo.delete_all(UsageEvent)
    :ok
  end

  test "stores files whose events exceed SQLite's bind-variable limit" do
    events =
      Enum.map(1..2_600, fn index ->
        %{
          event_key: Hash.stable(["large-file-event", index]),
          session_key: Hash.stable(["large-file-session"]),
          occurred_at: ~U[2026-07-24 10:00:00.000000Z],
          project: "project",
          agent: "codex",
          provider: "openai",
          model: "gpt-test",
          input_tokens: index,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          session_starts: 0
        }
      end)

    assert {:ok, %{added: 2_600, updated: 0}} = Storage.store_file(events, nil)
    assert Repo.aggregate(UsageEvent, :count) == 2_600
  end
end
