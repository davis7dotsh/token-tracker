defmodule TokenTracker.Claude.Parser do
  @moduledoc false

  alias TokenTracker.Counters

  def update_context(record, context) when is_map(record) do
    message = object(record["message"])

    context
    |> put_if_present(:project, text(record["cwd"] || record["projectPath"]))
    |> put_if_present(:model, text(message["model"] || record["model"]))
    |> put_if_present(:session, text(record["sessionId"] || record["session_id"]))
  end

  def update_context(_record, context), do: context

  def usage(record, context) when is_map(record) do
    message = object(record["message"])
    usage = object(message["usage"] || record["usage"])

    if map_size(usage) == 0 do
      nil
    else
      reasoning = count(usage["reasoning_tokens"])

      counters = %{
        input_tokens: count(usage["input_tokens"]),
        output_tokens: max(0, count(usage["output_tokens"]) - reasoning),
        reasoning_tokens: reasoning,
        cache_read_tokens: count(usage["cache_read_input_tokens"]),
        cache_write_tokens: count(usage["cache_creation_input_tokens"]),
        session_starts: 0
      }

      if Counters.total(counters) == 0 do
        nil
      else
        model = text(message["model"] || record["model"]) || context.model || "unknown"

        %{
          counters: counters,
          timestamp: text(record["timestamp"] || record["created_at"] || message["timestamp"]),
          project: text(record["cwd"] || record["projectPath"]) || context.project,
          provider: provider(model),
          model: model,
          session: text(record["sessionId"] || record["session_id"]) || context.session,
          message: text(message["id"] || record["uuid"])
        }
      end
    end
  end

  def usage(_record, _context), do: nil

  defp provider("gpt-" <> _rest), do: "openai"
  defp provider("claude-" <> _rest), do: "anthropic"
  defp provider(_model), do: nil

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
