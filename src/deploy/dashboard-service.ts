import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import { Data, Effect, Schedule } from 'effect';
import { execFile } from 'node:child_process';
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { launchdDomains, systemdQuote, xml } from '../cli/scheduler';

// A self-hosted dashboard installed as a user service: a copy of the
// adapter-node build with its production dependencies, run by Bun under
// systemd (Linux) or launchd (macOS). The install never points into a checkout,
// so deleting a worktree or switching branches cannot change a running hub.
export type DashboardServiceProps = {
  readonly name: string;
  // adapter-node output, relative to the deploy's working directory.
  readonly build: string;
  // Changes whenever the build output changes, so the service reinstalls.
  readonly revision: string | undefined;
  readonly appDirectory: string;
  readonly bun: string;
  readonly host: string;
  readonly port: number;
  readonly environment: Readonly<Record<string, string>>;
};

export type DashboardService = Resource<
  'TokenTracker.DashboardService',
  DashboardServiceProps,
  { readonly url: string; readonly manager: 'systemd' | 'launchd'; readonly unit: string }
>;
export const DashboardService = Resource<DashboardService>('TokenTracker.DashboardService');

export class ServiceError extends Data.TaggedError('ServiceError')<{ readonly message: string }> {}

const execute = promisify(execFile);
const run = (command: string, args: readonly string[], cwd?: string) =>
  Effect.tryPromise({
    try: () => execute(command, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }),
    catch: (cause) =>
      new ServiceError({
        message: `${[command, ...args].join(' ')} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
const io = <A>(message: string, action: () => Promise<A>) =>
  Effect.tryPromise({ try: action, catch: () => new ServiceError({ message }) });

const manager = () =>
  process.platform === 'linux'
    ? Effect.succeed('systemd' as const)
    : process.platform === 'darwin'
      ? Effect.succeed('launchd' as const)
      : Effect.fail(new ServiceError({ message: 'The local dashboard service supports Linux and macOS.' }));
const systemdUnit = (name: string) =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', `${name}.service`);
const launchdLabel = (name: string) => `sh.davis.${name}`;
const launchdPlistPath = (name: string) => join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(name)}.plist`);
const launchctl = (args: readonly string[]) => run('launchctl', args).pipe(Effect.asVoid);

export const unloadDashboardLaunchAgent = (plist: string, execute = launchctl) =>
  Effect.forEach(launchdDomains(), (domain) => execute(['bootout', domain, plist]).pipe(Effect.ignore), {
    discard: true,
  });

export const loadDashboardLaunchAgent = Effect.fn('DashboardService.loadLaunchAgent')(function* (
  plist: string,
  execute: typeof launchctl = launchctl,
) {
  const [guiDomain, userDomain] = launchdDomains();
  const domain = yield* execute(['print', guiDomain]).pipe(
    Effect.as(guiDomain),
    Effect.catch(() => Effect.succeed(userDomain)),
  );
  yield* unloadDashboardLaunchAgent(plist, execute);
  yield* execute(['bootstrap', domain, plist]);
});

const serviceEnvironment = (props: DashboardServiceProps) => ({
  ...props.environment,
  HOST: props.host,
  PORT: String(props.port),
});
const command = (props: DashboardServiceProps) => [props.bun, join(props.appDirectory, 'build', 'index.js')];

export const dashboardSystemdUnit = (props: DashboardServiceProps) =>
  [
    '[Unit]',
    'Description=Token tracker dashboard',
    'After=network.target',
    '',
    '[Service]',
    // WorkingDirectory takes a bare path; only specifiers need escaping.
    `WorkingDirectory=${props.appDirectory.replaceAll('%', '%%')}`,
    `ExecStart=${command(props).map(systemdQuote).join(' ')}`,
    ...Object.entries(serviceEnvironment(props)).map(
      ([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`,
    ),
    'Restart=on-failure',
    'RestartSec=3',
    'NoNewPrivileges=true',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');

export const dashboardLaunchdPlist = (props: DashboardServiceProps) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
  `<plist version="1.0"><dict>\n<key>Label</key><string>${xml(launchdLabel(props.name))}</string>\n` +
  `<key>LimitLoadToSessionType</key><array><string>Aqua</string><string>Background</string></array>\n` +
  `<key>ProgramArguments</key><array>${command(props)
    .map((value) => `<string>${xml(value)}</string>`)
    .join('')}</array>\n` +
  `<key>WorkingDirectory</key><string>${xml(props.appDirectory)}</string>\n` +
  `<key>EnvironmentVariables</key><dict>${Object.entries(serviceEnvironment(props))
    .map(([name, value]) => `<key>${xml(name)}</key><string>${xml(value)}</string>`)
    .join('')}</dict>\n` +
  `<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>Umask</key><integer>63</integer>\n` +
  `<key>StandardOutPath</key><string>${xml(join(props.appDirectory, 'dashboard.log'))}</string>\n` +
  `<key>StandardErrorPath</key><string>${xml(join(props.appDirectory, 'dashboard.log'))}</string>\n</dict></plist>\n`;

export const localUrl = (props: DashboardServiceProps) => {
  const host = props.host === '0.0.0.0' ? '127.0.0.1' : props.host === '::' ? '::1' : props.host;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${props.port}`;
};

// Replace the app atomically enough for a restart: the new build and its
// production dependencies are complete before the service is restarted.
const install = Effect.fn('DashboardService.install')(function* (props: DashboardServiceProps) {
  const source = resolve(props.build, '..');
  const next = `${props.appDirectory}.next`;
  yield* io('Could not stage the dashboard build.', async () => {
    await rm(next, { recursive: true, force: true });
    await mkdir(next, { recursive: true, mode: 0o700 });
    await cp(resolve(props.build), join(next, 'build'), { recursive: true });
    for (const file of ['package.json', 'bun.lock', 'patches'])
      await cp(join(source, file), join(next, file), { recursive: true });
  });
  yield* run(props.bun, ['install', '--production', '--frozen-lockfile'], next);
  yield* io('Could not replace the installed dashboard.', async () => {
    await rm(props.appDirectory, { recursive: true, force: true });
    await rename(next, props.appDirectory);
  });
});

const waitUntilHealthy = (props: DashboardServiceProps, unit: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${localUrl(props)}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`status ${response.status}`);
    },
    catch: () => new ServiceError({ message: `${unit} did not report healthy at ${localUrl(props)}/api/health.` }),
  }).pipe(Effect.retry({ schedule: Schedule.spaced('1 second'), times: 30 }));

const start = Effect.fn('DashboardService.start')(function* (props: DashboardServiceProps) {
  const kind = yield* manager();
  if (kind === 'systemd') {
    const unit = systemdUnit(props.name);
    yield* io('Could not write the systemd user unit.', async () => {
      await mkdir(join(unit, '..'), { recursive: true });
      await writeFile(unit, dashboardSystemdUnit(props), { mode: 0o600 });
    });
    yield* run('systemctl', ['--user', 'daemon-reload']);
    yield* run('systemctl', ['--user', 'enable', `${props.name}.service`]);
    yield* run('systemctl', ['--user', 'restart', `${props.name}.service`]);
    return { manager: kind, unit: `${props.name}.service` };
  }
  const plist = launchdPlistPath(props.name);
  yield* io('Could not write the LaunchAgent.', async () => {
    await mkdir(join(plist, '..'), { recursive: true });
    await writeFile(plist, dashboardLaunchdPlist(props), { mode: 0o600 });
  });
  yield* loadDashboardLaunchAgent(plist);
  return { manager: kind, unit: launchdLabel(props.name) };
});

const stop = Effect.fn('DashboardService.stop')(function* (props: DashboardServiceProps) {
  const kind = yield* manager();
  if (kind === 'systemd') {
    yield* run('systemctl', ['--user', 'disable', '--now', `${props.name}.service`]).pipe(Effect.ignore);
    yield* io('Could not remove the systemd user unit.', () => rm(systemdUnit(props.name), { force: true }));
    yield* run('systemctl', ['--user', 'daemon-reload']);
  } else {
    const plist = launchdPlistPath(props.name);
    yield* unloadDashboardLaunchAgent(plist);
    yield* io('Could not remove the LaunchAgent.', () => rm(plist, { force: true }));
  }
});

export const dashboardServiceProvider = () =>
  Provider.succeed(DashboardService, {
    reconcile: Effect.fn(function* ({ news, session }) {
      yield* session.note(`Installing ${news.appDirectory}`);
      yield* install(news);
      const service = yield* start(news);
      yield* session.note(`Waiting for ${localUrl(news)}`);
      yield* waitUntilHealthy(news, service.unit);
      return { ...service, url: localUrl(news) };
    }),
    // Usage data stays in the data directory; only the installed app is removed.
    delete: Effect.fn(function* ({ olds }) {
      yield* stop(olds);
      yield* io('Could not remove the installed dashboard.', () =>
        rm(olds.appDirectory, { recursive: true, force: true }),
      );
    }),
  });
