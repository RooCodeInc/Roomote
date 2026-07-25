import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  DEFAULT_XAI_OAUTH_CLIENT_ID,
  XAI_DEFAULT_ACCESS_TOKEN_TTL_MS,
  XAI_OAUTH_CLIENT_ID_ENV_VAR_NAME,
  XAI_OAUTH_DEVICE_CODE_ENDPOINT,
  XAI_OAUTH_DEVICE_VERIFICATION_URL,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_TOKEN_ENDPOINT,
  XAI_OPENCODE_PROVIDER_ID,
  XAI_POLL_SLOW_DOWN_MS,
  XAI_REFRESH_SAFETY_MARGIN_MS,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { decryptSecrets, encryptJSON } from '../encryption';
import { deploymentSecrets } from '../schema';

/**
 * Server-side lifecycle for the deployment-wide xAI Grok subscription OAuth
 * credential. Roomote owns token refresh; the inference gateway mints a fresh
 * access token per request so the OAuth record never enters sandboxes.
 */

const XAI_SUBSCRIPTION_SECRET_NAME = 'XAI_SUBSCRIPTION_OAUTH';
const XAI_SUBSCRIPTION_PENDING_SECRET_NAME = 'XAI_SUBSCRIPTION_PENDING_DEVICE';
const XAI_SUBSCRIPTION_ADVISORY_LOCK_KEY = 'roomote-xai-subscription-refresh';
const XAI_SUBSCRIPTION_DEVICE_LOCK_KEY = 'roomote-xai-subscription-device';

/**
 * Tracks the single deployment-wide device-code flow that is allowed to
 * persist tokens. A newer start supersedes older codes so an in-flight poll
 * from a cancelled/restarted dialog cannot overwrite the active connection.
 *
 * `claimId` is reserved before the device-code HTTP call so a slower earlier
 * start cannot register after a newer start. `deviceCode` is set only after
 * that HTTP call completes while the claim is still current.
 */
interface XaiPendingDeviceFlow {
  claimId: string;
  /** Set after the device-code endpoint returns for the active claim. */
  deviceCode?: string;
  /** Epoch milliseconds when the device code expires. */
  expiresAt: number;
  startedAt: string;
}

const SUPERSEDED_DEVICE_FLOW_ERROR =
  'This xAI device authorization is no longer active. Restart the connection.';

export type XaiSubscriptionStatusValue = 'connected' | 'error' | 'disconnected';

export interface XaiSubscriptionRecord {
  refresh: string;
  access: string;
  /** Epoch milliseconds when the access token expires. */
  expires: number;
  email?: string;
  status: XaiSubscriptionStatusValue;
  /** Last refresh/connect error message, populated when status is 'error'. */
  error?: string;
  connectedAt: string;
  updatedAt: string;
}

/**
 * Public, token-free status for the Settings UI. Never includes `refresh` or
 * `access`.
 */
export interface XaiSubscriptionPublicStatus {
  connected: boolean;
  status: XaiSubscriptionStatusValue;
  email?: string;
  error?: string;
  connectedAt?: string;
  updatedAt?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

interface IdTokenClaims {
  email?: string;
}

export function resolveXaiOAuthClientId(
  runtimeEnv: Partial<Record<string, string | undefined>> = process.env,
): string {
  return (
    runtimeEnv[XAI_OAUTH_CLIENT_ID_ENV_VAR_NAME]?.trim() ||
    DEFAULT_XAI_OAUTH_CLIENT_ID
  );
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
    ) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

function extractEmailFromTokens(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    if (claims?.email) {
      return claims.email;
    }
  }
  return undefined;
}

function resolveAccessTokenExpires(tokens: TokenResponse, now: number): number {
  const ttlMs =
    tokens.expires_in && tokens.expires_in > 0
      ? tokens.expires_in * 1000
      : XAI_DEFAULT_ACCESS_TOKEN_TTL_MS;
  return now + ttlMs;
}

async function loadSecretValue<T>(
  executor: DatabaseOrTransaction,
  secretName: string,
): Promise<T | null> {
  const [row] = await executor
    .select({ value: deploymentSecrets.value })
    .from(deploymentSecrets)
    .where(sql`${deploymentSecrets.name} = ${secretName}`)
    .limit(1);

  if (!row) {
    return null;
  }

  return decryptSecrets<T>(row.value);
}

async function persistSecretValue(
  executor: DatabaseOrTransaction,
  secretName: string,
  value: unknown,
): Promise<void> {
  const encrypted = encryptJSON(value);

  await executor
    .insert(deploymentSecrets)
    .values({
      name: secretName,
      value: encrypted,
    })
    .onConflictDoUpdate({
      target: deploymentSecrets.name,
      set: {
        value: encrypted,
        updatedAt: new Date(),
      },
    });
}

async function deleteSecretValue(
  executor: DatabaseOrTransaction,
  secretName: string,
): Promise<void> {
  await executor
    .delete(deploymentSecrets)
    .where(sql`${deploymentSecrets.name} = ${secretName}`);
}

async function loadRecord(
  executor: DatabaseOrTransaction = db,
): Promise<XaiSubscriptionRecord | null> {
  return loadSecretValue<XaiSubscriptionRecord>(
    executor,
    XAI_SUBSCRIPTION_SECRET_NAME,
  );
}

async function persistRecord(
  executor: DatabaseOrTransaction,
  record: XaiSubscriptionRecord,
): Promise<void> {
  await persistSecretValue(executor, XAI_SUBSCRIPTION_SECRET_NAME, record);
}

async function loadPendingDeviceFlow(
  executor: DatabaseOrTransaction = db,
): Promise<XaiPendingDeviceFlow | null> {
  return loadSecretValue<XaiPendingDeviceFlow>(
    executor,
    XAI_SUBSCRIPTION_PENDING_SECRET_NAME,
  );
}

async function persistPendingDeviceFlow(
  executor: DatabaseOrTransaction,
  pending: XaiPendingDeviceFlow,
): Promise<void> {
  await persistSecretValue(
    executor,
    XAI_SUBSCRIPTION_PENDING_SECRET_NAME,
    pending,
  );
}

async function clearPendingDeviceFlow(
  executor: DatabaseOrTransaction,
): Promise<void> {
  await deleteSecretValue(executor, XAI_SUBSCRIPTION_PENDING_SECRET_NAME);
}

function isActivePendingDeviceFlow(
  pending: XaiPendingDeviceFlow | null,
  deviceCode: string,
  now: number = Date.now(),
): boolean {
  return Boolean(
    pending &&
    pending.deviceCode &&
    pending.deviceCode === deviceCode &&
    pending.expiresAt > now,
  );
}

/**
 * Serialize device-code connect mutations. Unit-test executors may omit
 * `transaction`; fall back to running the body directly on the executor.
 */
async function withDeviceAuthLock(
  executor: DatabaseOrTransaction,
  body: (tx: DatabaseOrTransaction) => Promise<void>,
): Promise<void> {
  const maybeTx = executor as DatabaseOrTransaction & {
    transaction?: (
      fn: (tx: DatabaseOrTransaction) => Promise<void>,
    ) => Promise<void>;
    execute?: (query: unknown) => Promise<unknown>;
  };

  if (typeof maybeTx.transaction === 'function') {
    await maybeTx.transaction(async (tx) => {
      if (typeof tx.execute === 'function') {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${XAI_SUBSCRIPTION_DEVICE_LOCK_KEY}))`,
        );
      }
      await body(tx);
    });
    return;
  }

  await body(executor);
}

export async function getXaiSubscription(
  executor: DatabaseOrTransaction = db,
): Promise<XaiSubscriptionRecord | null> {
  return loadRecord(executor);
}

export async function isXaiSubscriptionConnected(
  executor: DatabaseOrTransaction = db,
): Promise<boolean> {
  const record = await loadRecord(executor);
  return Boolean(record && record.status === 'connected');
}

export async function getXaiSubscriptionStatus(
  executor: DatabaseOrTransaction = db,
): Promise<XaiSubscriptionPublicStatus> {
  const record = await loadRecord(executor);

  if (!record) {
    return { connected: false, status: 'disconnected' };
  }

  return {
    connected: record.status === 'connected',
    status: record.status,
    ...(record.email && { email: record.email }),
    ...(record.error && { error: record.error }),
    ...(record.connectedAt && { connectedAt: record.connectedAt }),
    ...(record.updatedAt && { updatedAt: record.updatedAt }),
  };
}

export async function saveXaiSubscription(
  tokens: TokenResponse,
  executor: DatabaseOrTransaction = db,
  existing?: XaiSubscriptionRecord | null,
): Promise<XaiSubscriptionRecord> {
  const now = Date.now();
  const email = extractEmailFromTokens(tokens) ?? existing?.email;
  const refresh = tokens.refresh_token ?? existing?.refresh;

  if (!refresh) {
    throw new Error('xAI token response did not include a refresh_token.');
  }

  const record: XaiSubscriptionRecord = {
    refresh,
    access: tokens.access_token,
    expires: resolveAccessTokenExpires(tokens, now),
    ...(email && { email }),
    status: 'connected',
    connectedAt: existing?.connectedAt ?? new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  await persistRecord(executor, record);
  return record;
}

export async function disconnectXaiSubscription(
  executor: DatabaseOrTransaction = db,
): Promise<void> {
  await deleteSecretValue(executor, XAI_SUBSCRIPTION_SECRET_NAME);
  await clearPendingDeviceFlow(executor);
}

/**
 * Refresh the access token when it is expiring within
 * `XAI_REFRESH_SAFETY_MARGIN_MS`. Serialized with a Postgres advisory lock so
 * concurrent gateway requests share one refreshed record. On failure, marks
 * the record `status: 'error'` instead of deleting it.
 */
export async function getFreshXaiAccessToken(
  options: {
    executor?: DatabaseOrTransaction;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): Promise<{
  access: string;
  refresh: string;
  expires: number;
  email?: string;
} | null> {
  const executor = options.executor ?? db;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const existing = await loadRecord(executor);

  if (!existing || existing.status !== 'connected') {
    return null;
  }

  if (existing.expires > now + XAI_REFRESH_SAFETY_MARGIN_MS) {
    return {
      access: existing.access,
      refresh: existing.refresh,
      expires: existing.expires,
      ...(existing.email && { email: existing.email }),
    };
  }

  const result: { record: XaiSubscriptionRecord | null } = { record: null };

  await executor.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${XAI_SUBSCRIPTION_ADVISORY_LOCK_KEY}))`,
    );

    const locked = await loadRecord(tx);

    if (!locked || locked.status !== 'connected') {
      return;
    }

    if (locked.expires > now + XAI_REFRESH_SAFETY_MARGIN_MS) {
      result.record = locked;
      return;
    }

    try {
      const clientId = resolveXaiOAuthClientId();
      const response = await fetchImpl(XAI_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'roomote',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: locked.refresh,
          client_id: clientId,
        }).toString(),
      });

      if (!response.ok) {
        throw new Error(`xAI token refresh failed: ${response.status}`);
      }

      const tokens = (await response.json()) as TokenResponse;
      if (!tokens.access_token) {
        throw new Error('xAI token refresh returned no access_token.');
      }

      const next = await saveXaiSubscription(tokens, tx, locked);
      result.record = next;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown refresh error';
      const errored: XaiSubscriptionRecord = {
        ...locked,
        status: 'error',
        error: message,
        updatedAt: new Date().toISOString(),
      };
      await persistRecord(tx, errored);
    }
  });

  const refreshed = result.record;

  if (!refreshed || refreshed.status !== 'connected') {
    return null;
  }

  return {
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    ...(refreshed.email && { email: refreshed.email }),
  };
}

/**
 * Build an OpenCode auth-content fragment for non-gateway control-plane
 * paths that need a bearer. Prefer the inference gateway in sandbox mode.
 */
export function buildXaiOpenCodeAuthContent(input: {
  access: string;
  refresh: string;
  expires: number;
}): string {
  return JSON.stringify({
    [XAI_OPENCODE_PROVIDER_ID]: {
      type: 'oauth',
      refresh: input.refresh,
      access: input.access,
      expires: input.expires,
    },
  });
}

export async function resolveXaiOpenCodeAuthContent(
  options: {
    executor?: DatabaseOrTransaction;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): Promise<string | null> {
  const fresh = await getFreshXaiAccessToken(options);
  if (!fresh) {
    return null;
  }
  return buildXaiOpenCodeAuthContent(fresh);
}

/**
 * Initiate the xAI device-code authorization flow. Returns the user code and
 * verification URL the operator enters in a browser. The caller polls
 * {@link pollXaiDeviceAuth} with the returned `deviceCode` until it resolves.
 *
 * Reserves a claim before the device-code HTTP request, then registers the
 * returned code only if that claim is still current. A slower earlier start
 * cannot overwrite a newer dialog's pending flow.
 */
export async function startXaiDeviceAuth(
  fetchImpl: typeof fetch = fetch,
  options: {
    executor?: DatabaseOrTransaction;
    now?: number;
  } = {},
): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresInMs: number;
}> {
  const executor = options.executor ?? db;
  const now = options.now ?? Date.now();
  const clientId = resolveXaiOAuthClientId();
  const claimId = randomUUID();
  // Provisional window until the device-code endpoint returns real expiry.
  const provisionalExpiresAt = now + 15 * 60 * 1000;

  // Reserve the active claim before any network I/O so concurrent starts order
  // by claim time, not by which HTTP response finishes first.
  await withDeviceAuthLock(executor, async (tx) => {
    await persistPendingDeviceFlow(tx, {
      claimId,
      expiresAt: provisionalExpiresAt,
      startedAt: new Date(now).toISOString(),
    });
  });

  const response = await fetchImpl(XAI_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'roomote',
    },
    body: new URLSearchParams({
      client_id: clientId,
      scope: XAI_OAUTH_SCOPE,
    }).toString(),
  });

  if (!response.ok) {
    // Drop this claim if it is still active so a failed start does not block
    // a later retry indefinitely under the provisional expiry.
    await withDeviceAuthLock(executor, async (tx) => {
      const pending = await loadPendingDeviceFlow(tx);
      if (pending?.claimId === claimId) {
        await clearPendingDeviceFlow(tx);
      }
    });
    throw new Error(
      `Failed to initiate xAI device authorization: ${response.status}`,
    );
  }

  const data = (await response.json()) as DeviceCodeResponse;
  const expiresInMs = Math.max(data.expires_in ?? 900, 1) * 1000;
  const result = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl:
      data.verification_uri_complete ??
      data.verification_uri ??
      XAI_OAUTH_DEVICE_VERIFICATION_URL,
    intervalMs: Math.max(data.interval ?? 5, 1) * 1000,
    expiresInMs,
  };

  let registered = false;
  await withDeviceAuthLock(executor, async (tx) => {
    const pending = await loadPendingDeviceFlow(tx);
    if (!pending || pending.claimId !== claimId) {
      // A newer start claimed the flow while we awaited xAI.
      return;
    }
    await persistPendingDeviceFlow(tx, {
      claimId,
      deviceCode: result.deviceCode,
      expiresAt: now + expiresInMs,
      startedAt: pending.startedAt,
    });
    registered = true;
  });

  if (!registered) {
    throw new Error(SUPERSEDED_DEVICE_FLOW_ERROR);
  }

  return result;
}

export type XaiDevicePollResult =
  | { status: 'pending'; intervalMs?: number }
  | { status: 'success'; record: XaiSubscriptionRecord }
  | { status: 'failed'; error: string };

/**
 * Poll the xAI token endpoint once for a device-code grant. Returns `pending`
 * while the operator has not finished authorization, `success` with the
 * persisted record once tokens are exchanged, or `failed` on a terminal error.
 *
 * Token persistence is gated on the deployment's currently active pending
 * device code (set by {@link startXaiDeviceAuth}). A poll for a superseded
 * code never writes subscription tokens, even if xAI still returns them.
 */
export async function pollXaiDeviceAuth(
  input: { deviceCode: string },
  options: {
    executor?: DatabaseOrTransaction;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): Promise<XaiDevicePollResult> {
  const executor = options.executor ?? db;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const clientId = resolveXaiOAuthClientId();

  // Cheap reject before talking to xAI when this code is already superseded.
  const pendingBefore = await loadPendingDeviceFlow(executor);
  if (!isActivePendingDeviceFlow(pendingBefore, input.deviceCode, now)) {
    return {
      status: 'failed',
      error: SUPERSEDED_DEVICE_FLOW_ERROR,
    };
  }

  const response = await fetchImpl(XAI_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'roomote',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: input.deviceCode,
    }).toString(),
  });

  let data: TokenResponse;
  try {
    data = (await response.json()) as TokenResponse;
  } catch {
    return {
      status: 'failed',
      error: `xAI device authorization failed: ${response.status}`,
    };
  }

  if (data.access_token) {
    if (!data.refresh_token) {
      return {
        status: 'failed',
        error: 'xAI device authorization returned no refresh_token.',
      };
    }

    // Re-check under lock: cancel/reopen may have registered a newer code
    // while this poll was awaiting xAI.
    let result: XaiDevicePollResult = {
      status: 'failed',
      error: SUPERSEDED_DEVICE_FLOW_ERROR,
    };

    await withDeviceAuthLock(executor, async (tx) => {
      const pending = await loadPendingDeviceFlow(tx);
      if (!isActivePendingDeviceFlow(pending, input.deviceCode, now)) {
        return;
      }

      const record = await saveXaiSubscription(data, tx);
      await clearPendingDeviceFlow(tx);
      result = { status: 'success', record };
    });

    return result;
  }

  // Terminal failures for a superseded code should still fail closed without
  // clearing a newer pending flow.
  const pendingAfter = await loadPendingDeviceFlow(executor);
  if (!isActivePendingDeviceFlow(pendingAfter, input.deviceCode, now)) {
    return {
      status: 'failed',
      error: SUPERSEDED_DEVICE_FLOW_ERROR,
    };
  }

  if (data.error === 'authorization_pending') {
    return { status: 'pending' };
  }

  if (data.error === 'slow_down') {
    return {
      status: 'pending',
      intervalMs:
        typeof data.interval === 'number' && data.interval > 0
          ? data.interval * 1000
          : XAI_POLL_SLOW_DOWN_MS,
    };
  }

  if (data.error === 'expired_token') {
    await withDeviceAuthLock(executor, async (tx) => {
      const pending = await loadPendingDeviceFlow(tx);
      if (isActivePendingDeviceFlow(pending, input.deviceCode, now)) {
        await clearPendingDeviceFlow(tx);
      }
    });
    return {
      status: 'failed',
      error: 'xAI device authorization code expired. Restart the connection.',
    };
  }

  if (data.error === 'access_denied') {
    await withDeviceAuthLock(executor, async (tx) => {
      const pending = await loadPendingDeviceFlow(tx);
      if (isActivePendingDeviceFlow(pending, input.deviceCode, now)) {
        await clearPendingDeviceFlow(tx);
      }
    });
    return {
      status: 'failed',
      error: 'xAI device authorization was denied.',
    };
  }

  if (!response.ok && !data.error) {
    return {
      status: 'failed',
      error: `xAI device authorization failed: ${response.status}`,
    };
  }

  return {
    status: 'failed',
    error:
      data.error_description ??
      (data.error
        ? `xAI device authorization failed: ${data.error}`
        : 'xAI device authorization returned no access token.'),
  };
}

export const XAI_SUBSCRIPTION_INTERNAL = {
  secretName: XAI_SUBSCRIPTION_SECRET_NAME,
  pendingSecretName: XAI_SUBSCRIPTION_PENDING_SECRET_NAME,
  defaultAccessTokenTtlMs: XAI_DEFAULT_ACCESS_TOKEN_TTL_MS,
  tokenEndpoint: XAI_OAUTH_TOKEN_ENDPOINT,
  supersededDeviceFlowError: SUPERSEDED_DEVICE_FLOW_ERROR,
};
