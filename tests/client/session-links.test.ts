import { expect, test } from 'bun:test';
import { repositoryWebUrl, safeWebUrl, sessionDisplayName } from '../../src/lib/client/session-links';

test('thread links allow browser URLs and reject executable schemes and embedded credentials', () => {
  expect(safeWebUrl('https://app.t3.codes/environment/thread')).toBe('https://app.t3.codes/environment/thread');
  expect(safeWebUrl('http://machine.ts.net:3773/environment/thread')).toBe(
    'http://machine.ts.net:3773/environment/thread',
  );
  for (const value of [
    'javascript:alert(1)',
    'file:///tmp/thread',
    'https://token@example.com/thread',
    'broken',
    undefined,
  ])
    expect(safeWebUrl(value)).toBeUndefined();
});

test('repository links use canonical remote identities and leave local-only repositories unlinked', () => {
  expect(repositoryWebUrl('github.com/davis7dotsh/token-tracker')).toBe('https://github.com/davis7dotsh/token-tracker');
  expect(repositoryWebUrl('gitlab.com/team/subgroup/app')).toBe('https://gitlab.com/team/subgroup/app');
  for (const value of [
    null,
    'local:/work/app',
    'user:password@github.com/team/app',
    'github.com/team/app?token=secret',
  ])
    expect(repositoryWebUrl(value)).toBeUndefined();
});

test('session names prefer the thread title, then attached project, then existing repository or directory label', () => {
  const session = { project: '/home/davis/.t3/scratch/date-task-id', repository: 'github.com/team/app' };
  expect(sessionDisplayName({ ...session, sessionTitle: 'Improve session links', projectName: 'Token tracker' })).toBe(
    'Improve session links',
  );
  expect(sessionDisplayName({ ...session, sessionTitle: ' ', projectName: 'Token tracker' })).toBe('Token tracker');
  expect(sessionDisplayName(session)).toBe('team/app');
  expect(sessionDisplayName({ project: '/work/apps/local-project', repository: null })).toBe('apps/local-project');
});
