type SetupGuardStatus = {
  hasGitHub?: boolean;
  hasEnvironments?: boolean;
  setupCompletedAt?: Date | string | null;
};

export function getSetupRedirectPath(
  status: SetupGuardStatus | undefined,
): string | null {
  if (status?.setupCompletedAt == null) {
    return '/setup';
  }

  if (!status?.hasGitHub) {
    return '/setup';
  }

  return null;
}

export function requiresSetup(status: SetupGuardStatus | undefined): boolean {
  return getSetupRedirectPath(status) !== null;
}
