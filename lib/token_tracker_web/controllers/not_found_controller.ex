defmodule TokenTrackerWeb.NotFoundController do
  use Phoenix.Controller, formats: [:json]

  def show(conn, _params), do: conn |> put_status(:not_found) |> json(%{error: "not found"})
end
