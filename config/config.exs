import Config

config :token_tracker,
  ecto_repos: [TokenTracker.Repo]

config :logger, level: :warning

if config_env() == :test do
  config :token_tracker,
    database:
      Path.join(
        System.tmp_dir!(),
        "token_tracker_test_#{System.unique_integer([:positive, :monotonic])}.sqlite3"
      )
end
