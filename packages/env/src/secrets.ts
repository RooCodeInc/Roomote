import { Env } from './index';

/**
 * Named secrets that back encryption-at-rest, artifact-URL signing, the ops
 * dashboard, and session-cookie signing. Auth-token signing keypairs are
 * resolved separately (see packages/db/src/lib/deployment-auth-keypairs.ts)
 * and are not covered here.
 *
 * Keep this in sync with the control-plane denylist: every name here must also
 * appear in `INSTANCE_SECRET_ENV_VAR_NAMES` (packages/types) so stored
 * deployment env vars cannot leak into the agent sandbox. The "keeps every
 * named secret in the agent-sandbox denylist" test enforces that invariant.
 */
export const SECRET_NAMES = [
  'ENCRYPTION_KEY',
  'ARTIFACT_SIGNING_KEY',
  'ARTIFACT_SIGNING_KEY_PREVIOUS',
  'DASHBOARD_PASSWORD',
  'BETTER_AUTH_SECRET',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * Indirection over secret material so a future backend (AWS KMS, HashiCorp
 * Vault, etc.) can be swapped in without touching call sites.
 *
 * The interface is intentionally synchronous: call sites read secrets on hot
 * paths (decryption, request auth) and cannot await. A remote-backed provider
 * is expected to fetch and cache secrets during boot (alongside the other
 * boot hooks) and then serve them synchronously from memory.
 */
export interface SecretProvider {
  /** The resolved secret value, or `undefined` when it is not configured. */
  getSecret(name: SecretName): string | undefined;
}

/** Default provider: reads secrets from the validated environment. */
class EnvSecretProvider implements SecretProvider {
  getSecret(name: SecretName): string | undefined {
    return Env[name] || undefined;
  }
}

let activeProvider: SecretProvider = new EnvSecretProvider();

/** The active secret provider. */
export function getSecretProvider(): SecretProvider {
  return activeProvider;
}

/**
 * Install a custom secret provider (e.g. a KMS/Vault-backed implementation).
 * Call once during boot, before any secret is read.
 */
export function setSecretProvider(provider: SecretProvider): void {
  activeProvider = provider;
}

/** Reset to the default environment-backed provider (test helper). */
export function resetSecretProvider(): void {
  activeProvider = new EnvSecretProvider();
}

function requireSecret(name: SecretName): string {
  const value = activeProvider.getSecret(name);
  if (!value) {
    throw new Error(`Secret ${name} is not configured`);
  }
  return value;
}

/** Master key for encryption-at-rest of stored secrets and session signing. */
export function getEncryptionKey(): string {
  return requireSecret('ENCRYPTION_KEY');
}

/** Current key for signing artifact download URLs. */
export function getArtifactSigningKey(): string {
  return requireSecret('ARTIFACT_SIGNING_KEY');
}

/** Previous artifact-signing key, if one is configured for rotation. */
export function getArtifactSigningKeyPrevious(): string | undefined {
  return activeProvider.getSecret('ARTIFACT_SIGNING_KEY_PREVIOUS');
}

/** Password for the ops (BullMQ / admin) dashboard basic auth. */
export function getDashboardPassword(): string {
  return requireSecret('DASHBOARD_PASSWORD');
}

/**
 * The dashboard password if one is configured, otherwise `undefined`. Unlike
 * {@link getDashboardPassword} this never throws, so a caller can fail closed
 * (refuse to expose an admin surface) instead of crashing the process when the
 * password is unset.
 */
export function resolveDashboardPassword(): string | undefined {
  return activeProvider.getSecret('DASHBOARD_PASSWORD') || undefined;
}

/**
 * Secret used to sign Better Auth session cookies. Prefers a dedicated
 * `BETTER_AUTH_SECRET` so the session-signing key is separated from the at-rest
 * `ENCRYPTION_KEY` (which also protects the deployment secret vault). Falls back
 * to `ENCRYPTION_KEY` for backward compatibility with deployments that have not
 * set a dedicated secret; setting `BETTER_AUTH_SECRET` later rotates the signing
 * key and invalidates existing sessions.
 */
export function getBetterAuthSecret(): string {
  return activeProvider.getSecret('BETTER_AUTH_SECRET') || getEncryptionKey();
}
