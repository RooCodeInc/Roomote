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
  if (path === '/setup' || path.startsWith('/setup?')) return true;
  const url = new URL(path, 'https://roomote.invalid');
  return (
    /^\/sessions\/[0-9a-f-]+$/i.test(url.pathname) &&
    url.searchParams.get('setup') === 'source-control'
  );
}

export function buildSetupSessionSourceControlReturnTarget(input: {
  sessionId: string;
  provider?: string | null;
}): string {
  const url = new URL(
    `/sessions/${input.sessionId}`,
    'https://roomote.invalid',
  );
  url.searchParams.set('setup', 'source-control');
  if (input.provider) url.searchParams.set('provider', input.provider);
  return `${url.pathname}${url.search}`;
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
  reason?: string | null,
): string {
  const url = new URL(target, 'https://roomote.invalid');
  url.searchParams.set(provider, result);
  if (result === 'error' && reason) {
    url.searchParams.set('reason', reason.slice(0, 500));
  }

  if (isSetupOAuthReturnTarget(target)) {
    url.searchParams.set('sync', '1');
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
