import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const targets = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
  'bun-windows-arm64',
] as const;
const requested = process.argv[2];
if (requested && !targets.some((target) => target === requested)) {
  console.error(`Unknown target ${requested}. Use ${targets.join(', ')}.`);
  process.exit(1);
}

// Compiled collectors report `<version>+<commit>`; outside a git checkout they
// report the plain release version.
const commit = (() => {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' });
    const value = result.success ? result.stdout.toString().trim() : '';
    return /^[0-9a-f]{4,40}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
})();

await mkdir('dist', { recursive: true });
const target = targets.find((target) => target === requested);
// cli.cjs maps process.platform win32 to this `windows` name and adds `.exe`.
const suffix = target?.startsWith('bun-windows-') || (!target && process.platform === 'win32') ? '.exe' : '';
const outfile = resolve(`${target ? `dist/token-tracker-${target.slice(4)}` : 'dist/token-tracker'}${suffix}`);
const result = await Bun.build({
  entrypoints: ['./src/cli/run.ts'],
  target: 'bun',
  minify: true,
  ...(commit ? { define: { TOKEN_TRACKER_BUILD: JSON.stringify(commit) } } : {}),
  compile: {
    ...(target ? { target } : {}),
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
console.log(`Built ${outfile}${commit ? ` (${commit})` : ''}`);
