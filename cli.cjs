#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

// Bun names the Windows target `windows`; build-cli.ts writes `.exe` binaries for it.
const windows = process.platform === 'win32';
const binary = join(
  __dirname,
  'dist',
  `token-tracker-${windows ? 'windows' : process.platform}-${process.arch}${windows ? '.exe' : ''}`,
);
if (!existsSync(binary)) {
  console.error(
    `Token tracker supports macOS, Linux, and Windows on x64 or arm64. No binary was bundled for ${process.platform}-${process.arch}.`,
  );
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not start token tracker: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  // Windows cannot re-raise most POSIX signals on itself.
  try {
    process.kill(process.pid, result.signal);
  } catch {
    process.exit(1);
  }
}
process.exit(result.status ?? 1);
