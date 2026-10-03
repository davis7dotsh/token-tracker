#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const binary = join(__dirname, 'dist', `token-tracker-${process.platform}-${process.arch}`);
if (!existsSync(binary)) {
  console.error(
    `Token tracker supports macOS and Linux on x64 or arm64. No binary was bundled for ${process.platform}-${process.arch}.`,
  );
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not start token tracker: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
