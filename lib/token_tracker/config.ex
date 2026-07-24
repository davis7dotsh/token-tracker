defmodule TokenTracker.Config do
  @moduledoc false

  alias TokenTracker.Paths

  @defaults %{
    version: 1,
    role: "standalone",
    device_id: nil,
    device_name: nil,
    address: "127.0.0.1",
    host_address: "127.0.0.1",
    name_mode: "long",
    epmd_port: 4369,
    distribution_port: 4789,
    cluster_cookie: nil,
    device_token: nil,
    sync_interval_seconds: 300,
    sync_jitter_seconds: 10,
    batch_max_sessions: 50,
    batch_max_bytes: 1_048_576,
    call_timeout_ms: 15_000,
    web_enabled: true,
    web_bind: "127.0.0.1",
    web_port: 4000
  }

  @key_map %{
    {"", "version"} => :version,
    {"", "role"} => :role,
    {"", "device_id"} => :device_id,
    {"", "device_name"} => :device_name,
    {"sync", "interval_seconds"} => :sync_interval_seconds,
    {"sync", "jitter_seconds"} => :sync_jitter_seconds,
    {"sync", "batch_max_sessions"} => :batch_max_sessions,
    {"sync", "batch_max_bytes"} => :batch_max_bytes,
    {"sync", "call_timeout_ms"} => :call_timeout_ms,
    {"network", "address"} => :address,
    {"network", "host_address"} => :host_address,
    {"network", "name_mode"} => :name_mode,
    {"network", "epmd_port"} => :epmd_port,
    {"network", "distribution_port"} => :distribution_port,
    {"auth", "cluster_cookie"} => :cluster_cookie,
    {"auth", "device_token"} => :device_token,
    {"web", "enabled"} => :web_enabled,
    {"web", "bind"} => :web_bind,
    {"web", "port"} => :web_port
  }
  @sections ["", "network", "auth", "sync", "web"]

  def defaults, do: @defaults

  def load(path \\ Paths.config()) do
    case File.read(path) do
      {:ok, contents} ->
        with {:ok, parsed} <- parse(contents),
             config = Map.merge(@defaults, parsed),
             :ok <- validate(config) do
          {:ok, config}
        end

      {:error, :enoent} ->
        {:ok, @defaults}

      {:error, reason} ->
        {:error, "could not read config: #{:file.format_error(reason)}"}
    end
  end

  def load!(path \\ Paths.config()) do
    case load(path) do
      {:ok, config} -> config
      {:error, reason} -> raise reason
    end
  end

  def write(config, path \\ Paths.config()) do
    config = Map.merge(@defaults, config)
    contents = render(config)
    temporary = path <> ".tmp-#{System.unique_integer([:positive])}"

    with :ok <- validate(config),
         :ok <- File.mkdir_p(Path.dirname(path)),
         :ok <- File.write(temporary, contents),
         :ok <- File.chmod(temporary, 0o600),
         :ok <- File.rename(temporary, path) do
      :ok
    else
      {:error, reason} ->
        File.rm(temporary)
        {:error, reason}
    end
  end

  def render(config) do
    """
    version = 1
    role = #{string(config.role)}
    device_id = #{string(config.device_id)}
    device_name = #{string(config.device_name)}

    [network]
    address = #{string(config.address)}
    host_address = #{string(config.host_address)}
    name_mode = #{string(config.name_mode)}
    epmd_port = #{config.epmd_port}
    distribution_port = #{config.distribution_port}

    [auth]
    cluster_cookie = #{string(config.cluster_cookie)}
    device_token = #{string(config.device_token)}

    [sync]
    interval_seconds = #{config.sync_interval_seconds}
    jitter_seconds = #{config.sync_jitter_seconds}
    batch_max_sessions = #{config.batch_max_sessions}
    batch_max_bytes = #{config.batch_max_bytes}
    call_timeout_ms = #{config.call_timeout_ms}

    [web]
    enabled = #{config.web_enabled}
    bind = #{string(config.web_bind)}
    port = #{config.web_port}
    """
  end

  def host_node(config) do
    :"token_tracker_host@#{config.host_address}"
  end

  def local_node(%{role: "host"} = config) do
    :"token_tracker_host@#{config.address}"
  end

  def local_node(%{role: "client"} = config) do
    compact_id = config.device_id |> to_string() |> String.replace("-", "")
    :"token_tracker_client_#{compact_id}@#{config.address}"
  end

  def local_node(_config), do: nil

  def name_domain(%{name_mode: "long"}), do: :longnames
  def name_domain(%{name_mode: "short"}), do: :shortnames

  def transient_node(config) do
    suffix = generate_id() |> String.replace("-", "")
    :"token_tracker_cli_#{suffix}@#{config.address}"
  end

  def validate(config) do
    cond do
      config.version != 1 ->
        {:error, "unsupported config version #{inspect(config.version)}; expected 1"}

      config.role not in ["standalone", "host", "client"] ->
        {:error, "role must be standalone, host, or client"}

      config.name_mode not in ["long", "short"] ->
        {:error, "network.name_mode must be \"long\" or \"short\""}

      not valid_address?(config.address) ->
        {:error, "network.address must be a non-empty hostname or IP address without @"}

      not valid_address?(config.host_address) ->
        {:error, "network.host_address must be a non-empty hostname or IP address without @"}

      config.name_mode == "long" and not long_address?(config.address) ->
        {:error,
         "network.name_mode is \"long\", so network.address must be an IP address or fully qualified hostname"}

      config.name_mode == "long" and config.role in ["host", "client"] and
          not long_address?(config.host_address) ->
        {:error,
         "network.name_mode is \"long\", so network.host_address must be an IP address or fully qualified hostname"}

      config.name_mode == "short" and
          (long_address?(config.address) or
             (config.role in ["host", "client"] and long_address?(config.host_address))) ->
        {:error,
         "network.name_mode is \"short\", so network addresses must be simple hostnames without dots or colons"}

      not valid_port?(config.epmd_port) or not valid_port?(config.distribution_port) ->
        {:error, "network ports must be integers from 1 through 65535"}

      not positive_integer?(config.sync_interval_seconds) ->
        {:error, "sync.interval_seconds must be a positive integer"}

      not (is_integer(config.sync_jitter_seconds) and config.sync_jitter_seconds >= 0 and
               config.sync_jitter_seconds <= config.sync_interval_seconds) ->
        {:error, "sync.jitter_seconds must be between 0 and sync.interval_seconds"}

      Enum.any?(
        [config.batch_max_sessions, config.batch_max_bytes, config.call_timeout_ms],
        &(not positive_integer?(&1))
      ) ->
        {:error, "sync batch limits and call timeout must be positive integers"}

      not is_boolean(config.web_enabled) ->
        {:error, "web.enabled must be true or false"}

      not loopback_bind?(config.web_bind) ->
        {:error, "web.bind must be a loopback IPv4 address in 127.0.0.0/8"}

      not valid_port?(config.web_port) ->
        {:error, "web.port must be an integer from 1 through 65535"}

      config.role in ["host", "client"] and not valid_identity?(config.device_id) ->
        {:error, "device_id must be a UUID for host and client roles"}

      config.role in ["host", "client"] and not nonempty?(config.device_name) ->
        {:error, "device_name is required for host and client roles"}

      config.role in ["host", "client"] and not valid_secret?(config.cluster_cookie) ->
        {:error, "auth.cluster_cookie is required and may not contain whitespace"}

      config.role == "client" and not valid_secret?(config.device_token) ->
        {:error, "auth.device_token is required for client role and may not contain whitespace"}

      true ->
        :ok
    end
  end

  def generate_id do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)

    Enum.join(
      [
        hex(a, 8),
        hex(b, 4),
        hex(Bitwise.bor(Bitwise.band(c, 0x0FFF), 0x4000), 4),
        hex(Bitwise.bor(Bitwise.band(d, 0x3FFF), 0x8000), 4),
        hex(e, 12)
      ],
      "-"
    )
  end

  def generate_secret(bytes \\ 32) do
    bytes
    |> :crypto.strong_rand_bytes()
    |> Base.url_encode64(padding: false)
  end

  defp parse(contents) do
    contents
    |> String.split("\n")
    |> Enum.with_index(1)
    |> Enum.reduce_while({"", %{}}, fn {raw_line, line_number}, {section, values} ->
      line = raw_line |> strip_comment() |> String.trim()

      cond do
        line == "" ->
          {:cont, {section, values}}

        String.starts_with?(line, "[") and String.ends_with?(line, "]") ->
          next_section = line |> String.trim_leading("[") |> String.trim_trailing("]")

          if next_section in @sections do
            {:cont, {next_section, values}}
          else
            {:halt, {:error, "unknown config section [#{next_section}] on line #{line_number}"}}
          end

        true ->
          case parse_assignment(line, section, values) do
            {:ok, next_values} ->
              {:cont, {section, next_values}}

            {:unknown, key} ->
              {:halt,
               {:error, "unknown config key #{config_label(section, key)} on line #{line_number}"}}

            {:error, key} ->
              {:halt, {:error, "invalid value for #{key} on line #{line_number}"}}
          end
      end
    end)
    |> case do
      {:error, _reason} = error -> error
      {_section, values} -> {:ok, values}
    end
  end

  defp parse_assignment(line, section, values) do
    case String.split(line, "=", parts: 2) do
      [key, raw] ->
        key = String.trim(key)

        case @key_map[{section, key}] do
          nil ->
            {:unknown, key}

          config_key ->
            case parse_value(String.trim(raw)) do
              {:ok, value} -> {:ok, Map.put(values, config_key, value)}
              _ -> {:error, config_label(section, key)}
            end
        end

      _ ->
        {:error, config_label(section, line)}
    end
  end

  defp parse_value("\"" <> _ = value), do: Jason.decode(value)
  defp parse_value("null"), do: {:ok, nil}
  defp parse_value("true"), do: {:ok, true}
  defp parse_value("false"), do: {:ok, false}

  defp parse_value(value) do
    case Integer.parse(value) do
      {integer, ""} -> {:ok, integer}
      _ -> {:error, :invalid}
    end
  end

  defp strip_comment(line) do
    line
    |> String.graphemes()
    |> Enum.reduce_while({[], false, false}, fn
      char, {chars, quoted?, true} ->
        {:cont, {[char | chars], quoted?, false}}

      "\\", {chars, true, false} ->
        {:cont, {["\\" | chars], true, true}}

      "\"", {chars, quoted?, false} ->
        {:cont, {["\"" | chars], not quoted?, false}}

      "#", {chars, false, false} ->
        {:halt, {chars, false, false}}

      char, {chars, quoted?, false} ->
        {:cont, {[char | chars], quoted?, false}}
    end)
    |> elem(0)
    |> Enum.reverse()
    |> Enum.join()
  end

  defp string(nil), do: "null"
  defp string(value), do: Jason.encode!(value)

  defp hex(value, width) do
    value
    |> Integer.to_string(16)
    |> String.downcase()
    |> String.pad_leading(width, "0")
  end

  defp valid_address?(value) do
    nonempty?(value) and not String.contains?(value, ["@", " ", "\t", "\n"])
  end

  defp long_address?(value), do: String.contains?(value, [".", ":"])
  defp valid_port?(value), do: is_integer(value) and value in 1..65_535

  defp loopback_bind?(value) when is_binary(value) do
    case :inet.parse_ipv4_address(String.to_charlist(value)) do
      {:ok, {127, _second, _third, _fourth}} -> true
      _ -> false
    end
  end

  defp loopback_bind?(_value), do: false
  defp positive_integer?(value), do: is_integer(value) and value > 0
  defp nonempty?(value), do: is_binary(value) and String.trim(value) != ""

  defp valid_secret?(value) do
    nonempty?(value) and not String.match?(value, ~r/\s/)
  end

  defp valid_identity?(value) do
    is_binary(value) and
      String.match?(
        value,
        ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/i
      )
  end

  defp config_label("", key), do: key
  defp config_label(section, key), do: "#{section}.#{key}"
end
