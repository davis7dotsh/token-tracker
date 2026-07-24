defmodule TokenTracker.Setup do
  @moduledoc false

  alias TokenTracker.{Config, Paths, Sessions}

  def host(opts \\ []) do
    name = Keyword.get(opts, :name) || hostname()
    address = Keyword.get(opts, :address) || "127.0.0.1"
    name_mode = Keyword.get(opts, :name_mode) || "long"
    device_id = Keyword.get(opts, :device_id) || Config.generate_id()
    cluster_cookie = Keyword.get(opts, :cluster_cookie) || Config.generate_secret()

    config =
      Config.defaults()
      |> Map.merge(%{
        role: "host",
        device_id: device_id,
        device_name: name,
        address: address,
        host_address: address,
        name_mode: name_mode,
        cluster_cookie: cluster_cookie
      })

    with :ok <- Config.write(config) do
      {:ok, config}
    end
  end

  def client(enrollment_path, opts \\ []) do
    with {:ok, contents} <- read_enrollment(enrollment_path),
         {:ok, enrollment} <- Jason.decode(contents),
         :ok <- validate_enrollment(enrollment) do
      config =
        Config.defaults()
        |> Map.merge(%{
          role: "client",
          device_id: enrollment["device_id"],
          device_name: enrollment["device_name"],
          address: Keyword.get(opts, :address) || default_client_address(enrollment["name_mode"]),
          host_address: enrollment["host_address"],
          name_mode: enrollment["name_mode"],
          epmd_port: enrollment["epmd_port"],
          distribution_port: enrollment["distribution_port"],
          cluster_cookie: enrollment["cluster_cookie"],
          device_token: enrollment["device_token"]
        })

      with :ok <- Config.write(config) do
        {:ok, config}
      end
    end
  end

  def enroll(name, config, output \\ nil) do
    output = output || Path.join(Paths.enrollments(), "#{safe_name(name)}.json")
    File.mkdir_p!(Path.dirname(output))

    with :ok <- validate_host_enrollment(name, config),
         {:ok, device} <- Sessions.enroll_device(name) do
      enrollment = %{
        version: 1,
        device_id: device.device_id,
        device_name: device.name,
        device_token: device.token,
        cluster_cookie: config.cluster_cookie,
        host_address: config.host_address,
        name_mode: config.name_mode,
        epmd_port: config.epmd_port,
        distribution_port: config.distribution_port
      }

      temporary = output <> ".tmp-#{System.unique_integer([:positive])}"

      with :ok <- File.write(temporary, Jason.encode!(enrollment, pretty: true) <> "\n"),
           :ok <- File.chmod(temporary, 0o600),
           :ok <- File.rename(temporary, output) do
        {:ok, %{path: output, device_id: device.device_id}}
      end
    end
  end

  defp read_enrollment("-"), do: {:ok, IO.read(:stdio, :eof)}
  defp read_enrollment(path), do: File.read(path)

  defp validate_enrollment(enrollment) do
    required = [
      "device_id",
      "device_name",
      "device_token",
      "cluster_cookie",
      "host_address",
      "name_mode",
      "epmd_port",
      "distribution_port"
    ]

    cond do
      not is_map(enrollment) ->
        {:error, "enrollment file must contain a JSON object"}

      enrollment["version"] != 1 ->
        {:error, "enrollment version must be 1"}

      not Enum.all?(required, &Map.has_key?(enrollment, &1)) ->
        {:error, "enrollment file is missing required fields"}

      true ->
        enrollment
        |> then(fn values ->
          Config.defaults()
          |> Map.merge(%{
            role: "client",
            device_id: values["device_id"],
            device_name: values["device_name"],
            address: if(values["name_mode"] == "short", do: "client", else: "127.0.0.1"),
            host_address: values["host_address"],
            name_mode: values["name_mode"],
            epmd_port: values["epmd_port"],
            distribution_port: values["distribution_port"],
            cluster_cookie: values["cluster_cookie"],
            device_token: values["device_token"]
          })
        end)
        |> Config.validate()
    end
  end

  defp validate_host_enrollment(name, config) do
    cond do
      config.role != "host" -> {:error, "device enrollment requires host role"}
      not (is_binary(name) and String.trim(name) != "") -> {:error, "device name is required"}
      true -> Config.validate(config)
    end
  end

  defp safe_name(name) do
    name
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9_-]+/, "-")
    |> String.trim("-")
  end

  defp hostname do
    case :inet.gethostname() do
      {:ok, hostname} -> to_string(hostname)
      _ -> "token-tracker"
    end
  end

  defp default_client_address("short") do
    hostname() |> String.split(".", parts: 2) |> hd()
  end

  defp default_client_address(_name_mode), do: "127.0.0.1"
end
