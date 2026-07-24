# Preserved reference configuration. This directory is not loaded by Mix.
import Config

parse_positive_integer = fn name, default ->
  case Integer.parse(System.get_env(name, "")) do
    {value, ""} when value > 0 -> value
    _ -> default
  end
end

targets =
  System.get_env("TTEX_TARGETS", "")
  |> String.split(",", trim: true)
  |> Enum.map(&String.trim/1)
  |> Enum.reject(&(&1 == ""))

config :token_tracker_elixir_experiment,
  role: System.get_env("TTEX_ROLE", "leaf"),
  targets: targets,
  poll_interval_ms: parse_positive_integer.("TTEX_POLL_INTERVAL_MS", 5_000),
  request_timeout_ms: parse_positive_integer.("TTEX_REQUEST_TIMEOUT_MS", 1_500)
