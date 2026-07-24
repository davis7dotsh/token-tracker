defmodule TokenTrackerWeb.QueryParams do
  @moduledoc false

  import Plug.Conn

  def init(options), do: options

  def call(conn, options) do
    fetch_query_params(conn, options)
  rescue
    error in Plug.Conn.InvalidQueryError ->
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(Plug.Exception.status(error), Jason.encode!(%{error: "malformed query"}))
      |> halt()
  end
end
