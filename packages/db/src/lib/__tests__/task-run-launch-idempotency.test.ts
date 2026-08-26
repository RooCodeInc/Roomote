import { RunStatus, TaskPayloadKind } from '@roomote/types';

import { db, inArray, taskFactory, taskRuns, tasks } from '../../server';
import type { CreateTaskRun } from '../../types';

const createdTaskIds: string[] = [];

async function createTask() {
  const task = await taskFactory.create({ state: 'active' });
  createdTaskIds.push(task.id);
  return task;
}

afterEach(async () => {
  if (createdTaskIds.length === 0) {
    return;
  }

  await db.delete(tasks).where(inArray(tasks.id, createdTaskIds.splice(0)));
});

describe('task run launch idempotency', () => {
  it('rejects a second persisted run with the same launch key', async () => {
    const firstTask = await createTask();
    const secondTask = await createTask();
    const payload = {
      repo: 'test/repo',
      description: 'starter task launch',
      launchIdempotencyKey:
        'setup-starter:test-user:11111111-1111-4111-8111-111111111111:speed-up-ci',
    } as CreateTaskRun['payload'];

    await db.insert(taskRuns).values({
      taskId: firstTask.id,
      kind: 'fresh',
      payloadKind: TaskPayloadKind.StandardTask,
      payload,
      status: RunStatus.Pending,
    });

    await expect(
      db.insert(taskRuns).values({
        taskId: secondTask.id,
        kind: 'fresh',
        payloadKind: TaskPayloadKind.StandardTask,
        payload,
        status: RunStatus.Pending,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
