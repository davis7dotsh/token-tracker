# Project instructions

- Use Vite+ for the development toolchain and managed Node/Bun environments.
- Keep Bun as the runtime, test runner, and native CLI builder.
- Prefer functional patterns, typed errors as values, and inferred TypeScript types. Avoid `as any`.
- Keep changes focused and preserve the existing UI conventions.

## Required verification

After making changes, run all of these commands before committing or reporting the work complete:

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

- Fix failures and rerun the affected checks. If formatting changes files, verify the final formatted source.
- Use `bun run check` for the complete check: it synchronizes SvelteKit, runs Vite+ format/lint/type checks, and runs `svelte-check --tsgo` for Svelte component types and diagnostics. Bare `vp check` does not replace it.
- Preserve the native TypeScript compiler alias and `--tsgo` flag. TypeScript 6 remains necessary for the JavaScript tooling APIs.
- Generated builds, native binaries, dependencies, and local databases must remain ignored by Git.
