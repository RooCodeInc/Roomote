import { sql } from 'drizzle-orm';

import {
  CHATGPT_DEFAULT_ACCESS_TOKEN_TTL_MS,
  CHATGPT_DEVICE_AUTH_NOT_FOUND_ERROR_CODE,
  CHATGPT_DEVICE_AUTH_PENDING_ERROR_CODE,
  CHATGPT_DEVICE_CODE_DEFAULT_TTL_MS,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_DEVICE_CODE_ENDPOINT,
  CHATGPT_OAUTH_DEVICE_CALLBACK_REDIRECT_URI,
  CHATGPT_OAUTH_DEVICE_TOKEN_ENDPOINT,
  CHATGPT_OAUTH_DEVICE_VERIFICATION_URL,
  CHATGPT_OAUTH_ISSUER,
  CHATGPT_OAUTH_TOKEN_ENDPOINT,
  CHATGPT_OPENCODE_PROVIDER_ID,
  CHATGPT_POLL_SLOW_DOWN_MS,
  CHATGPT_REFRESH_SAFETY_MARGIN_MS,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { decryptSecrets, encryptJSON } from '../encryption';
import { deploymentSecrets } from '../schema';

/**
 * Server-side lifecycle for the deployment-wide ChatGPT subscription OAuth
 * credential. Roomote owns token refresh; control-plane OpenCode helpers use
 * `OPENCODE_AUTH_CONTENT`, while task sandboxes authenticate through the
 * inference gateway and never receive the OAuth record.
 *
 * The OAuth mechanics (issuer, client id, device-code + refresh grant shapes,
 * JWT `accountId` extraction) mirror opencode's built-in Codex auth plugin so
 * the records Roomote produces are accepted under opencode provider id
 * `openai`.
 */

const CHATGPT_SUBSCRIPTION_SECRET_NAME = 'CHATGPT_SUBSCRIPTION_OAUTH';
const CHATGPT_SUBSCRIPTION_ADVISORY_LOCK_KEY =
  'roomote-chatgpt-subscription-refresh';

export type ChatGptSubscriptionStatusValue =
  | 'connected'
  | 'error'
  | 'disconnected';

export interface ChatGptSubscriptionRecord {
  refresh: string;
  access: string;
  /** Epoch milliseconds when the access token expires. */
  expires: number;
  accountId?: string;
  email?: string;
  status: ChatGptSubscriptionStatusValue;
  fastMode: boolean;
  /** Last refresh/connect error message, populated when status is 'error'. */
  error?: string;
  connectedAt: string;
  updatedAt: string;
}

/**
 * Public, token-free status for the Settings UI. Never includes `refresh` or
 * `access`.
 */
export interface ChatGptSubscriptionPublicStatus {
  connected: boolean;
  status: ChatGptSubscriptionStatusValue;
  fastMode: boolean;
  accountId?: string;
  email?: string;
  error?: string;
  connectedAt?: string;
  updatedAt?: string;
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
  };
}

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface DeviceUserCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval: string;
  /** ISO 8601 timestamp after which the user code stops being accepted. */
  expires_at?: string;
}

interface DeviceTokenPendingResponse {
  authorization_code: string;
  code_verifier: string;
}

/** Error envelope the deviceauth endpoints return on a non-2xx response. */
interface DeviceAuthErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
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

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

export function extractAccountIdFromTokens(
  tokens: TokenResponse,
): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) {
      return accountId;
    }
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    return claims ? extractAccountIdFromClaims(claims) : undefined;
  }
  return undefined;
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

async function loadRecord(
  executor: DatabaseOrTransaction = db,
): Promise<ChatGptSubscriptionRecord | null> {
  const [row] = await executor
    .select({ value: deploymentSecrets.value })
    .from(deploymentSecrets)
    .where(sql`${deploymentSecrets.name} = ${CHATGPT_SUBSCRIPTION_SECRET_NAME}`)
    .limit(1);

  if (!row) {
    return null;
  }

  return decryptSecrets<ChatGptSubscriptionRecord>(row.value);
}

async function persistRecord(
  executor: DatabaseOrTransaction,
  record: ChatGptSubscriptionRecord,
): Promise<void> {
  const encrypted = encryptJSON(record);

  await executor
    .insert(deploymentSecrets)
    .values({
      name: CHATGPT_SUBSCRIPTION_SECRET_NAME,
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

async function withChatGptSubscriptionLock<T>(
  executor: DatabaseOrTransaction,
  operation: (tx: DatabaseOrTransaction) => Promise<T>,
): Promise<T> {
  const transaction = (
    executor as DatabaseOrTransaction & {
      transaction?: (
        callback: (tx: DatabaseOrTransaction) => Promise<T>,
      ) => Promise<T>;
    }
  ).transaction;

  if (typeof transaction !== 'function') {
    return operation(executor);
  }

  return transaction.call(executor, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${CHATGPT_SUBSCRIPTION_ADVISORY_LOCK_KEY}))`,
    );
    return operation(tx);
  });
}

export async function getChatGptSubscription(
  executor: DatabaseOrTransaction = db,
): Promise<ChatGptSubscriptionRecord | null> {
  return loadRecord(executor);
}

export async function isChatGptSubscriptionConnected(
  executor: DatabaseOrTransaction = db,
): Promise<boolean> {
  const record = await loadRecord(executor);
  return Boolean(record && record.status === 'connected');
}

export async function getChatGptSubscriptionStatus(
  executor: DatabaseOrTransaction = db,
): Promise<ChatGptSubscriptionPublicStatus> {
  const record = await loadRecord(executor);

  if (!record) {
    return { connected: false, status: 'disconnected', fastMode: false };
  }

  return {
    connected: record.status === 'connected',
    status: record.status,
    fastMode: record.fastMode === true,
    ...(record.accountId && { accountId: record.accountId }),
    ...(record.email && { email: record.email }),
    ...(record.error && { error: record.error }),
    ...(record.connectedAt && { connectedAt: record.connectedAt }),
    ...(record.updatedAt && { updatedAt: record.updatedAt }),
  };
}

function resolveAccessTokenExpires(tokens: TokenResponse, now: number): number {
  const ttlMs =
    tokens.expires_in && tokens.expires_in > 0
      ? tokens.expires_in * 1000
      : CHATGPT_DEFAULT_ACCESS_TOKEN_TTL_MS;
  return now + ttlMs;
}

export async function saveChatGptSubscription(
  tokens: TokenResponse,
  executor: DatabaseOrTransaction = db,
): Promise<ChatGptSubscriptionRecord> {
  return withChatGptSubscriptionLock(executor, async (tx) => {
    const now = Date.now();
    const existing = await loadRecord(tx);
    const accountId = extractAccountIdFromTokens(tokens);
    const email = extractEmailFromTokens(tokens);
    const record: ChatGptSubscriptionRecord = {
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: resolveAccessTokenExpires(tokens, now),
      ...(accountId && { accountId }),
      ...(email && { email }),
      status: 'connected',
      fastMode: existing?.fastMode === true,
      connectedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    await persistRecord(tx, record);
    return record;
  });
}

export async function updateChatGptSubscriptionFastMode(
  fastMode: boolean,
  executor: DatabaseOrTransaction = db,
): Promise<void> {
  await withChatGptSubscriptionLock(executor, async (tx) => {
    const record = await loadRecord(tx);

    if (!record) {
      throw new Error('ChatGPT subscription is not connected.');
    }

    await persistRecord(tx, {
      ...record,
      fastMode,
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function isChatGptSubscriptionFastModeEnabled(
  executor: DatabaseOrTransaction = db,
): Promise<boolean> {
  const record = await loadRecord(executor);
  return record?.fastMode === true;
}

export async function disconnectChatGptSubscription(
  executor: DatabaseOrTransaction = db,
): Promise<void> {
  await executor
    .delete(deploymentSecrets)
    .where(
      sql`${deploymentSecrets.name} = ${CHATGPT_SUBSCRIPTION_SECRET_NAME}`,
    );
}

/**
 * Refresh the access token when it is expiring within
 * `CHATGPT_REFRESH_SAFETY_MARGIN_MS`. Serialized with a Postgres advisory lock
 * so the API, BullMQ, and web processes agree on a single refreshed record.
 * On failure, marks the record `status: 'error'` with the failure reason
 * instead of deleting it, so the UI can prompt reconnect.
 *
 * Returns the fresh access token (and full record) or `null` when no
 * connected subscription exists or refresh failed.
 */
export async function getFreshChatGptAccessToken(
  options: {
    executor?: DatabaseOrTransaction;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): Promise<{
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
} | null> {
  const executor = options.executor ?? db;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const existing = await loadRecord(executor);

  if (!existing || existing.status !== 'connected') {
    return null;
  }

  if (existing.expires > now + CHATGPT_REFRESH_SAFETY_MARGIN_MS) {
    return {
      access: existing.access,
      refresh: existing.refresh,
      expires: existing.expires,
      ...(existing.accountId && { accountId: existing.accountId }),
    };
  }

  // Refresh under an advisory lock so concurrent callers reuse one refresh.
  const result: { record: ChatGptSubscriptionRecord | null } = {
    record: null,
  };

  await executor.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${CHATGPT_SUBSCRIPTION_ADVISORY_LOCK_KEY}))`,
    );

    // Re-read inside the lock; another process may have refreshed already.
    const locked = await loadRecord(tx);

    if (!locked || locked.status !== 'connected') {
      return;
    }

    if (locked.expires > now + CHATGPT_REFRESH_SAFETY_MARGIN_MS) {
      result.record = locked;
      return;
    }

    try {
      const response = await fetchImpl(CHATGPT_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: locked.refresh,
          client_id: CHATGPT_OAUTH_CLIENT_ID,
        }).toString(),
      });

      if (!response.ok) {
        throw new Error(`ChatGPT token refresh failed: ${response.status}`);
      }

      const tokens = (await response.json()) as TokenResponse;
      const accountId = extractAccountIdFromTokens(tokens) ?? locked.accountId;
      const email = extractEmailFromTokens(tokens) ?? locked.email;
      const next: ChatGptSubscriptionRecord = {
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: resolveAccessTokenExpires(tokens, Date.now()),
        ...(accountId && { accountId }),
        ...(email && { email }),
        status: 'connected',
        fastMode: locked.fastMode === true,
        connectedAt: locked.connectedAt,
        updatedAt: new Date().toISOString(),
      };

      await persistRecord(tx, next);
      result.record = next;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown refresh error';
      const errored: ChatGptSubscriptionRecord = {
        ...locked,
        status: 'error',
        fastMode: locked.fastMode === true,
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
    ...(refreshed.accountId && { accountId: refreshed.accountId }),
  };
}

/**
 * Build the JSON value for the `OPENCODE_AUTH_CONTENT` env var from a
 * ChatGPT subscription record. The shape matches opencode's `Auth.Oauth`
 * schema under provider id `openai`:
 * `{ openai: { type: 'oauth', refresh, access, expires, accountId? } }`.
 */
export function buildOpenCodeAuthContent(input: {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}): string {
  const record: Record<string, unknown> = {
    [CHATGPT_OPENCODE_PROVIDER_ID]: {
      type: 'oauth',
      refresh: input.refresh,
      access: input.access,
      expires: input.expires,
      ...(input.accountId && { accountId: input.accountId }),
    },
  };
  return JSON.stringify(record);
}

/**
 * Resolve a fresh `OPENCODE_AUTH_CONTENT` value for control-plane OpenCode
 * when a ChatGPT subscription is connected, or `null` when it is not
 * connected or refresh failed. Performs a central refresh when the access
 * token is near expiry.
 */
export async function resolveOpenCodeAuthContent(
  options: {
    executor?: DatabaseOrTransaction;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): Promise<string | null> {
  const fresh = await getFreshChatGptAccessToken(options);

  if (!fresh) {
    return null;
  }

  return buildOpenCodeAuthContent(fresh);
}

/**
 * Initiate the OpenAI device-code authorization flow. Returns the user code
 * and verification URL the operator enters in a browser. The caller polls
 * {@link pollChatGptDeviceAuth} with the returned `deviceAuthId` and
 * `userCode` until it resolves to tokens, and stops once `expiresInMs`
 * elapses. The issuer stops accepting the code at that point and every later
 * poll returns `deviceauth_not_found`.
 *
 * `expiresInMs` is relative rather than absolute so a clock skew between this
 * server and the operator's browser cannot expire the code early or late.
 */
export async function startChatGptDeviceAuth(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresInMs: number;
}> {
  const response = await fetchImpl(CHATGPT_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'roomote',
    },
    body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to initiate ChatGPT device authorization: ${response.status}`,
    );
  }

  const data = (await response.json()) as DeviceUserCodeResponse;
  const intervalSeconds = Math.max(parseInt(data.interval) || 5, 1);

  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: CHATGPT_OAUTH_DEVICE_VERIFICATION_URL,
    intervalMs: intervalSeconds * 1000,
    expiresInMs: resolveDeviceCodeExpiresInMs(data.expires_at, now),
  };
}

function resolveDeviceCodeExpiresInMs(
  expiresAt: string | undefined,
  now: number,
): number {
  const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;

  if (Number.isNaN(parsed)) {
    return CHATGPT_DEVICE_CODE_DEFAULT_TTL_MS;
  }

  // Never hand back a non-positive window; a code that is already expired
  // should still give the dialog one poll before it reports expiry.
  return Math.max(parsed - now, 1_000);
}

/**
 * Why a poll ended terminally, so the dialog can show guidance the operator
 * can act on instead of a generic error:
 * - `blocked`: the issuer refused the app, typically an org policy on the
 *   ChatGPT workspace. Only an admin of that workspace can clear it.
 * - `expired`: the code aged out or was already consumed; restart the flow.
 */
export type ChatGptDevicePollFailureReason = 'blocked' | 'expired';

export type ChatGptDevicePollResult =
  | { status: 'pending'; intervalMs?: number }
  | { status: 'success'; record: ChatGptSubscriptionRecord }
  | {
      status: 'failed';
      error: string;
      reason?: ChatGptDevicePollFailureReason;
    };

/**
 * Poll the OpenAI device-token endpoint once. Returns `pending` while the
 * operator has not yet completed authorization, `success` with the persisted
 * subscription record once tokens are exchanged, or `failed` on a terminal
 * error.
 *
 * The endpoint signals pending with HTTP 403 and the structured error code
 * `deviceauth_authorization_pending`, and reuses 403 for refusals that no
 * amount of waiting resolves (an org policy blocking the OAuth app). Classify
 * on the structured code rather than the status alone so a blocked deployment
 * is not rendered as an endless "waiting" spinner. When the body carries no
 * recognizable code we fall back to `pending`; the caller's expiry deadline
 * bounds that fallback.
 */
/**
 * Read the structured `error.code` from a deviceauth error response, or
 * `undefined` when the body is absent, unparseable, or carries no code. Only
 * the code is inspected; the human-readable `message` is not matched on.
 */
async function readDeviceAuthErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as DeviceAuthErrorResponse;
    const code = body?.error?.code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a refused device-token poll to a result, keyed only on the structured
 * `error.code`. The HTTP status is deliberately not part of the decision: the
 * issuer reuses 403 for both "not entered yet" and refusals no amount of
 * waiting resolves, so the status alone cannot tell them apart.
 *
 * `undefined` means the body carried no usable code, which stays `pending` to
 * preserve the behavior that shipped before this was classified at all. The
 * caller stops at the device code's expiry, so that fallback is bounded.
 *
 * Pure, so the branch table is testable without an HTTP mock.
 */
export function classifyDeviceAuthRefusal(
  errorCode: string | undefined,
): ChatGptDevicePollResult {
  switch (errorCode) {
    case CHATGPT_DEVICE_AUTH_PENDING_ERROR_CODE:
      return { status: 'pending' };
    case CHATGPT_DEVICE_AUTH_NOT_FOUND_ERROR_CODE:
      return {
        status: 'failed',
        reason: 'expired',
        error:
          'ChatGPT authorization code expired. Restart the connection to get a new code.',
      };
    case undefined:
      return { status: 'pending' };
    default:
      return {
        status: 'failed',
        reason: 'blocked',
        error: `ChatGPT device authorization was refused (${errorCode}).`,
      };
  }
}

export async function pollChatGptDeviceAuth(input: {
  deviceAuthId: string;
  userCode: string;
  fetchImpl?: typeof fetch;
  executor?: DatabaseOrTransaction;
}): Promise<ChatGptDevicePollResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const executor = input.executor ?? db;

  const response = await fetchImpl(CHATGPT_OAUTH_DEVICE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'roomote',
    },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode,
    }),
  });

  if (response.status === 429) {
    return { status: 'pending', intervalMs: CHATGPT_POLL_SLOW_DOWN_MS };
  }

  if (response.status === 403 || response.status === 404) {
    return classifyDeviceAuthRefusal(await readDeviceAuthErrorCode(response));
  }

  if (!response.ok) {
    return {
      status: 'failed',
      error: `ChatGPT device authorization failed: ${response.status}`,
    };
  }

  const data = (await response.json()) as DeviceTokenPendingResponse;

  let tokens: TokenResponse;
  try {
    const tokenResponse = await fetchImpl(CHATGPT_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: data.authorization_code,
        redirect_uri: CHATGPT_OAUTH_DEVICE_CALLBACK_REDIRECT_URI,
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        code_verifier: data.code_verifier,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      return {
        status: 'failed',
        error: `ChatGPT token exchange failed: ${tokenResponse.status}`,
      };
    }

    tokens = (await tokenResponse.json()) as TokenResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', error: message };
  }

  const record = await saveChatGptSubscription(tokens, executor);
  return { status: 'success', record };
}

export const CHATGPT_SUBSCRIPTION_INTERNAL = {
  secretName: CHATGPT_SUBSCRIPTION_SECRET_NAME,
  defaultAccessTokenTtlMs: CHATGPT_DEFAULT_ACCESS_TOKEN_TTL_MS,
  issuer: CHATGPT_OAUTH_ISSUER,
};
