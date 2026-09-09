import {
  db,
  deploymentSettings,
  sql,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
  githubInstallations,
  githubInstallationFactory,
  repositoryFactory,
  repositories,
  sourceControlConnectionRequests,
  userFactory,
  users,
  ensureSessionForFastConversation,
  environments,
  environmentFactory,
} from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  wake: vi.fn(),
  deliver: vi.fn(),
  acquireLock: vi.fn(),
  listIntegrations: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.wake;
  },
}));
vi.mock('@roomote/redis', () => ({ getRedis: () => ({}) }));
vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  findFastAgentDurableRetryScheduledError: () => null,
  listFastAgentIntegrations: mocks.listIntegrations,
}));
vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createAuthToken: vi.fn(async () => 'test-token'),
}));
vi.mock('./fast-agent-parent-event', () => ({
  buildEventClientMessageSeed: (event: { requestId: string }) =>
    `fast-parent-connection-ready:${event.requestId}`,
  deliverFastAgentParentEventWithLock: mocks.deliver,
  FastAgentParentEventDeliveryError: class extends Error {},
}));
vi.mock('./task-runs/fast-agent-startup-retry', () => ({
  retryFastAgentStartup: vi.fn(),
}));

import {
  getSourceControlReadiness,
  requestSourceControlConnection,
  getSourceControlConnectionRequest,
  cancelSourceControlConnectionRequest,
  reconcileSourceControlConnectionRequests,
  supersedeSourceControlConnectionRequests,
  validateSourceControlConnectionContinuation,
  settleSourceControlConnectionRequest,
  createSourceControlConnectionAdapter,
  isSourceControlConnectionEnabled,
  enforceSourceControlConnectionRollout,
  requireSourceControlConnectionSync,
  getSourceControlSyncStartedAt,
} from './source-control-connection';
import {
  admitSourceControlConnectionReadyEvent,
  drainFastAgentParentEvents,
  enqueueFastAgentParentEvent,
} from './fast-agent-parent-event-queue';

describe('source-control connection requests (PostgreSQL)', () => {
  let originalFlag: Record<string, unknown> = {};
  beforeAll(async () => {
    const [row] = await db
      .select({ metadata: deploymentSettings.metadata })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'));
    if (
      row?.metadata &&
      typeof row.metadata === 'object' &&
      'optional_source_control_enabled' in row.metadata
    )
      originalFlag = {
        optional_source_control_enabled:
          row.metadata.optional_source_control_enabled,
      };
  });
  afterAll(async () => {
    await db
      .update(deploymentSettings)
      .set({
        metadata: sql`(${deploymentSettings.metadata} - 'optional_source_control_enabled') || ${JSON.stringify(originalFlag)}::jsonb`,
      })
      .where(eq(deploymentSettings.id, 'default'));
  });
  async function setFlag(value: unknown) {
    if (value === undefined) {
      await db
        .update(deploymentSettings)
        .set({
          metadata: sql`${deploymentSettings.metadata} - 'optional_source_control_enabled'`,
        })
        .where(eq(deploymentSettings.id, 'default'));
      return;
    }
    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        metadata: { optional_source_control_enabled: value },
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({ optional_source_control_enabled: value })}::jsonb`,
        },
      });
  }
  let user: Awaited<ReturnType<typeof userFactory.create>>;
  let admin: Awaited<ReturnType<typeof userFactory.create>>;
  let conversationId: string;
  let installationId: string;
  let repositoryFullName: string;
  const input = () => ({
    conversationId,
    actorUserId: user.id,
    turnId: 'original-turn',
    provider: 'github' as const,
    capability: 'repository' as const,
    repositoryFullName,
  });
  const readRequest = (id: string) =>
    getSourceControlConnectionRequest({ requestId: id, actorUserId: user.id });

  beforeEach(async () => {
    vi.clearAllMocks();
    await setFlag(true);
    user = await userFactory.create({ role: 'member' });
    admin = await userFactory.create({ role: 'admin' });
    const installation = await githubInstallationFactory.create({
      installedByUserId: admin.id,
    });
    installationId = installation.id;
    repositoryFullName = `connection-test/${crypto.randomUUID()}`;
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: admin.id,
        surface: 'web',
        workspaceId: 'connection-test',
        conversationId: crypto.randomUUID(),
      })
      .returning();
    conversationId = conversation!.id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversationId));
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, installationId));
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(users).where(eq(users.id, admin.id));
  });

  const grant = () =>
    repositoryFactory.create({
      installationId,
      linkedByUserId: admin.id,
      fullName: repositoryFullName,
    });

  it('blocks sync-start capture until the configuration transaction commits and rejects pre-config proof', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    const oldStartedAt = await getSourceControlSyncStartedAt('github');
    let releaseConfig!: () => void;
    const commit = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    let configLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      configLocked = resolve;
    });
    const config = db.transaction(async (tx) => {
      await requireSourceControlConnectionSync('github', tx);
      configLocked();
      await commit;
    });
    let sync:
      | Promise<{ startedAt: string; requiredAt: string | undefined }>
      | undefined;
    let syncPid = 0;
    let syncFinished = false;
    try {
      await Promise.race([locked, config]);
      sync = db.transaction(async (tx) => {
        const [backend] = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        syncPid = backend!.pid;
        const startedAt = await getSourceControlSyncStartedAt('github', tx);
        const current =
          await tx.query.sourceControlConnectionRequests.findFirst({
            where: eq(sourceControlConnectionRequests.id, request.id),
          });
        syncFinished = true;
        return { startedAt, requiredAt: current?.syncAttempt?.startedAt };
      });
      // Observe the actual PostgreSQL waiter instead of relying on a timing sleep.
      await vi.waitFor(async () => {
        expect(syncPid).toBeGreaterThan(0);
        const [waiter] = await db.execute<{
          blocked: boolean;
        }>(sql`select exists (
          select 1 from pg_locks where pid = ${syncPid} and locktype = 'advisory' and not granted
        ) as blocked`);
        expect(waiter!.blocked).toBe(true);
      });
      expect(syncFinished).toBe(false);
      // Provider locks are independent.
      expect(await getSourceControlSyncStartedAt('gitlab')).toMatch(
        /\.\d{6}Z$/,
      );
      releaseConfig();
      await config;
      const fresh = await sync;
      expect(fresh.requiredAt).toBeDefined();
      const context = { requestId: request.id, provider: 'github' as const };
      expect(
        await reconcileSourceControlConnectionRequests(context, {
          successfulSync: {
            startedAt: oldStartedAt,
            repositoryFullNames: [repositoryFullName],
          },
        }),
      ).toEqual({ ready: 0 });
      expect(await reconcileSourceControlConnectionRequests(context)).toEqual({
        ready: 0,
      });
      expect(
        await reconcileSourceControlConnectionRequests(context, {
          successfulSync: {
            startedAt: fresh.startedAt,
            repositoryFullNames: [repositoryFullName],
          },
        }),
      ).toEqual({ ready: 1 });
      expect(await reconcileSourceControlConnectionRequests(context)).toEqual({
        ready: 0,
      });
      expect(
        await db
          .select()
          .from(fastAgentParentEvents)
          .where(eq(fastAgentParentEvents.conversationId, conversationId)),
      ).toHaveLength(1);
    } finally {
      releaseConfig();
      await config;
      await sync;
    }
  });

  it('supersedes queued ready requests and discards their events atomically with config invalidation', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    await reconcileSourceControlConnectionRequests({ requestId: request.id });
    const eventKey = (await readRequest(request.id))!.continuationEventKey!;
    await expect(
      db.transaction(async (tx) => {
        await requireSourceControlConnectionSync('github', tx);
        expect(
          await tx.query.sourceControlConnectionRequests.findFirst({
            where: eq(sourceControlConnectionRequests.id, request.id),
          }),
        ).toMatchObject({ status: 'superseded' });
        expect(
          await tx.query.fastAgentParentEvents.findFirst({
            where: eq(fastAgentParentEvents.eventKey, eventKey),
          }),
        ).toMatchObject({ discardedAt: expect.any(Date) });
        throw new Error('rollback config');
      }),
    ).rejects.toThrow('rollback config');
    expect((await readRequest(request.id))?.status).toBe('ready');
    expect(
      await db.query.fastAgentParentEvents.findFirst({
        where: eq(fastAgentParentEvents.eventKey, eventKey),
      }),
    ).toMatchObject({ discardedAt: null });
    await db.transaction(async (tx) => {
      await requireSourceControlConnectionSync('github', tx);
    });
    expect((await readRequest(request.id))?.status).toBe('superseded');
    expect(
      await db.query.fastAgentParentEvents.findFirst({
        where: eq(fastAgentParentEvents.eventKey, eventKey),
      }),
    ).toMatchObject({ discardedAt: expect.any(Date), deliveredAt: null });
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).toBeNull();
    expect(
      await reconcileSourceControlConnectionRequests(
        { requestId: request.id, provider: 'github' },
        {
          successfulSync: {
            startedAt: await getSourceControlSyncStartedAt('github'),
            repositoryFullNames: [repositoryFullName],
          },
        },
      ),
    ).toEqual({ ready: 0 });
  });

  it('does not round a pre-invalidation sync up to the same millisecond', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    await db
      .update(sourceControlConnectionRequests)
      .set({
        syncAttempt: {
          provider: 'github',
          state: 'pending',
          startedAt: '2026-09-08T12:00:00.123456Z',
        },
      })
      .where(eq(sourceControlConnectionRequests.id, request.id));
    const context = { requestId: request.id, provider: 'github' as const };
    expect(
      await reconcileSourceControlConnectionRequests(context, {
        successfulSync: {
          startedAt: '2026-09-08T12:00:00.123455Z',
          repositoryFullNames: [repositoryFullName],
        },
      }),
    ).toEqual({ ready: 0 });
    expect(
      await reconcileSourceControlConnectionRequests(context, {
        successfulSync: {
          startedAt: '2026-09-08T12:00:00.123457Z',
          repositoryFullNames: [repositoryFullName],
        },
      }),
    ).toEqual({ ready: 1 });
  });

  it.each(['pending', 'failed'] as const)(
    'does not admit stale active inventory after %s sync; authoritative exact-target success admits once',
    async (state) => {
      await grant();
      const request = await requestSourceControlConnection(input());
      await requireSourceControlConnectionSync('github');
      const attempt = (await readRequest(request.id))!.syncAttempt!;
      await db
        .update(sourceControlConnectionRequests)
        .set({ syncAttempt: { ...attempt, state } })
        .where(eq(sourceControlConnectionRequests.id, request.id));
      const context = { requestId: request.id, provider: 'github' as const };
      expect(await reconcileSourceControlConnectionRequests(context)).toEqual({
        ready: 0,
      });
      expect((await readRequest(request.id))?.reason).toBe(
        state === 'failed' ? 'sync_failed' : 'sync_pending',
      );
      expect(
        await reconcileSourceControlConnectionRequests(context, {
          successfulSync: {
            startedAt: new Date(
              Date.parse(attempt.startedAt) - 1,
            ).toISOString(),
            repositoryFullNames: [repositoryFullName],
          },
        }),
      ).toEqual({ ready: 0 });
      expect(
        await reconcileSourceControlConnectionRequests(context, {
          successfulSync: {
            startedAt: await getSourceControlSyncStartedAt('github'),
            repositoryFullNames: ['other/repository'],
          },
        }),
      ).toEqual({ ready: 0 });
      expect((await readRequest(request.id))?.status).toBe('pending');
      expect(
        await db
          .select()
          .from(fastAgentParentEvents)
          .where(eq(fastAgentParentEvents.conversationId, conversationId)),
      ).toHaveLength(0);
      const options = {
        successfulSync: {
          startedAt: await getSourceControlSyncStartedAt('github'),
          repositoryFullNames: [repositoryFullName],
        },
      };
      expect(
        await reconcileSourceControlConnectionRequests(context, options),
      ).toEqual({ ready: 1 });
      expect(
        await reconcileSourceControlConnectionRequests(context, options),
      ).toEqual({ ready: 0 });
      expect(await reconcileSourceControlConnectionRequests(context)).toEqual({
        ready: 0,
      });
      expect((await readRequest(request.id))?.syncAttempt).toBeNull();
      expect(
        await db
          .select()
          .from(fastAgentParentEvents)
          .where(eq(fastAgentParentEvents.conversationId, conversationId)),
      ).toHaveLength(1);
    },
  );

  it.each(['authorizing', 'syncing'] as const)(
    'retains webhook proof without admitting an active %s attempt',
    async (state) => {
      await grant();
      const request = await requestSourceControlConnection(input());
      const attempt = {
        provider: 'github' as const,
        startedAt: await getSourceControlSyncStartedAt('github'),
        state,
      };
      await db
        .update(sourceControlConnectionRequests)
        .set({ syncAttempt: attempt, revision: 2 })
        .where(eq(sourceControlConnectionRequests.id, request.id));
      const context = { requestId: request.id, provider: 'github' as const };
      const options = {
        successfulSync: {
          startedAt: await getSourceControlSyncStartedAt('github'),
          repositoryFullNames: [repositoryFullName],
        },
      };
      expect(
        await reconcileSourceControlConnectionRequests(context, options),
      ).toEqual({ ready: 0 });
      expect(
        (await readRequest(request.id))?.syncAttempt?.successfulSync
          ?.repositoryFullNames,
      ).toEqual([repositoryFullName]);
      expect(await reconcileSourceControlConnectionRequests(context)).toEqual({
        ready: 0,
      });
      await db
        .update(sourceControlConnectionRequests)
        .set({ syncAttempt: { ...attempt, state: 'pending' } })
        .where(eq(sourceControlConnectionRequests.id, request.id));
      expect(
        await reconcileSourceControlConnectionRequests(
          { ...context, attemptRevision: 1 },
          options,
        ),
      ).toEqual({ ready: 0 });
      expect(
        await reconcileSourceControlConnectionRequests(
          { ...context, attemptRevision: 2 },
          options,
        ),
      ).toEqual({ ready: 1 });
    },
  );

  it('does not gate repository-free environments and requires every named environment repository', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: admin.id,
      config: { name: 'connection-test', repositories: [] },
    });
    try {
      expect(
        await getSourceControlReadiness({
          actorUserId: user.id,
          environmentId: environment.id,
          capability: 'repository',
        }),
      ).toMatchObject({ status: 'ready' });
      await db
        .update(environments)
        .set({
          config: {
            name: 'connection-test',
            repositories: [{ repository: repositoryFullName }],
          },
        })
        .where(eq(environments.id, environment.id));
      expect(
        await getSourceControlReadiness({
          actorUserId: user.id,
          environmentId: environment.id,
          capability: 'repository',
          provider: 'github',
        }),
      ).toMatchObject({ status: 'repository_unavailable' });
      await grant();
      expect(
        await getSourceControlReadiness({
          actorUserId: user.id,
          environmentId: environment.id,
          capability: 'repository',
          provider: 'github',
        }),
      ).toMatchObject({ status: 'ready' });
    } finally {
      await db.delete(environments).where(eq(environments.id, environment.id));
    }
  });

  it('clears the inventory gate for provider-only tools while still requiring fresh discovery', async () => {
    await grant();
    const request = await requestSourceControlConnection(
      {
        ...input(),
        repositoryFullName: undefined,
        capability: 'source_control_tool',
        tool: { integrationId: 'github', toolName: 'get_pull_request' },
      },
      { probeSourceControlTools: async () => false },
    );
    await requireSourceControlConnectionSync('github');
    expect(
      await reconcileSourceControlConnectionRequests(
        { requestId: request.id, provider: 'github' },
        {
          successfulSync: {
            startedAt: await getSourceControlSyncStartedAt('github'),
            repositoryFullNames: [repositoryFullName],
          },
          probeSourceControlTools: async () => false,
        },
      ),
    ).toEqual({ ready: 0 });
    expect((await readRequest(request.id))?.syncAttempt).toBeNull();
    expect((await readRequest(request.id))?.reason).toBe(
      'discovery_unavailable',
    );
    expect(
      await reconcileSourceControlConnectionRequests(
        { requestId: request.id },
        {
          probeSourceControlTools: async () => true,
        },
      ),
    ).toEqual({ ready: 1 });
  });

  it('retains failed sync as a safe pending reason until an authoritative successful retry', async () => {
    await grant();
    const request = await requestSourceControlConnection(input(), {
      syncState: 'failed',
    });
    expect(request.reason).toBe('sync_failed');
    expect(
      await reconcileSourceControlConnectionRequests(
        { requestId: request.id },
        { syncState: 'pending' },
      ),
    ).toEqual({ ready: 0 });
    expect((await readRequest(request.id))?.reason).toBe('sync_pending');
    expect(
      await reconcileSourceControlConnectionRequests({ requestId: request.id }),
    ).toEqual({ ready: 0 });
    expect(
      await reconcileSourceControlConnectionRequests(
        { requestId: request.id, provider: 'github' },
        {
          successfulSync: {
            startedAt: await getSourceControlSyncStartedAt('github'),
            repositoryFullNames: [repositoryFullName],
          },
        },
      ),
    ).toEqual({ ready: 1 });
  });

  it('rechecks stale continuation state again at the eventual repository operation', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    await reconcileSourceControlConnectionRequests({ requestId: request.id });
    const adapter = createSourceControlConnectionAdapter(
      {},
      { requestId: request.id, conversationId },
    );
    expect(
      await adapter.getSourceControlReadiness!({
        actorUserId: user.id,
        target: input(),
      }),
    ).toMatchObject({ status: 'ready' });
    await supersedeSourceControlConnectionRequests({
      ...input(),
      turnId: 'new-intent',
    });
    expect(
      await adapter.getSourceControlReadiness!({
        actorUserId: user.id,
        target: input(),
      }),
    ).toEqual({ status: 'forbidden' });
  });

  it('returns one active logical request under concurrent admission and a canonical navigation-only URL', async () => {
    const requests = await Promise.all(
      Array.from({ length: 6 }, () => requestSourceControlConnection(input())),
    );
    expect(new Set(requests.map((request) => request.id)).size).toBe(1);
    const session = await db.transaction((tx) =>
      ensureSessionForFastConversation(tx, conversationId),
    );
    expect(requests[0]!.url).toBe(
      `/sessions/${session.id}?connectionRequest=${requests[0]!.id}`,
    );
    expect(
      requests[0]!.expiresAt.getTime() - requests[0]!.createdAt.getTime(),
    ).toBeGreaterThan(86_390_000);
    await expect(
      requestSourceControlConnection({ ...input(), actorUserId: admin.id }),
    ).rejects.toThrow('active connection request');
  });

  it('does not mistake unrelated repository inventory for the requested grant', async () => {
    await repositoryFactory.create({
      installationId,
      linkedByUserId: admin.id,
    });
    const request = await requestSourceControlConnection(input());
    expect(
      await reconcileSourceControlConnectionRequests({ requestId: request.id }),
    ).toEqual({ ready: 0 });
    expect((await readRequest(request.id))?.reason).toBe(
      'repository_unavailable',
    );
    await grant();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        reconcileSourceControlConnectionRequests({
          requestId: request.id,
          completedByUserId: admin.id,
        }),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.ready, 0)).toBe(1);
    const events = await db
      .select()
      .from(fastAgentParentEvents)
      .where(eq(fastAgentParentEvents.conversationId, conversationId));
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toEqual({
      type: 'connection_ready',
      requestId: request.id,
    });
    expect((await readRequest(request.id))?.completedByUserId).toBe(admin.id);
    expect(
      (
        await validateSourceControlConnectionContinuation({
          requestId: request.id,
          conversationId,
        })
      )?.actorUserId,
    ).toBe(user.id);
    expect((await readRequest(request.id))?.status).toBe('ready');
    await settleSourceControlConnectionRequest({
      requestId: request.id,
      conversationId,
    });
    expect((await readRequest(request.id))?.status).toBe('continued');
  });

  it('keeps durable admission after Redis fails and rejects cancelled work at consumption', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    mocks.wake.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect(
      await reconcileSourceControlConnectionRequests({ requestId: request.id }),
    ).toEqual({ ready: 1 });
    const reader = await userFactory.create({ role: 'member' });
    try {
      await expect(
        cancelSourceControlConnectionRequest({
          requestId: request.id,
          actorUserId: reader.id,
        }),
      ).rejects.toThrow('Forbidden');
    } finally {
      await db.delete(users).where(eq(users.id, reader.id));
    }
    await cancelSourceControlConnectionRequest({
      requestId: request.id,
      actorUserId: admin.id,
    });
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).toBeNull();
    expect((await readRequest(request.id))?.status).toBe('cancelled');
    expect(
      await reconcileSourceControlConnectionRequests({ requestId: request.id }),
    ).toEqual({ ready: 0 });
  });

  it('rolls the ready transition and event insertion back together', async () => {
    const request = await requestSourceControlConnection(input());
    await expect(
      db.transaction(async (tx) => {
        await admitSourceControlConnectionReadyEvent(tx, {
          requestId: request.id,
          parent: {
            sessionId: conversationId,
            conversation: {
              surface: 'web',
              workspaceId: 'connection-test',
              conversationId: 'native',
            },
          },
        });
        await tx
          .update(sourceControlConnectionRequests)
          .set({ status: 'ready' })
          .where(eq(sourceControlConnectionRequests.id, request.id));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await readRequest(request.id))?.status).toBe('pending');
    expect(
      await db
        .select()
        .from(fastAgentParentEvents)
        .where(eq(fastAgentParentEvents.conversationId, conversationId)),
    ).toHaveLength(0);
  });

  it('settles continued only after the durable consumer settles, retaining one event across a retry', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    await reconcileSourceControlConnectionRequests({ requestId: request.id });
    const queued = await readRequest(request.id);
    const wakeup = { conversationId, eventKey: queued!.continuationEventKey! };
    const lock = Object.assign(
      vi.fn(async () => {}),
      { signal: new AbortController().signal },
    );
    mocks.acquireLock.mockResolvedValue(lock);
    mocks.deliver.mockImplementationOnce(async ({ durableAdmission }) => {
      expect(durableAdmission.eventId).toBeDefined();
      expect(
        await validateSourceControlConnectionContinuation({
          requestId: request.id,
          conversationId,
        }),
      ).not.toBeNull();
      throw new Error('transient failure');
    });
    await expect(drainFastAgentParentEvents(wakeup)).rejects.toThrow(
      'transient failure',
    );
    expect((await readRequest(request.id))?.status).toBe('ready');
    mocks.deliver.mockImplementationOnce(
      async ({ durableAdmission, resumedAfterInterruption }) => {
        expect(resumedAfterInterruption).toBe(true);
        expect(
          (
            await validateSourceControlConnectionContinuation({
              requestId: request.id,
              conversationId,
            })
          )?.actorUserId,
        ).toBe(user.id);
        await db
          .update(fastAgentParentEvents)
          .set({ deliveredAt: new Date() })
          .where(eq(fastAgentParentEvents.id, durableAdmission.eventId));
        return 'delivered';
      },
    );
    await drainFastAgentParentEvents(wakeup);
    expect((await readRequest(request.id))?.status).toBe('continued');
    await drainFastAgentParentEvents(wakeup);
    expect(mocks.deliver).toHaveBeenCalledTimes(2);
  });

  it('supersedes at queued human admission, but a duplicate webhook does not supersede new intent', async () => {
    const request = await requestSourceControlConnection(input());
    const parent = {
      sessionId: conversationId,
      conversation: {
        surface: 'web' as const,
        workspaceId: 'connection-test',
        conversationId: 'native',
      },
    };
    const event = {
      type: 'human_follow_up' as const,
      eventId: 'new-human',
      currentMessageId: 'new-human',
      userId: admin.id,
      question: 'Change direction.',
    };
    await enqueueFastAgentParentEvent({ parent, event });
    expect((await readRequest(request.id))?.status).toBe('superseded');
    const next = await requestSourceControlConnection({
      ...input(),
      turnId: 'next-turn',
    });
    await enqueueFastAgentParentEvent({ parent, event });
    expect((await readRequest(next.id))?.status).toBe('pending');
  });

  it('expires on reads and never resurrects an old intent after a new human turn', async () => {
    const request = await requestSourceControlConnection(input());
    expect(await supersedeSourceControlConnectionRequests({ ...input() })).toBe(
      0,
    );
    expect(
      await supersedeSourceControlConnectionRequests({
        ...input(),
        actorUserId: admin.id,
        turnId: 'new-turn',
      }),
    ).toBe(1);
    await grant();
    expect(
      await reconcileSourceControlConnectionRequests({ requestId: request.id }),
    ).toEqual({ ready: 0 });
    const replacement = await requestSourceControlConnection({
      ...input(),
      turnId: 'new-turn',
    });
    await db
      .update(sourceControlConnectionRequests)
      .set({ expiresAt: new Date(0) })
      .where(eq(sourceControlConnectionRequests.id, replacement.id));
    expect((await readRequest(replacement.id))?.status).toBe('expired');
    expect(
      await reconcileSourceControlConnectionRequests({
        requestId: replacement.id,
      }),
    ).toEqual({ ready: 0 });
  });

  it.each([
    'actor_deleted',
    'repository_revoked',
    'installation_suspended',
  ] as const)('revalidates %s before continuation', async (revocation) => {
    const repo = await grant();
    const request = await requestSourceControlConnection(input());
    await reconcileSourceControlConnectionRequests({ requestId: request.id });
    if (revocation === 'actor_deleted')
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, user.id));
    if (revocation === 'repository_revoked')
      await db
        .update(repositories)
        .set({ isActive: false })
        .where(eq(repositories.id, repo.id));
    if (revocation === 'installation_suspended')
      await db
        .update(githubInstallations)
        .set({ suspendedAt: new Date() })
        .where(eq(githubInstallations.id, installationId));
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).toBeNull();
  });

  it('serializes cancellation against execution admission without falsely marking a running continuation completed', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    await reconcileSourceControlConnectionRequests({ requestId: request.id });
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).not.toBeNull();
    await expect(
      cancelSourceControlConnectionRequest({
        requestId: request.id,
        actorUserId: user.id,
      }),
    ).rejects.toThrow('Continuation has started');
    expect((await readRequest(request.id))?.status).toBe('ready');
    // A retry keeps the same logical continuation and remains eligible.
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).not.toBeNull();
  });

  it('requires fresh discovery only for tool capability and rejects cross-session lookups', async () => {
    await grant();
    const probe = vi.fn().mockResolvedValue(false);
    expect(
      await getSourceControlReadiness(input(), {
        probeSourceControlTools: probe,
      }),
    ).toMatchObject({ status: 'ready' });
    expect(probe).not.toHaveBeenCalled();
    expect(
      await getSourceControlReadiness(
        {
          ...input(),
          capability: 'source_control_tool',
          tool: { integrationId: 'github', toolName: 'get_file_contents' },
        },
        { probeSourceControlTools: probe },
      ),
    ).toMatchObject({ status: 'discovery_unavailable' });
    expect(probe).toHaveBeenCalledWith({
      actorUserId: user.id,
      provider: 'github',
      tool: { integrationId: 'github', toolName: 'get_file_contents' },
      fresh: true,
    });
    probe.mockResolvedValue(true);
    expect(
      await getSourceControlReadiness(
        {
          ...input(),
          capability: 'source_control_tool',
          tool: { integrationId: 'github', toolName: 'get_file_contents' },
        },
        { probeSourceControlTools: probe },
      ),
    ).toMatchObject({ status: 'ready' });
    const request = await requestSourceControlConnection(input());
    expect(
      await getSourceControlConnectionRequest({
        requestId: request.id,
        actorUserId: user.id,
        conversationId: crypto.randomUUID(),
      }),
    ).toBeNull();
  });
  it.each([undefined, false, 'true', null])(
    'defaults off for metadata flag %s, preserving ordinary adapter preflight',
    async (flag) => {
      await setFlag(flag);
      expect(await isSourceControlConnectionEnabled()).toBe(false);
      const adapter = createSourceControlConnectionAdapter();
      expect(
        await adapter.getSourceControlReadiness!({
          actorUserId: user.id,
          target: input(),
        }),
      ).toEqual({ status: 'ready' });
      await expect(requestSourceControlConnection(input())).rejects.toThrow(
        'disabled',
      );
      await expect(
        adapter.requestSourceControlConnection!({
          ...input(),
          conversation: {
            surface: 'web',
            workspaceId: 'test',
            conversationId: 'test',
          },
          target: input(),
        }),
      ).rejects.toThrow('disabled');
      expect(
        await db
          .select()
          .from(sourceControlConnectionRequests)
          .where(
            eq(sourceControlConnectionRequests.conversationId, conversationId),
          ),
      ).toHaveLength(0);
    },
  );

  it('cancels pending and admitted work on disable; reenable and late callbacks cannot revive it', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    await reconcileSourceControlConnectionRequests({ requestId: request.id });
    await db.transaction(async (tx) => {
      await tx
        .update(deploymentSettings)
        .set({
          metadata: sql`${deploymentSettings.metadata} || '{"optional_source_control_enabled":false}'::jsonb`,
        })
        .where(eq(deploymentSettings.id, 'default'));
      expect(await enforceSourceControlConnectionRollout(tx)).toBe(false);
    });
    const view = await readRequest(request.id);
    expect(view).toMatchObject({
      status: 'cancelled',
      reason: 'feature_disabled',
    });
    const [event] = await db
      .select()
      .from(fastAgentParentEvents)
      .where(eq(fastAgentParentEvents.eventKey, view!.continuationEventKey!));
    expect(event!.discardedAt).not.toBeNull();
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).toBeNull();
    await setFlag(true);
    expect(
      await reconcileSourceControlConnectionRequests({ requestId: request.id }),
    ).toEqual({ ready: 0 });
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).toBeNull();
    const pending = await requestSourceControlConnection({
      ...input(),
      turnId: 'new-turn',
    });
    await setFlag(false);
    expect(
      await reconcileSourceControlConnectionRequests({ requestId: pending.id }),
    ).toEqual({ ready: 0 });
    expect(await readRequest(pending.id)).toMatchObject({
      status: 'cancelled',
      reason: 'feature_disabled',
    });
  });

  it('honors a disable racing an in-flight readiness probe before consumer execution', async () => {
    await grant();
    const tool = { integrationId: 'github', toolName: 'get_file_contents' };
    const request = await requestSourceControlConnection(
      { ...input(), capability: 'source_control_tool', tool },
      { probeSourceControlTools: async () => false },
    );
    let release!: () => void;
    let entered!: () => void;
    const enteredProbe = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseProbe = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = reconcileSourceControlConnectionRequests(
      { requestId: request.id },
      {
        probeSourceControlTools: async () => {
          entered();
          await releaseProbe;
          return true;
        },
      },
    );
    await enteredProbe;
    const disabling = setFlag(false);
    release();
    await Promise.all([callback, disabling]);
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).toBeNull();
    expect(await readRequest(request.id)).toMatchObject({
      status: 'cancelled',
      reason: 'feature_disabled',
    });
  });

  it('uses native Roomote source-control operations for non-GitHub without probing a fabricated catalog', async () => {
    for (const name of [
      'GITEA_CLIENT_ID',
      'GITEA_CLIENT_SECRET',
      'GITEA_WEBHOOK_SECRET',
    ])
      vi.stubEnv(name, 'test-value');
    vi.stubEnv('GITEA_BASE_URL', 'https://gitea.example');
    const repo = await repositoryFactory.create({
      sourceControlProvider: 'gitea',
      fullName: repositoryFullName,
      linkedByUserId: admin.id,
    });
    try {
      const probe = vi.fn(async () => false);
      const operation = {
        ...input(),
        provider: 'gitea' as const,
        capability: 'source_control_tool' as const,
        tool: { integrationId: 'roomote', toolName: 'manage_source_control' },
      };
      expect(
        await getSourceControlReadiness(operation, {
          probeSourceControlTools: probe,
        }),
      ).toMatchObject({ status: 'ready' });
      expect(probe).not.toHaveBeenCalled();
      const request = await requestSourceControlConnection(operation, {
        probeSourceControlTools: probe,
      });
      expect(request.tool).toEqual(operation.tool);
      expect(
        await reconcileSourceControlConnectionRequests(
          { requestId: request.id },
          { probeSourceControlTools: probe },
        ),
      ).toEqual({ ready: 1 });
      expect(
        await validateSourceControlConnectionContinuation(
          { requestId: request.id, conversationId },
          { probeSourceControlTools: probe },
        ),
      ).toMatchObject({ actorUserId: user.id, tool: operation.tool });
      expect(probe).not.toHaveBeenCalled();
    } finally {
      await db.delete(repositories).where(eq(repositories.id, repo.id));
    }
  });

  it('requires the exact tool in discovery rather than any nonempty catalog', async () => {
    await grant();
    const operation = {
      ...input(),
      capability: 'source_control_tool' as const,
      tool: { integrationId: 'github', toolName: 'get_file_contents' },
    };
    mocks.listIntegrations.mockResolvedValue([
      { id: 'github', tools: [{ name: 'get_issue' }] },
    ]);
    expect(await getSourceControlReadiness(operation)).toMatchObject({
      status: 'discovery_unavailable',
    });
    mocks.listIntegrations.mockResolvedValue([
      { id: 'github', tools: [{ name: 'get_file_contents' }] },
    ]);
    expect(await getSourceControlReadiness(operation)).toMatchObject({
      status: 'ready',
    });
    expect(
      await getSourceControlReadiness({
        ...operation,
        tool: { integrationId: 'gitlab', toolName: 'get_file_contents' },
      }),
    ).toMatchObject({ status: 'discovery_unavailable' });
  });

  it.each(['gitlab', 'bitbucket'] as const)(
    'uses fresh actor-scoped broker discovery for native %s tools',
    async (provider) => {
      vi.stubEnv(`${provider.toUpperCase()}_CLIENT_ID`, 'test-client');
      vi.stubEnv(`${provider.toUpperCase()}_CLIENT_SECRET`, 'test-secret');
      vi.stubEnv('GITLAB_BASE_URL', 'https://gitlab.com');
      const repo = await repositoryFactory.create({
        sourceControlProvider: provider,
        fullName: repositoryFullName,
        linkedByUserId: admin.id,
      });
      try {
        const operation = {
          ...input(),
          provider,
          capability: 'source_control_tool' as const,
          tool: { integrationId: provider, toolName: 'get_file_contents' },
        };
        mocks.listIntegrations.mockResolvedValue([
          { id: provider, tools: [{ name: operation.tool.toolName }] },
        ]);
        expect(await getSourceControlReadiness(operation)).toMatchObject({
          status: 'ready',
        });
        expect(mocks.listIntegrations).toHaveBeenCalledWith(
          { userId: user.id, forceFreshDiscovery: true },
          expect.any(Function),
        );
        mocks.listIntegrations.mockResolvedValue([]);
        expect(await getSourceControlReadiness(operation)).toMatchObject({
          status: 'discovery_unavailable',
        });
        mocks.listIntegrations.mockResolvedValue([
          { id: provider, tools: [{ name: 'different_tool' }] },
        ]);
        expect(await getSourceControlReadiness(operation)).toMatchObject({
          status: 'discovery_unavailable',
        });
      } finally {
        await db.delete(repositories).where(eq(repositories.id, repo.id));
      }
    },
  );

  it('carries only the matching attempted tool from adapter preflight into persisted continuation', async () => {
    const target = { ...input(), capability: 'source_control_tool' as const };
    const tool = {
      integrationId: 'roomote',
      toolName: 'manage_source_control',
    };
    const adapter = createSourceControlConnectionAdapter();
    expect(
      await adapter.getSourceControlReadiness!({
        actorUserId: user.id,
        target,
        tool,
      }),
    ).toMatchObject({ status: 'repository_unavailable' });
    const result = await adapter.requestSourceControlConnection!({
      ...input(),
      target,
      conversation: {
        surface: 'web',
        workspaceId: 'test',
        conversationId: 'test',
      },
    });
    expect(result.status).toBe('pending');
    if (result.status !== 'pending')
      throw new Error('Expected pending request');
    expect(await readRequest(result.requestId)).toMatchObject({
      tool,
      capability: 'source_control_tool',
    });
    await grant();
    expect(
      await reconcileSourceControlConnectionRequests({
        requestId: result.requestId,
      }),
    ).toEqual({ ready: 1 });
  });

  it.each(['reconcile', 'consume'] as const)(
    'rechecks expiry after slow discovery during %s',
    async (phase) => {
      await grant();
      const request = await requestSourceControlConnection(
        {
          ...input(),
          capability: 'source_control_tool',
          tool: { integrationId: 'github', toolName: 'get_file_contents' },
        },
        { probeSourceControlTools: async () => false },
      );
      if (phase === 'consume')
        await reconcileSourceControlConnectionRequests(
          { requestId: request.id },
          { probeSourceControlTools: async () => true },
        );
      const options = {
        probeSourceControlTools: async () => {
          vi.setSystemTime(new Date(request.expiresAt.getTime() + 1));
          return true;
        },
      };
      if (phase === 'consume')
        expect(
          await validateSourceControlConnectionContinuation(
            { requestId: request.id, conversationId },
            options,
          ),
        ).toBeNull();
      else
        expect(
          await reconcileSourceControlConnectionRequests(
            { requestId: request.id },
            options,
          ),
        ).toEqual({ ready: 0 });
      expect(await readRequest(request.id)).toMatchObject({
        status: 'expired',
        executionStartedAt: null,
      });
    },
  );

  it('rechecks actor revocation after remote discovery and never claims the continuation', async () => {
    await grant();
    const request = await requestSourceControlConnection(
      {
        ...input(),
        capability: 'source_control_tool',
        tool: { integrationId: 'github', toolName: 'get_file_contents' },
      },
      { probeSourceControlTools: async () => true },
    );
    await reconcileSourceControlConnectionRequests(
      { requestId: request.id },
      { probeSourceControlTools: async () => true },
    );
    expect(
      await validateSourceControlConnectionContinuation(
        { requestId: request.id, conversationId },
        {
          probeSourceControlTools: async () => {
            await db
              .update(users)
              .set({ deletedAt: new Date() })
              .where(eq(users.id, user.id));
            return true;
          },
        },
      ),
    ).toBeNull();
    expect(
      await getSourceControlConnectionRequest({
        requestId: request.id,
        actorUserId: admin.id,
      }),
    ).toMatchObject({
      status: 'superseded',
      reason: 'forbidden',
      executionStartedAt: null,
    });
  });

  it('does not admit a callback whose completing admin loses authorization during discovery', async () => {
    await grant();
    const request = await requestSourceControlConnection(
      {
        ...input(),
        capability: 'source_control_tool',
        tool: { integrationId: 'github', toolName: 'get_file_contents' },
      },
      { probeSourceControlTools: async () => false },
    );
    await expect(
      reconcileSourceControlConnectionRequests(
        { requestId: request.id, completedByUserId: admin.id },
        {
          probeSourceControlTools: async () => {
            await db
              .update(users)
              .set({ role: 'member' })
              .where(eq(users.id, admin.id));
            return true;
          },
        },
      ),
    ).rejects.toThrow('Forbidden');
    expect(await readRequest(request.id)).toMatchObject({
      status: 'pending',
      continuationEventKey: null,
    });
  });

  it('does not replay an already settled durable event and preserves its outcome on disable', async () => {
    await grant();
    const request = await requestSourceControlConnection(input());
    await reconcileSourceControlConnectionRequests({ requestId: request.id });
    const admitted = await readRequest(request.id);
    await db
      .update(fastAgentParentEvents)
      .set({ deliveredAt: new Date() })
      .where(
        eq(fastAgentParentEvents.eventKey, admitted!.continuationEventKey!),
      );
    expect(
      await validateSourceControlConnectionContinuation({
        requestId: request.id,
        conversationId,
      }),
    ).toBeNull();
    await setFlag(false);
    expect(await readRequest(request.id)).toMatchObject({
      status: 'continued',
    });
  });
});
