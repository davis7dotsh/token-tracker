import Config

config :token_tracker,
  ecto_repos: [TokenTracker.Repo]

config :token_tracker, TokenTrackerWeb.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  http: [ip: {127, 0, 0, 1}, port: 4000],
  render_errors: [formats: [json: TokenTrackerWeb.ErrorJSON]],
  secret_key_base: :crypto.strong_rand_bytes(64) |> Base.url_encode64(padding: false),
  server: false,
  url: [host: "localhost"]

config :phoenix, :json_library, Jason
config :logger, level: :warning

if config_env() == :test do
  config :token_tracker,
    database:
      Path.join(
        System.tmp_dir!(),
        "token_tracker_test_#{System.unique_integer([:positive, :monotonic])}.sqlite3"
      )
end
