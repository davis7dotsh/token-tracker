defmodule TokenTrackerWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :token_tracker

  plug(TokenTrackerWeb.SecurityHeaders)

  plug(Plug.Static,
    at: "/",
    from: :token_tracker,
    gzip: false,
    only: ~w(_app),
    cache_control_for_etags: "public, max-age=31536000, immutable"
  )

  plug(Plug.Static,
    at: "/",
    from: :token_tracker,
    gzip: false,
    only: ~w(robots.txt theme.js),
    cache_control_for_etags: "no-cache"
  )

  plug(TokenTrackerWeb.Router)
end
