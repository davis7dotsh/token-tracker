defmodule Mix.Tasks.TokenTracker.Install do
  use Mix.Task

  @shortdoc "Builds and installs token-tracker under ~/.local"

  @impl Mix.Task
  def run(_args) do
    local_root = Path.expand("~/.local")
    release_root = Path.join([local_root, "lib", "token-tracker"])
    executable = Path.join([local_root, "bin", "token-tracker"])
    launcher = Path.expand("scripts/token-tracker")

    File.mkdir_p!(Path.dirname(release_root))
    File.mkdir_p!(Path.dirname(executable))

    Mix.Task.run("assets.install")
    Mix.Task.run("assets.build")

    Mix.Task.run("release", [
      "token_tracker",
      "--overwrite",
      "--path",
      release_root
    ])

    File.cp!(launcher, executable)
    File.chmod!(executable, 0o755)

    Mix.shell().info("Installed token-tracker at #{executable}")
  end
end
