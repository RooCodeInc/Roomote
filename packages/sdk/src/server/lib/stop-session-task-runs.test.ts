import {
  db,
  runFactory,
  sessionFactory,
  sessionTasks,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

const mocks = vi.hoisted(() => ({ stopTaskRun: vi.fn() }));

vi.mock('./task-runs/stop-task-run', () => ({
  stopTaskRun: mocks.stopTaskRun,
}));

import { stopSessionTaskRuns } from './stop-session-task-runs';

describe('stopSessionTaskRuns', () => {
  beforeEach(() => mocks.stopTaskRun.mockReset());

  it('stops every active run linked to the Session without terminating or touching other sessions', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    const linkedTaskIds = await Promise.all([
      taskFactory.create({ initiatorUserId: owner.id }),
      taskFactory.create({ initiatorUserId: owner.id }),
    ]);
    const unrelatedTask = await taskFactory.create({
      initiatorUserId: owner.id,
    });
    const completedTask = await taskFactory.create({
      initiatorUserId: owner.id,
    });
    const unrelatedSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    await db.insert(sessionTasks).values([
      {
        sessionId: session.id,
        taskId: linkedTaskIds[0]!.id,
        origin: 'direct_launch',
      },
      {
        sessionId: session.id,
        taskId: linkedTaskIds[1]!.id,
        origin: 'fast_delegation',
      },
      {
        sessionId: unrelatedSession.id,
        taskId: unrelatedTask.id,
        origin: 'direct_launch',
      },
      {
        sessionId: session.id,
        taskId: completedTask.id,
        origin: 'direct_launch',
      },
    ]);

    const running = await runFactory.create({
      taskId: linkedTaskIds[0]!.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'https://sandbox-running.example',
    });
    const idle = await runFactory.create({
      taskId: linkedTaskIds[1]!.id,
      status: RunStatus.Idle,
      sandboxServerUrl: 'https://sandbox-idle.example',
    });
    await runFactory.create({
      taskId: unrelatedTask.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'https://sandbox-unrelated.example',
    });
    await runFactory.create({
      taskId: completedTask.id,
      status: RunStatus.Completed,
      sandboxServerUrl: 'https://sandbox-completed.example',
    });
    mocks.stopTaskRun.mockResolvedValue({
      success: true,
      mode: 'sandbox_stop',
    });

    await expect(
      stopSessionTaskRuns({
        sessionId: session.id,
        authUserId: owner.id,
        cancelledBy: { name: 'Session owner', source: 'telegram' },
      }),
    ).resolves.toEqual({ success: true, stoppedCount: 2 });

    expect(
      mocks.stopTaskRun.mock.calls
        .map(([input]) => input.run.id)
        .sort((a, b) => a - b),
    ).toEqual([running.id, idle.id].sort((a, b) => a - b));
    for (const [input] of mocks.stopTaskRun.mock.calls) {
      expect(input).toMatchObject({
        authUserId: owner.id,
        terminate: false,
        cancelledBy: { name: 'Session owner', source: 'telegram' },
      });
    }
  });

  it('succeeds when the Session has no active task runs', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });

    await expect(
      stopSessionTaskRuns({ sessionId: session.id, authUserId: owner.id }),
    ).resolves.toEqual({ success: true, stoppedCount: 0 });
    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
  });
});
