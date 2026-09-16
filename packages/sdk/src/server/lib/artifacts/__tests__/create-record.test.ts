import {
  db,
  eq,
  taskArtifacts,
  taskFactory,
  userFactory,
} from '@roomote/db/server';

import {
  authorizeTaskArtifactUpload,
  createTaskArtifactRecord,
} from '../create-record';

describe('createTaskArtifactRecord', () => {
  it('creates upload records for private tasks under their inherited owner', async () => {
    const owner = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });

    const artifact = await createTaskArtifactRecord({
      taskId: task.id,
      artifactType: 'general',
      contentType: 'text/plain',
      path: 'private.txt',
      size: 10,
    });
    expect(artifact).toMatchObject({ taskId: task.id, uploaded: false });

    const expiresAt = new Date(Date.now() + 60_000);
    await authorizeTaskArtifactUpload({
      taskId: task.id,
      artifactId: artifact!.id,
      expiresAt,
    });
    await expect(
      db.query.taskArtifacts.findFirst({
        where: eq(taskArtifacts.id, artifact!.id),
      }),
    ).resolves.toMatchObject({ uploadUrlExpiresAt: expiresAt });
  });

  it('allocates versions independently for each task owner', async () => {
    const firstTask = await taskFactory.create();
    const secondTask = await taskFactory.create();
    const input = {
      artifactType: 'general' as const,
      contentType: 'text/markdown',
      path: 'notes/result.md',
      size: 10,
    };

    const [first, second] = await Promise.all([
      createTaskArtifactRecord({ ...input, taskId: firstTask.id }),
      createTaskArtifactRecord({ ...input, taskId: firstTask.id }),
    ]);
    const otherOwner = await createTaskArtifactRecord({
      ...input,
      taskId: secondTask.id,
    });

    expect([first?.version, second?.version].sort()).toEqual([1, 2]);
    expect(otherOwner?.version).toBe(1);
    expect(first).toMatchObject({
      taskId: firstTask.id,
      sessionId: null,
      uploaded: false,
    });
  });

  it('records the bearer upload expiry on an existing shared artifact', async () => {
    const task = await taskFactory.create();
    const artifact = await createTaskArtifactRecord({
      taskId: task.id,
      artifactType: 'general',
      contentType: 'text/plain',
      path: 'authorized.txt',
      size: 10,
    });
    const expiresAt = new Date(Date.now() + 60_000);

    await authorizeTaskArtifactUpload({
      taskId: task.id,
      artifactId: artifact!.id,
      expiresAt,
    });

    await expect(
      db.query.taskArtifacts.findFirst({
        where: eq(taskArtifacts.id, artifact!.id),
      }),
    ).resolves.toMatchObject({ uploadUrlExpiresAt: expiresAt });
  });
});
