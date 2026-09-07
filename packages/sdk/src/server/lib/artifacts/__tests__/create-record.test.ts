import { taskFactory } from '@roomote/db/server';

import { createTaskArtifactRecord } from '../create-record';

describe('createTaskArtifactRecord', () => {
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
