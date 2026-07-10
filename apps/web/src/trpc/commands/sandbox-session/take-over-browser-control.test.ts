import {
  runFactory,
  db,
  eq,
  taskFactory,
  taskRuns,
  userFactory,
} from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

import { takeOverBrowserControlCommand } from './index';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'user-browser-control-test',
    isAdmin: false,
    name: 'Test User',
    primaryEmail: 'test@test.com',
    featureFlags: {} as Record<FeatureFlag, boolean>,
    resource: {
      username: 'testuser',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
      primaryEmailAddress: { id: '1', emailAddress: 'test@test.com' },
      emailAddresses: [{ id: '1', emailAddress: 'test@test.com' }],
      imageUrl: 'https://example.com/avatar.jpg',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;

  return auth as UserAuthSuccess;
}

describe('takeOverBrowserControlCommand', () => {
  it("updates actingUserId on the task's current task run", async () => {
    const owner = await userFactory.create();
    const viewer = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
    });
    const staleTaskRun = await runFactory.create({
      taskId: task.id,
      actingUserId: owner.id,
      status: RunStatus.Completed,
      snapshotId: 'snapshot-1',
    });
    const activeTaskRun = await runFactory.create({
      taskId: task.id,
      sourceRunId: staleTaskRun.id,
      kind: 'resume',
      payloadKind: TaskPayloadKind.SnapshotResume,
      actingUserId: owner.id,
      status: RunStatus.Running,
    });

    const result = await takeOverBrowserControlCommand(
      buildMockAuth({
        userId: viewer.id,
      }),
      { taskId: task.id },
    );

    expect(result).toEqual({
      success: true,
      taskRun: {
        id: activeTaskRun.id,
        actingUserId: viewer.id,
      },
    });

    const updatedTaskRuns = await db
      .select({
        id: taskRuns.id,
        actingUserId: taskRuns.actingUserId,
      })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, task.id));

    expect(updatedTaskRuns).toEqual(
      expect.arrayContaining([
        { id: staleTaskRun.id, actingUserId: owner.id },
        { id: activeTaskRun.id, actingUserId: viewer.id },
      ]),
    );
  });
});
