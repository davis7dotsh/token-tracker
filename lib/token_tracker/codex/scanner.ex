defmodule TokenTracker.Codex.Scanner do
  @moduledoc false

  alias TokenTracker.{Codex.Parser, Counters, Hash, Paths, Project, Storage}

  @parser_version "codex-v1"

  def collect(roots \\ Paths.codex_roots()) do
    files =
      roots
      |> Enum.flat_map(&Path.wildcard(Path.join(&1, "**/*.jsonl"), match_dot: true))
      |> Enum.uniq()
      |> Enum.sort()

    Enum.reduce(files, initial_result(length(files)), &scan_file/2)
  end

  defp initial_result(total_files) do
    %{
      total_files: total_files,
      scanned_files: 0,
      skipped_files: 0,
      failed_files: 0,
      malformed_lines: 0,
      added_events: 0,
      updated_events: 0
    }
  end

  defp scan_file(path, result) do
    with {:ok, before_stat} <- File.stat(path, time: :posix) do
      path_hash = Hash.stable([path])

      if Storage.checkpoint_current?(path_hash, before_stat, @parser_version) do
        Map.update!(result, :skipped_files, &(&1 + 1))
      else
        persist_scan(path, path_hash, before_stat, result)
      end
    else
      _ -> Map.update!(result, :failed_files, &(&1 + 1))
    end
  rescue
    _error in File.Error -> Map.update!(result, :failed_files, &(&1 + 1))
  end

  defp persist_scan(path, path_hash, before_stat, result) do
    parsed = parse_file(path, path_hash, before_stat)
    checkpoint = stable_checkpoint(path, path_hash, before_stat)
    {:ok, stored} = Storage.store_file(Map.values(parsed.events), checkpoint)

    result
    |> Map.update!(:scanned_files, &(&1 + 1))
    |> Map.update!(:malformed_lines, &(&1 + parsed.malformed_lines))
    |> Map.update!(:added_events, &(&1 + stored.added))
    |> Map.update!(:updated_events, &(&1 + stored.updated))
  end

  defp parse_file(path, path_hash, stat) do
    fallback_time = stat.mtime |> DateTime.from_unix!() |> microsecond_precision()

    parsed =
      path
      |> File.stream!(:line, [])
      |> Enum.reduce(parse_state(path_hash), fn line, state ->
        parse_line(line, state, fallback_time)
      end)

    %{events: parsed.events, malformed_lines: parsed.malformed_lines}
  end

  defp parse_state(path_hash) do
    %{
      context: %{project: nil, model: nil, session: nil},
      events: %{},
      sessions: MapSet.new(),
      project_names: %{},
      file_identity: path_hash,
      malformed_lines: 0
    }
  end

  defp parse_line(line, state, fallback_time) do
    if String.trim(line) == "" do
      state
    else
      case Jason.decode(line) do
        {:ok, record} ->
          context = Parser.update_context(record, state.context)
          state = %{state | context: context}

          case Parser.usage(record, context) do
            nil -> state
            usage -> put_usage(state, usage, fallback_time)
          end

        {:error, _reason} ->
          Map.update!(state, :malformed_lines, &(&1 + 1))
      end
    end
  end

  defp put_usage(state, usage, fallback_time) do
    session_identity = usage.session || state.file_identity
    session_key = Hash.stable(["codex", session_identity])
    occurred_at = parse_timestamp(usage.timestamp) || fallback_time
    {project, state} = project_name(usage.project, state)

    message_identity =
      usage.message ||
        Hash.stable([
          DateTime.to_iso8601(occurred_at),
          usage.model,
          Jason.encode!(usage.counters)
        ])

    event_key = Hash.stable(["codex", session_identity, message_identity])
    first_session_event = not MapSet.member?(state.sessions, session_key)

    event =
      usage.counters
      |> Map.put(:event_key, event_key)
      |> Map.put(:session_key, session_key)
      |> Map.put(:occurred_at, occurred_at)
      |> Map.put(:project, project)
      |> Map.put(:model, usage.model)
      |> Map.put(:session_starts, if(first_session_event, do: 1, else: 0))

    existing = Map.get(state.events, event_key)
    event = keep_fullest(existing, event)

    %{
      state
      | events: Map.put(state.events, event_key, event),
        sessions: MapSet.put(state.sessions, session_key)
    }
  end

  defp project_name(candidate, state) do
    case Map.fetch(state.project_names, candidate) do
      {:ok, project} ->
        {project, state}

      :error ->
        project = Project.name(candidate)
        {project, %{state | project_names: Map.put(state.project_names, candidate, project)}}
    end
  end

  defp keep_fullest(nil, candidate), do: candidate

  defp keep_fullest(existing, candidate) do
    if Counters.total(candidate) >= Counters.total(existing), do: candidate, else: existing
  end

  defp parse_timestamp(nil), do: nil

  defp parse_timestamp(timestamp) do
    case DateTime.from_iso8601(timestamp) do
      {:ok, value, _offset} -> microsecond_precision(value)
      _ -> nil
    end
  end

  defp microsecond_precision(%DateTime{microsecond: {value, _precision}} = datetime) do
    %{datetime | microsecond: {value, 6}}
  end

  defp stable_checkpoint(path, path_hash, before_stat) do
    case File.stat(path, time: :posix) do
      {:ok, after_stat}
      when after_stat.size == before_stat.size and after_stat.mtime == before_stat.mtime ->
        %{
          path_hash: path_hash,
          size: after_stat.size,
          mtime_ms: after_stat.mtime * 1_000,
          parser_version: @parser_version
        }

      _ ->
        nil
    end
  end
end
