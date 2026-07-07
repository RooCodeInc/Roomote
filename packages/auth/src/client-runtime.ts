import { Env } from '@roomote/env';

interface AuthClientEnvOverrides {
  nodeEnv?: string;
  jobAuthPrivateKey?: string;
  jobAuthPublicKey?: string;
  previewAuthPrivateKey?: string;
  previewAuthPublicKey?: string;
  sandboxOidcPrivateKey?: string;
  sandboxOidcPublicKey?: string;
  sandboxOidcPublicKeySecondary?: string;
}

let authClientEnvOverrides: AuthClientEnvOverrides | null = null;

/**
 * Override auth runtime inputs for long-lived runtimes that either scrub
 * secrets from `process.env` after boot or resolve env values outside the
 * shared `@roomote/env` singleton.
 *
 * The worker uses this to keep in-process token validation working after it
 * removes launcher-provided public keys from `process.env` so child processes
 * do not inherit them accidentally.
 */
export function configureAuthClientEnv(
  overrides: AuthClientEnvOverrides | null,
): void {
  authClientEnvOverrides = overrides ? { ...overrides } : null;
}

function getConfiguredValue({
  key,
  override,
  fallback,
}: {
  key: string;
  override?: string;
  fallback?: string;
}): string {
  const value = override?.trim() || fallback?.trim();

  if (!value) {
    throw new Error(`${key} is not configured for the auth runtime.`);
  }

  return value;
}

export function getJobAuthPrivateKey(): string {
  return getConfiguredValue({
    key: 'JOB_AUTH_PRIVATE_KEY',
    override: authClientEnvOverrides?.jobAuthPrivateKey,
    fallback: Env.JOB_AUTH_PRIVATE_KEY,
  });
}

export function getJobAuthPublicKey(): string {
  return getConfiguredValue({
    key: 'JOB_AUTH_PUBLIC_KEY',
    override: authClientEnvOverrides?.jobAuthPublicKey,
    fallback: Env.JOB_AUTH_PUBLIC_KEY,
  });
}

export function getPreviewAuthPrivateKey(): string {
  return getConfiguredValue({
    key: 'PREVIEW_AUTH_PRIVATE_KEY',
    override: authClientEnvOverrides?.previewAuthPrivateKey,
    fallback: Env.PREVIEW_AUTH_PRIVATE_KEY,
  });
}

export function getPreviewAuthPublicKey(): string {
  return getConfiguredValue({
    key: 'PREVIEW_AUTH_PUBLIC_KEY',
    override: authClientEnvOverrides?.previewAuthPublicKey,
    fallback: Env.PREVIEW_AUTH_PUBLIC_KEY,
  });
}

export function isAuthClientTestEnv(): boolean {
  return (authClientEnvOverrides?.nodeEnv ?? Env.NODE_ENV) === 'test';
}

export function getSandboxOidcPrivateKey(): string {
  return getConfiguredValue({
    key: 'SANDBOX_OIDC_PRIVATE_KEY',
    override: authClientEnvOverrides?.sandboxOidcPrivateKey,
    fallback: Env.SANDBOX_OIDC_PRIVATE_KEY,
  });
}

export function getSandboxOidcPublicKey(): string {
  return getConfiguredValue({
    key: 'SANDBOX_OIDC_PUBLIC_KEY',
    override: authClientEnvOverrides?.sandboxOidcPublicKey,
    fallback: Env.SANDBOX_OIDC_PUBLIC_KEY,
  });
}

export function getSandboxOidcSecondaryPublicKey(): string | undefined {
  return (
    authClientEnvOverrides?.sandboxOidcPublicKeySecondary?.trim() ||
    Env.SANDBOX_OIDC_PUBLIC_KEY_SECONDARY?.trim() ||
    undefined
  );
}
