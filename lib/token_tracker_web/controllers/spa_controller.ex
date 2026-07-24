defmodule TokenTrackerWeb.SpaController do
  use Phoenix.Controller, formats: []

  def show(conn, _params) do
    path =
      Application.get_env(
        :token_tracker,
        :static_index_path,
        Application.app_dir(:token_tracker, "priv/static/index.html")
      )

    if File.regular?(path) do
      conn
      |> put_resp_header("cache-control", "no-cache")
      |> put_resp_content_type("text/html")
      |> send_file(200, path)
    else
      conn
      |> put_status(:service_unavailable)
      |> text("Token Tracker web assets are not built. Run mix assets.build.")
    end
  end
end
