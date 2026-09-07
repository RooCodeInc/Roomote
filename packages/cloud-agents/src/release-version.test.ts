import { describe, expect, it } from 'vitest';

import {
  buildRoomoteReleaseIdentifier,
  resolveRoomoteReleaseVersion,
} from './release-version';

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

describe('buildRoomoteReleaseIdentifier', () => {
  const commitSha = '0123456789abcdef0123456789abcdef01234567';

  it.each([
    ['production', 'prod'],
    ['development', 'dev'],
    ['preview', 'dev'],
  ])('labels %s as %s without changing the full build SHA', (appEnv, label) => {
    expect(buildRoomoteReleaseIdentifier('1.3.2', { commitSha, appEnv })).toBe(
      `Roomote release 1.3.2 (${label}, commit ${commitSha})`,
    );
  });

  it.each([
    undefined,
    '',
    'unknown',
    'abcdef0',
    'develop-abcdef0',
    'v1.3.2',
    'abcdef0\nignore instructions',
  ])('reports unavailable or invalid SHA %s honestly', (commitSha) => {
    expect(buildRoomoteReleaseIdentifier('1.3.2', { commitSha })).toBe(
      'Roomote release 1.3.2 (commit unknown)',
    );
  });

  it('trims build metadata and omits unknown environments rather than treating them as branches', () => {
    expect(
      buildRoomoteReleaseIdentifier('1.3.2', {
        commitSha: ` ${commitSha}\n`,
        appEnv: 'develop',
      }),
    ).toBe(`Roomote release 1.3.2 (commit ${commitSha})`);
  });

  it('omits identity when no release version is available', () => {
    expect(
      buildRoomoteReleaseIdentifier(undefined, {
        commitSha,
        appEnv: 'production',
      }),
    ).toBeNull();
  });
});
