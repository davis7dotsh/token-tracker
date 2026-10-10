import { expect, test } from 'bun:test';
import {
  createSession,
  loginDestination,
  matchesPasscode,
  sessionMaxAge,
  validSession,
} from '../../src/lib/server/auth';

const passcode = 'test-only-dashboard-passcode';
const now = Date.parse('2026-10-10T12:00:00Z');

test('dashboard sessions reject tampering, expiry, and passcode rotation', async () => {
  const cookie = await createSession(passcode, now);
  expect(await validSession(cookie, passcode, now)).toBe(true);
  expect(cookie).not.toContain(passcode);
  expect(await validSession(cookie, passcode, now + sessionMaxAge * 1000)).toBe(false);
  expect(await validSession(cookie, 'rotated-dashboard-passcode', now)).toBe(false);
  const parts = cookie.split('.');
  parts[1] = String(Number(parts[1]) + 1000);
  expect(await validSession(parts.join('.'), passcode, now)).toBe(false);
  expect(await validSession(cookie.slice(0, -1), passcode, now)).toBe(false);
  expect(await validSession(undefined, passcode, now)).toBe(false);
  expect(await validSession('v1.invalid.cookie.signature', passcode, now)).toBe(false);
});

test('passcodes are exact and redirects stay on the dashboard', async () => {
  expect(await matchesPasscode(passcode, passcode)).toBe(true);
  expect(await matchesPasscode(passcode.toUpperCase(), passcode)).toBe(false);
  expect(await matchesPasscode('', passcode)).toBe(false);
  expect(loginDestination('/?range=7d&devices=laptop')).toBe('/?range=7d&devices=laptop');
  for (const destination of [
    null,
    'https://evil.test',
    '//evil.test',
    '/\\evil.test',
    '/\t/evil.test',
    '/login',
    '/logout',
  ])
    expect(loginDestination(destination)).toBe('/');
});
