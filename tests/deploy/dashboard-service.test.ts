import { expect, test } from 'bun:test';
import { dashboardLaunchdPlist, dashboardSystemdUnit } from '../../src/deploy/dashboard-service';

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
