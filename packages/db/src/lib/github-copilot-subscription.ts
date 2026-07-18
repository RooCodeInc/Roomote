import { sql } from 'drizzle-orm';

import {
  GITHUB_COPILOT_ACCESS_TOKEN_ENDPOINT,
  GITHUB_COPILOT_DEVICE_CODE_ENDPOINT,
  GITHUB_COPILOT_DEVICE_VERIFICATION_URL,
  DEFAULT_GITHUB_COPILOT_OAUTH_CLIENT_ID,
  GITHUB_COPILOT_OAUTH_CLIENT_ID_ENV_VAR_NAME,
  GITHUB_COPILOT_OPENCODE_PROVIDER_ID,
  GITHUB_COPILOT_POLL_SLOW_DOWN_MS,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { decryptSecrets, encryptJSON } from '../encryption';
import { deploymentSecrets } from '../schema';

const GITHUB_COPILOT_SUBSCRIPTION_SECRET_NAME =
  'GITHUB_COPILOT_SUBSCRIPTION_OAUTH';

export type GitHubCopilotSubscriptionStatusValue =
  | 'connected'
  | 'error'
  | 'disconnected';

export interface GitHubCopilotSubscriptionRecord {
  access: string;
  status: GitHubCopilotSubscriptionStatusValue;
  error?: string;
  connectedAt: string;
  updatedAt: string;
}

export interface GitHubCopilotSubscriptionPublicStatus {
  connected: boolean;
  status: GitHubCopilotSubscriptionStatusValue;
  error?: string;
  connectedAt?: string;
  updatedAt?: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  interval?: number;
  expires_in?: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export function resolveGitHubCopilotOAuthClientId(
  runtimeEnv: Partial<Record<string, string | undefined>> = process.env,
): string {
  return (
    runtimeEnv[GITHUB_COPILOT_OAUTH_CLIENT_ID_ENV_VAR_NAME]?.trim() ||
    DEFAULT_GITHUB_COPILOT_OAUTH_CLIENT_ID
  );
}

async function loadRecord(
  executor: DatabaseOrTransaction = db,
): Promise<GitHubCopilotSubscriptionRecord | null> {
  const [row] = await executor
    .select({ value: deploymentSecrets.value })
    .from(deploymentSecrets)
    .where(
      sql`${deploymentSecrets.name} = ${GITHUB_COPILOT_SUBSCRIPTION_SECRET_NAME}`,
    )
    .limit(1);

  return row
    ? decryptSecrets<GitHubCopilotSubscriptionRecord>(row.value)
    : null;
}

async function persistRecord(
  executor: DatabaseOrTransaction,
  record: GitHubCopilotSubscriptionRecord,
): Promise<void> {
  const encrypted = encryptJSON(record);

  await executor
    .insert(deploymentSecrets)
    .values({
      name: GITHUB_COPILOT_SUBSCRIPTION_SECRET_NAME,
      value: encrypted,
    })
    .onConflictDoUpdate({
      target: deploymentSecrets.name,
      set: { value: encrypted, updatedAt: new Date() },
    });
}

export async function getGitHubCopilotSubscriptionStatus(
  executor: DatabaseOrTransaction = db,
): Promise<GitHubCopilotSubscriptionPublicStatus> {
  const record = await loadRecord(executor);

  if (!record) return { connected: false, status: 'disconnected' };

  return {
    connected: record.status === 'connected',
    status: record.status,
    ...(record.error && { error: record.error }),
    connectedAt: record.connectedAt,
    updatedAt: record.updatedAt,
  };
}

export async function isGitHubCopilotSubscriptionConnected(
  executor: DatabaseOrTransaction = db,
): Promise<boolean> {
  const record = await loadRecord(executor);
  return record?.status === 'connected';
}

export async function getGitHubCopilotAccessToken(
  executor: DatabaseOrTransaction = db,
): Promise<string | null> {
  const record = await loadRecord(executor);
  return record?.status === 'connected' ? record.access : null;
}

export async function resolveGitHubCopilotOpenCodeAuthContent(
  executor: DatabaseOrTransaction = db,
): Promise<string | null> {
  const access = await getGitHubCopilotAccessToken(executor);
  return access
    ? JSON.stringify({
        [GITHUB_COPILOT_OPENCODE_PROVIDER_ID]: {
          type: 'oauth',
          refresh: access,
          access,
          expires: 0,
        },
      })
    : null;
}

export async function disconnectGitHubCopilotSubscription(
  executor: DatabaseOrTransaction = db,
): Promise<void> {
  await executor
    .delete(deploymentSecrets)
    .where(
      sql`${deploymentSecrets.name} = ${GITHUB_COPILOT_SUBSCRIPTION_SECRET_NAME}`,
    );
}

export async function startGitHubCopilotDeviceAuth(
  fetchImpl: typeof fetch = fetch,
): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresInMs: number;
}> {
  const clientId = resolveGitHubCopilotOAuthClientId();
  const response = await fetchImpl(GITHUB_COPILOT_DEVICE_CODE_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'roomote',
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: 'read:user',
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to initiate GitHub Copilot authorization: ${response.status}`,
    );
  }

  const data = (await response.json()) as DeviceCodeResponse;

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl:
      data.verification_uri ?? GITHUB_COPILOT_DEVICE_VERIFICATION_URL,
    intervalMs: Math.max(data.interval ?? 5, 1) * 1000,
    expiresInMs: Math.max(data.expires_in ?? 900, 1) * 1000,
  };
}

export type GitHubCopilotDevicePollResult =
  | { status: 'pending'; intervalMs?: number }
  | { status: 'success' }
  | { status: 'failed'; error: string };

export async function pollGitHubCopilotDeviceAuth(
  input: { deviceCode: string },
  options: {
    executor?: DatabaseOrTransaction;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GitHubCopilotDevicePollResult> {
  const executor = options.executor ?? db;
  const fetchImpl = options.fetchImpl ?? fetch;
  const clientId = resolveGitHubCopilotOAuthClientId();
  const response = await fetchImpl(GITHUB_COPILOT_ACCESS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'roomote',
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: input.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  if (!response.ok) {
    return {
      status: 'failed',
      error: `GitHub Copilot authorization failed: ${response.status}`,
    };
  }

  const data = (await response.json()) as AccessTokenResponse;

  if (data.access_token) {
    const now = new Date().toISOString();
    await persistRecord(executor, {
      access: data.access_token,
      status: 'connected',
      connectedAt: now,
      updatedAt: now,
    });
    return { status: 'success' };
  }

  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') {
    return {
      status: 'pending',
      intervalMs:
        typeof data.interval === 'number' && data.interval > 0
          ? data.interval * 1000
          : GITHUB_COPILOT_POLL_SLOW_DOWN_MS,
    };
  }

  return {
    status: 'failed',
    error:
      data.error_description ??
      (data.error
        ? `GitHub Copilot authorization failed: ${data.error}`
        : 'GitHub Copilot authorization returned no access token.'),
  };
}

export const GITHUB_COPILOT_SUBSCRIPTION_INTERNAL = {
  secretName: GITHUB_COPILOT_SUBSCRIPTION_SECRET_NAME,
};
