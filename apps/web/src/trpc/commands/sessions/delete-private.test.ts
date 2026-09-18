import {
  brainMemoryEvents,
  brainPageRetirements,
  db,
  eq,
  fastAgentConversations,
  fastAgentMemoryEvents,
  runFactory,
  saveBrainAgentSummary,
  sessionFactory,
  sessions,
  sessionTasks,
  taskArtifacts,
  taskFactory,
  taskRuns,
  tasks,
  userFactory,
} from '@roomote/db/server';
import {
  fastConversationMemorySlug,
  RunStatus,
  taskMemorySlug,
} from '@roomote/types';
import * as cloudAgents from '@roomote/cloud-agents/server';
import * as sdk from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';

const mockDeleteArtifactsBatch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/s3-client', () => ({
  deleteArtifactsBatch: mockDeleteArtifactsBatch,
}));

import { deleteSessionCommand } from './index';

describe('deleteSessionCommand', () => {
  beforeEach(() => {
    mockDeleteArtifactsBatch.mockReset();
    mockDeleteArtifactsBatch.mockResolvedValue({ deleted: 1, errors: 0 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(brainPageRetirements);
  });

  it('deletes an owned private Session and descendants but denies other users', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        privacy: 'private',
        privateOwnerUserId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
      fastConversationId: conversation!.id,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    const [artifact] = await db
      .insert(taskArtifacts)
      .values({
        taskId: task.id,
        contentType: 'text/plain',
        path: 'private.txt',
        version: 1,
        size: 7,
        uploaded: true,
        uploadUrlExpiresAt: new Date(0),
      })
      .returning();
    const [sessionArtifact] = await db
      .insert(taskArtifacts)
      .values({
        sessionId: session.id,
        contentType: 'text/plain',
        path: 'session-private.txt',
        version: 1,
        size: 7,
        uploaded: true,
        uploadUrlExpiresAt: new Date(0),
      })
      .returning();

    await expect(
      deleteSessionCommand(
        { userId: other.id, isAdmin: true } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: false });
    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: true });
    expect(mockDeleteArtifactsBatch).toHaveBeenCalledWith([
      {
        taskId: task.id,
        artifactId: artifact!.id,
        path: 'private.txt',
        version: 1,
      },
      {
        sessionId: session.id,
        artifactId: sessionArtifact!.id,
        path: 'session-private.txt',
        version: 1,
      },
    ]);
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.fastAgentConversations.findFirst({
        where: eq(fastAgentConversations.id, conversation!.id),
      }),
    ).resolves.toBeUndefined();
  });

  it('retains private Session rows when artifact object deletion fails', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    const [artifact] = await db
      .insert(taskArtifacts)
      .values({
        taskId: task.id,
        contentType: 'text/plain',
        path: 'retry.txt',
        version: 0,
        size: 5,
        uploaded: true,
        uploadUrlExpiresAt: new Date(0),
      })
      .returning();
    mockDeleteArtifactsBatch.mockResolvedValue({ deleted: 0, errors: 1 });

    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).rejects.toThrow('Failed to delete 1 session artifact object');
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeDefined();
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toMatchObject({ state: 'active' });
    await expect(
      db.query.taskArtifacts.findFirst({
        where: eq(taskArtifacts.id, artifact!.id),
      }),
    ).resolves.toBeDefined();
  });

  it('releases row locks for S3 cleanup and retries when artifacts change', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    await db.insert(taskArtifacts).values({
      taskId: task.id,
      contentType: 'text/plain',
      path: 'existing.txt',
      version: 0,
      size: 8,
      uploaded: true,
      uploadUrlExpiresAt: new Date(0),
    });
    let concurrentArtifactId: string | undefined;
    mockDeleteArtifactsBatch.mockImplementation(async () => {
      if (!concurrentArtifactId) {
        const [concurrentArtifact] = await db
          .insert(taskArtifacts)
          .values({
            taskId: task.id,
            contentType: 'text/plain',
            path: 'too-late.txt',
            version: 0,
            size: 8,
            uploaded: true,
            uploadUrlExpiresAt: new Date(0),
          })
          .returning({ id: taskArtifacts.id });
        concurrentArtifactId = concurrentArtifact!.id;
      }
      return { deleted: 0, errors: 0 };
    });

    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: true });
    expect(concurrentArtifactId).toBeDefined();
    expect(mockDeleteArtifactsBatch).toHaveBeenCalledTimes(2);
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toBeUndefined();
  });

  it('waits for authorized uploads to expire before deleting objects or rows', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    const [artifact] = await db
      .insert(taskArtifacts)
      .values({
        taskId: task.id,
        contentType: 'text/plain',
        path: 'authorized.txt',
        version: 1,
        size: 8,
        uploaded: false,
        uploadUrlExpiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toMatchObject({
      deleted: false,
      reason: 'artifact_uploads_pending',
      retryAfter: expect.any(String),
    });
    expect(mockDeleteArtifactsBatch).not.toHaveBeenCalled();
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeDefined();

    await db
      .update(taskArtifacts)
      .set({ uploadUrlExpiresAt: new Date(0) })
      .where(eq(taskArtifacts.id, artifact!.id));
    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: true });
    expect(mockDeleteArtifactsBatch).toHaveBeenCalledOnce();
  });

  it('waits for a private Session artifact write lease to settle', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    const [artifact] = await db
      .insert(taskArtifacts)
      .values({
        sessionId: session.id,
        contentType: 'text/plain',
        path: 'pending.txt',
        version: 1,
        size: 8,
        uploaded: false,
        uploadUrlExpiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    const auth = { userId: owner.id, isAdmin: false } as UserAuthSuccess;
    await expect(deleteSessionCommand(auth, session.id)).resolves.toMatchObject(
      {
        deleted: false,
        reason: 'artifact_uploads_pending',
      },
    );
    expect(mockDeleteArtifactsBatch).not.toHaveBeenCalled();

    await db
      .update(taskArtifacts)
      .set({ uploaded: true, uploadUrlExpiresAt: new Date(0) })
      .where(eq(taskArtifacts.id, artifact!.id));
    await expect(deleteSessionCommand(auth, session.id)).resolves.toEqual({
      deleted: true,
    });
    expect(mockDeleteArtifactsBatch).toHaveBeenCalledWith([
      {
        sessionId: session.id,
        artifactId: artifact!.id,
        path: 'pending.txt',
        version: 1,
      },
    ]);
  });

  it('stops an active linked run before deleting the session', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
    });

    const auth = { userId: owner.id, isAdmin: false } as UserAuthSuccess;
    await expect(deleteSessionCommand(auth, session.id)).resolves.toEqual({
      deleted: true,
    });
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.taskRuns.findFirst({ where: eq(taskRuns.id, run.id) }),
    ).resolves.toBeUndefined();
  });

  it('keeps the session intact when active work cannot be stopped', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.test',
    });
    vi.spyOn(sdk, 'stopTaskRun').mockResolvedValueOnce({
      success: false,
      statusCode: 502,
      error: 'sandbox unavailable',
    });

    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: false, reason: 'stop_failed' });
    expect(mockDeleteArtifactsBatch).not.toHaveBeenCalled();
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeDefined();
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toMatchObject({ deletedAt: null });
  });

  it('removes artifact rows when an active run races finalization', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    const [artifact] = await db
      .insert(taskArtifacts)
      .values({
        taskId: task.id,
        contentType: 'text/plain',
        path: 'deleted-before-run-race.txt',
        version: 0,
        size: 8,
        uploaded: true,
        uploadUrlExpiresAt: new Date(0),
      })
      .returning();
    mockDeleteArtifactsBatch.mockImplementationOnce(async () => {
      await runFactory.create({
        taskId: task.id,
        status: RunStatus.Running,
        sandboxServerUrl: 'http://sandbox.test',
      });
      return { deleted: 1, errors: 0 };
    });

    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: false, reason: 'stop_failed' });

    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeDefined();
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toMatchObject({ deletedAt: null });
    await expect(
      db.query.taskArtifacts.findFirst({
        where: eq(taskArtifacts.id, artifact!.id),
      }),
    ).resolves.toBeUndefined();
  });

  it('does not delete a private Session while its Fast turn is active', async () => {
    const owner = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        privacy: 'private',
        privateOwnerUserId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
      fastConversationId: conversation!.id,
    });
    vi.spyOn(cloudAgents, 'acquireFastAgentTurnLock').mockResolvedValueOnce(
      null,
    );

    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: false, reason: 'session_busy' });
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeDefined();
    expect(mockDeleteArtifactsBatch).not.toHaveBeenCalled();
  });

  it('lets an owner delete a shared session and retires only its direct memories', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        privacy: 'shared',
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'shared',
      fastConversationId: conversation!.id,
    });
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Completed,
    });
    await db.insert(brainMemoryEvents).values({
      runId: run.id,
      status: 'done',
    });
    await db.insert(fastAgentMemoryEvents).values({
      conversationId: conversation!.id,
      memory: '- direct session memory',
      status: 'done',
    });

    await expect(
      deleteSessionCommand(
        { userId: other.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: false });
    await expect(
      deleteSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: true });

    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    await expect(
      db.query.fastAgentConversations.findFirst({
        where: eq(fastAgentConversations.id, conversation!.id),
      }),
    ).resolves.toBeUndefined();
    const retirements = await db.select().from(brainPageRetirements);
    expect(retirements.map(({ slug }) => slug).sort()).toEqual(
      [
        taskMemorySlug(task.id, run.id),
        fastConversationMemorySlug(conversation!.id),
      ].sort(),
    );

    await saveBrainAgentSummary(db, run.id, 'late summary');
    await expect(
      db.query.brainMemoryEvents.findFirst({
        where: eq(brainMemoryEvents.runId, run.id),
      }),
    ).resolves.toMatchObject({
      status: 'skipped',
      agentSummary: null,
      lastError: 'task deleted',
    });
  });
});
