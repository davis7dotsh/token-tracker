defmodule TokenTracker.Sync.Server do
  @moduledoc false

  use GenServer

  alias TokenTracker.Sessions

  @protocol_version 1

  def start_link(config) do
    GenServer.start_link(__MODULE__, config, name: __MODULE__)
  end

  @impl true
  def init(config), do: {:ok, config}

  @impl true
  def handle_call(
        {:sync_sessions, @protocol_version, device_id, token, batch_id, snapshots} = message,
        _from,
        config
      ) do
    reply =
      cond do
        not is_list(snapshots) ->
          protocol_error(batch_id, "snapshots must be a list")

        length(snapshots) > config.batch_max_sessions ->
          protocol_error(batch_id, "batch has too many sessions")

        :erlang.external_size(message) > config.batch_max_bytes ->
          protocol_error(batch_id, "batch exceeds encoded size limit")

        true ->
          receive_snapshots(device_id, token, batch_id, snapshots)
      end

    {:reply, reply, config}
  end

  def handle_call(
        {:sync_sessions, version, _device_id, _token, batch_id, _snapshots},
        _from,
        state
      ) do
    {:reply, protocol_error(batch_id, "unsupported protocol version #{inspect(version)}"), state}
  end

  def handle_call(_message, _from, state) do
    {:reply, {:sync_error, @protocol_version, nil, "invalid message"}, state}
  end

  defp receive_snapshots(device_id, token, batch_id, snapshots) do
    case Sessions.authenticate(device_id, token) do
      :ok ->
        {accepted, rejected} =
          Enum.reduce(snapshots, {[], []}, fn snapshot, {accepted, rejected} ->
            key = if is_map(snapshot), do: Map.get(snapshot, :session_key), else: nil
            generation = if is_map(snapshot), do: Map.get(snapshot, :generation), else: nil

            case Sessions.ingest(device_id, snapshot) do
              {:accepted, status} ->
                {[
                   %{session_key: key, generation: generation, status: status}
                   | accepted
                 ], rejected}

              {:rejected, reason} ->
                {accepted,
                 [
                   %{session_key: key, generation: generation, reason: reason}
                   | rejected
                 ]}
            end
          end)

        Sessions.touch_device(device_id)

        {:sync_ack, @protocol_version, batch_id, Enum.reverse(accepted), Enum.reverse(rejected)}

      {:error, reason} ->
        protocol_error(batch_id, "authentication failed: #{reason}")
    end
  end

  defp protocol_error(batch_id, reason) do
    {:sync_error, @protocol_version, batch_id, reason}
  end
end
