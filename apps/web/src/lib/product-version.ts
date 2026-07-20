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

function parseProductVersion(value: string): {
  segments: number[] | null;
  prereleaseIds: string[];
} {
  const dashIndex = value.indexOf('-');
  const numeric = dashIndex === -1 ? value : value.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? '' : value.slice(dashIndex + 1);
  const segments = numeric.split('.').map((part) => Number.parseInt(part, 10));

  return {
    segments: segments.every((n) => Number.isFinite(n)) ? segments : null,
    prereleaseIds: prerelease ? prerelease.split('.') : [],
  };
}

/**
 * SemVer 2.0.0 §11 prerelease identifier comparison:
 * numeric identifiers compare as numbers; non-numeric compare as ASCII strings;
 * numeric ranks below non-numeric; a longer equal-prefix set ranks higher.
 */
function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    const normalizedLeft = left.replace(/^0+(?=\d)/, '');
    const normalizedRight = right.replace(/^0+(?=\d)/, '');

    if (normalizedLeft.length !== normalizedRight.length) {
      return normalizedLeft.length < normalizedRight.length ? -1 : 1;
    }
    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft < normalizedRight ? -1 : 1;
    }
    return 0;
  }

  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }

  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function comparePrereleaseSets(left: string[], right: string[]): number {
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const leftId = left[i];
    const rightId = right[i];

    if (leftId === undefined && rightId !== undefined) {
      return -1;
    }
    if (leftId !== undefined && rightId === undefined) {
      return 1;
    }
    if (leftId === undefined || rightId === undefined) {
      return 0;
    }

    const diff = comparePrereleaseIdentifiers(leftId, rightId);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Compare two product versions. Returns negative when `left < right`,
 * positive when `left > right`, and 0 when equal. Plain releases outrank a
 * prerelease on the same numeric version (0.14.1 > 0.14.1-rc.1). Prerelease
 * suffixes follow SemVer identifier rules (e.g. rc.2 < rc.10). Unparsable
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

  const pa = parseProductVersion(a);
  const pb = parseProductVersion(b);
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

  if (pa.prereleaseIds.length === 0 && pb.prereleaseIds.length > 0) {
    return 1;
  }
  if (pa.prereleaseIds.length > 0 && pb.prereleaseIds.length === 0) {
    return -1;
  }

  return comparePrereleaseSets(pa.prereleaseIds, pb.prereleaseIds);
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
