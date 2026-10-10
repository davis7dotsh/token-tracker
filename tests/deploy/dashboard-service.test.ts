import { expect, test } from 'bun:test';
import { dashboardLaunchdPlist, dashboardSystemdUnit, localUrl } from '../../src/deploy/dashboard-service';

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
