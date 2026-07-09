type SetupGuardStatus = {
  hasGitHub?: boolean;
  hasEnvironments?: boolean;
  setupCompletedAt?: Date | string | null;
};

export const DEFAULT_SETUP_REDIRECT_PATH = '/setup?step=welcome';

export function getSetupRedirectPath(
  status: SetupGuardStatus | undefined,
): string | null {
  if (status?.setupCompletedAt == null) {
    return DEFAULT_SETUP_REDIRECT_PATH;
  }

  if (!status?.hasGitHub) {
    return DEFAULT_SETUP_REDIRECT_PATH;
  }

  return null;
}

export function requiresSetup(status: SetupGuardStatus | undefined): boolean {
  return getSetupRedirectPath(status) !== null;
}
