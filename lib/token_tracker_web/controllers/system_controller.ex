defmodule TokenTrackerWeb.SystemController do
  use Phoenix.Controller, formats: [:json]

  def show(conn, _params), do: json(conn, TokenTracker.Dashboard.system())
end
