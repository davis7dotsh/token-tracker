import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effect, FileSystem } from 'effect';
import { CliFailure, configDirectory } from './state';

export const executableCommand = () =>
  Bun.main.includes('$bunfs') ? [process.execPath] : [process.execPath, join(import.meta.dir, 'run.ts')];

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

const systemdQuote = (value: string) =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const absoluteSourcePath = (value: string) =>
  resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
const launchdDomains = () => [`gui/${process.getuid?.() ?? 0}`, `user/${process.getuid?.() ?? 0}`];
const scheduledEnvironment = (directory: string) => [
  { name: 'TOKEN_TRACKER_CONFIG_DIR', value: directory },
  ...[
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'TOKEN_TRACKER_DATA_DIR',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'PI_CODING_AGENT_DIR',
    'GROK_HOME',
  ].flatMap((name) => {
    const value = process.env[name];
    if (!value) return [];
    const resolved = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'GROK_HOME'].includes(name)
      ? value
          .split(',')
          .map((path) => path.trim())
          .filter(Boolean)
          .map(absoluteSourcePath)
          .join(',')
      : absoluteSourcePath(value);
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

export const installSchedule = Effect.fn('cli.installSchedule')(function* (minutes: number) {
  const fs = yield* FileSystem.FileSystem;
  const directory = configDirectory();
  let command = executableCommand();
  if (Bun.main.includes('$bunfs')) {
    // npx caches can be evicted. The scheduled job owns a durable copy instead
    // of pointing at the transient npm package extraction directory.
    const binaryDirectory = join(directory, 'bin');
    const destination = join(binaryDirectory, 'token-tracker');
    yield* fs.makeDirectory(binaryDirectory, { recursive: true, mode: 0o700 });
    if (process.execPath !== destination) {
      const temporary = `${destination}.${process.pid}.tmp`;
      yield* fs.copyFile(process.execPath, temporary);
      yield* fs.chmod(temporary, 0o700);
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
  return yield* Effect.fail(new CliFailure({ message: 'Scheduled sync currently supports macOS and Linux.' }));
});

export const removeSchedule = Effect.fn('cli.removeSchedule')(function* (scheduler: 'systemd' | 'launchd' | null) {
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
  }
});
