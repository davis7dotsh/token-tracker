defmodule TokenTrackerWeb.SecurityHeaders do
  @moduledoc false
  import Plug.Conn

  @inline_script ~r/<script\b([^>]*)>(.*?)<\/script>/is

  def init(options), do: options

  def call(conn, _options) do
    conn
    |> put_resp_header("x-content-type-options", "nosniff")
    |> put_resp_header("x-frame-options", "DENY")
    |> put_resp_header("referrer-policy", "no-referrer")
    |> put_resp_header("content-security-policy", content_security_policy())
    |> api_no_store()
  end

  def allow_inline_scripts(conn, html) do
    put_resp_header(conn, "content-security-policy", content_security_policy(script_hashes(html)))
  end

  defp content_security_policy(script_hashes \\ []) do
    script_sources =
      ["'self'" | Enum.map(script_hashes, &"'sha256-#{&1}'")]
      |> Enum.join(" ")

    "default-src 'self'; style-src 'self' 'unsafe-inline'; " <>
      "script-src #{script_sources}; connect-src 'self'; font-src 'self' data:"
  end

  defp script_hashes(html) do
    @inline_script
    |> Regex.scan(html)
    |> Enum.reject(fn [_match, attributes, body] ->
      Regex.match?(~r/\bsrc\s*=/i, attributes) or body == ""
    end)
    |> Enum.map(fn [_match, _attributes, body] ->
      body
      |> then(&:crypto.hash(:sha256, &1))
      |> Base.encode64()
    end)
    |> Enum.uniq()
  end

  defp api_no_store(%Plug.Conn{request_path: "/api/" <> _rest} = conn),
    do: put_resp_header(conn, "cache-control", "no-store")

  defp api_no_store(conn), do: conn
end
