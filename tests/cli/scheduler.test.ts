import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  launchdPlist,
  localStartBoundary,
  schtasksCreate,
  schtasksDelete,
  schtasksScript,
  schtasksXml,
  systemdUnits,
  utf16le,
} from '../../src/cli/scheduler';

test('scheduled sync preserves multiple custom Grok roots on Linux and macOS', () => {
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = '~/grok history,, ./grok-other,';
  try {
    const roots = `${join(homedir(), 'grok history')},${resolve('grok-other')}`;
    expect(systemdUnits(['/bin/token-tracker'], '/tmp/tracker', 5).service).toContain(
      `Environment="GROK_HOME=${roots}"`,
    );
    expect(launchdPlist(['/bin/token-tracker'], '/tmp/tracker', 5)).toContain(
      `<key>GROK_HOME</key><string>${roots}</string>`,
    );
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
});

test('Windows sync wrapper sets literal cmd.exe variables and appends to the sync log', () => {
  const env = {
    USERPROFILE: 'C:\\Users\\Ada Lovelace',
    HOME: '/ignored/on/windows',
    CODEX_HOME: 'D:\\codex,, E:\\100% codex',
  };
  const script = schtasksScript(
    ['C:\\Users\\Ada Lovelace\\AppData\\Roaming\\token-tracker\\bin\\token-tracker.exe'],
    'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\token-tracker',
    env,
  );
  expect(script.split('\r\n')).toEqual([
    '@echo off',
    'chcp 65001 >nul',
    'set "TOKEN_TRACKER_CONFIG_DIR=C:\\Users\\Ada Lovelace\\AppData\\Roaming\\token-tracker"',
    'set "USERPROFILE=C:\\Users\\Ada Lovelace"',
    'set "CODEX_HOME=D:\\codex,E:\\100%% codex"',
    '"C:\\Users\\Ada Lovelace\\AppData\\Roaming\\token-tracker\\bin\\token-tracker.exe" "sync" "--quiet" >> "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\token-tracker\\sync.log" 2>&1',
    '',
  ]);
});

test('Windows schedule imports the task from an XML file', () => {
  const task = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\token-tracker\\bin\\sync-task.xml';
  expect(schtasksCreate(task)).toEqual(['schtasks.exe', '/Create', '/XML', task, '/TN', 'Token Tracker Sync', '/F']);
  expect(schtasksDelete).toEqual(['schtasks.exe', '/Delete', '/TN', 'Token Tracker Sync', '/F']);
});

test('Windows task XML runs the wrapper headless on a repeating interval', () => {
  const script = 'C:\\Users\\Ada & Co\\AppData\\Roaming\\token-tracker\\bin\\sync.cmd';
  const task = schtasksXml(script, 5, '2026-11-01T09:05:07');
  expect(task.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n')).toBe(true);
  expect(task).toContain('<Interval>PT5M</Interval>');
  expect(task).toContain('<StartBoundary>2026-11-01T09:05:07</StartBoundary>');
  expect(task).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  expect(task).toContain('<ExecutionTimeLimit>PT11M</ExecutionTimeLimit>');
  expect(task).toContain(
    '<Exec><Command>conhost.exe</Command><Arguments>--headless cmd.exe /d /c &quot;C:\\Users\\Ada &amp; Co\\AppData\\Roaming\\token-tracker\\bin\\sync.cmd&quot;</Arguments></Exec>',
  );
  expect(schtasksXml(script, 120, '2026-11-01T09:05:07')).toContain('<Interval>PT2H</Interval>');
  expect(schtasksXml(script, 1440, '2026-11-01T09:05:07')).toContain('<Interval>PT24H</Interval>');
});

test('Windows task XML is written as UTF-16LE with a BOM and a local start time', () => {
  expect([...utf16le('<é')]).toEqual([0xff, 0xfe, 0x3c, 0x00, 0xe9, 0x00]);
  expect(localStartBoundary(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02T03:04:05');
});
