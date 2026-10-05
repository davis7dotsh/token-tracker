import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModule } from 'svelte/compiler';

let directory: string;
let runed: typeof import('runed/kit');

// Compile the installed, persistently patched dependency as Svelte SSR does.
// Fake only SvelteKit request state, keeping Runed's parsing/cache code intact.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'token-tracker-search-params-'));
  const result = await Bun.build({
    entrypoints: [fileURLToPath(import.meta.resolve('runed/kit'))],
    outdir: directory,
    target: 'bun',
    plugins: [
      {
        name: 'runed-ssr',
        setup(build) {
          build.onResolve({ filter: /^\$app\/(state|navigation|env)$|^esm-env$/ }, ({ path }) => ({
            path,
            namespace: 'request-state',
          }));
          build.onLoad({ filter: /.*/, namespace: 'request-state' }, ({ path }) => ({
            loader: 'js',
            contents:
              path === '$app/state'
                ? 'export const page = { url: new URL("https://tracker.test/?range=month&sessionSearch=true#sessions") };'
                : path === '$app/navigation'
                  ? 'export function goto() { throw new Error("SSR must not navigate"); }'
                  : 'export const browser = false; export const building = false; export const BROWSER = false; export const DEV = false;',
          }));
          build.onLoad({ filter: /\.svelte\.js$/ }, async ({ path }) => ({
            loader: 'js',
            contents: compileModule(await readFile(path, 'utf8'), {
              filename: path,
              generate: 'server',
            }).js.code,
          }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, 'Runed SSR test compilation failed');
  runed = await import(result.outputs[0]!.path);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('literal search text and encoded filter strings survive URL parsing exactly', () => {
  const schema = runed.createSearchParamsSchema({
    sessionSearch: { type: 'string', default: '' },
    models: { type: 'string', default: '' },
  });
  for (const text of ['true', 'false', '[]', '{}', '[1]', '{"x": 1}', '["none","model,with,commas"]']) {
    const url = new URL('https://tracker.test/');
    url.searchParams.set('sessionSearch', text);
    url.searchParams.set('models', text);
    const validated = runed.validateSearchParams(url, schema);
    expect(validated.data).toEqual({ sessionSearch: text, models: text });
    expect(validated.searchParams.get('sessionSearch')).toBe(text);
    expect(validated.searchParams.get('models')).toBe(text);
  }
});

test('number, boolean, array, object, and date parsing retains typed behavior', () => {
  const schema = runed.createSearchParamsSchema({
    page: { type: 'number', default: 0 },
    enabled: { type: 'boolean', default: false },
    models: { type: 'array', default: [], arrayType: '' },
    options: { type: 'object', default: {} },
    day: { type: 'date', default: new Date('2026-10-04T00:00:00.000Z') },
  });
  const url = new URL('https://tracker.test/');
  url.search = new URLSearchParams({
    page: '3',
    enabled: 'true',
    models: '["gpt-6.1-sol","grok-4.7-build-fast"]',
    options: '{"mode":"tokens"}',
    day: '2026-10-03T00:00:00.000Z',
  }).toString();
  expect(runed.validateSearchParams(url, schema).data).toEqual({
    page: 3,
    enabled: true,
    models: ['gpt-6.1-sol', 'grok-4.7-build-fast'],
    options: { mode: 'tokens' },
    day: new Date('2026-10-03T00:00:00.000Z'),
  });
  url.searchParams.set('models', 'codex,claude');
  expect(runed.validateSearchParams(url, schema).data.models).toEqual(['codex', 'claude']);
  url.searchParams.set('page', 'invalid');
  const invalid = runed.validateSearchParams(url, schema).data;
  expect(invalid.page).toBe(0);
  expect(invalid.enabled).toBe(true);
  expect(invalid.models).toEqual(['codex', 'claude']);
});

test('SSR initializes from the request URL and local updates preserve literal strings', () => {
  const params = runed.useSearchParams(
    runed.createSearchParamsSchema({
      range: { type: 'string', default: 'week' },
      sessionSearch: { type: 'string', default: '' },
    }),
  );
  expect(params.range).toBe('month');
  expect(params.sessionSearch).toBe('true');
  params.update({ sessionSearch: '{"x": 1}' }, { pushHistory: false });
  expect(params.sessionSearch).toBe('{"x": 1}');
  params.sessionSearch = 'false';
  expect(params.sessionSearch).toBe('false');
  params.reset();
  expect(params.range).toBe('week');
  expect(params.sessionSearch).toBe('');
});
