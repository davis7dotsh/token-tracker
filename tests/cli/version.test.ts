import { expect, test } from 'bun:test';
import packageJson from '../../package.json';
import { collectorVersion, formatCollectorVersion, releaseVersion } from '../../src/lib/shared/version';

test('collectors report the package release, plus a build commit when one was embedded', () => {
  expect(releaseVersion).toBe(packageJson.version);
  // Source runs have no embedded commit.
  expect(collectorVersion).toBe(releaseVersion);
  expect(formatCollectorVersion('0.4.1', ' 0cebd19\n')).toBe('0.4.1+0cebd19');
  for (const build of [undefined, '', 'not a commit', 'x'.repeat(41)])
    expect(formatCollectorVersion('0.4.1', build)).toBe('0.4.1');
  expect(formatCollectorVersion('9'.repeat(40), 'a'.repeat(40))).toHaveLength(64);
});
