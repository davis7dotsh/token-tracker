defmodule TokenTracker.Pi.Scanner do
  @moduledoc false

  alias TokenTracker.{History.Scanner, Paths, Pi.Parser}

  def collect(roots \\ Paths.pi_roots()) do
    Scanner.collect("pi", "Pi", roots, Parser, "pi-v2")
  end
end
