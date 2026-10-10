import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { launchdDomains } from '../../src/cli/scheduler';
import {
  dashboardLaunchdPlist,
  dashboardSystemdUnit,
  loadDashboardLaunchAgent,
  localUrl,
  ServiceError,
  unloadDashboardLaunchAgent,
} from '../../src/deploy/dashboard-service';

const props = {
  name: 'token-tracker-dashboard',
  build: 'build',
  revision: 'abc',
  appDirectory: '/home/ben/.local/share/token-tracker-dashboard 100%',
  bun: '/home/ben/.local/share/vite-plus/bun/bin/bun.native',
  host: '127.0.0.1',
  port: 8787,
  environment: {
    ORIGIN: 'https://nexus.example.ts.net:10007',
    TOKEN_TRACKER_CONFIG_DIR: '/home/ben/.config/token-tracker',
  },
};

test('the local dashboard runs its installed build with a pinned Bun on Linux and macOS', () => {
  const unit = dashboardSystemdUnit(props);
  expect(unit).toContain('WorkingDirectory=/home/ben/.local/share/token-tracker-dashboard 100%%\n');
  expect(unit).toContain(
    'ExecStart="/home/ben/.local/share/vite-plus/bun/bin/bun.native" "/home/ben/.local/share/token-tracker-dashboard 100%%/build/index.js"',
  );
  expect(unit).toContain('Environment="ORIGIN=https://nexus.example.ts.net:10007"');
  expect(unit).toContain('Environment="PORT=8787"');
  expect(unit).toContain('UMask=0077');

  const plist = dashboardLaunchdPlist(props);
  expect(plist).toContain('<key>Label</key><string>sh.davis.token-tracker-dashboard</string>');
  expect(plist).toContain('<key>HOST</key><string>127.0.0.1</string>');
  expect(plist).toContain('<key>KeepAlive</key><true/>');
  expect(plist).toContain(
    '<key>LimitLoadToSessionType</key><array><string>Aqua</string><string>Background</string></array>',
  );
});

for (const guiAvailable of [true, false]) {
  test(`dashboard launchd ${guiAvailable ? 'desktop' : 'headless'} start and removal use the available session`, async () => {
    const [guiDomain, userDomain] = launchdDomains();
    const plist = '/tmp/token-tracker-dashboard.plist';
    const loaded = new Set(
      guiAvailable ? [`${guiDomain}:${plist}`, `${userDomain}:${plist}`] : [`${userDomain}:${plist}`],
    );
    const execute = (args: readonly string[]) =>
      Effect.gen(function* () {
        const [operation, domain, file] = args;
        if (domain === guiDomain && !guiAvailable)
          return yield* new ServiceError({ message: 'The GUI domain does not exist.' });
        if (operation === 'bootout') loaded.delete(`${domain}:${file}`);
        if (operation === 'bootstrap') {
          if (domain !== (guiAvailable ? guiDomain : userDomain))
            return yield* new ServiceError({ message: 'Cannot bootstrap in an unavailable domain.' });
          loaded.add(`${domain}:${file}`);
        }
      });
    await Effect.runPromise(loadDashboardLaunchAgent(plist, execute));
    expect([...loaded]).toEqual([`${guiAvailable ? guiDomain : userDomain}:${plist}`]);
    await Effect.runPromise(unloadDashboardLaunchAgent(plist, execute));
    expect([...loaded]).toEqual([]);
  });
}

test('a headless launchd bootstrap failure is reported rather than swallowed', async () => {
  const execute = (args: readonly string[]) =>
    args[0] === 'bootout' ? Effect.void : Effect.fail(new ServiceError({ message: 'launchctl failed' }));
  const result = await Effect.runPromiseExit(loadDashboardLaunchAgent('/tmp/dashboard.plist', execute));
  expect(result._tag).toBe('Failure');
});

test('IPv6 loopback and wildcard health URLs reach the running service', async () => {
  const server = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('healthy') });
  try {
    const port = server.port;
    if (port === undefined) throw new Error('The health test requires an HTTP listener.');
    for (const host of ['::1', '::', '[::1]']) {
      const response = await fetch(`${localUrl({ ...props, host, port })}/api/health`);
      expect(await response.text()).toBe('healthy');
    }
    expect(new URL(localUrl({ ...props, host: '0.0.0.0' })).hostname).toBe('127.0.0.1');
  } finally {
    await server.stop(true);
  }
});
