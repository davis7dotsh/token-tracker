import { expect, test } from 'bun:test';
import {
  nativeThreadUrl,
  projectLabel,
  projectLabels,
  repositoryWebUrl,
  safeWebUrl,
  sessionDisplayName,
} from '../../src/lib/client/session-links';

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
  const session = { project: '/home/user/.t3/scratch/date-task-id', repository: 'github.com/team/app' };
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

test('project labels retain existing compact labels when there are no collisions', () => {
  const values = ['github.com/team/app', 'local:/work/solo', 'https://gitlab.com/other/repo.git', 'C:\\work\\tools'];
  const labels = projectLabels(values);
  for (const value of values) expect(labels.get(value)).toBe(projectLabel(value));
  expect(labels.get('https://gitlab.com/other/repo.git')).toBe('other/repo');
  expect(projectLabels([...values, values[0]]).size).toBe(values.length);
});

test('project labels extend colliding suffixes only as far as each identity needs', () => {
  const labels = projectLabels([
    '/one/team/app',
    '/two/team/app',
    '/east/shared/org/api',
    '/west/shared/org/api',
    '/team/app',
    '/unrelated/unique',
  ]);
  expect([...labels.values()]).toEqual([
    'one/team/app',
    'two/team/app',
    'east/shared/org/api',
    'west/shared/org/api',
    'team/app',
    'unrelated/unique',
  ]);
  const reversed = projectLabels([...labels.keys()].reverse());
  for (const [key, label] of labels) expect(reversed.get(key)).toBe(label);
});

test('project labels preserve full canonical keys when stripped identities are identical', () => {
  const values = ['https://github.com/team/app.git', 'github.com/team/app', 'local:github.com/team/app'];
  expect([...projectLabels(values).values()]).toEqual(values);
});

test('full identity fallbacks cannot collide with a different project suffix', () => {
  const values = ['local:/a/team/app', '/a/team/app', '/root/local:/a/team/app'];
  const labels = projectLabels(values);
  expect(new Set(labels.values()).size).toBe(values.length);
  expect(labels.get('local:/a/team/app')).toBe('local:/a/team/app');
  expect(labels.get('/a/team/app')).toBe('/a/team/app');
  expect(labels.get('/root/local:/a/team/app')).toBe('root/local:/a/team/app');
});
