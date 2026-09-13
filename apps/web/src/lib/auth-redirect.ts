const AUTH_REDIRECT_BASE_URL = 'https://roomote.local';

export function getSafeSignInRedirectPath(
  redirectParam: string | string[] | null | undefined,
  fallback: string,
): string {
  const redirectPath = Array.isArray(redirectParam)
    ? redirectParam[0]
    : redirectParam;

  if (
    !redirectPath ||
    !redirectPath.startsWith('/') ||
    redirectPath.startsWith('//')
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(redirectPath, AUTH_REDIRECT_BASE_URL);
    if (
      parsed.origin !== AUTH_REDIRECT_BASE_URL ||
      parsed.pathname === '/sign-in' ||
      parsed.pathname.startsWith('/sign-in/')
    ) {
      return fallback;
    }
  } catch {
    return fallback;
  }

  return redirectPath;
}

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
