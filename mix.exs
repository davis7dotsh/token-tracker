defmodule TokenTracker.MixProject do
  use Mix.Project

  def project do
    [
      app: :token_tracker,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      releases: [token_tracker: []],
      aliases: aliases(),
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:crypto, :logger],
      mod: {TokenTracker.Application, []}
    ]
  end

  def cli do
    [preferred_envs: [check: :test, "token_tracker.install": :prod]]
  end

  defp deps do
    [
      {:ecto_sqlite3, "~> 0.24.1"},
      {:jason, "~> 1.4"}
    ]
  end

  defp aliases do
    [
      check: ["format --check-formatted", "test"]
    ]
  end
end
