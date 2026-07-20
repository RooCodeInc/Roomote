/**
 * Product version helpers for Roomote's single monorepo version
 * (`v0.14.1` / `0.14.1`, optional prerelease suffixes).
 */

export function normalizeProductVersion(
  version: string | null | undefined,
): string | null {
  if (typeof version !== 'string') {
    return null;
  }

  const trimmed = version.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^v/i, '');
}

/**
 * Compare two product versions. Returns negative when `left < right`,
 * positive when `left > right`, and 0 when equal. Plain releases outrank a
 * prerelease on the same numeric version (0.14.1 > 0.14.1-rc1). Unparsable
 * values compare as equal to nothing useful and return 0.
 */
export function compareProductVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const a = normalizeProductVersion(left);
  const b = normalizeProductVersion(right);
  if (!a || !b) {
    return 0;
  }

  const parse = (value: string) => {
    const dashIndex = value.indexOf('-');
    const numeric = dashIndex === -1 ? value : value.slice(0, dashIndex);
    const prerelease = dashIndex === -1 ? '' : value.slice(dashIndex + 1);
    const segments = numeric
      .split('.')
      .map((part) => Number.parseInt(part, 10));
    return {
      segments: segments.every((n) => Number.isFinite(n)) ? segments : null,
      prerelease,
    };
  };

  const pa = parse(a);
  const pb = parse(b);
  if (!pa.segments || !pb.segments) {
    return 0;
  }

  const max = Math.max(pa.segments.length, pb.segments.length);
  for (let i = 0; i < max; i += 1) {
    const diff = (pa.segments[i] ?? 0) - (pb.segments[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }

  if (!pa.prerelease && pb.prerelease) {
    return 1;
  }
  if (pa.prerelease && !pb.prerelease) {
    return -1;
  }
  if (pa.prerelease === pb.prerelease) {
    return 0;
  }
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

export function isProductVersionNewer(
  candidate: string | null | undefined,
  baseline: string | null | undefined,
): boolean {
  return compareProductVersions(candidate, baseline) > 0;
}

export function toReleaseTag(version: string): string {
  const bare = normalizeProductVersion(version) ?? version.trim();
  return bare.startsWith('v') ? bare : `v${bare}`;
}
