import { taskFactory, userFactory } from '@roomote/db/server';

import { createTaskArtifactRecord } from '../create-record';

describe('createTaskArtifactRecord', () => {
  it('rejects private tasks before creating an upload record', async () => {
    const owner = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });

    await expect(
      createTaskArtifactRecord({
        taskId: task.id,
        artifactType: 'general',
        contentType: 'text/plain',
        path: 'private.txt',
        size: 10,
      }),
    ).rejects.toThrow('Artifact publishing is unavailable in private Sessions');
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
});
