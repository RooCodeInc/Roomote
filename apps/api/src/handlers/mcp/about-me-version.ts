const PRODUCT_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/i;

export function resolveAboutMeVersion(
  ...versions: Array<string | undefined>
): string | undefined {
  for (const value of versions) {
    const trimmed = value?.trim();
    if (trimmed && PRODUCT_VERSION_PATTERN.test(trimmed)) {
      return `v${trimmed.replace(/^v/i, '')}`;
    }
  }

  return undefined;
}
