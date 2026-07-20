import { describe, expect, it } from 'vitest';

import {
  compareProductVersions,
  isProductVersionNewer,
  normalizeProductVersion,
  toReleaseTag,
} from '../product-version';

describe('product-version', () => {
  it('normalizes leading v and whitespace', () => {
    expect(normalizeProductVersion(' v0.14.1 ')).toBe('0.14.1');
    expect(normalizeProductVersion(null)).toBeNull();
    expect(normalizeProductVersion('')).toBeNull();
  });

  it('compares numeric segments', () => {
    expect(compareProductVersions('0.14.0', '0.14.1')).toBe(-1);
    expect(compareProductVersions('v0.15.0', '0.14.9')).toBe(1);
    expect(compareProductVersions('0.14.1', '0.14.1')).toBe(0);
  });

  it('ranks plain releases above prereleases on the same version', () => {
    expect(compareProductVersions('0.14.1', '0.14.1-rc1')).toBe(1);
    expect(compareProductVersions('0.14.1-rc1', '0.14.1')).toBe(-1);
  });

  it('compares prerelease identifiers with SemVer rules', () => {
    expect(compareProductVersions('0.15.0-rc.2', '0.15.0-rc.10')).toBe(-1);
    expect(compareProductVersions('0.15.0-rc.10', '0.15.0-rc.2')).toBe(1);
    expect(compareProductVersions('0.15.0-alpha', '0.15.0-alpha.1')).toBe(-1);
    expect(compareProductVersions('0.15.0-alpha.1', '0.15.0-alpha.beta')).toBe(
      -1,
    );
    expect(compareProductVersions('0.15.0-alpha.beta', '0.15.0-beta')).toBe(-1);
    expect(compareProductVersions('0.15.0-beta.2', '0.15.0-beta.11')).toBe(-1);
    expect(compareProductVersions('0.15.0-rc.1', '0.15.0-rc.1')).toBe(0);
  });

  it('isProductVersionNewer only when strictly greater', () => {
    expect(isProductVersionNewer('0.14.2', '0.14.1')).toBe(true);
    expect(isProductVersionNewer('0.15.0-rc.10', '0.15.0-rc.2')).toBe(true);
    expect(isProductVersionNewer('0.15.0-rc.2', '0.15.0-rc.10')).toBe(false);
    expect(isProductVersionNewer('0.14.1', '0.14.1')).toBe(false);
    expect(isProductVersionNewer(null, '0.14.1')).toBe(false);
  });

  it('toReleaseTag always prefixes v', () => {
    expect(toReleaseTag('0.14.1')).toBe('v0.14.1');
    expect(toReleaseTag('v0.14.1')).toBe('v0.14.1');
  });
});
