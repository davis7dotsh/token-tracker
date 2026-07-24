defmodule TokenTracker.Hash do
  @moduledoc false

  def stable(parts) do
    parts
    |> Enum.join(<<0>>)
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end
end
