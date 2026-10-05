import {
  Env,
  isEmailChannelEnabled,
  isRoomoteCloudEnabled,
} from '@roomote/env';

import { getEnvLicenseKey } from './deployment-license';
import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';

export type AgentMailRuntimeCredentials = {
  apiKey: string | null;
  webhookSecret: string | null;
  inboxId: string | null;
};

const CACHE_TTL_MS = 30_000;
const CLOUD_READ_TIMEOUT_MS = 5_000;
// Allocation creates the inbox, its key, and its webhook at AgentMail.
const CLOUD_ALLOCATE_TIMEOUT_MS = 45_000;
// A failed allocation is not retried by every send in a burst.
const CLOUD_ALLOCATE_RETRY_AFTER_MS = 15_000;

let cachedCredentials: {
  value: AgentMailRuntimeCredentials;
  expiresAtMs: number;
} | null = null;
let allocation: Promise<AgentMailRuntimeCredentials | null> | null = null;
let allocateRetryAfterMs = 0;

function normalizeInboxId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function readProcessEnvCredentials(): AgentMailRuntimeCredentials {
  return {
    apiKey: process.env.R_AGENTMAIL_API_KEY?.trim() || null,
    webhookSecret: process.env.R_AGENTMAIL_WEBHOOK_SECRET?.trim() || null,
    inboxId: normalizeInboxId(process.env.R_AGENTMAIL_INBOX_ID),
  };
}

function isComplete(credentials: AgentMailRuntimeCredentials): boolean {
  return Boolean(
    credentials.apiKey && credentials.inboxId && credentials.webhookSecret,
  );
}

/**
 * Whether Roomote Cloud hands this deployment its email inbox on demand.
 * Cloud turns the channel on for its tenants without allocating an inbox
 * until one is needed; the tenant then asks Cloud for it with its
 * Cloud-issued license.
 */
export function isAgentMailCloudManaged(): boolean {
  return (
    isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED) &&
    isEmailChannelEnabled() &&
    Boolean(getEnvLicenseKey())
  );
}

async function requestCloudManagedCredentials(
  allocate: boolean,
): Promise<AgentMailRuntimeCredentials | null> {
  const licenseKey = getEnvLicenseKey();
  if (!licenseKey) return null;
  const baseUrl = Env.R_LICENSE_CLOUD_BASE_URL.replace(/\/+$/, '');
  try {
    const response = await fetch(
      `${baseUrl}/api/v1/managed-email/credentials`,
      {
        method: 'POST',
        headers: {
          Authorization: `License ${licenseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ allocate }),
        signal: AbortSignal.timeout(
          allocate ? CLOUD_ALLOCATE_TIMEOUT_MS : CLOUD_READ_TIMEOUT_MS,
        ),
      },
    );
    // Not allocated yet (a read) or not eligible: nothing to use.
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(
        `[agentmail] Roomote Cloud could not provide email credentials (status ${response.status}, allocate=${allocate}).`,
      );
      return null;
    }
    const body = (await response.json()) as Record<string, unknown>;
    const credentials: AgentMailRuntimeCredentials = {
      apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : null,
      inboxId:
        typeof body.inboxId === 'string'
          ? normalizeInboxId(body.inboxId)
          : null,
      webhookSecret:
        typeof body.webhookSecret === 'string'
          ? body.webhookSecret.trim()
          : null,
    };
    return isComplete(credentials) ? credentials : null;
  } catch (error) {
    console.warn(
      `[agentmail] Roomote Cloud email credential request failed (allocate=${allocate}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** One allocation per process at a time; concurrent sends share it. */
function allocateCloudManagedCredentials(): Promise<AgentMailRuntimeCredentials | null> {
  if (Date.now() < allocateRetryAfterMs) return Promise.resolve(null);
  allocation ??= requestCloudManagedCredentials(true)
    .then((credentials) => {
      if (!credentials) {
        allocateRetryAfterMs = Date.now() + CLOUD_ALLOCATE_RETRY_AFTER_MS;
      }
      return credentials;
    })
    .finally(() => {
      allocation = null;
    });
  return allocation;
}

/**
 * Resolve the AgentMail credentials the way operators configure them: real
 * environment variables always win, and values saved from the comms settings
 * UI (encrypted deployment env vars) fill any gaps. On a Cloud deployment
 * whose inbox is allocated on demand, Cloud supplies them instead: `allocate`
 * (a send that is about to happen) creates the inbox if the deployment has
 * none yet, while plain reads never do. Resolved values are cached briefly
 * so webhook-path callers do not hit the database or Cloud on every call.
 */
export async function resolveAgentMailRuntimeCredentials(options?: {
  allocate?: boolean;
}): Promise<AgentMailRuntimeCredentials> {
  const fromEnv = readProcessEnvCredentials();

  const nowMs = Date.now();

  if (
    cachedCredentials &&
    cachedCredentials.expiresAtMs > nowMs &&
    (!options?.allocate || isComplete(cachedCredentials.value))
  ) {
    return cachedCredentials.value;
  }

  const deploymentEnvVars = isComplete(fromEnv)
    ? {}
    : await resolveEffectiveDeploymentEnvVars();
  let value: AgentMailRuntimeCredentials = {
    apiKey:
      fromEnv.apiKey || deploymentEnvVars.R_AGENTMAIL_API_KEY?.trim() || null,
    webhookSecret:
      fromEnv.webhookSecret ||
      deploymentEnvVars.R_AGENTMAIL_WEBHOOK_SECRET?.trim() ||
      null,
    inboxId:
      fromEnv.inboxId ||
      normalizeInboxId(deploymentEnvVars.R_AGENTMAIL_INBOX_ID),
  };

  if (!isComplete(value) && isAgentMailCloudManaged()) {
    const fromCloud = options?.allocate
      ? await allocateCloudManagedCredentials()
      : await requestCloudManagedCredentials(false);
    // Cloud's set is whole; never mix it with a partial local one.
    if (fromCloud) {
      value = fromCloud;
    }
  }

  cachedCredentials = { value, expiresAtMs: Date.now() + CACHE_TTL_MS };

  return value;
}

/**
 * Whether email could be sent right now, counting an inbox Cloud would
 * allocate on the first send. For availability checks, which must not
 * allocate on their own.
 */
export async function canSendAgentMailWithRuntimeCredentials(): Promise<boolean> {
  if (isAgentMailCloudManaged()) {
    return true;
  }
  const credentials = await resolveAgentMailRuntimeCredentials();
  return Boolean(credentials.apiKey && credentials.inboxId);
}

/** Drop the cached credentials, e.g. right after the settings UI saves. */
export function invalidateAgentMailRuntimeCredentialsCache(): void {
  cachedCredentials = null;
  allocateRetryAfterMs = 0;
}
