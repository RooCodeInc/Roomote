export function normalizeAuthRedirect(
  redirectParam: string | null | undefined,
  currentOrigin: string,
): string | undefined {
  if (!redirectParam) {
    return undefined;
  }

  if (redirectParam.startsWith('/') && !redirectParam.startsWith('//')) {
    return redirectParam;
  }

  if (
    !redirectParam.startsWith('http://') &&
    !redirectParam.startsWith('https://')
  ) {
    return undefined;
  }

  try {
    const parsed = new URL(redirectParam);
    if (parsed.origin !== currentOrigin) {
      return undefined;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}
