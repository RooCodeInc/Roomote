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

function makeExecutor(record: unknown = null) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const limit = vi
    .fn()
    .mockResolvedValue(record ? [{ value: JSON.stringify(record) }] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const delWhere = vi.fn().mockResolvedValue(undefined);
  const del = vi.fn().mockReturnValue({ where: delWhere });

  return {
    executor: { insert, select, delete: del } as never,
    values,
    insert,
    select,
    del,
    delWhere,
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

    await expect(startXaiDeviceAuth(fetchImpl)).resolves.toEqual({
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
  });

  it('fails closed when the device-code endpoint returns an error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503 }));

    await expect(startXaiDeviceAuth(fetchImpl)).rejects.toThrow(
      'Failed to initiate xAI device authorization: 503',
    );
  });
});

describe('pollXaiDeviceAuth', () => {
  it('reports pending authorization without storing a credential', async () => {
    const { executor, values } = makeExecutor();
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
    expect(values).not.toHaveBeenCalled();
  });

  it('honors slow_down with an optional interval bump', async () => {
    const { executor, values } = makeExecutor();
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
    const { executor, values } = makeExecutor();
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
    expect(values).toHaveBeenCalledOnce();
    const stored = JSON.parse(
      (values.mock.calls[0] as [{ value: string }])[0].value,
    ) as { access: string; refresh: string };
    expect(stored.access).toBe('access-secret');
    expect(stored.refresh).toBe('refresh-secret');
  });

  it('fails when the grant has no refresh token', async () => {
    const { executor } = makeExecutor();
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
    const { executor } = makeExecutor();

    await expect(
      pollXaiDeviceAuth(
        { deviceCode: 'device-1' },
        {
          executor,
          fetchImpl: vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: 'access_denied' }), {
              status: 400,
            }),
          ),
        },
      ),
    ).resolves.toMatchObject({ status: 'failed' });

    await expect(
      pollXaiDeviceAuth(
        { deviceCode: 'device-1' },
        {
          executor,
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
    const { executor } = makeExecutor(null);
    await expect(getXaiSubscriptionStatus(executor)).resolves.toEqual({
      connected: false,
      status: 'disconnected',
    });
  });

  it('reports connected without access or refresh tokens', async () => {
    const { executor } = makeExecutor({
      refresh: 'rt',
      access: 'at',
      expires: Date.now() + 60_000,
      status: 'connected',
      email: 'a@b.com',
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
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
    const { executor, del, delWhere, select } = makeExecutor(connectedRecord);

    // Before disconnect the record is still loadable.
    await expect(getXaiSubscriptionStatus(executor)).resolves.toMatchObject({
      connected: true,
      status: 'connected',
    });

    await disconnectXaiSubscription(executor);

    expect(del).toHaveBeenCalledOnce();
    expect(delWhere).toHaveBeenCalledOnce();

    // After delete, subsequent loads see no row (simulate cleared secret).
    const emptyLimit = vi.fn().mockResolvedValue([]);
    const emptyWhere = vi.fn().mockReturnValue({ limit: emptyLimit });
    const emptyFrom = vi.fn().mockReturnValue({ where: emptyWhere });
    (select as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      from: emptyFrom,
    });

    await expect(getXaiSubscriptionStatus(executor)).resolves.toEqual({
      connected: false,
      status: 'disconnected',
    });
  });
});

describe('getFreshXaiAccessToken', () => {
  it('returns the existing access token when it is outside the safety margin', async () => {
    const expires = Date.now() + XAI_REFRESH_SAFETY_MARGIN_MS + 60_000;
    const { executor } = makeExecutor({
      refresh: 'rt',
      access: 'still-valid',
      expires,
      status: 'connected',
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
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

    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const limit = vi
      .fn()
      .mockResolvedValueOnce([{ value: JSON.stringify(existing) }])
      .mockResolvedValueOnce([{ value: JSON.stringify(existing) }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const execute = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({ select, insert, execute });
    });

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
      executor: { select, insert, transaction } as never,
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

  it('returns null when no connected subscription exists', async () => {
    const { executor } = makeExecutor(null);
    await expect(
      getFreshXaiAccessToken({ executor, fetchImpl: vi.fn() }),
    ).resolves.toBeNull();
  });
});

describe('XAI_SUBSCRIPTION_INTERNAL', () => {
  it('exposes the deployment secret name for ops tooling', () => {
    expect(XAI_SUBSCRIPTION_INTERNAL.secretName).toBe('XAI_SUBSCRIPTION_OAUTH');
  });
});
