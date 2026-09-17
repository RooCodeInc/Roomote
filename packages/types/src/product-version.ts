/** Helpers for Roomote's single monorepo product version. */
export function normalizeProductVersion(
  version: string | null | undefined,
): string | null {
  if (typeof version !== 'string') return null;

  const trimmed = version.trim();
  return trimmed ? trimmed.replace(/^v/i, '') : null;
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
    segments: segments.every((segment) => Number.isFinite(segment))
      ? segments
      : null,
    prereleaseIds: prerelease ? prerelease.split('.') : [],
  };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    const normalizedLeft = left.replace(/^0+(?=\d)/, '');
    const normalizedRight = right.replace(/^0+(?=\d)/, '');
    if (normalizedLeft.length !== normalizedRight.length) {
      return normalizedLeft.length < normalizedRight.length ? -1 : 1;
    }
    return normalizedLeft === normalizedRight
      ? 0
      : normalizedLeft < normalizedRight
        ? -1
        : 1;
  }

  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrereleaseSets(left: string[], right: string[]): number {
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const leftId = left[index];
    const rightId = right[index];
    if (leftId === undefined) return rightId === undefined ? 0 : -1;
    if (rightId === undefined) return 1;

    const diff = comparePrereleaseIdentifiers(leftId, rightId);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function compareProductVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const a = normalizeProductVersion(left);
  const b = normalizeProductVersion(right);
  if (!a || !b) return 0;

  const parsedA = parseProductVersion(a);
  const parsedB = parseProductVersion(b);
  if (!parsedA.segments || !parsedB.segments) return 0;

  const max = Math.max(parsedA.segments.length, parsedB.segments.length);
  for (let index = 0; index < max; index += 1) {
    const diff =
      (parsedA.segments[index] ?? 0) - (parsedB.segments[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  if (parsedA.prereleaseIds.length === 0 && parsedB.prereleaseIds.length > 0) {
    return 1;
  }
  if (parsedA.prereleaseIds.length > 0 && parsedB.prereleaseIds.length === 0) {
    return -1;
  }
  return comparePrereleaseSets(parsedA.prereleaseIds, parsedB.prereleaseIds);
}

export function isParsableProductVersion(
  version: string | null | undefined,
): boolean {
  const normalized = normalizeProductVersion(version);
  return Boolean(normalized && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(normalized));
}

export function isProductVersionNewer(
  candidate: string | null | undefined,
  baseline: string | null | undefined,
): boolean {
  return compareProductVersions(candidate, baseline) > 0;
}

export function toReleaseTag(version: string): string {
  return `v${normalizeProductVersion(version) ?? version.trim()}`;
}
