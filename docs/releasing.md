# Releasing Token Tracker

Depot CI is the only continuous-integration and release runner for this
repository. Pull requests and pushes to `main` run
`.depot/workflows/ci.yml`. Version tags run `.depot/workflows/release.yml`.

## Release artifacts

The release workflow uses Burrito and Zig to cross-build self-contained
executables with ERTS and the SQLite NIF for:

- macOS arm64
- macOS x86-64
- Linux arm64
- Linux x86-64

Target machines do not need Erlang, Elixir, Node.js, pnpm, Zig, or SQLite.
The executable expands its versioned runtime payload on first launch.

## Publish a release

1. Update the version in `mix.exs`.
2. Run `mix check` and `mix assets.check`.
3. Merge the version change to `main`.
4. Create and push the matching tag:

   ```sh
   git tag v0.4.0
   git push origin v0.4.0
   ```

The tag must exactly match the version in `mix.exs`. Depot builds all four
targets, smoke-tests the Linux x86-64 artifact, writes SHA-256 checksums, and
creates the GitHub Release using its short-lived GitHub App token.

An existing tag can be retried with:

```sh
depot ci dispatch --workflow .depot/workflows/release.yml \
  --input tag=v0.4.0
```

## Validate before pushing

Depot can execute the workflow with the current working tree, including
uncommitted changes:

```sh
depot ci run --workflow .depot/workflows/ci.yml --follow
```

Automatic pull-request and tag triggers are registered after the `.depot`
workflows reach the default branch.
