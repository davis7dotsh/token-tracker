# Contributing

## Setup

Install [Vite+](https://viteplus.dev/guide/) if you do not already have `vp`:

```sh
curl -fsSL https://vite.plus | bash
```

Open a new shell, then:

```sh
vp install --frozen-lockfile
bun run dev
```

Bun 1.4.2 comes from the `packageManager` field. Node 24.21.0 or later works. CI uses Node 24.21.0.

`bun run cli` is the from-source CLI. `cli.cjs` only launches a native binary, so run `bun run build:cli` before using the package `bin`.

## Checks

Pull requests run these with no secrets:

```sh
bun run format
bun run lint
bun run format:check
bun run check
bun run test
bun run build
bun run build:cli
git diff --check
```

`bun run check` is the typecheck: SvelteKit sync, Vite+ format/lint/TypeScript, then `svelte-check --tsgo`.

## Pull requests

Open a pull request against `main`. Leave `.env`, `.alchemy/`, local databases, and `dist/` untracked.

There is no `LICENSE` file yet. Ask before you redistribute the code.
