import type { SetupAuthProviderId, SetupAuthStatus } from '@roomote/types';

export type BootstrapStep =
  | 'welcome'
  | 'email-account'
  | 'email-password'
  | 'auth-provider'
  | 'auth-env-vars';

type BootstrapAuthSetupStep = Extract<
  BootstrapStep,
  'auth-provider' | 'auth-env-vars'
>;

export function getBootstrapAuthProvider(
  authSetup: SetupAuthStatus | null | undefined,
  pendingAuthProvider: SetupAuthProviderId | null,
): SetupAuthProviderId | null {
  return (
    pendingAuthProvider ??
    authSetup?.runtimeConfiguredProvider ??
    authSetup?.selectedProvider ??
    null
  );
}

export function getBootstrapStepFromSetupStepParam(
  step: string | null,
): BootstrapStep | null {
  return step === 'auth-provider' || step === 'auth-env-vars' ? step : null;
}

export function getNextBootstrapStep(
  authSetup: SetupAuthStatus | null | undefined,
  pendingAuthProvider?: SetupAuthProviderId | null,
): BootstrapAuthSetupStep {
  if (authSetup?.lockReason === 'runtime_env') {
    return 'auth-env-vars';
  }

  if (authSetup?.selectedProvider || pendingAuthProvider) {
    return 'auth-env-vars';
  }

  return 'auth-provider';
}

export function shouldSkipBootstrapAccountStep(
  authSetup: SetupAuthStatus | null | undefined,
) {
  return (
    authSetup?.lockReason === 'runtime_env' &&
    (authSetup.runtimeConfiguredProvider === 'slack' ||
      authSetup.runtimeConfiguredProvider === 'microsoft')
  );
}

export function getBootstrapStepAfterWelcome(
  authSetup: SetupAuthStatus | null | undefined,
): Exclude<BootstrapStep, 'welcome'> {
  // Shared Cloud apps connect after an account exists. They intentionally do
  // not expose provider secrets to the tenant, so the founding admin needs a
  // local account before the managed Slack/Teams handoff can begin.
  if (authSetup?.managedConnection) {
    return 'email-password';
  }

  if (shouldSkipBootstrapAccountStep(authSetup)) {
    return getNextBootstrapStep(authSetup);
  }

  return 'email-account';
}
