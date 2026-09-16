import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';

import type { UserDeviceEnvironment } from '@roomote/types';

/**
 * Apple Push Notification service client.
 *
 * Deliberately dependency-free: one ES256 provider token signed with the
 * deployment's `.p8` key, one HTTP/2 session per APNs host, and a pure
 * request builder so the wire format is unit-testable without a network.
 */

export const APNS_HOSTS: Record<UserDeviceEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Apple rejects provider tokens older than an hour; refresh well before. */
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1_000;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type ApnsCredentials = {
  teamId: string;
  keyId: string;
  /** PEM contents of the AuthKey_<keyId>.p8 file. */
  privateKey: string;
  bundleId: string;
};

export type ApnsRequest = {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type ApnsResponse = {
  status: number;
  body: string;
};

export type ApnsTransport = (request: ApnsRequest) => Promise<ApnsResponse>;

export type ApnsSendResult =
  /** APNs accepted the notification. */
  | { outcome: 'sent' }
  /** The token is gone for good; the device row should be disabled. */
  | { outcome: 'unregistered'; reason: string }
  /** APNs rejected this notification; retrying will not help. */
  | { outcome: 'rejected'; status: number; reason: string };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign an APNs provider token (RFC 7519 JWT, ES256). Apple wants the raw
 * IEEE P1363 `r||s` signature rather than DER, hence `dsaEncoding`.
 */
export function buildApnsProviderToken(
  credentials: Pick<ApnsCredentials, 'teamId' | 'keyId' | 'privateKey'>,
  issuedAt = Math.floor(Date.now() / 1_000),
): string {
  const header = base64url(
    JSON.stringify({ alg: 'ES256', kid: credentials.keyId }),
  );
  const claims = base64url(
    JSON.stringify({ iss: credentials.teamId, iat: issuedAt }),
  );
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey(credentials.privateKey);
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

type CachedToken = { token: string; expiresAt: number };
const providerTokenCache = new Map<string, CachedToken>();

function providerTokenCacheKey(
  credentials: Pick<ApnsCredentials, 'teamId' | 'keyId'>,
): string {
  return `${credentials.teamId}:${credentials.keyId}`;
}

export function getApnsProviderToken(
  credentials: Pick<ApnsCredentials, 'teamId' | 'keyId' | 'privateKey'>,
  now = Date.now(),
): string {
  const cacheKey = providerTokenCacheKey(credentials);
  const cached = providerTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.token;
  const token = buildApnsProviderToken(credentials, Math.floor(now / 1_000));
  providerTokenCache.set(cacheKey, {
    token,
    expiresAt: now + PROVIDER_TOKEN_TTL_MS,
  });
  return token;
}

export function invalidateApnsProviderToken(
  credentials: Pick<ApnsCredentials, 'teamId' | 'keyId'>,
): void {
  providerTokenCache.delete(providerTokenCacheKey(credentials));
}

/** Test seam: forget every cached provider token. */
export function resetApnsProviderTokenCache(): void {
  providerTokenCache.clear();
}

export function buildApnsRequest(input: {
  deviceToken: string;
  environment: UserDeviceEnvironment;
  bundleId: string;
  providerToken: string;
  payload: Record<string, unknown>;
  collapseId?: string;
  pushType?: 'alert' | 'background';
  priority?: 5 | 10;
}): ApnsRequest {
  const headers: Record<string, string> = {
    authorization: `bearer ${input.providerToken}`,
    'apns-topic': input.bundleId,
    'apns-push-type': input.pushType ?? 'alert',
    'apns-priority': String(input.priority ?? 10),
    'content-type': 'application/json',
  };
  if (input.collapseId) {
    // Apple caps collapse ids at 64 bytes.
    headers['apns-collapse-id'] = input.collapseId.slice(0, 64);
  }
  return {
    host: APNS_HOSTS[input.environment],
    path: `/3/device/${input.deviceToken}`,
    headers,
    body: JSON.stringify(input.payload),
  };
}

function parseApnsReason(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : '';
  } catch {
    return '';
  }
}

export class ApnsRetryableError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'ApnsRetryableError';
  }
}

/**
 * Deliver one notification. Retryable failures (429, 5xx, transport errors)
 * throw so the queue backs off; terminal ones come back as a result.
 */
export async function sendApnsPush(
  input: {
    credentials: ApnsCredentials;
    deviceToken: string;
    environment: UserDeviceEnvironment;
    payload: Record<string, unknown>;
    collapseId?: string;
  },
  transport: ApnsTransport = http2Transport,
): Promise<ApnsSendResult> {
  const attempt = async (providerToken: string): Promise<ApnsResponse> =>
    transport(
      buildApnsRequest({
        deviceToken: input.deviceToken,
        environment: input.environment,
        bundleId: input.credentials.bundleId,
        providerToken,
        payload: input.payload,
        ...(input.collapseId ? { collapseId: input.collapseId } : {}),
      }),
    );

  let response = await attempt(getApnsProviderToken(input.credentials));
  let reason = parseApnsReason(response.body);
  if (
    response.status === 403 &&
    (reason === 'InvalidProviderToken' || reason === 'ExpiredProviderToken')
  ) {
    invalidateApnsProviderToken(input.credentials);
    response = await attempt(getApnsProviderToken(input.credentials));
    reason = parseApnsReason(response.body);
  }

  if (response.status === 200) return { outcome: 'sent' };
  if (
    response.status === 410 ||
    (response.status === 400 && reason === 'BadDeviceToken')
  ) {
    return { outcome: 'unregistered', reason: reason || 'Unregistered' };
  }
  if (response.status === 429 || response.status >= 500) {
    throw new ApnsRetryableError(
      `APNs responded ${response.status}${reason ? ` (${reason})` : ''}`,
      response.status,
      reason,
    );
  }
  return { outcome: 'rejected', status: response.status, reason };
}

type SessionEntry = { session: http2.ClientHttp2Session };
const sessions = new Map<string, SessionEntry>();

function getSession(host: string): http2.ClientHttp2Session {
  const existing = sessions.get(host);
  if (existing && !existing.session.closed && !existing.session.destroyed) {
    return existing.session;
  }
  const session = http2.connect(host);
  session.setTimeout(SESSION_IDLE_TIMEOUT_MS, () => session.close());
  session.once('close', () => {
    if (sessions.get(host)?.session === session) sessions.delete(host);
  });
  session.on('error', (error) => {
    console.warn(
      `[apns] HTTP/2 session error for ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  sessions.set(host, { session });
  return session;
}

/** Close every pooled APNs session (shutdown / tests). */
export function closeApnsSessions(): void {
  for (const { session } of sessions.values()) session.close();
  sessions.clear();
}

const http2Transport: ApnsTransport = (request) =>
  new Promise<ApnsResponse>((resolve, reject) => {
    let session: http2.ClientHttp2Session;
    try {
      session = getSession(request.host);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const stream = session.request({
      ':method': 'POST',
      ':path': request.path,
      ...request.headers,
    });
    let status = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      finish(() =>
        reject(new ApnsRetryableError('APNs request timed out', 0, 'Timeout')),
      );
    });
    stream.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () =>
      finish(() =>
        resolve({ status, body: Buffer.concat(chunks).toString('utf8') }),
      ),
    );
    stream.on('error', (error) =>
      finish(() =>
        reject(
          new ApnsRetryableError(
            `APNs transport error: ${error.message}`,
            0,
            'Transport',
          ),
        ),
      ),
    );
    stream.end(request.body);
  });
