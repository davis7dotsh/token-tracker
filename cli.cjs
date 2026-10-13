#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const binary = join(__dirname, 'dist', `token-tracker-${process.platform}-${process.arch}`);
const supportedPlatform = process.platform === 'darwin' || process.platform === 'linux';
const supportedArch = process.arch === 'x64' || process.arch === 'arm64';
if (!existsSync(binary)) {
  if (!supportedPlatform || !supportedArch) {
    console.error(
      `Token tracker supports macOS and Linux on x64 or arm64. This machine is ${process.platform}-${process.arch}.`,
    );
  } else {
    console.error(
      `No token-tracker binary at ${binary}. From a source checkout, run \`bun run build:cli\` first, or use \`bun run cli\` without a native build.`,
    );
  }
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not start token tracker: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
