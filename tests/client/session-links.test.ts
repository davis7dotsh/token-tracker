import { expect, test } from 'bun:test';
import { nativeThreadUrl, repositoryWebUrl, safeWebUrl, sessionDisplayName } from '../../src/lib/client/session-links';

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

test('native links preserve the environment and namespaced thread across public and private web routes', () => {
  const environment = '6fe5a640-69f8-4ad6-b09e-2b3964e7ce35';
  const thread = 'mcp:f1704b48-45f0-4649-8b2e-3f23a3b15797';
  for (const base of ['https://app.t3.codes', 'http://machine.ts.net:3773/t3']) {
    expect(
      nativeThreadUrl({ t3ThreadId: thread, t3ThreadUrl: `${base}/${environment}/${encodeURIComponent(thread)}` }),
    ).toBe(`t3code://threads/${environment}/${thread}`);
  }
  expect(safeWebUrl(`t3code://threads/${environment}/${thread}`)).toBeUndefined();
});

test('native links require a coherent binding and reject malformed or cleared web routes', () => {
  for (const t3ThreadUrl of [
    undefined,
    '',
    'javascript:alert(1)',
    't3code://threads/env/thread',
    'https://token@app.t3.codes/env/thread',
    'https://app.t3.codes/env/other',
    'https://app.t3.codes/thread',
    'https://app.t3.codes/env/thread/',
    'https://app.t3.codes/env/thread?token=secret',
    'https://app.t3.codes/env/thread#fragment',
    'https://app.t3.codes/env%2Fother/thread',
    'https://app.t3.codes/%ZZ/thread',
  ])
    expect(nativeThreadUrl({ t3ThreadId: 'thread', t3ThreadUrl })).toBeUndefined();
  expect(nativeThreadUrl({ t3ThreadUrl: 'https://app.t3.codes/env/thread' })).toBeUndefined();
  expect(
    nativeThreadUrl({ t3ThreadId: 'thread/other', t3ThreadUrl: 'https://app.t3.codes/env/thread%2Fother' }),
  ).toBeUndefined();
});
