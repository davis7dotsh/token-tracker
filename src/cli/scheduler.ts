import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { Effect, FileSystem } from 'effect';
import { CliFailure, configDirectory, posixModes, type Connection } from './state';

// Compiled Bun binaries embed their entrypoint in a virtual filesystem:
// `/$bunfs/root/...` on Linux and macOS, `B:\~BUN\root\...` on Windows.
export const compiledBinary = Bun.main.includes('$bunfs') || /^B:[\\/]~BUN[\\/]/.test(Bun.main);
export const executableCommand = () =>
  compiledBinary ? [process.execPath] : [process.execPath, join(import.meta.dir, 'run.ts')];

const run = Effect.fn('cli.scheduler.run')(function* (command: readonly string[]) {
  const result = yield* Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
        new Response(process.stdout).text(),
      ]);
      return { exitCode, stderr };
    },
    catch: (cause) => new CliFailure({ message: `Unable to run ${command[0]}: ${String(cause)}` }),
  });
  if (result.exitCode !== 0)
    return yield* Effect.fail(
      new CliFailure({
        message: `${command[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      }),
    );
});

export const systemdQuote = (value: string) =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
export const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const absoluteSourcePath = (value: string, platform: NodeJS.Platform) => {
  const path = platform === 'win32' ? win32 : posix;
  const home = value === '~' || value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'));
  return path.resolve(home ? path.join(homedir(), value.slice(2)) : value);
};
export const launchdDomains = () => [`gui/${process.getuid?.() ?? 0}`, `user/${process.getuid?.() ?? 0}`];
const sourceOverrides = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'GROK_HOME', 'MUSE_HOME'];
export const scheduledEnvironment = (
  directory: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) => [
  { name: 'TOKEN_TRACKER_CONFIG_DIR', value: directory },
  ...[
    // Bun resolves the Windows home directory from USERPROFILE.
    platform === 'win32' ? 'USERPROFILE' : 'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'TOKEN_TRACKER_DATA_DIR',
    ...sourceOverrides,
  ].flatMap((name) => {
    const value = env[name];
    if (!value) return [];
    const resolved = sourceOverrides.includes(name)
      ? value
          .split(',')
          .map((path) => path.trim())
          .filter(Boolean)
          .map((path) => absoluteSourcePath(path, platform))
          .join(',')
      : absoluteSourcePath(value, platform);
    return [{ name, value: resolved }];
  }),
];

export const systemdUnits = (command: readonly string[], directory: string, minutes: number) => ({
  service: [
    '[Unit]',
    'Description=Token Tracker usage sync',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${[...command, 'sync', '--quiet'].map(systemdQuote).join(' ')}`,
    ...scheduledEnvironment(directory).map(({ name, value }) => `Environment=${systemdQuote(`${name}=${value}`)}`),
    'TimeoutStartSec=11min',
    '',
  ].join('\n'),
  timer: [
    '[Unit]',
    'Description=Sync Token Tracker usage periodically',
    '',
    '[Timer]',
    'OnActiveSec=1min',
    `OnUnitActiveSec=${minutes}min`,
    'Persistent=true',
    'Unit=token-tracker-sync.service',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n'),
});

export const launchdPlist = (command: readonly string[], directory: string, minutes: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
  `<plist version="1.0"><dict>\n<key>Label</key><string>sh.davis.token-tracker.sync</string>\n` +
  `<key>LimitLoadToSessionType</key><array><string>Aqua</string><string>Background</string></array>\n` +
  `<key>ProgramArguments</key><array>${[...command, 'sync', '--quiet'].map((value) => `<string>${xml(value)}</string>`).join('')}</array>\n` +
  `<key>EnvironmentVariables</key><dict>${scheduledEnvironment(directory)
    .map(({ name, value }) => `<key>${xml(name)}</key><string>${xml(value)}</string>`)
    .join('')}</dict>\n` +
  `<key>StartInterval</key><integer>${minutes * 60}</integer>\n` +
  `<key>StandardOutPath</key><string>${xml(join(directory, 'sync.log'))}</string>\n` +
  `<key>StandardErrorPath</key><string>${xml(join(directory, 'sync.log'))}</string>\n</dict></plist>\n`;

// cmd.exe expands `%` even inside quotes. Windows paths cannot contain quotes
// or line breaks, so dropping them keeps each value one literal token.
const cmdText = (value: string) => value.replaceAll(/["\r\n]/g, '').replaceAll('%', '%%');
export const schtasksName = 'Token Tracker Sync';
// Task Scheduler cannot set environment variables. This wrapper sets them,
// then runs one quiet sync with output appended to sync.log like launchd.
export const schtasksScript = (command: readonly string[], directory: string, env: NodeJS.ProcessEnv = process.env) =>
  [
    '@echo off',
    'chcp 65001 >nul',
    ...scheduledEnvironment(directory, 'win32', env).map(({ name, value }) => `set "${name}=${cmdText(value)}"`),
    `${[...command, 'sync', '--quiet'].map((value) => `"${cmdText(value)}"`).join(' ')} >> "${cmdText(win32.join(directory, 'sync.log'))}" 2>&1`,
    '',
  ].join('\r\n');
// Whole hours use hour units (`PT2H`); a daily schedule is `PT24H`.
const repetitionInterval = (minutes: number) => (minutes % 60 === 0 ? `PT${minutes / 60}H` : `PT${minutes}M`);
// Runs as the current user without elevation. Headless conhost keeps the
// periodic task from opening a console or Windows Terminal window. The quoted
// script path lives in the XML because Bun's Windows spawn rejects embedded
// quotes in a `/TR` argument.
export const schtasksXml = (script: string, minutes: number, startBoundary: string) =>
  [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>Token Tracker usage sync</Description></RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    `      <Repetition><Interval>${repetitionInterval(minutes)}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`,
    `      <StartBoundary>${xml(startBoundary)}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    // Mirrors the systemd `TimeoutStartSec=11min`.
    '    <ExecutionTimeLimit>PT11M</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>conhost.exe</Command><Arguments>--headless cmd.exe /d /c &quot;${xml(script)}&quot;</Arguments></Exec>`,
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
// Task Scheduler rejects UTF-8 task XML; it requires UTF-16LE with a BOM.
// JavaScript strings are already UTF-16 code units; write each low byte first.
export const utf16le = (text: string) =>
  Uint8Array.from([
    0xff,
    0xfe,
    ...Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)).flatMap((unit) => [
      unit & 0xff,
      unit >> 8,
    ]),
  ]);
// Local time without a zone suffix, as Task Scheduler expects for StartBoundary.
export const localStartBoundary = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
export const schtasksCreate = (xmlPath: string) => [
  // Bun's Windows spawn does not apply PATHEXT, so the extension is required.
  'schtasks.exe',
  '/Create',
  '/XML',
  xmlPath,
  '/TN',
  schtasksName,
  '/F',
];
export const schtasksDelete = ['schtasks.exe', '/Delete', '/TN', schtasksName, '/F'];
const schtasksScriptPath = () => join(configDirectory(), 'bin', 'sync.cmd');
const schtasksXmlPath = () => join(configDirectory(), 'bin', 'sync-task.xml');

export const installSchedule = Effect.fn('cli.installSchedule')(function* (minutes: number) {
  const fs = yield* FileSystem.FileSystem;
  const directory = configDirectory();
  let command = executableCommand();
  if (compiledBinary) {
    // npx caches can be evicted. The scheduled job owns a durable copy instead
    // of pointing at the transient npm package extraction directory.
    const binaryDirectory = join(directory, 'bin');
    const destination = join(binaryDirectory, process.platform === 'win32' ? 'token-tracker.exe' : 'token-tracker');
    yield* fs.makeDirectory(binaryDirectory, { recursive: true, mode: 0o700 });
    const running =
      process.platform === 'win32'
        ? process.execPath.toLowerCase() === destination.toLowerCase()
        : process.execPath === destination;
    if (!running) {
      const temporary = `${destination}.${process.pid}.tmp`;
      yield* fs.copyFile(process.execPath, temporary);
      if (posixModes) yield* fs.chmod(temporary, 0o700);
      yield* fs.rename(temporary, destination);
    }
    command = [destination];
  }
  if (process.platform === 'linux') {
    const units = systemdUnits(command, directory, minutes);
    const unitDirectory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
    yield* fs.makeDirectory(unitDirectory, { recursive: true });
    yield* fs.writeFileString(join(unitDirectory, 'token-tracker-sync.service'), units.service, { mode: 0o600 });
    yield* fs.writeFileString(join(unitDirectory, 'token-tracker-sync.timer'), units.timer, { mode: 0o600 });
    yield* run(['systemctl', '--user', 'daemon-reload']);
    yield* run(['systemctl', '--user', 'enable', '--now', 'token-tracker-sync.timer']);
    return 'systemd' as const;
  }
  if (process.platform === 'darwin') {
    const agents = join(homedir(), 'Library', 'LaunchAgents');
    const plist = join(agents, 'sh.davis.token-tracker.sync.plist');
    const [guiDomain, userDomain] = launchdDomains();
    const domain = yield* run(['launchctl', 'print', guiDomain]).pipe(
      Effect.as(guiDomain),
      Effect.catch(() => Effect.succeed(userDomain)),
    );
    yield* fs.makeDirectory(agents, { recursive: true });
    yield* fs.writeFileString(plist, launchdPlist(command, directory, minutes), { mode: 0o600 });
    for (const previousDomain of launchdDomains()) {
      yield* run(['launchctl', 'bootout', previousDomain, plist]).pipe(Effect.catch(() => Effect.void));
    }
    yield* run(['launchctl', 'bootstrap', domain, plist]);
    return 'launchd' as const;
  }
  if (process.platform === 'win32') {
    const script = schtasksScriptPath();
    yield* fs.makeDirectory(join(directory, 'bin'), { recursive: true });
    const task = schtasksXmlPath();
    yield* fs.writeFileString(script, schtasksScript(command, directory));
    yield* fs.writeFile(task, utf16le(schtasksXml(script, minutes, localStartBoundary(new Date()))));
    yield* run(schtasksCreate(task));
    return 'schtasks' as const;
  }
  return yield* Effect.fail(
    new CliFailure({ message: 'Scheduled sync currently supports macOS, Linux, and Windows.' }),
  );
});

export const removeSchedule = Effect.fn('cli.removeSchedule')(function* (scheduler: Connection['scheduler']) {
  const fs = yield* FileSystem.FileSystem;
  if (scheduler === 'systemd') {
    yield* run(['systemctl', '--user', 'disable', '--now', 'token-tracker-sync.timer']);
    const directory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
    yield* fs.remove(join(directory, 'token-tracker-sync.timer'), { force: true });
    yield* fs.remove(join(directory, 'token-tracker-sync.service'), { force: true });
    yield* run(['systemctl', '--user', 'daemon-reload']);
  } else if (scheduler === 'launchd') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'sh.davis.token-tracker.sync.plist');
    for (const domain of launchdDomains()) {
      yield* run(['launchctl', 'bootout', domain, plist]).pipe(Effect.catch(() => Effect.void));
    }
    yield* fs.remove(plist, { force: true });
  } else if (scheduler === 'schtasks') {
    // An already deleted task leaves nothing to remove.
    yield* run(schtasksDelete).pipe(Effect.catch(() => Effect.void));
    yield* fs.remove(schtasksScriptPath(), { force: true });
    yield* fs.remove(schtasksXmlPath(), { force: true });
  }
});
