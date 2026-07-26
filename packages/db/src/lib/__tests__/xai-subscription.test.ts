import { describe, expect, it, vi } from 'vitest';

vi.mock('../../encryption', () => ({
  encryptJSON: (value: unknown) => JSON.stringify(value),
  decryptSecrets: async (value: string) => JSON.parse(value) as unknown,
}));

import {
  XAI_OAUTH_DEVICE_CODE_ENDPOINT,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_TOKEN_ENDPOINT,
  XAI_REFRESH_SAFETY_MARGIN_MS,
} from '@roomote/types';

import {
  disconnectXaiSubscription,
  getFreshXaiAccessToken,
  getXaiSubscriptionStatus,
  pollXaiDeviceAuth,
  resolveXaiOAuthClientId,
  startXaiDeviceAuth,
  XAI_SUBSCRIPTION_INTERNAL,
} from '../xai-subscription';

function secretNameFromWhere(clause: {
  queryChunks?: unknown[];
}): string | null {
  const chunks = clause.queryChunks ?? [];
  for (const chunk of chunks) {
    if (typeof chunk === 'string' && chunk.startsWith('XAI_')) {
      return chunk;
    }
  }
  return null;
}

function makeExecutor(
  initial: Record<string, unknown> = {},
  options: { withTransaction?: boolean } = {},
) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([name, value]) => [
      name,
      JSON.stringify(value),
    ]),
  );

  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi
    .fn()
    .mockImplementation((row: { name: string; value: string }) => {
      store.set(row.name, row.value);
      return { onConflictDoUpdate };
    });
  const insert = vi.fn().mockReturnValue({ values });

  const limit = vi
    .fn()
    .mockImplementation(
      async function limitImpl(this: { __secretName?: string | null }) {
        const name = this.__secretName;
        if (!name) {
          return [];
        }
        const value = store.get(name);
        return value ? [{ value }] : [];
      },
    );

  const where = vi
    .fn()
    .mockImplementation((clause: { queryChunks?: unknown[] }) => {
      const secretName = secretNameFromWhere(clause);
      return {
        limit: limit.bind({ __secretName: secretName }),
        // delete().where() resolves directly
        then: undefined,
      };
    });

  // delete uses where that resolves as a promise when awaited
  const delWhere = vi
    .fn()
    .mockImplementation(async (clause: { queryChunks?: unknown[] }) => {
      const secretName = secretNameFromWhere(clause);
      if (secretName) {
        store.delete(secretName);
      }
    });
  const del = vi.fn().mockReturnValue({ where: delWhere });

  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const execute = vi.fn().mockResolvedValue(undefined);

  const base = { insert, select, delete: del, execute, store };

  if (options.withTransaction) {
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(base);
    });
    return {
      executor: { ...base, transaction } as never,
      values,
      insert,
      select,
      del,
      delWhere,
      store,
      transaction,
    };
  }

  return {
    executor: base as never,
    values,
    insert,
    select,
    del,
    delWhere,
    store,
  };
}

function activePending(
  deviceCode = 'device-1',
  expiresAt = Date.now() + 900_000,
  claimId = 'claim-1',
) {
  return {
    claimId,
    deviceCode,
    expiresAt,
    startedAt: new Date().toISOString(),
  };
}

function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('xAI OAuth client id', () => {
  it('defaults to the public Grok CLI client id and accepts an override', () => {
    expect(resolveXaiOAuthClientId({})).toBe(
      'b1a00492-073a-47ea-816f-4c329264a828',
    );
    expect(
      resolveXaiOAuthClientId({
        XAI_OAUTH_CLIENT_ID: ' roomote-xai-client ',
      }),
    ).toBe('roomote-xai-client');
  });
});

describe('startXaiDeviceAuth', () => {
  it('starts the Grok CLI device-code flow with the public client id and scopes', async () => {
    const { executor, store } = makeExecutor();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://accounts.x.ai/device',
          verification_uri_complete:
            'https://accounts.x.ai/device?user_code=ABCD-EFGH',
          interval: 5,
          expires_in: 900,
        }),
        { status: 200 },
      ),
    );

    const now = 1_700_000_000_000;
    await expect(
      startXaiDeviceAuth(fetchImpl, { executor, now }),
    ).resolves.toEqual({
      deviceCode: 'device-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://accounts.x.ai/device?user_code=ABCD-EFGH',
      intervalMs: 5_000,
      expiresInMs: 900_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      XAI_OAUTH_DEVICE_CODE_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');
    expect(body.get('scope')).toBe(XAI_OAUTH_SCOPE);

    const pending = JSON.parse(
      store.get(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)!,
    ) as {
      claimId: string;
      deviceCode: string;
      expiresAt: number;
      startedAt: string;
    };
    expect(pending.deviceCode).toBe('device-1');
    expect(pending.expiresAt).toBe(now + 900_000);
    expect(pending.startedAt).toBe(new Date(now).toISOString());
    expect(pending.claimId).toEqual(expect.any(String));
  });

  it('supersedes a prior pending device code on restart', async () => {
    const { executor, store } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]:
        activePending('old-device'),
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'new-device',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://accounts.x.ai/device',
          interval: 5,
          expires_in: 900,
        }),
        { status: 200 },
      ),
    );

    await startXaiDeviceAuth(fetchImpl, { executor, now: Date.now() });

    const pending = JSON.parse(
      store.get(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)!,
    ) as { deviceCode: string };
    expect(pending.deviceCode).toBe('new-device');
  });

  it('does not let a slower earlier start overwrite a newer claim', async () => {
    const { executor, store } = makeExecutor();
    let releaseEarlyHttp: (() => void) | undefined;
    const earlyHttpGate = new Promise<void>((resolve) => {
      releaseEarlyHttp = resolve;
    });

    const earlyFetch = vi.fn().mockImplementation(async () => {
      await earlyHttpGate;
      return new Response(
        JSON.stringify({
          device_code: 'stale-device',
          user_code: 'STALE-CODE',
          verification_uri: 'https://accounts.x.ai/device',
          interval: 5,
          expires_in: 900,
        }),
        { status: 200 },
      );
    });

    const lateFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'fresh-device',
          user_code: 'FRESH-CODE',
          verification_uri: 'https://accounts.x.ai/device',
          interval: 5,
          expires_in: 900,
        }),
        { status: 200 },
      ),
    );

    const earlyStart = startXaiDeviceAuth(earlyFetch, {
      executor,
      now: Date.now(),
    });
    // Allow the early start to reserve its claim before the later start.
    await Promise.resolve();
    await Promise.resolve();

    const lateResult = await startXaiDeviceAuth(lateFetch, {
      executor,
      now: Date.now() + 1,
    });
    expect(lateResult.deviceCode).toBe('fresh-device');

    releaseEarlyHttp?.();
    await expect(earlyStart).rejects.toThrow(
      XAI_SUBSCRIPTION_INTERNAL.supersededDeviceFlowError,
    );

    const pending = JSON.parse(
      store.get(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)!,
    ) as { deviceCode: string };
    expect(pending.deviceCode).toBe('fresh-device');
  });

  it('fails closed when the device-code endpoint returns an error', async () => {
    const { executor, store } = makeExecutor();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503 }));

    await expect(startXaiDeviceAuth(fetchImpl, { executor })).rejects.toThrow(
      'Failed to initiate xAI device authorization: 503',
    );
    // Failed start clears its provisional claim.
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)).toBe(false);
  });
});

describe('pollXaiDeviceAuth', () => {
  it('reports pending authorization without storing a credential', async () => {
    const { executor, values, store } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });
    const result = await pollXaiDeviceAuth(
      { deviceCode: 'device-1' },
      {
        executor,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'authorization_pending' }), {
            status: 400,
          }),
        ),
      },
    );

    expect(result).toEqual({ status: 'pending' });
    // values may be unused for pending; subscription secret must stay empty
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.secretName)).toBe(false);
    expect(values).not.toHaveBeenCalled();
  });

  it('honors slow_down with an optional interval bump', async () => {
    const { executor, values } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });
    const result = await pollXaiDeviceAuth(
      { deviceCode: 'device-1' },
      {
        executor,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'slow_down', interval: 10 }), {
            status: 400,
          }),
        ),
      },
    );

    expect(result).toEqual({ status: 'pending', intervalMs: 10_000 });
    expect(values).not.toHaveBeenCalled();
  });

  it('encrypts and stores tokens after approval without returning them as public status', async () => {
    const { executor, values, store } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });
    const idToken = makeJwt({ email: 'user@example.com' });
    const result = await pollXaiDeviceAuth(
      { deviceCode: 'device-1' },
      {
        executor,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: 'access-secret',
              refresh_token: 'refresh-secret',
              expires_in: 3600,
              id_token: idToken,
            }),
            { status: 200 },
          ),
        ),
      },
    );

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      throw new Error('expected success');
    }
    // The internal record has tokens for persistence, but the public status
    // shape used by tRPC never includes them.
    expect(result.record).toMatchObject({
      access: 'access-secret',
      refresh: 'refresh-secret',
      status: 'connected',
      email: 'user@example.com',
    });
    expect(values).toHaveBeenCalled();
    const stored = JSON.parse(
      store.get(XAI_SUBSCRIPTION_INTERNAL.secretName)!,
    ) as { access: string; refresh: string };
    expect(stored.access).toBe('access-secret');
    expect(stored.refresh).toBe('refresh-secret');
    // Pending flow cleared after successful connect.
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)).toBe(false);
  });

  it('does not persist tokens for a superseded device code', async () => {
    const { executor, store } = makeExecutor({
      // Active flow is a newer restart; old poll still holds device-1.
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-2'),
    });

    const result = await pollXaiDeviceAuth(
      { deviceCode: 'device-1' },
      {
        executor,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: 'stale-access',
              refresh_token: 'stale-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      },
    );

    expect(result).toEqual({
      status: 'failed',
      error: XAI_SUBSCRIPTION_INTERNAL.supersededDeviceFlowError,
    });
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.secretName)).toBe(false);
    // Active newer pending remains so the restart can complete.
    expect(
      JSON.parse(store.get(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)!)
        .deviceCode,
    ).toBe('device-2');
  });

  it('does not persist when a newer start wins while the token exchange is in flight', async () => {
    const { executor, store } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });

    const fetchImpl = vi.fn().mockImplementation(async () => {
      // Simulate cancel/reopen registering a newer device code mid-request.
      store.set(
        XAI_SUBSCRIPTION_INTERNAL.pendingSecretName,
        JSON.stringify(activePending('device-2')),
      );
      return new Response(
        JSON.stringify({
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });

    const result = await pollXaiDeviceAuth(
      { deviceCode: 'device-1' },
      { executor, fetchImpl },
    );

    expect(result).toEqual({
      status: 'failed',
      error: XAI_SUBSCRIPTION_INTERNAL.supersededDeviceFlowError,
    });
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.secretName)).toBe(false);
    expect(
      JSON.parse(store.get(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)!)
        .deviceCode,
    ).toBe('device-2');
  });

  it('fails when the grant has no refresh token', async () => {
    const { executor } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });
    const result = await pollXaiDeviceAuth(
      { deviceCode: 'device-1' },
      {
        executor,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: 'access-only',
            }),
            { status: 200 },
          ),
        ),
      },
    );

    expect(result).toEqual({
      status: 'failed',
      error: 'xAI device authorization returned no refresh_token.',
    });
  });

  it('fails on access_denied and expired_token', async () => {
    const { executor: executorDenied, store: storeDenied } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });

    await expect(
      pollXaiDeviceAuth(
        { deviceCode: 'device-1' },
        {
          executor: executorDenied,
          fetchImpl: vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: 'access_denied' }), {
              status: 400,
            }),
          ),
        },
      ),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(storeDenied.has(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)).toBe(
      false,
    );

    const { executor: executorExpired } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });

    await expect(
      pollXaiDeviceAuth(
        { deviceCode: 'device-1' },
        {
          executor: executorExpired,
          fetchImpl: vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: 'expired_token' }), {
              status: 400,
            }),
          ),
        },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('expired'),
    });
  });
});

describe('getXaiSubscriptionStatus', () => {
  it('reports disconnected when no subscription record exists', async () => {
    const { executor } = makeExecutor();
    await expect(getXaiSubscriptionStatus(executor)).resolves.toEqual({
      connected: false,
      status: 'disconnected',
    });
  });

  it('reports connected without access or refresh tokens', async () => {
    const { executor } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.secretName]: {
        refresh: 'rt',
        access: 'at',
        expires: Date.now() + 60_000,
        status: 'connected',
        email: 'a@b.com',
        connectedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const status = await getXaiSubscriptionStatus(executor);
    expect(status).toEqual({
      connected: true,
      status: 'connected',
      email: 'a@b.com',
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(status).not.toHaveProperty('access');
    expect(status).not.toHaveProperty('refresh');
  });
});

describe('disconnectXaiSubscription', () => {
  it('deletes the encrypted deployment secret so status becomes disconnected', async () => {
    const connectedRecord = {
      refresh: 'rt',
      access: 'at',
      expires: Date.now() + 60_000,
      status: 'connected' as const,
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { executor, del, delWhere, store } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.secretName]: connectedRecord,
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });

    // Before disconnect the record is still loadable.
    await expect(getXaiSubscriptionStatus(executor)).resolves.toMatchObject({
      connected: true,
      status: 'connected',
    });

    await disconnectXaiSubscription(executor);

    expect(del).toHaveBeenCalled();
    expect(delWhere).toHaveBeenCalled();
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.secretName)).toBe(false);
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)).toBe(false);

    await expect(getXaiSubscriptionStatus(executor)).resolves.toEqual({
      connected: false,
      status: 'disconnected',
    });
  });

  it('wins over an in-flight poll that already received tokens', async () => {
    const { executor, store } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.pendingSecretName]: activePending('device-1'),
    });

    const fetchImpl = vi.fn().mockImplementation(async () => {
      // Operator disconnects while the device poll is awaiting xAI.
      await disconnectXaiSubscription(executor);
      return new Response(
        JSON.stringify({
          access_token: 'should-not-persist',
          refresh_token: 'should-not-persist',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });

    const result = await pollXaiDeviceAuth(
      { deviceCode: 'device-1' },
      { executor, fetchImpl },
    );

    expect(result).toEqual({
      status: 'failed',
      error: XAI_SUBSCRIPTION_INTERNAL.supersededDeviceFlowError,
    });
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.secretName)).toBe(false);
    expect(store.has(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName)).toBe(false);
  });
});

describe('getFreshXaiAccessToken', () => {
  it('returns the existing access token when it is outside the safety margin', async () => {
    const expires = Date.now() + XAI_REFRESH_SAFETY_MARGIN_MS + 60_000;
    const { executor } = makeExecutor({
      [XAI_SUBSCRIPTION_INTERNAL.secretName]: {
        refresh: 'rt',
        access: 'still-valid',
        expires,
        status: 'connected',
        connectedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const fetchImpl = vi.fn();

    const fresh = await getFreshXaiAccessToken({
      executor,
      fetchImpl,
      now: Date.now(),
    });

    expect(fresh).toMatchObject({ access: 'still-valid', refresh: 'rt' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes an expiring access token and replaces the stored record', async () => {
    const now = Date.now();
    const expires = now + 30_000; // well inside the safety margin
    const existing = {
      refresh: 'old-rt',
      access: 'old-at',
      expires,
      status: 'connected' as const,
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const { executor, values } = makeExecutor(
      { [XAI_SUBSCRIPTION_INTERNAL.secretName]: existing },
      { withTransaction: true },
    );

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 7200,
        }),
        { status: 200 },
      ),
    );

    const fresh = await getFreshXaiAccessToken({
      executor,
      fetchImpl,
      now,
    });

    expect(fresh).toMatchObject({
      access: 'new-at',
      refresh: 'new-rt',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      XAI_OAUTH_TOKEN_ENDPOINT,
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-rt');
    expect(values).toHaveBeenCalled();
  });

  it('does not clobber a newer subscription when refresh HTTP is still in flight', async () => {
    const now = Date.now();
    const expires = now + 30_000;
    const existing = {
      refresh: 'old-rt',
      access: 'old-at',
      expires,
      status: 'connected' as const,
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const reconnected = {
      refresh: 'fresh-rt',
      access: 'fresh-at',
      expires: now + 3_600_000,
      status: 'connected' as const,
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };

    const { executor, store } = makeExecutor(
      { [XAI_SUBSCRIPTION_INTERNAL.secretName]: existing },
      { withTransaction: true },
    );

    const fetchImpl = vi.fn().mockImplementation(async () => {
      // A concurrent device-code connect replaces the secret mid-refresh.
      store.set(
        XAI_SUBSCRIPTION_INTERNAL.secretName,
        JSON.stringify(reconnected),
      );
      return new Response(
        JSON.stringify({
          access_token: 'stale-refresh-at',
          refresh_token: 'stale-refresh-rt',
          expires_in: 7200,
        }),
        { status: 200 },
      );
    });

    const fresh = await getFreshXaiAccessToken({
      executor,
      fetchImpl,
      now,
    });

    expect(fresh).toMatchObject({
      access: 'fresh-at',
      refresh: 'fresh-rt',
    });
    const stored = JSON.parse(
      store.get(XAI_SUBSCRIPTION_INTERNAL.secretName)!,
    ) as { access: string; refresh: string };
    expect(stored.access).toBe('fresh-at');
    expect(stored.refresh).toBe('fresh-rt');
  });

  it('returns null when no connected subscription exists', async () => {
    const { executor } = makeExecutor();
    await expect(
      getFreshXaiAccessToken({ executor, fetchImpl: vi.fn() }),
    ).resolves.toBeNull();
  });

  it('marks the record errored and returns null when refresh fails terminally', async () => {
    const now = Date.now();
    const expires = now + 30_000; // inside the safety margin
    const existing = {
      refresh: 'stale-rt',
      access: 'stale-at',
      expires,
      status: 'connected' as const,
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const { executor, values, store } = makeExecutor(
      { [XAI_SUBSCRIPTION_INTERNAL.secretName]: existing },
      { withTransaction: true },
    );

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('invalid_grant', { status: 401 }));

    const fresh = await getFreshXaiAccessToken({
      executor,
      fetchImpl,
      now,
    });

    expect(fresh).toBeNull();
    expect(values).toHaveBeenCalled();
    const stored = JSON.parse(
      store.get(XAI_SUBSCRIPTION_INTERNAL.secretName)!,
    ) as { status: string; error?: string; access: string };
    expect(stored.status).toBe('error');
    expect(stored.error).toMatch(/xAI token refresh failed: 401/);
    // Keep the prior tokens so reconnect can be distinguished from wipe.
    expect(stored.access).toBe('stale-at');
  });

  it('keeps connected status on a transient refresh failure and serves remaining access', async () => {
    const now = Date.now();
    const expires = now + 30_000; // inside the safety margin but still valid
    const existing = {
      refresh: 'rt',
      access: 'still-usable',
      expires,
      status: 'connected' as const,
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const { executor, store } = makeExecutor(
      { [XAI_SUBSCRIPTION_INTERNAL.secretName]: existing },
      { withTransaction: true },
    );

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('upstream unavailable', { status: 503 }));

    const fresh = await getFreshXaiAccessToken({
      executor,
      fetchImpl,
      now,
    });

    expect(fresh).toMatchObject({
      access: 'still-usable',
      refresh: 'rt',
    });
    const stored = JSON.parse(
      store.get(XAI_SUBSCRIPTION_INTERNAL.secretName)!,
    ) as { status: string; access: string };
    expect(stored.status).toBe('connected');
    expect(stored.access).toBe('still-usable');
  });
});

describe('XAI_SUBSCRIPTION_INTERNAL', () => {
  it('exposes the deployment secret name for ops tooling', () => {
    expect(XAI_SUBSCRIPTION_INTERNAL.secretName).toBe('XAI_SUBSCRIPTION_OAUTH');
    expect(XAI_SUBSCRIPTION_INTERNAL.pendingSecretName).toBe(
      'XAI_SUBSCRIPTION_PENDING_DEVICE',
    );
  });
});
