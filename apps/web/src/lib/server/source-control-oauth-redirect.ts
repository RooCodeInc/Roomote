export const SOURCE_CONTROL_SETTINGS_PATH = '/settings/source-control';
export const SOURCE_CONTROL_SETUP_PATH = '/setup?step=source-control-connect';
export const SOURCE_CONTROL_OAUTH_COOKIE_MAX_AGE = 600;

type SourceControlOAuthProvider = 'gitlab' | 'gitea' | 'bitbucket';

export function getSourceControlOAuthReturnCookieName(
  provider: SourceControlOAuthProvider,
): string {
  return `roomote-${provider}-oauth-return-to`;
}

export function normalizeSourceControlOAuthReturnTarget(
  value: string | null | undefined,
): string | null {
  const target = value?.trim();
  if (
    !target ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.includes('://')
  ) {
    return null;
  }

  return target;
}

function isSetupPath(path: string): boolean {
  return path === '/setup' || path.startsWith('/setup?');
}

export function resolveSourceControlOAuthReturnTarget({
  requestedTarget,
  setupOpen,
}: {
  requestedTarget?: string | null;
  setupOpen: boolean;
}): string {
  const fallback = setupOpen
    ? SOURCE_CONTROL_SETUP_PATH
    : SOURCE_CONTROL_SETTINGS_PATH;
  const target =
    normalizeSourceControlOAuthReturnTarget(requestedTarget) ?? fallback;

  // A setup-originated OAuth flow can outlive setup completion in another tab
  // or while the provider is open. Never re-enter the completed setup wizard.
  return !setupOpen && isSetupPath(target)
    ? SOURCE_CONTROL_SETTINGS_PATH
    : target;
}

export function isSetupOAuthReturnTarget(path: string): boolean {
  return isSetupPath(path);
}

export function addSourceControlOAuthResult(
  target: string,
  provider: SourceControlOAuthProvider,
  result: 'connected' | 'error',
): string {
  const url = new URL(target, 'https://roomote.invalid');
  url.searchParams.set(provider, result);

  if (isSetupOAuthReturnTarget(target)) {
    url.searchParams.set('sync', '1');
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
