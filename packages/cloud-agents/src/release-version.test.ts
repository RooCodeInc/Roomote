import { describe, expect, it } from 'vitest';

import { resolveRoomoteReleaseVersion } from './release-version';

describe('resolveRoomoteReleaseVersion', () => {
  it('uses the first semantic version and normalizes a leading v', () => {
    expect(resolveRoomoteReleaseVersion(' v0.40.2 ', '0.40.1')).toBe('0.40.2');
  });

  it('ignores a non-semantic release version and uses the fallback', () => {
    const bundledPackageVersion = '0.40.2';

    expect(
      resolveRoomoteReleaseVersion(
        undefined,
        'develop-abc1234',
        bundledPackageVersion,
      ),
    ).toBe('0.40.2');
  });

  it('accepts semantic build metadata and rejects leading-zero versions', () => {
    expect(resolveRoomoteReleaseVersion('1.2.3+build.1')).toBe('1.2.3+build.1');
    expect(resolveRoomoteReleaseVersion('01.2.3')).toBeUndefined();
  });

  it('returns undefined when no semantic version resolves', () => {
    expect(
      resolveRoomoteReleaseVersion(undefined, 'develop-abc1234'),
    ).toBeUndefined();
  });
});
