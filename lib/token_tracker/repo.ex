defmodule TokenTracker.Repo do
  use Ecto.Repo,
    otp_app: :token_tracker,
    adapter: Ecto.Adapters.SQLite3

  @impl true
  def init(_type, config) do
    database = Application.get_env(:token_tracker, :database, TokenTracker.Paths.database())
    database |> Path.dirname() |> File.mkdir_p!()

    {:ok,
     Keyword.merge(config,
       database: database,
       pool_size: 1,
       journal_mode: :wal,
       busy_timeout: 5_000
     )}
  end
end
