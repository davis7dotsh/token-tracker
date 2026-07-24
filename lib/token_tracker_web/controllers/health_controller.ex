defmodule TokenTrackerWeb.HealthController do
  use Phoenix.Controller, formats: [:json]

  def show(conn, _params), do: json(conn, %{ok: true})
end
