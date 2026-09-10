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

export function buildRoomoteReleaseIdentifier(
  releaseVersion: string | undefined,
  { commitSha, appEnv }: { commitSha?: string; appEnv?: string } = {},
): string | null {
  if (!releaseVersion) return null;

  const sha = commitSha?.trim();
  const commit = sha && /^[a-f0-9]{40}$/i.test(sha) ? sha : 'unknown';
  const environment =
    appEnv === 'production'
      ? 'prod'
      : appEnv === 'development' || appEnv === 'preview'
        ? 'dev'
        : undefined;

  return `Roomote release ${releaseVersion} (${environment ? `${environment}, ` : ''}commit ${commit})`;
}
