type SetupGuardStatus = {
  hasGitHub?: boolean;
  hasEnvironments?: boolean;
  setupCompletedAt?: Date | string | null;
};

export function getSetupRedirectPath(
  status: SetupGuardStatus | undefined,
): string | null {
  // setupCompletedAt is the completion signal. Requiring a GitHub
  // installation here would permanently bounce GitLab/Gitea/ADO-only
  // deployments back into setup; the setup flow itself gates source-control
  // connection before completion.
  if (status?.setupCompletedAt == null) {
    return '/setup';
  }

  return null;
}

export function requiresSetup(status: SetupGuardStatus | undefined): boolean {
  return getSetupRedirectPath(status) !== null;
}
