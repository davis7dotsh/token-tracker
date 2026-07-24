defmodule TokenTracker.CLI do
  @moduledoc false

  alias TokenTracker.{Codex.Scanner, Paths, Report, Storage}

  @version Mix.Project.config()[:version]

  def main_from_env do
    count =
      "TOKEN_TRACKER_CLI_ARG_COUNT"
      |> System.fetch_env!()
      |> String.to_integer()

    args =
      if count == 0 do
        []
      else
        Enum.map(0..(count - 1), &System.fetch_env!("TOKEN_TRACKER_CLI_ARG_#{&1}"))
      end

    main(args)
  end

  def main(args) do
    case args do
      ["collect" | rest] -> collect(rest)
      ["--version"] -> IO.puts("token-tracker #{@version}")
      ["-v"] -> IO.puts("token-tracker #{@version}")
      ["help"] -> help()
      ["--help"] -> help()
      ["-h"] -> help()
      [] -> help()
      _ -> fail("unknown command")
    end
  end

  defp collect(args) do
    {opts, positional, invalid} =
      OptionParser.parse(args,
        strict: [all: :boolean, home: :string],
        aliases: [a: :all]
      )

    cond do
      positional != [] -> fail("unexpected arguments: #{Enum.join(positional, " ")}")
      invalid != [] -> fail("invalid options: #{inspect(invalid)}")
      true -> run_collect(opts)
    end
  end

  defp run_collect(opts) do
    if home = opts[:home], do: System.put_env("TOKEN_TRACKER_HOME", home)

    Paths.ensure_home!()
    {:ok, _applications} = Application.ensure_all_started(:token_tracker)
    :ok = Storage.migrate()

    Scanner.collect()
    |> Report.print(all: Keyword.get(opts, :all, false))
  rescue
    error ->
      fail(Exception.message(error))
  end

  defp help do
    IO.puts("""
    Usage:
      token-tracker collect [--all] [--home PATH]
      token-tracker --version

    Commands:
      collect    Import new Codex history and print a local usage summary

    Options:
      --all      Show every project and model instead of the top 10
      --home     Override TOKEN_TRACKER_HOME (default: ~/.token-tracker)
    """)
  end

  defp fail(message) do
    IO.puts(:stderr, "token-tracker: #{message}")
    System.halt(1)
  end
end
