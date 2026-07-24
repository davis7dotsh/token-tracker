defmodule TokenTracker.Claude.Scanner do
  @moduledoc false

  alias TokenTracker.{Claude.Parser, History.Scanner, Paths}

  def collect(roots \\ Paths.claude_roots()) do
    Scanner.collect("claude", "Claude Code", roots, Parser, "claude-v2")
  end
end
