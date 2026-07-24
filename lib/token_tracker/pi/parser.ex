defmodule TokenTracker.Pi.Parser do
  @moduledoc false

  alias TokenTracker.Counters

  def update_context(record, context) when is_map(record) do
    message = object(record["message"])
    session = object(record["session"])

    context
    |> put_if_present(:project, text(record["cwd"] || session["cwd"]))
    |> put_if_present(:model, text(message["model"] || record["model"] || record["modelId"]))
    |> put_if_present(:session, session(record))
  end

  def update_context(_record, context), do: context

  def usage(record, context) when is_map(record) do
    message = object(record["message"])
    session_record = object(record["session"])
    usage = object(message["usage"] || record["usage"])

    if map_size(usage) == 0 do
      nil
    else
      reasoning = count(usage["reasoning"] || usage["reasoning_tokens"])

      counters = %{
        input_tokens: count(usage["input"] || usage["input_tokens"]),
        output_tokens: max(0, count(usage["output"] || usage["output_tokens"]) - reasoning),
        reasoning_tokens: reasoning,
        cache_read_tokens: count(usage["cacheRead"] || usage["cache_read_tokens"]),
        cache_write_tokens: count(usage["cacheWrite"] || usage["cache_write_tokens"]),
        session_starts: 0
      }

      if Counters.total(counters) == 0 do
        nil
      else
        model =
          text(message["model"] || record["model"] || record["modelId"]) ||
            context.model || "unknown"

        %{
          counters: counters,
          timestamp: text(record["timestamp"] || message["timestamp"]),
          project: text(record["cwd"] || session_record["cwd"]) || context.project,
          provider: provider(text(message["provider"] || record["provider"]), model),
          model: model,
          session: session(record) || context.session,
          message:
            text(
              message["responseId"] || record["responseId"] || record["response_id"] ||
                record["id"] || message["id"]
            )
        }
      end
    end
  end

  def usage(_record, _context), do: nil

  defp provider("openai-codex", _model), do: "openai"
  defp provider("opencode", model), do: inferred_provider(model)
  defp provider(provider, _model) when not is_nil(provider), do: provider
  defp provider(nil, model), do: inferred_provider(model)

  defp inferred_provider("gpt-" <> _rest), do: "openai"
  defp inferred_provider("claude-" <> _rest), do: "anthropic"
  defp inferred_provider(model), do: model |> String.split("/", parts: 2) |> inferred_prefix()

  defp inferred_prefix([provider, _model]), do: provider
  defp inferred_prefix([_model]), do: nil

  defp session(record) do
    cond do
      record["type"] == "session" -> text(record["id"])
      true -> text(record["sessionId"] || record["session_id"])
    end
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
