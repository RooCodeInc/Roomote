import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OAuthRefreshError,
  createOAuthRefreshCoordinator,
  isDefinitiveOAuthErrorCode,
} from '../refresh-coordinator';

type Connection = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  status: 'active' | 'reauthorization_required';
};

describe('source-control OAuth refresh coordinator', () => {
  let stored: Connection | null;
  let readConnection: ReturnType<
    typeof vi.fn<() => Promise<Connection | null>>
  >;
  let writeConnection: ReturnType<
    typeof vi.fn<(value: Connection) => Promise<void>>
  >;
  let deleteConnection: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let refresh: ReturnType<
    typeof vi.fn<(value: Connection) => Promise<Connection>>
  >;

  beforeEach(() => {
    stored = {
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: new Date(0).toISOString(),
      status: 'active',
    };
    readConnection = vi.fn(async () => stored);
    writeConnection = vi.fn(async (value) => {
      stored = value;
    });
    deleteConnection = vi.fn(async () => {
      stored = null;
    });
    refresh = vi.fn(async (value) => ({
      ...value,
      accessToken: 'new-access-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
  });

  function coordinator(options?: { retainPreviousAccessToken?: boolean }) {
    return createOAuthRefreshCoordinator({
      readConnection,
      writeConnection,
      deleteConnection,
      isFresh: (connection) => Date.parse(connection.expiresAt) > Date.now(),
      refresh,
      toResult: (connection) => connection.accessToken,
      ...options,
    });
  }

  it('recognizes only definitive OAuth grant and client errors', () => {
    expect(isDefinitiveOAuthErrorCode('invalid_grant')).toBe(true);
    expect(isDefinitiveOAuthErrorCode('invalid_client')).toBe(true);
    expect(isDefinitiveOAuthErrorCode('unauthorized_client')).toBe(true);
    expect(isDefinitiveOAuthErrorCode('temporarily_unavailable')).toBe(false);
  });

  it('returns a fresh connection without refreshing it', async () => {
    stored = {
      ...stored!,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    await expect(coordinator().resolve()).resolves.toBe('old-access-token');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('serializes concurrent refreshes and persists the result once', async () => {
    const instance = coordinator();

    await expect(
      Promise.all([instance.resolve(), instance.resolve(), instance.resolve()]),
    ).resolves.toEqual([
      'new-access-token',
      'new-access-token',
      'new-access-token',
    ]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(writeConnection).toHaveBeenCalledOnce();
  });

  it('does not change connection state for transient failures', async () => {
    refresh.mockRejectedValue(
      new OAuthRefreshError('temporary failure', false),
    );

    await expect(coordinator().resolve()).rejects.toThrow('temporary failure');
    expect(writeConnection).not.toHaveBeenCalled();
  });

  it('marks the latest connection for reauthorization after definitive failures', async () => {
    refresh.mockRejectedValue(
      new OAuthRefreshError('renew authorization', true),
    );

    await expect(coordinator().resolve()).rejects.toThrow(
      'renew authorization',
    );
    expect(writeConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reauthorization_required' }),
    );
  });

  it('recovers a fresh token rotated by a peer after a definitive failure', async () => {
    refresh.mockImplementation(async () => {
      stored = {
        ...stored!,
        accessToken: 'peer-access-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      throw new OAuthRefreshError('stale grant', true);
    });

    await expect(coordinator().resolve()).resolves.toBe('peer-access-token');
    expect(writeConnection).not.toHaveBeenCalled();
  });

  it('waits for refresh and prevents it from recreating a deleted connection', async () => {
    let finishRefresh!: (connection: Connection) => void;
    refresh.mockReturnValue(
      new Promise<Connection>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const instance = coordinator();
    const resolving = instance.resolve();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const deleting = instance.delete();

    finishRefresh({
      ...stored!,
      accessToken: 'late-access-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(resolving).resolves.toBeNull();
    await deleting;
    expect(writeConnection).not.toHaveBeenCalled();
    expect(deleteConnection).toHaveBeenCalledOnce();
  });

  it('does not persist definitive failure recovery after deletion starts', async () => {
    let finishRecoveryRead!: (connection: Connection | null) => void;
    readConnection.mockResolvedValueOnce(stored).mockReturnValueOnce(
      new Promise<Connection | null>((resolve) => {
        finishRecoveryRead = resolve;
      }),
    );
    refresh.mockRejectedValue(new OAuthRefreshError('stale grant', true));
    const instance = coordinator();
    const resolving = instance.resolve();
    await vi.waitFor(() => expect(readConnection).toHaveBeenCalledTimes(2));
    const deleting = instance.delete();

    finishRecoveryRead(stored);

    await expect(resolving).resolves.toBeNull();
    await deleting;
    expect(writeConnection).not.toHaveBeenCalled();
  });

  it('does not overwrite a connection replaced during an in-flight refresh', async () => {
    let finishRefresh!: (connection: Connection) => void;
    refresh.mockReturnValue(
      new Promise<Connection>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const instance = coordinator();
    const resolving = instance.resolve();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const replacement = {
      ...stored!,
      accessToken: 'replacement-access-token',
      refreshToken: 'replacement-refresh-token',
    };
    stored = replacement;
    instance.remember(replacement);

    finishRefresh({
      ...replacement,
      accessToken: 'stale-refreshed-access-token',
    });

    await expect(resolving).resolves.toBeNull();
    expect(writeConnection).not.toHaveBeenCalled();
    expect(instance.isAccessToken('replacement-access-token')).toBe(true);
  });

  it('can retain one previous token for in-flight callers', async () => {
    const instance = coordinator({ retainPreviousAccessToken: true });
    instance.remember(stored!);

    await instance.resolve();

    expect(instance.isAccessToken('old-access-token')).toBe(true);
    expect(instance.isAccessToken('new-access-token')).toBe(true);
    await instance.delete();
    expect(instance.isAccessToken('old-access-token')).toBe(false);
    expect(instance.isAccessToken('new-access-token')).toBe(false);
  });
});
