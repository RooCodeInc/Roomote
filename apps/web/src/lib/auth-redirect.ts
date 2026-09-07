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

export function getSafeRedirectUrl(
  rawRedirectUrl: string | null,
  fallback = '/setup',
): string {
  if (
    !rawRedirectUrl?.startsWith('/') ||
    rawRedirectUrl.startsWith('//') ||
    // URL parsers strip control characters; reject them before navigation.
    // eslint-disable-next-line no-control-regex
    /[\\\u0000-\u001f\u007f]/.test(rawRedirectUrl)
  ) {
    return fallback;
  }

  return rawRedirectUrl;
}
