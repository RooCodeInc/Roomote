import type { SetupAuthProviderId, SetupAuthStatus } from '@roomote/types';

import {
  getBootstrapAuthProvider,
  getBootstrapStepFromSetupStepParam,
  getBootstrapStepAfterWelcome,
  getNextBootstrapStep,
  shouldSkipBootstrapAccountStep,
} from './bootstrapFlow';

function buildAuthSetup(
  overrides: Partial<SetupAuthStatus> = {},
): SetupAuthStatus {
  return {
    selectedProvider: null,
    preselectedProvider: 'slack',
    runtimeConfiguredProvider: null,
    runtimeConfiguredProviders: [],
    lockReason: null,
    providers: [],
    setupSatisfiedByRuntimeEnv: false,
    ...overrides,
    managedConnection: overrides.managedConnection ?? null,
  };
}

describe('bootstrapFlow', () => {
  it('routes runtime-configured Slack directly to auth env vars/sign-in', () => {
    const authSetup = buildAuthSetup({
      selectedProvider: 'slack',
      runtimeConfiguredProvider: 'slack',
      runtimeConfiguredProviders: ['slack'],
      lockReason: 'runtime_env',
      setupSatisfiedByRuntimeEnv: true,
    });

    expect(getNextBootstrapStep(authSetup)).toBe('auth-env-vars');
    expect(getBootstrapStepAfterWelcome(authSetup)).toBe('auth-env-vars');
    expect(shouldSkipBootstrapAccountStep(authSetup)).toBe(true);
    expect(getBootstrapAuthProvider(authSetup, null)).toBe('slack');
  });

  it('routes runtime-configured Microsoft Teams directly to auth env vars/sign-in', () => {
    const authSetup = buildAuthSetup({
      selectedProvider: 'microsoft',
      runtimeConfiguredProvider: 'microsoft',
      runtimeConfiguredProviders: ['microsoft'],
      lockReason: 'runtime_env',
      setupSatisfiedByRuntimeEnv: true,
    });

    expect(getNextBootstrapStep(authSetup)).toBe('auth-env-vars');
    expect(getBootstrapStepAfterWelcome(authSetup)).toBe('auth-env-vars');
    expect(shouldSkipBootstrapAccountStep(authSetup)).toBe(true);
    expect(getBootstrapAuthProvider(authSetup, null)).toBe('microsoft');
  });

  it('keeps the chooser when only a saved provider is preselected', () => {
    const authSetup = buildAuthSetup({
      preselectedProvider: 'slack',
    });

    expect(getNextBootstrapStep(authSetup)).toBe('auth-provider');
    expect(getBootstrapStepAfterWelcome(authSetup)).toBe('email-account');
    expect(shouldSkipBootstrapAccountStep(authSetup)).toBe(false);
    expect(getBootstrapAuthProvider(authSetup, null)).toBeNull();
  });

  it('creates the founding Cloud admin with email/password before connecting shared apps', () => {
    const authSetup = buildAuthSetup({
      managedConnection: {
        cloudUrl: 'https://cloud.example',
        deploymentId: 'deployment-1',
        providers: ['slack', 'microsoft'],
      },
    });

    expect(getBootstrapStepAfterWelcome(authSetup)).toBe('email-password');
    expect(shouldSkipBootstrapAccountStep(authSetup)).toBe(false);
  });

  it('skips the chooser when a provider is pending from the account step', () => {
    const authSetup = buildAuthSetup();

    expect(getNextBootstrapStep(authSetup, 'slack')).toBe('auth-env-vars');
    expect(getNextBootstrapStep(authSetup, 'microsoft')).toBe('auth-env-vars');
  });

  it('uses an explicit pending provider before runtime defaults', () => {
    const authSetup = buildAuthSetup({
      selectedProvider: 'slack',
      runtimeConfiguredProvider: 'slack',
      runtimeConfiguredProviders: ['slack'],
      lockReason: 'runtime_env',
    });
    const pendingProvider: SetupAuthProviderId = 'microsoft';

    expect(getBootstrapAuthProvider(authSetup, pendingProvider)).toBe(
      'microsoft',
    );
  });

  it('maps only auth setup query steps into the signed-out bootstrap flow', () => {
    expect(getBootstrapStepFromSetupStepParam('auth-provider')).toBe(
      'auth-provider',
    );
    expect(getBootstrapStepFromSetupStepParam('auth-env-vars')).toBe(
      'auth-env-vars',
    );
    expect(
      getBootstrapStepFromSetupStepParam('source-control-config'),
    ).toBeNull();
    expect(getBootstrapStepFromSetupStepParam(null)).toBeNull();
  });
});
