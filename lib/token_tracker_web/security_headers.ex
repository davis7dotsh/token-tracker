defmodule TokenTrackerWeb.SecurityHeaders do
  @moduledoc false
  import Plug.Conn

  def init(options), do: options

  def call(conn, _options) do
    conn
    |> put_resp_header("x-content-type-options", "nosniff")
    |> put_resp_header("x-frame-options", "DENY")
    |> put_resp_header("referrer-policy", "no-referrer")
    |> put_resp_header(
      "content-security-policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
    )
    |> api_no_store()
  end

  defp api_no_store(%Plug.Conn{request_path: "/api/" <> _rest} = conn),
    do: put_resp_header(conn, "cache-control", "no-store")

  defp api_no_store(conn), do: conn
end
