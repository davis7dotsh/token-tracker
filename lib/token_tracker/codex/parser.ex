defmodule TokenTracker.Codex.Parser do
  @moduledoc false

  alias TokenTracker.Counters

  def update_context(record, context) when is_map(record) do
    payload = object(record["payload"])

    context
    |> put_if_present(:project, text(payload["cwd"]))
    |> put_if_present(:model, text(payload["model"]))
    |> put_if_present(:session, session(record, payload))
  end

  def update_context(_record, context), do: context

  def usage(record, context) when is_map(record) do
    payload = object(record["payload"])
    info = object(payload["info"])
    usage = object(info["last_token_usage"] || payload["usage"])

    if map_size(usage) == 0 do
      nil
    else
      cached_input = count(usage["cached_input_tokens"])
      reasoning = count(usage["reasoning_output_tokens"] || usage["reasoning_tokens"])

      counters = %{
        input_tokens: max(0, count(usage["input_tokens"]) - cached_input),
        output_tokens: max(0, count(usage["output_tokens"]) - reasoning),
        reasoning_tokens: reasoning,
        cache_read_tokens: cached_input,
        cache_write_tokens: 0,
        session_starts: 0
      }

      if Counters.total(counters) == 0 do
        nil
      else
        %{
          counters: counters,
          timestamp: timestamp(record, payload),
          project: text(payload["cwd"]) || context.project,
          model: text(payload["model"]) || context.model || "unknown",
          session: text(payload["session_id"]) || context.session,
          message: text(payload["id"])
        }
      end
    end
  end

  def usage(_record, _context), do: nil

  defp session(record, payload) do
    cond do
      record["type"] == "session_meta" -> text(payload["id"] || payload["session_id"])
      text(payload["session_id"]) -> text(payload["session_id"])
      true -> nil
    end
  end

  defp timestamp(record, payload) do
    text(record["timestamp"]) || text(payload["timestamp"])
  end

  defp put_if_present(context, _key, nil), do: context
  defp put_if_present(context, key, value), do: Map.put(context, key, value)

  defp object(value) when is_map(value), do: value
  defp object(_value), do: %{}

  defp text(value) when is_binary(value) and value != "", do: value
  defp text(_value), do: nil

  defp count(value) when is_integer(value), do: max(0, value)
  defp count(value) when is_float(value), do: value |> trunc() |> max(0)
  defp count(_value), do: 0
end
