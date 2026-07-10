import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';

const CACHE_TTL_MS = 30_000;

let cachedSigningSecret: {
  value: string | null;
  expiresAtMs: number;
} | null = null;

/**
 * Resolve the Slack signing secret the way operators configure it: the real
 * environment variable wins, and a value saved from the comms settings UI
 * (encrypted deployment env var) fills the gap. Cached briefly so the
 * webhook verification path does not hit the database on every event.
 */
export async function resolveSlackSigningSecret(): Promise<string | null> {
  const fromEnv = process.env.R_SLACK_SIGNING_SECRET?.trim();

  if (fromEnv) {
    return fromEnv;
  }

  const nowMs = Date.now();

  if (cachedSigningSecret && cachedSigningSecret.expiresAtMs > nowMs) {
    return cachedSigningSecret.value;
  }

  const deploymentEnvVars = await resolveEffectiveDeploymentEnvVars();
  const value = deploymentEnvVars.R_SLACK_SIGNING_SECRET?.trim() || null;

  cachedSigningSecret = { value, expiresAtMs: nowMs + CACHE_TTL_MS };

  return value;
}

/** Drop the cached secret, e.g. right after the settings UI saves. */
export function invalidateSlackSigningSecretCache(): void {
  cachedSigningSecret = null;
}
