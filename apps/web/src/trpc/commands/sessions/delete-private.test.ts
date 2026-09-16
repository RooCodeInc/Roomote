import {
  db,
  eq,
  fastAgentConversations,
  sessionFactory,
  sessions,
  sessionTasks,
  taskArtifacts,
  taskFactory,
  tasks,
  userFactory,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';

const mockDeleteArtifactsBatch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/s3-client', () => ({
  deleteArtifactsBatch: mockDeleteArtifactsBatch,
}));

import { deletePrivateSessionCommand } from './index';

describe('deletePrivateSessionCommand', () => {
  beforeEach(() => {
    mockDeleteArtifactsBatch.mockReset();
    mockDeleteArtifactsBatch.mockResolvedValue({ deleted: 1, errors: 0 });
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
      deletePrivateSessionCommand(
        { userId: other.id, isAdmin: true } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: false });
    await expect(
      deletePrivateSessionCommand(
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
      deletePrivateSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).rejects.toThrow('Failed to delete 1 private Session artifact object');
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeDefined();
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toBeDefined();
    await expect(
      db.query.taskArtifacts.findFirst({
        where: eq(taskArtifacts.id, artifact!.id),
      }),
    ).resolves.toBeDefined();
  });

  it('blocks concurrent artifact creation before taking the deletion snapshot', async () => {
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
    let concurrentInsert: Promise<unknown> | null = null;
    mockDeleteArtifactsBatch.mockImplementation(async () => {
      concurrentInsert = Promise.resolve(
        db.insert(taskArtifacts).values({
          taskId: task.id,
          contentType: 'text/plain',
          path: 'too-late.txt',
          version: 0,
          size: 8,
          uploaded: true,
        }),
      );
      const settled = concurrentInsert.then(
        () => true,
        () => true,
      );
      await expect(
        Promise.race([
          settled,
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), 100),
          ),
        ]),
      ).resolves.toBe(false);
      return { deleted: 0, errors: 0 };
    });

    await expect(
      deletePrivateSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: true });
    await expect(concurrentInsert).rejects.toThrow();
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
      deletePrivateSessionCommand(
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
      deletePrivateSessionCommand(
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
    await expect(
      deletePrivateSessionCommand(auth, session.id),
    ).resolves.toMatchObject({
      deleted: false,
      reason: 'artifact_uploads_pending',
    });
    expect(mockDeleteArtifactsBatch).not.toHaveBeenCalled();

    await db
      .update(taskArtifacts)
      .set({ uploaded: true, uploadUrlExpiresAt: new Date(0) })
      .where(eq(taskArtifacts.id, artifact!.id));
    await expect(
      deletePrivateSessionCommand(auth, session.id),
    ).resolves.toEqual({ deleted: true });
    expect(mockDeleteArtifactsBatch).toHaveBeenCalledWith([
      {
        sessionId: session.id,
        artifactId: artifact!.id,
        path: 'pending.txt',
        version: 1,
      },
    ]);
  });
});
