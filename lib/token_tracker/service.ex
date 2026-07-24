defmodule TokenTracker.Service do
  @moduledoc false

  alias TokenTracker.Paths

  @label "dev.token-tracker"

  def install(opts \\ []) do
    executable = Keyword.get(opts, :executable, System.find_executable("token-tracker"))

    if is_nil(executable) do
      {:error, "token-tracker executable was not found on PATH"}
    else
      case os() do
        :macos -> install_macos(executable)
        :linux -> install_linux(executable)
        :unsupported -> {:error, "service installation supports macOS and Linux"}
      end
    end
  end

  def start, do: control(:start)
  def stop, do: control(:stop)
  def status, do: control(:status)

  def state do
    case os() do
      :macos ->
        case run("launchctl", ["print", "gui/#{uid()}/#{@label}"]) do
          {:ok, _output} -> "running"
          {:error, _reason} -> "stopped"
        end

      :linux ->
        case run("systemctl", ["--user", "is-active", @label]) do
          {:ok, "active"} -> "running"
          {:ok, state} -> state
          {:error, _reason} -> "stopped"
        end

      :unsupported ->
        "unsupported"
    end
  end

  def render_launchd(executable, home \\ Paths.home()) do
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key>
      <string>#{@label}</string>
      <key>ProgramArguments</key>
      <array>
        <string>#{xml(executable)}</string>
        <string>daemon</string>
      </array>
      <key>EnvironmentVariables</key>
      <dict>
        <key>TOKEN_TRACKER_HOME</key>
        <string>#{xml(home)}</string>
      </dict>
      <key>RunAtLoad</key>
      <true/>
      <key>KeepAlive</key>
      <true/>
      <key>StandardOutPath</key>
      <string>#{xml(Path.join(home, "service.log"))}</string>
      <key>StandardErrorPath</key>
      <string>#{xml(Path.join(home, "service-error.log"))}</string>
    </dict>
    </plist>
    """
  end

  def render_systemd(executable, home \\ Paths.home()) do
    """
    [Unit]
    Description=Token Tracker
    After=network-online.target

    [Service]
    Type=simple
    Environment=TOKEN_TRACKER_HOME=#{systemd_escape(home)}
    ExecStart=#{systemd_escape(executable)} daemon
    Restart=on-failure
    RestartSec=5

    [Install]
    WantedBy=default.target
    """
  end

  defp install_macos(executable) do
    path = macos_path()
    File.mkdir_p!(Path.dirname(path))

    with :ok <- File.write(path, render_launchd(executable)),
         :ok <- File.chmod(path, 0o600) do
      {:ok, path}
    end
  end

  defp install_linux(executable) do
    path = linux_path()
    File.mkdir_p!(Path.dirname(path))

    with :ok <- File.write(path, render_systemd(executable)),
         :ok <- File.chmod(path, 0o600) do
      case System.cmd("systemctl", ["--user", "daemon-reload"], stderr_to_stdout: true) do
        {_output, 0} -> {:ok, path}
        {_output, status} -> {:error, "systemctl daemon-reload exited with status #{status}"}
      end
    end
  end

  defp control(action) do
    case {os(), action} do
      {:macos, :start} -> run("launchctl", ["bootstrap", "gui/#{uid()}", macos_path()])
      {:macos, :stop} -> run("launchctl", ["bootout", "gui/#{uid()}", macos_path()])
      {:macos, :status} -> run("launchctl", ["print", "gui/#{uid()}/#{@label}"])
      {:linux, :start} -> run("systemctl", ["--user", "enable", "--now", @label])
      {:linux, :stop} -> run("systemctl", ["--user", "disable", "--now", @label])
      {:linux, :status} -> run("systemctl", ["--user", "status", @label, "--no-pager"])
      _ -> {:error, "service control supports macOS and Linux"}
    end
  end

  defp run(command, args) do
    {output, status} = System.cmd(command, args, stderr_to_stdout: true)
    if status == 0, do: {:ok, String.trim(output)}, else: {:error, String.trim(output)}
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp os do
    case :os.type() do
      {:unix, :darwin} -> :macos
      {:unix, _} -> :linux
      _ -> :unsupported
    end
  end

  defp macos_path do
    Path.join([System.user_home!(), "Library", "LaunchAgents", "#{@label}.plist"])
  end

  defp linux_path do
    Path.join([System.user_home!(), ".config", "systemd", "user", "#{@label}.service"])
  end

  defp uid do
    {uid, 0} = System.cmd("id", ["-u"])
    String.trim(uid)
  end

  defp xml(value) do
    value
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
  end

  defp systemd_escape(value) do
    if String.match?(value, ~r/[\s"'\\]/) do
      ("\"" <> String.replace(value, ["\\"], "\\\\")) |> Kernel.<>("\"")
    else
      value
    end
  end
end
