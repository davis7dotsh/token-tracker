defmodule TokenTrackerWeb.ReportController do
  use Phoenix.Controller, formats: [:json]

  def show(conn, params) do
    case TokenTracker.Dashboard.report(params) do
      {:ok, report} -> json(conn, report)
      {:error, reason} -> conn |> put_status(:bad_request) |> json(%{error: reason})
    end
  end
end
