defmodule TokenTracker.MixProject do
  use Mix.Project

  def project do
    [
      app: :token_tracker,
      version: "0.5.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      releases: releases(),
      aliases: aliases(),
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:crypto, :logger],
      mod: {TokenTracker.Application, []},
      start_phases: [portable_cli: []]
    ]
  end

  def cli do
    [preferred_envs: [check: :test, "token_tracker.install": :prod]]
  end

  defp deps do
    [
      {:bandit, "~> 1.12"},
      {:burrito, "~> 1.5"},
      {:ecto_sqlite3, "~> 0.24.1"},
      {:jason, "~> 1.4"},
      {:phoenix, "~> 1.8"},
      {:plug, "~> 1.18"},
      {:req, "~> 0.6.3"},
      {:tz, "~> 0.28.2"}
    ]
  end

  defp releases do
    [
      token_tracker: [],
      token_tracker_portable: [
        steps: [:assemble, &Burrito.wrap/1],
        burrito: [
          targets: [
            darwin_arm64: [os: :darwin, cpu: :aarch64],
            darwin_x86_64: [os: :darwin, cpu: :x86_64],
            linux_arm64: [os: :linux, cpu: :aarch64],
            linux_x86_64: [os: :linux, cpu: :x86_64]
          ]
        ]
      ]
    ]
  end

  defp aliases do
    [
      "assets.install": ["cmd --cd web pnpm install --frozen-lockfile"],
      "assets.build": ["cmd --cd web pnpm build"],
      "assets.check": [
        "assets.install",
        "cmd --cd web pnpm format:check",
        "cmd --cd web pnpm check",
        "cmd --cd web pnpm lint",
        "cmd --cd web pnpm test",
        "assets.build"
      ],
      check: ["format --check-formatted", "test"]
    ]
  end
end
