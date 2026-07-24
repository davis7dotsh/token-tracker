defmodule TokenTracker.Codex.Scanner do
  @moduledoc false

  alias TokenTracker.{Codex.Parser, History.Scanner, Paths}

  def collect(roots \\ Paths.codex_roots()) do
    Scanner.collect("codex", "Codex", roots, Parser, "codex-v1")
  end
end
