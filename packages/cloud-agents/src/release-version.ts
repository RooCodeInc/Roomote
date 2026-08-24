const PRODUCT_VERSION_PATTERN =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function resolveRoomoteReleaseVersion(
  ...versions: Array<string | undefined>
): string | undefined {
  for (const value of versions) {
    const trimmed = value?.trim();
    if (trimmed && PRODUCT_VERSION_PATTERN.test(trimmed)) {
      return trimmed.replace(/^v/i, '');
    }
  }

  return undefined;
}
