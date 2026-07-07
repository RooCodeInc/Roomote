import { afterEach, describe, expect, it } from 'vitest';

import { CONTROL_PLANE_ENV_VAR_NAMES } from '@roomote/types';

import {
  SECRET_NAMES,
  getArtifactSigningKeyPrevious,
  getBetterAuthSecret,
  getDashboardPassword,
  getEncryptionKey,
  getSecretProvider,
  resetSecretProvider,
  setSecretProvider,
  type SecretName,
  type SecretProvider,
} from '../secrets';

function fakeProvider(
  values: Partial<Record<SecretName, string>>,
): SecretProvider {
  return { getSecret: (name) => values[name] };
}

describe('secret provider', () => {
  afterEach(() => {
    resetSecretProvider();
  });

  it('defaults to the environment-backed provider', () => {
    // The env test harness runs with the local development defaults in effect.
    expect(getEncryptionKey()).toBe('local-roomote-encryption-key-0001');
    expect(getDashboardPassword()).toBe('roomote-local-admin');
  });

  it('routes accessors through a swapped-in provider', () => {
    setSecretProvider(
      fakeProvider({
        ENCRYPTION_KEY: 'kms-encryption-key',
        ARTIFACT_SIGNING_KEY: 'kms-artifact-key',
        DASHBOARD_PASSWORD: 'kms-dashboard-password',
      }),
    );

    expect(getEncryptionKey()).toBe('kms-encryption-key');
    expect(getDashboardPassword()).toBe('kms-dashboard-password');
    expect(getArtifactSigningKeyPrevious()).toBeUndefined();
  });

  it('returns the previous artifact signing key when the provider supplies one', () => {
    setSecretProvider(
      fakeProvider({ ARTIFACT_SIGNING_KEY_PREVIOUS: 'rotated-key' }),
    );
    expect(getArtifactSigningKeyPrevious()).toBe('rotated-key');
  });

  it('throws for a required secret the provider cannot resolve', () => {
    setSecretProvider(fakeProvider({}));
    expect(() => getEncryptionKey()).toThrow(
      /ENCRYPTION_KEY is not configured/,
    );
  });

  it('resets back to the default provider', () => {
    setSecretProvider(fakeProvider({ ENCRYPTION_KEY: 'temp' }));
    resetSecretProvider();
    expect(getSecretProvider().getSecret('ENCRYPTION_KEY')).toBe(
      'local-roomote-encryption-key-0001',
    );
  });

  it('prefers a dedicated BETTER_AUTH_SECRET when configured', () => {
    setSecretProvider(
      fakeProvider({
        BETTER_AUTH_SECRET: 'dedicated-auth-secret',
        ENCRYPTION_KEY: 'enc-key',
      }),
    );
    expect(getBetterAuthSecret()).toBe('dedicated-auth-secret');
  });

  it('falls back to ENCRYPTION_KEY when BETTER_AUTH_SECRET is unset', () => {
    setSecretProvider(fakeProvider({ ENCRYPTION_KEY: 'enc-key' }));
    expect(getBetterAuthSecret()).toBe('enc-key');
  });

  it('keeps every named secret in the agent-sandbox denylist', () => {
    // Every secret the secret provider can resolve must also be reserved from
    // the generic environment-variables editor and stripped from the agent
    // sandbox env (CONTROL_PLANE_ENV_VAR_NAMES). Adding a new SecretName without
    // adding it to the denylist would let an operator store it as a generic
    // deployment env var and forward it into task sandboxes.
    for (const name of SECRET_NAMES) {
      expect(CONTROL_PLANE_ENV_VAR_NAMES.has(name), name).toBe(true);
    }
  });
});
