defmodule TokenTracker.Sync.Client do
  @moduledoc false

  alias TokenTracker.{Config, Network, Sessions}

  @protocol_version 1

  def sync_once(config, opts \\ []) do
    call =
      Keyword.get(opts, :call) ||
        fn call_config, message, timeout ->
          remote_call(call_config, message, timeout, opts)
        end

    {batches, oversized} = build_batches(config)

    Enum.each(oversized, fn entry ->
      Sessions.mark_error([entry], "session snapshot exceeds batch_max_bytes")
    end)

    initial =
      if oversized == [] do
        empty_result()
      else
        %{empty_result() | error: "#{length(oversized)} session snapshots exceed the size limit"}
      end

    Enum.reduce_while(batches, initial, fn {entries, message, batch_id}, result ->
      case call.(config, message, config.call_timeout_ms) do
        {:ok, {:sync_ack, @protocol_version, ^batch_id, accepted, rejected}} ->
          Sessions.acknowledge(accepted)
          rejection_error = mark_rejections(entries, rejected)

          {:cont,
           %{
             result
             | batches: result.batches + 1,
               accepted: result.accepted + length(accepted),
               rejected: result.rejected + length(rejected),
               error: merge_error(result.error, rejection_error)
           }}

        {:ok, {:sync_error, @protocol_version, ^batch_id, reason}} ->
          Sessions.mark_attempt(entries, reason)
          {:halt, %{result | error: merge_error(result.error, reason)}}

        {:ok, other} ->
          reason = "unexpected host response: #{inspect(other)}"
          Sessions.mark_attempt(entries, reason)
          {:halt, %{result | error: merge_error(result.error, reason)}}

        {:error, reason} ->
          text = format_error(reason)
          Sessions.mark_attempt(entries, text)
          {:halt, %{result | error: merge_error(result.error, text)}}
      end
    end)
    |> then(fn result ->
      Sessions.put_state("last_sync_error", result.error)

      if result.accepted > 0 do
        Sessions.put_state("last_sync_at", DateTime.utc_now() |> DateTime.to_iso8601())
      end

      Map.put(result, :pending, Sessions.pending_count())
    end)
  end

  def build_batches(config) do
    config
    |> TokenTracker.Sync.Client.SessionsBuilder.new()
    |> TokenTracker.Sync.Client.SessionsBuilder.pack(Sessions.outbox_entries())
  end

  defp remote_call(config, message, timeout, opts) do
    network_opts = Keyword.take(opts, [:node_name])

    with :ok <- Network.start(config, network_opts),
         :ok <- Network.connect(config) do
      {:ok,
       GenServer.call({TokenTracker.Sync.Server, Config.host_node(config)}, message, timeout)}
    end
  catch
    :exit, reason -> {:error, reason}
  end

  defp mark_rejections(_entries, []), do: :ok

  defp mark_rejections(entries, rejected) do
    reasons = Enum.map_join(rejected, "; ", &"#{&1.session_key}: #{&1.reason}")
    rejected_keys = MapSet.new(rejected, &{&1.session_key, &1.generation})

    rejected_entries =
      Enum.filter(entries, &MapSet.member?(rejected_keys, {&1.session_key, &1.generation}))

    Sessions.mark_attempt(rejected_entries, reasons)
    reasons
  end

  defp empty_result do
    %{batches: 0, accepted: 0, rejected: 0, pending: 0, error: nil}
  end

  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp format_error(reason), do: inspect(reason)

  defp merge_error(nil, :ok), do: nil
  defp merge_error(error, :ok), do: error
  defp merge_error(nil, error), do: format_error(error)
  defp merge_error(existing, error), do: existing <> "; " <> format_error(error)

  defmodule SessionsBuilder do
    @moduledoc false

    def new(config), do: %{config: config, batches: [], current: [], oversized: []}

    def pack(builder, entries) do
      builder = Enum.reduce(entries, builder, &append/2)

      groups =
        if builder.current == [],
          do: builder.batches,
          else: [builder.current | builder.batches]

      batches =
        groups
        |> Enum.reverse()
        |> Enum.map(&message(builder.config, &1))

      {batches, Enum.reverse(builder.oversized)}
    end

    defp append(entry, state) do
      snapshot = TokenTracker.Sessions.decode_outbox(entry)
      candidate = state.current ++ [{entry, snapshot}]

      cond do
        fits?(state.config, candidate) ->
          %{state | current: candidate}

        state.current != [] and fits?(state.config, [{entry, snapshot}]) ->
          %{state | batches: [state.current | state.batches], current: [{entry, snapshot}]}

        state.current != [] ->
          %{
            state
            | batches: [state.current | state.batches],
              current: [],
              oversized: [entry | state.oversized]
          }

        true ->
          %{state | oversized: [entry | state.oversized]}
      end
    end

    defp message(config, pairs) do
      batch_id = TokenTracker.Config.generate_id()
      entries = Enum.map(pairs, &elem(&1, 0))
      snapshots = Enum.map(pairs, &elem(&1, 1))

      message =
        {:sync_sessions, 1, config.device_id, config.device_token, batch_id, snapshots}

      {entries, message, batch_id}
    end

    defp fits?(config, pairs) do
      if length(pairs) > config.batch_max_sessions do
        false
      else
        snapshots = Enum.map(pairs, &elem(&1, 1))

        message =
          {:sync_sessions, 1, config.device_id, config.device_token,
           "00000000-0000-4000-8000-000000000000", snapshots}

        :erlang.external_size(message) <= config.batch_max_bytes
      end
    end
  end
end
