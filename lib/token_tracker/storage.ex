defmodule TokenTracker.Storage do
  @moduledoc false

  import Ecto.Query

  alias TokenTracker.{FileCheckpoint, Repo, UsageEvent}

  @replace_fields [
    :session_key,
    :occurred_at,
    :project,
    :agent,
    :provider,
    :model,
    :input_tokens,
    :output_tokens,
    :reasoning_tokens,
    :cache_read_tokens,
    :cache_write_tokens,
    :session_starts
  ]

  def migrate do
    migrations = Application.app_dir(:token_tracker, "priv/repo/migrations")
    Ecto.Migrator.run(Repo, migrations, :up, all: true, log: false)

    Repo.config()
    |> Keyword.fetch!(:database)
    |> File.chmod!(0o600)

    :ok
  end

  def checkpoint_current?(path_hash, stat, parser_version) do
    case Repo.get(FileCheckpoint, path_hash) do
      %FileCheckpoint{
        size: size,
        mtime_ms: mtime_ms,
        parser_version: ^parser_version
      } ->
        size == stat.size and mtime_ms == mtime_ms(stat)

      %FileCheckpoint{} ->
        false

      nil ->
        false
    end
  end

  def store_file(events, checkpoint) do
    Repo.transaction(fn ->
      existing = existing_keys(events)
      rows = Enum.map(events, &Map.take(&1, [:event_key | @replace_fields]))

      unless rows == [] do
        Repo.insert_all(UsageEvent, rows,
          on_conflict: {:replace, @replace_fields},
          conflict_target: :event_key
        )
      end

      if checkpoint do
        now = DateTime.utc_now()

        Repo.insert_all(
          FileCheckpoint,
          [
            %{
              path_hash: checkpoint.path_hash,
              size: checkpoint.size,
              mtime_ms: checkpoint.mtime_ms,
              parser_version: checkpoint.parser_version,
              inserted_at: now
            }
          ],
          on_conflict: {:replace, [:size, :mtime_ms, :parser_version, :inserted_at]},
          conflict_target: :path_hash
        )
      end

      added = Enum.count(events, &(not MapSet.member?(existing, &1.event_key)))
      %{added: added, updated: length(events) - added}
    end)
  end

  defp existing_keys([]), do: MapSet.new()

  defp existing_keys(events) do
    events
    |> Enum.map(& &1.event_key)
    |> Enum.chunk_every(400)
    |> Enum.flat_map(fn keys ->
      Repo.all(
        from(event in UsageEvent, where: event.event_key in ^keys, select: event.event_key)
      )
    end)
    |> MapSet.new()
  end

  defp mtime_ms(stat), do: stat.mtime * 1_000
end
