import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';

export type AgentMailRuntimeCredentials = {
  apiKey: string | null;
  webhookSecret: string | null;
  inboxId: string | null;
  /**
   * AgentMail pod the inbox lives in, when the deployment was set up with a
   * pod-scoped key (or asked to keep its resources inside a pod). Null means
   * organization-level resources.
   */
  podId: string | null;
  /**
   * Whether the API key is an inbox-scoped key. Inbox-scoped keys manage the
   * webhook through the inbox's own endpoints; detected at save time and
   * persisted so status and disconnect use the same endpoints.
   */
  keyScope: AgentMailKeyScope;
};

export type AgentMailKeyScope = 'organization' | 'inbox';

function normalizeKeyScope(
  value: string | null | undefined,
): AgentMailKeyScope {
  return value?.trim().toLowerCase() === 'inbox' ? 'inbox' : 'organization';
}

const CACHE_TTL_MS = 30_000;

let cachedCredentials: {
  value: AgentMailRuntimeCredentials;
  expiresAtMs: number;
} | null = null;

function normalizeInboxId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function readProcessEnvCredentials(): AgentMailRuntimeCredentials {
  return {
    apiKey: process.env.R_AGENTMAIL_API_KEY?.trim() || null,
    webhookSecret: process.env.R_AGENTMAIL_WEBHOOK_SECRET?.trim() || null,
    inboxId: normalizeInboxId(process.env.R_AGENTMAIL_INBOX_ID),
    podId: process.env.R_AGENTMAIL_POD_ID?.trim() || null,
    keyScope: normalizeKeyScope(process.env.R_AGENTMAIL_KEY_SCOPE),
  };
}

/**
 * Resolve the AgentMail credentials the way operators configure them: real
 * environment variables always win, and values saved from the comms settings
 * UI (encrypted deployment env vars) fill any gaps. Resolved values are cached
 * briefly so webhook-path callers do not hit the database on every delivery.
 */
export async function resolveAgentMailRuntimeCredentials(): Promise<AgentMailRuntimeCredentials> {
  const fromEnv = readProcessEnvCredentials();

  const nowMs = Date.now();

  if (cachedCredentials && cachedCredentials.expiresAtMs > nowMs) {
    return cachedCredentials.value;
  }

  const deploymentEnvVars =
    fromEnv.apiKey && fromEnv.webhookSecret && fromEnv.inboxId && fromEnv.podId
      ? {}
      : await resolveEffectiveDeploymentEnvVars();
  const value: AgentMailRuntimeCredentials = {
    apiKey:
      fromEnv.apiKey || deploymentEnvVars.R_AGENTMAIL_API_KEY?.trim() || null,
    webhookSecret:
      fromEnv.webhookSecret ||
      deploymentEnvVars.R_AGENTMAIL_WEBHOOK_SECRET?.trim() ||
      null,
    inboxId:
      fromEnv.inboxId ||
      normalizeInboxId(deploymentEnvVars.R_AGENTMAIL_INBOX_ID),
    podId:
      fromEnv.podId || deploymentEnvVars.R_AGENTMAIL_POD_ID?.trim() || null,
    keyScope: process.env.R_AGENTMAIL_KEY_SCOPE?.trim()
      ? fromEnv.keyScope
      : normalizeKeyScope(deploymentEnvVars.R_AGENTMAIL_KEY_SCOPE),
  };

  cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };

  return value;
}

/** Drop the cached credentials, e.g. right after the settings UI saves. */
export function invalidateAgentMailRuntimeCredentialsCache(): void {
  cachedCredentials = null;
}
