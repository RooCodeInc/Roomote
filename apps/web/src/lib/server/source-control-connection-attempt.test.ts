import {
  db,
  deploymentSettings,
  eq,
  fastAgentConversations,
  sourceControlConnectionRequests,
  userFactory,
  users,
  ensureSessionForFastConversation,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn().mockResolvedValue({ ready: 0 }),
  authorize: vi.fn(),
  exchange: vi.fn(),
  sync: vi.fn(),
  setupNotify: vi.fn(),
}));
vi.mock('./auth-context', () => ({ authorize: mocks.authorize }));
vi.mock('./setup-bootstrap-state', () => ({
  getSetupBootstrapState: async () => ({ setupOpen: false }),
}));
vi.mock('@/trpc/commands/setup/setup-session', () => ({
  notifySetupSourceControlSynchronized: mocks.setupNotify,
}));
vi.mock('@/trpc/commands/source-control', () => ({
  syncRepositoriesCommand: mocks.sync,
}));
vi.mock('@roomote/gitlab', () => ({
  exchangeGitLabOAuthCode: mocks.exchange,
  resolveGitLabBaseUrl: async () => 'https://gitlab.com',
  buildGitLabOAuthRedirectUri: (origin: string) =>
    `${origin}/api/source-control/gitlab/oauth/callback`,
}));
vi.mock('@roomote/gitea', () => ({
  exchangeGiteaOAuthCode: mocks.exchange,
  resolveGiteaBaseUrl: async () => 'https://gitea.example',
  buildGiteaOAuthRedirectUri: (origin: string) =>
    `${origin}/api/source-control/gitea/oauth/callback`,
}));
vi.mock('@roomote/bitbucket', () => ({
  exchangeBitbucketOAuthCode: mocks.exchange,
  buildBitbucketOAuthRedirectUri: (origin: string) =>
    `${origin}/api/source-control/bitbucket/oauth/callback`,
}));
vi.mock('./env', () => ({
  getBetterAuthSecret: () => 'connection-state-test-secret',
}));
vi.mock('@roomote/sdk/server', async () => {
  const actual =
    await import('../../../../../packages/sdk/src/server/lib/source-control-connection');
  return {
    ...actual,
    reconcileSourceControlConnectionRequests: mocks.reconcile,
  };
});

import {
  beginConnectionAttempt,
  completeConnectionAttempt,
} from './source-control-connection-attempt';
import { verifyConnectionState } from './source-control-connection-state';
import { connectionOAuthCallback } from './source-control-connection-callback';
import { connectionRequestCommand } from '@/trpc/commands/source-control/connection-requests';
import { getSourceControlSyncStartedAt } from '@roomote/sdk/server';

describe('connection attempts and request authorization (PostgreSQL)', () => {
  let admin: Awaited<ReturnType<typeof userFactory.create>>;
  let member: Awaited<ReturnType<typeof userFactory.create>>;
  let reader: Awaited<ReturnType<typeof userFactory.create>>;
  const conversationIds: string[] = [];
  const auth = (user: { id: string; role: string }) =>
    ({
      success: true,
      userType: 'user',
      userId: user.id,
      isAdmin: user.role === 'admin',
    }) as UserAuthSuccess;
  const makeRequest = async (
    provider: 'gitlab' | 'github' | 'gitea' | 'bitbucket' | 'ado' = 'gitlab',
  ) => {
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: member.id,
        surface: 'web',
        workspaceId: 'connection-tests',
        conversationId: crypto.randomUUID(),
      })
      .returning();
    conversationIds.push(conversation!.id);
    const session = await ensureSessionForFastConversation(
      db,
      conversation!.id,
    );
    const [request] = await db
      .insert(sourceControlConnectionRequests)
      .values({
        conversationId: conversation!.id,
        actorUserId: member.id,
        turnId: 'test-turn',
        provider,
        repositoryFullName: 'org/required',
        capability: 'repository',
        reason: 'not_connected',
        expiresAt: new Date(Date.now() + 86400000),
      })
      .returning();
    return { request: request!, session };
  };
  beforeEach(async () => {
    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        metadata: { optional_source_control_enabled: true },
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: { metadata: { optional_source_control_enabled: true } },
      });
    vi.clearAllMocks();
    for (const provider of ['GITLAB', 'GITEA', 'BITBUCKET']) {
      vi.stubEnv(`${provider}_CLIENT_ID`, 'test-client');
      vi.stubEnv(`${provider}_CLIENT_SECRET`, 'test-secret');
    }
    mocks.exchange.mockResolvedValue(undefined);
    mocks.sync.mockResolvedValue({ success: true, repositories: [] });
    admin = await userFactory.create({ role: 'admin' });
    member = await userFactory.create({ role: 'member' });
    reader = await userFactory.create({ role: 'member' });
    mocks.authorize.mockResolvedValue(auth(admin));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const id of conversationIds.splice(0))
      await db
        .delete(fastAgentConversations)
        .where(eq(fastAgentConversations.id, id));
    for (const user of [admin, member, reader])
      await db.delete(users).where(eq(users.id, user.id));
  });

  it.each([false, 'true', null])(
    'fails closed on rollout value %s while preserving ordinary settings authorization and request visibility',
    async (flag) => {
      const { request, session } = await makeRequest();
      const state = await beginConnectionAttempt(auth(admin), {
        provider: 'gitlab',
        requestId: request.id,
      });
      await db
        .update(deploymentSettings)
        .set({
          metadata:
            flag === null ? {} : { optional_source_control_enabled: flag },
        })
        .where(eq(deploymentSettings.id, 'default'));
      await expect(
        beginConnectionAttempt(auth(admin), {
          provider: 'gitlab',
          requestId: request.id,
        }),
      ).rejects.toThrow('disabled');
      const sync = vi.fn(async () => ({ success: true }));
      await expect(
        completeConnectionAttempt(
          auth(admin),
          { provider: 'gitlab', state },
          sync,
        ),
      ).rejects.toThrow('disabled');
      expect(sync).not.toHaveBeenCalled();
      const view = await connectionRequestCommand(auth(admin), {
        sessionId: session.id,
        requestId: request.id,
      });
      expect(view).toMatchObject({
        enabled: false,
        canCheck: false,
        canConnect: false,
      });
      await expect(
        connectionRequestCommand(
          auth(admin),
          { sessionId: session.id, requestId: request.id },
          'check',
        ),
      ).rejects.toThrow('disabled');
      expect(
        await connectionRequestCommand(
          auth(member),
          { sessionId: session.id, requestId: request.id },
          'cancel',
        ),
      ).toMatchObject({ status: 'cancelled' });
      expect(
        await beginConnectionAttempt(auth(admin), {
          provider: 'gitlab',
          returnTarget: '/settings/source-control',
        }),
      ).toBeTruthy();
      expect(mocks.reconcile).not.toHaveBeenCalled();
    },
  );
  it('authorizes reads but limits cancellation to requester/admin, and scopes IDs to the Session', async () => {
    const { request, session } = await makeRequest();
    const other = await makeRequest();
    const input = { requestId: request.id, sessionId: session.id };
    const view = await connectionRequestCommand(auth(reader), input);
    expect(view).toMatchObject({
      id: request.id,
      canConnect: false,
      canCancel: false,
    });
    expect(view).not.toHaveProperty('revision');
    expect(view).not.toHaveProperty('actorUserId');
    expect(
      await connectionRequestCommand(auth(admin), {
        ...input,
        sessionId: other.session.id,
      }),
    ).toBeNull();
    await expect(
      connectionRequestCommand(auth(reader), input, 'cancel'),
    ).rejects.toThrow();
    await expect(
      connectionRequestCommand(auth(reader), input, 'check'),
    ).rejects.toThrow();
    expect(
      (await connectionRequestCommand(auth(member), input, 'cancel'))?.status,
    ).toBe('cancelled');
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, reader.id));
    await expect(
      connectionRequestCommand(auth(reader), input),
    ).rejects.toThrow();
  });
  it.each(['gitlab', 'gitea', 'bitbucket', 'github', 'ado'] as const)(
    'binds %s attempts to live admin/provider/request and rejects replacement callbacks',
    async (provider) => {
      const { request, session } = await makeRequest(provider);
      await expect(
        beginConnectionAttempt(auth(member), {
          provider,
          requestId: request.id,
        }),
      ).rejects.toThrow('Forbidden');
      await expect(
        beginConnectionAttempt(auth(admin), {
          provider: provider === 'github' ? 'gitlab' : 'github',
          requestId: request.id,
        }),
      ).rejects.toThrow();
      const first = await beginConnectionAttempt(auth(admin), {
        provider,
        requestId: request.id,
        returnTarget: '//attacker',
      });
      expect(
        verifyConnectionState(first, admin.id, provider).returnTarget,
      ).toBe(`/sessions/${session.id}?connectionRequest=${request.id}`);
      const second = await beginConnectionAttempt(auth(admin), {
        provider,
        requestId: request.id,
      });
      const sync = vi.fn().mockResolvedValue({ success: true });
      await expect(
        completeConnectionAttempt(
          auth(admin),
          { provider, state: first },
          sync,
        ),
      ).rejects.toThrow();
      expect(sync).not.toHaveBeenCalled();
      await completeConnectionAttempt(
        auth(admin),
        { provider, state: second },
        sync,
      );
      expect(sync).toHaveBeenCalledTimes(1);
      expect(mocks.reconcile).toHaveBeenCalledWith(
        {
          provider,
          requestId: request.id,
          attemptRevision: expect.any(Number),
          completedByUserId: admin.id,
        },
        {
          successfulSync: {
            startedAt: expect.any(String),
            repositoryFullNames: [],
          },
        },
      );
      await expect(
        completeConnectionAttempt(
          auth(admin),
          { provider, state: second },
          sync,
        ),
      ).rejects.toThrow();
      expect(sync).toHaveBeenCalledTimes(1);
    },
  );
  it('completes simultaneous same-provider tabs against their own requests', async () => {
    const a = await makeRequest();
    const b = await makeRequest();
    const first = await beginConnectionAttempt(auth(admin), {
      provider: 'gitlab',
      requestId: a.request.id,
    });
    const second = await beginConnectionAttempt(auth(admin), {
      provider: 'gitlab',
      requestId: b.request.id,
    });
    const completed = await Promise.all(
      [first, second].map((state) =>
        completeConnectionAttempt(
          auth(admin),
          { provider: 'gitlab', state },
          async () => ({ success: true }),
        ),
      ),
    );
    expect(completed.map((entry) => entry.returnTarget)).toEqual([
      `/sessions/${a.session.id}?connectionRequest=${a.request.id}`,
      `/sessions/${b.session.id}?connectionRequest=${b.request.id}`,
    ]);
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  });
  it.each(['cancelled', 'superseded', 'expired'] as const)(
    'cannot consume %s intent',
    async (status) => {
      const { request } = await makeRequest();
      const state = await beginConnectionAttempt(auth(admin), {
        provider: 'gitlab',
        requestId: request.id,
      });
      await db
        .update(sourceControlConnectionRequests)
        .set({ status })
        .where(eq(sourceControlConnectionRequests.id, request.id));
      const sync = vi.fn().mockResolvedValue({ success: true });
      await expect(
        completeConnectionAttempt(
          auth(admin),
          { provider: 'gitlab', state },
          sync,
        ),
      ).rejects.toThrow();
      expect(sync).not.toHaveBeenCalled();
    },
  );
  it('revalidates an admin role and retains pending intent after sync failure', async () => {
    const { request } = await makeRequest();
    const state = await beginConnectionAttempt(auth(admin), {
      provider: 'gitlab',
      requestId: request.id,
    });
    await db
      .update(users)
      .set({ role: 'member' })
      .where(eq(users.id, admin.id));
    await expect(
      completeConnectionAttempt(
        auth(admin),
        { provider: 'gitlab', state },
        async () => ({ success: true }),
      ),
    ).rejects.toThrow();
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id));
    await completeConnectionAttempt(
      auth(admin),
      { provider: 'gitlab', state },
      async () => ({ success: false }),
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(
      (
        await db.query.sourceControlConnectionRequests.findFirst({
          where: eq(sourceControlConnectionRequests.id, request.id),
        })
      )?.status,
    ).toBe('pending');
    expect(
      await db.query.sourceControlConnectionRequests.findFirst({
        where: eq(sourceControlConnectionRequests.id, request.id),
      }),
    ).toMatchObject({
      reason: 'sync_failed',
      syncAttempt: { provider: 'gitlab', state: 'failed' },
    });
    expect(
      await beginConnectionAttempt(auth(admin), {
        provider: 'gitlab',
        requestId: request.id,
      }),
    ).toBeTruthy();
  });
  it('persists thrown sync failures without reconciling inventory', async () => {
    const { request } = await makeRequest();
    const state = await beginConnectionAttempt(auth(admin), {
      provider: 'gitlab',
      requestId: request.id,
    });
    expect(
      await db.query.sourceControlConnectionRequests.findFirst({
        where: eq(sourceControlConnectionRequests.id, request.id),
      }),
    ).toMatchObject({
      syncAttempt: { state: 'authorizing' },
      reason: 'sync_pending',
    });
    await expect(
      completeConnectionAttempt(
        auth(admin),
        { provider: 'gitlab', state },
        async () => {
          expect(
            await db.query.sourceControlConnectionRequests.findFirst({
              where: eq(sourceControlConnectionRequests.id, request.id),
            }),
          ).toMatchObject({ syncAttempt: { state: 'syncing' } });
          throw new Error('sync failed');
        },
      ),
    ).rejects.toThrow('sync failed');
    expect(
      await db.query.sourceControlConnectionRequests.findFirst({
        where: eq(sourceControlConnectionRequests.id, request.id),
      }),
    ).toMatchObject({
      status: 'pending',
      reason: 'sync_failed',
      syncAttempt: { state: 'failed' },
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('carries exact webhook inventory that arrives during an authenticated GitHub approval callback', async () => {
    const { request } = await makeRequest('github');
    const state = await beginConnectionAttempt(auth(admin), {
      provider: 'github',
      requestId: request.id,
      purpose: 'github-install',
    });
    const startedAt = await getSourceControlSyncStartedAt('github');
    await completeConnectionAttempt(
      auth(admin),
      { provider: 'github', state, reconcile: false },
      async () => {
        const current =
          await db.query.sourceControlConnectionRequests.findFirst({
            where: eq(sourceControlConnectionRequests.id, request.id),
          });
        await db
          .update(sourceControlConnectionRequests)
          .set({
            syncAttempt: {
              ...current!.syncAttempt!,
              successfulSync: {
                startedAt,
                repositoryFullNames: ['org/required'],
              },
            },
          })
          .where(eq(sourceControlConnectionRequests.id, request.id));
        return { success: true };
      },
    );
    expect(mocks.reconcile).toHaveBeenCalledWith(
      {
        provider: 'github',
        requestId: request.id,
        attemptRevision: 2,
        completedByUserId: admin.id,
      },
      { successfulSync: { startedAt, repositoryFullNames: ['org/required'] } },
    );
    expect(
      await db.query.sourceControlConnectionRequests.findFirst({
        where: eq(sourceControlConnectionRequests.id, request.id),
      }),
    ).toMatchObject({ syncAttempt: { state: 'pending' } });
  });
  it.each(['gitlab', 'gitea', 'bitbucket'] as const)(
    '%s callback ignores overwritten tab cookies and syncs before scoped reconciliation',
    async (provider) => {
      const first = await makeRequest(provider);
      const second = await makeRequest(provider);
      const state = await beginConnectionAttempt(auth(admin), {
        provider,
        requestId: first.request.id,
      });
      const otherState = await beginConnectionAttempt(auth(admin), {
        provider,
        requestId: second.request.id,
      });
      const request = new NextRequest(
        `https://roomote.test/api/source-control/${provider}/oauth/callback?${new URLSearchParams({ state, code: 'code-from-first-tab' })}`,
        {
          headers: {
            cookie: `roomote-${provider}-oauth-state=${otherState}; roomote-${provider}-oauth-return-to=/sessions/wrong`,
          },
        },
      );
      const response = await connectionOAuthCallback(
        request,
        provider,
        'https://roomote.test',
      );
      expect(response.headers.get('location')).toBe(
        `https://roomote.test/sessions/${first.session.id}?connectionRequest=${first.request.id}&${provider}=connected`,
      );
      expect(mocks.exchange).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'code-from-first-tab' }),
      );
      expect(mocks.sync).toHaveBeenCalledWith(auth(admin), { provider });
      expect(mocks.reconcile).toHaveBeenCalledWith(
        {
          provider,
          requestId: first.request.id,
          attemptRevision: expect.any(Number),
          completedByUserId: admin.id,
        },
        {
          successfulSync: {
            startedAt: expect.any(String),
            repositoryFullNames: [],
          },
        },
      );
      expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.reconcile.mock.invocationCallOrder[0]!,
      );
      expect(mocks.setupNotify).not.toHaveBeenCalled();
      await connectionOAuthCallback(request, provider, 'https://roomote.test');
      expect(mocks.exchange).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects token callback actor changes, denial and sync failure without reconciliation or raw error redirects', async () => {
    const { request } = await makeRequest();
    const state = await beginConnectionAttempt(auth(admin), {
      provider: 'gitlab',
      requestId: request.id,
    });
    const callback = (query: Record<string, string>) =>
      connectionOAuthCallback(
        new NextRequest(
          `https://roomote.test/api/source-control/gitlab/oauth/callback?${new URLSearchParams({ state, ...query })}`,
        ),
        'gitlab',
        'https://roomote.test',
      );
    mocks.authorize.mockResolvedValue(auth(reader));
    expect((await callback({ code: 'secret-code' })).status).toBe(401);
    expect(mocks.exchange).not.toHaveBeenCalled();
    mocks.authorize.mockResolvedValue(auth(admin));
    const denied = await callback({ error: 'access_denied' });
    expect(denied.headers.get('location')).toContain('gitlab=error');
    expect(mocks.exchange).not.toHaveBeenCalled();
    const retry = await beginConnectionAttempt(auth(admin), {
      provider: 'gitlab',
      requestId: request.id,
    });
    mocks.sync.mockResolvedValue({
      success: false,
      error: 'secret-provider-error',
    });
    const failed = await connectionOAuthCallback(
      new NextRequest(
        `https://roomote.test/callback?${new URLSearchParams({ state: retry, code: 'retry-code' })}`,
      ),
      'gitlab',
      'https://roomote.test',
    );
    expect(failed.headers.get('location')).not.toContain(
      'secret-provider-error',
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
