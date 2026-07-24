defmodule TokenTracker.Paths do
  @moduledoc """
  Resolves every user-owned path used by Token Tracker.
  """

  @home_env "TOKEN_TRACKER_HOME"

  def home do
    case System.get_env(@home_env) do
      value when is_binary(value) and value != "" -> Path.expand(value)
      _ -> Path.expand("~/.token-tracker")
    end
  end

  def database, do: Path.join(home(), "usage.sqlite3")
  def pricing_cache, do: Path.join(home(), "pricing-cache.json")

  def codex_roots do
    user_home = System.user_home!()

    [
      Path.join([user_home, ".codex", "sessions"]),
      Path.join([user_home, ".codex", "archived_sessions"])
    ]
  end

  def claude_roots do
    [Path.join([System.user_home!(), ".claude", "projects"])]
  end

  def pi_roots do
    [Path.join([System.user_home!(), ".pi", "agent", "sessions"])]
  end

  def ensure_home! do
    directory = home()
    File.mkdir_p!(directory)
    File.chmod!(directory, 0o700)
    directory
  end
end
