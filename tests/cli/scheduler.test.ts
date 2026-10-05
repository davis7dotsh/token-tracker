import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchdPlist, systemdUnits } from '../../src/cli/scheduler';

test('scheduled sync preserves multiple custom Grok roots on Linux and macOS', () => {
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = '~/grok history,, ./grok-other,';
  try {
    const roots = `${join(homedir(), 'grok history')},${resolve('grok-other')}`;
    expect(systemdUnits(['/bin/token-tracker'], '/tmp/tracker', 5).service).toContain(
      `Environment="GROK_HOME=${roots}"`,
    );
    expect(launchdPlist(['/bin/token-tracker'], '/tmp/tracker', 5)).toContain(
      `<key>GROK_HOME</key><string>${roots}</string>`,
    );
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
});
