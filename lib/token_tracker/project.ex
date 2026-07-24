defmodule TokenTracker.Project do
  @moduledoc false

  @github_remote ~r{github\.com[/:]([^/]+/[^/]+?)(?:\.git)?$}i

  def name(candidate) when is_binary(candidate) and candidate != "" do
    candidate
    |> github_name()
    |> case do
      nil -> safe_basename(candidate)
      name -> name
    end
  end

  def name(_candidate), do: "unknown"

  defp github_name(directory) do
    with true <- File.dir?(directory),
         {remote, 0} <-
           System.cmd("git", ["-C", directory, "remote", "get-url", "origin"],
             stderr_to_stdout: true
           ),
         [_, slug] <- Regex.run(@github_remote, String.trim(remote)) do
      slug
    else
      _ -> nil
    end
  end

  defp safe_basename(candidate) do
    candidate
    |> String.trim_trailing("/\\")
    |> Path.basename()
    |> case do
      value when value in ["", ".", "/"] -> "unknown"
      value -> String.slice(value, 0, 180)
    end
  end
end
