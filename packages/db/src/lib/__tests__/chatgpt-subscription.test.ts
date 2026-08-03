import { describe, expect, it, vi } from 'vitest';

vi.mock('../../encryption', () => ({
  encryptJSON: (value: unknown) => JSON.stringify(value),
  decryptSecrets: async (value: string) => JSON.parse(value) as unknown,
}));

import {
  buildOpenCodeAuthContent,
  extractAccountIdFromTokens,
} from '../chatgpt-subscription';

describe('extractAccountIdFromTokens', () => {
  function makeJwt(payload: object): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
      'base64url',
    );
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.sig`;
  }

  it('extracts chatgpt_account_id from the id_token claims', () => {
    const idToken = makeJwt({ chatgpt_account_id: 'acct-123' });

    expect(
      extractAccountIdFromTokens({
        id_token: idToken,
        access_token: 'at',
        refresh_token: 'rt',
      }),
    ).toBe('acct-123');
  });

  it('extracts from the namespaced auth claim', () => {
    const idToken = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-ns' },
    });

    expect(
      extractAccountIdFromTokens({
        id_token: idToken,
        access_token: 'at',
        refresh_token: 'rt',
      }),
    ).toBe('acct-ns');
  });

  it('falls back to the first organization id', () => {
    const idToken = makeJwt({ organizations: [{ id: 'org-1' }] });

    expect(
      extractAccountIdFromTokens({
        id_token: idToken,
        access_token: 'at',
        refresh_token: 'rt',
      }),
    ).toBe('org-1');
  });

  it('returns undefined when no account id is present', () => {
    expect(
      extractAccountIdFromTokens({
        access_token: 'at',
        refresh_token: 'rt',
      }),
    ).toBeUndefined();
  });
});

describe('buildOpenCodeAuthContent', () => {
  it('produces the opencode OAuth auth record under the openai provider id', () => {
    const content = buildOpenCodeAuthContent({
      access: 'at',
      refresh: 'rt',
      expires: 1_700_000_000_000,
      accountId: 'acct-1',
    });

    const parsed = JSON.parse(content) as Record<string, unknown>;

    expect(parsed.openai).toMatchObject({
      type: 'oauth',
      refresh: 'rt',
      access: 'at',
      expires: 1_700_000_000_000,
      accountId: 'acct-1',
    });
  });

  it('omits accountId when not provided', () => {
    const content = buildOpenCodeAuthContent({
      access: 'at',
      refresh: 'rt',
      expires: 1_700_000_000_000,
    });

    const parsed = JSON.parse(content) as {
      openai: { accountId?: string };
    };

    expect(parsed.openai.accountId).toBeUndefined();
  });
});

describe('getChatGptSubscriptionStatus', () => {
  function makeStatusExecutor(record: unknown) {
    const limit = vi
      .fn()
      .mockResolvedValue(record ? [{ value: JSON.stringify(record) }] : []);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { select } as never;
  }

  it('reports disconnected when no subscription record exists', async () => {
    const { getChatGptSubscriptionStatus } =
      await import('../chatgpt-subscription');

    const status = await getChatGptSubscriptionStatus(makeStatusExecutor(null));

    expect(status).toEqual({
      connected: false,
      status: 'disconnected',
      fastMode: false,
    });
  });

  it('reports connected when a connected record exists', async () => {
    const { getChatGptSubscriptionStatus } =
      await import('../chatgpt-subscription');

    const status = await getChatGptSubscriptionStatus(
      makeStatusExecutor({
        refresh: 'rt',
        access: 'at',
        expires: 1,
        status: 'connected',
        accountId: 'acct',
        email: 'a@b.com',
        fastMode: true,
        connectedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    expect(status).toMatchObject({
      connected: true,
      status: 'connected',
      accountId: 'acct',
      email: 'a@b.com',
      fastMode: true,
    });
  });

  it('reports errored when an errored record exists', async () => {
    const { getChatGptSubscriptionStatus } =
      await import('../chatgpt-subscription');

    const status = await getChatGptSubscriptionStatus(
      makeStatusExecutor({
        refresh: 'rt',
        access: 'at',
        expires: 1,
        status: 'error',
        error: 'refresh failed',
        connectedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    expect(status).toMatchObject({
      connected: false,
      status: 'error',
      error: 'refresh failed',
    });
  });
});

describe('updateChatGptSubscriptionFastMode', () => {
  function makeExecutor(record: unknown) {
    const limit = vi
      .fn()
      .mockResolvedValue(record ? [{ value: JSON.stringify(record) }] : []);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const execute = vi.fn().mockResolvedValue(undefined);
    const tx = { select, insert, execute };
    const transaction = vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    return {
      executor: { select, insert, transaction } as never,
      execute,
      values,
    };
  }

  it('persists fast mode alongside the existing subscription record', async () => {
    const { executor, execute, values } = makeExecutor({
      refresh: 'rt',
      access: 'at',
      expires: 1,
      status: 'connected',
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const { updateChatGptSubscriptionFastMode } =
      await import('../chatgpt-subscription');

    await updateChatGptSubscriptionFastMode(true, executor);

    expect(execute).toHaveBeenCalled();
    const persisted = JSON.parse(values.mock.calls[0]![0].value) as {
      fastMode?: boolean;
    };
    expect(persisted.fastMode).toBe(true);
  });

  it('rejects updates when no subscription is connected', async () => {
    const { executor } = makeExecutor(null);
    const { updateChatGptSubscriptionFastMode } =
      await import('../chatgpt-subscription');

    await expect(
      updateChatGptSubscriptionFastMode(true, executor),
    ).rejects.toThrow('ChatGPT subscription is not connected.');
  });
});

describe('getFreshChatGptAccessToken', () => {
  const mockRecord = {
    refresh: 'rt-old',
    access: 'at-old',
    expires: Date.now() + 1000,
    status: 'connected' as const,
    fastMode: true,
    connectedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  function makeQueryChain(
    record:
      | (Omit<typeof mockRecord, 'fastMode'> & { fastMode?: boolean })
      | null,
  ) {
    const limit = vi
      .fn()
      .mockResolvedValue(record ? [{ value: JSON.stringify(record) }] : []);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    return { select, insert, limit };
  }

  function makeExecutor(
    record:
      | (Omit<typeof mockRecord, 'fastMode'> & { fastMode?: boolean })
      | null,
  ) {
    const chain = makeQueryChain(record);
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: chain.select,
      insert: chain.insert,
    };
    const executor = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => cb(tx)),
      select: chain.select,
      insert: chain.insert,
    };
    return { executor, tx, chain };
  }

  it('returns null when no connected subscription exists', async () => {
    const { executor } = makeExecutor(null);
    const { getFreshChatGptAccessToken } =
      await import('../chatgpt-subscription');

    const result = await getFreshChatGptAccessToken({
      executor: executor as never,
      now: Date.now(),
    });

    expect(result).toBeNull();
  });

  it('refreshes an expiring token and persists the rotated tokens', async () => {
    const { executor, chain } = makeExecutor(mockRecord);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        expires_in: 3600,
        id_token: undefined,
      }),
    });
    const { getFreshChatGptAccessToken } =
      await import('../chatgpt-subscription');

    const result = await getFreshChatGptAccessToken({
      executor: executor as never,
      fetchImpl: fetchImpl as never,
      now: Date.now(),
    });

    expect(result).not.toBeNull();
    expect(result!.access).toBe('at-new');
    expect(result!.refresh).toBe('rt-new');
    expect(fetchImpl).toHaveBeenCalled();
    // The persisted record was updated inside the transaction.
    expect(chain.insert).toHaveBeenCalled();
    const persisted = JSON.parse(
      chain.insert.mock.results[0]!.value.values.mock.calls[0]![0].value,
    ) as { fastMode?: boolean };
    expect(persisted.fastMode).toBe(true);
  });

  it('marks a legacy record errored and persists disabled fast mode when refresh fails', async () => {
    const { fastMode: _fastMode, ...legacyRecord } = mockRecord;
    const { executor, chain } = makeExecutor(legacyRecord);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const { getFreshChatGptAccessToken } =
      await import('../chatgpt-subscription');

    const result = await getFreshChatGptAccessToken({
      executor: executor as never,
      fetchImpl: fetchImpl as never,
      now: Date.now(),
    });

    expect(result).toBeNull();
    expect(chain.insert).toHaveBeenCalled();
    const persisted = JSON.parse(
      chain.insert.mock.results[0]!.value.values.mock.calls[0]![0].value,
    ) as { fastMode?: boolean };
    expect(persisted.fastMode).toBe(false);
  });
});

describe('startChatGptDeviceAuth', () => {
  function makeStartFetch(body: Record<string, unknown>) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        device_auth_id: 'dev-1',
        user_code: 'CODE',
        interval: '5',
        ...body,
      }),
    });
  }

  it('derives the poll deadline from the issuer expires_at', async () => {
    const now = Date.parse('2026-07-31T22:04:00.000Z');
    const fetchImpl = makeStartFetch({
      expires_at: '2026-07-31T22:19:00.000Z',
    });
    const { startChatGptDeviceAuth } = await import('../chatgpt-subscription');

    const result = await startChatGptDeviceAuth(fetchImpl as never, now);

    expect(result.expiresInMs).toBe(15 * 60 * 1000);
    expect(result.intervalMs).toBe(5000);
  });

  it('falls back to the default TTL when expires_at is absent or unparseable', async () => {
    const now = Date.now();
    const { startChatGptDeviceAuth } = await import('../chatgpt-subscription');

    const missing = await startChatGptDeviceAuth(
      makeStartFetch({}) as never,
      now,
    );
    const garbage = await startChatGptDeviceAuth(
      makeStartFetch({ expires_at: 'not-a-date' }) as never,
      now,
    );

    expect(missing.expiresInMs).toBe(900 * 1000);
    expect(garbage.expiresInMs).toBe(900 * 1000);
  });

  it('never returns a non-positive window for an already expired code', async () => {
    const now = Date.parse('2026-07-31T22:30:00.000Z');
    const fetchImpl = makeStartFetch({
      expires_at: '2026-07-31T22:19:00.000Z',
    });
    const { startChatGptDeviceAuth } = await import('../chatgpt-subscription');

    const result = await startChatGptDeviceAuth(fetchImpl as never, now);

    expect(result.expiresInMs).toBeGreaterThan(0);
  });
});

describe('pollChatGptDeviceAuth', () => {
  function makeErrorFetch(status: number, code?: string) {
    return vi.fn().mockResolvedValue({
      status,
      json: async () => ({
        error: {
          message: 'irrelevant prose',
          type: 'invalid_request_error',
          code,
        },
      }),
    });
  }

  it('returns pending while the user has not authorized', async () => {
    const fetchImpl = makeErrorFetch(403, 'deviceauth_authorization_pending');
    const { pollChatGptDeviceAuth } = await import('../chatgpt-subscription');

    const result = await pollChatGptDeviceAuth({
      deviceAuthId: 'dev-1',
      userCode: 'CODE',
      fetchImpl: fetchImpl as never,
    });

    expect(result).toEqual({ status: 'pending' });
  });

  it('fails as blocked on a 403 that is not the pending code', async () => {
    const fetchImpl = makeErrorFetch(403, 'deviceauth_forbidden');
    const { pollChatGptDeviceAuth } = await import('../chatgpt-subscription');

    const result = await pollChatGptDeviceAuth({
      deviceAuthId: 'dev-1',
      userCode: 'CODE',
      fetchImpl: fetchImpl as never,
    });

    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ reason: 'blocked' });
  });

  it('fails as expired when the issuer no longer knows the code', async () => {
    const fetchImpl = makeErrorFetch(404, 'deviceauth_not_found');
    const { pollChatGptDeviceAuth } = await import('../chatgpt-subscription');

    const result = await pollChatGptDeviceAuth({
      deviceAuthId: 'dev-1',
      userCode: 'CODE',
      fetchImpl: fetchImpl as never,
    });

    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ reason: 'expired' });
  });

  it('stays pending when the error body carries no structured code', async () => {
    const { pollChatGptDeviceAuth } = await import('../chatgpt-subscription');

    const noCode = await pollChatGptDeviceAuth({
      deviceAuthId: 'dev-1',
      userCode: 'CODE',
      fetchImpl: makeErrorFetch(403) as never,
    });
    const unparseable = await pollChatGptDeviceAuth({
      deviceAuthId: 'dev-1',
      userCode: 'CODE',
      fetchImpl: vi.fn().mockResolvedValue({
        status: 403,
        json: async () => {
          throw new Error('not json');
        },
      }) as never,
    });

    expect(noCode).toEqual({ status: 'pending' });
    expect(unparseable).toEqual({ status: 'pending' });
  });

  it('backs off instead of failing when polling is rate limited', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 429 });
    const { pollChatGptDeviceAuth } = await import('../chatgpt-subscription');

    const result = await pollChatGptDeviceAuth({
      deviceAuthId: 'dev-1',
      userCode: 'CODE',
      fetchImpl: fetchImpl as never,
    });

    expect(result).toEqual({ status: 'pending', intervalMs: 5000 });
  });

  it('returns success after exchanging the device authorization code', async () => {
    const fetchImpl = vi.fn();
    fetchImpl
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_code: 'auth-code',
          code_verifier: 'verifier',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
        }),
      });
    const { pollChatGptDeviceAuth } = await import('../chatgpt-subscription');

    // Avoid persisting to a real DB: pass an executor whose save is a no-op.
    const executor = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    } as never;

    const result = await pollChatGptDeviceAuth({
      deviceAuthId: 'dev-1',
      userCode: 'CODE',
      fetchImpl: fetchImpl as never,
      executor,
    });

    expect(result.status).toBe('success');
  });
});
