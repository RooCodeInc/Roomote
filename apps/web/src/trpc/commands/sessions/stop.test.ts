import {
  db,
  runFactory,
  sessionFactory,
  sessionTasks,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

const mocks = vi.hoisted(() => ({ stopTaskRun: vi.fn() }));

vi.mock('@roomote/sdk/server', () => ({
  settleLiveTaskMessageOnExit: vi.fn(),
  stopTaskRun: mocks.stopTaskRun,
}));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));

import { stopSessionTasksCommand } from './index';

describe('stopSessionTasksCommand', () => {
  beforeEach(() => mocks.stopTaskRun.mockReset());

  async function fixture() {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    const taskOne = await taskFactory.create({ initiatorUserId: owner.id });
    const taskTwo = await taskFactory.create({ initiatorUserId: owner.id });
    await db.insert(sessionTasks).values([
      { sessionId: session.id, taskId: taskOne.id, origin: 'direct_launch' },
      { sessionId: session.id, taskId: taskTwo.id, origin: 'fast_delegation' },
    ]);
    const runOne = await runFactory.create({
      taskId: taskOne.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'https://sandbox-one.example',
    });
    const runTwo = await runFactory.create({
      taskId: taskTwo.id,
      status: RunStatus.Idle,
      sandboxServerUrl: 'https://sandbox-two.example',
    });
    const auth = {
      userId: owner.id,
      isAdmin: false,
      name: 'Session owner',
    } as UserAuthSuccess;
    return { auth, session, runOne, runTwo };
  }

  it('fans out resumable stops to every exact active run concurrently', async () => {
    const { auth, session, runOne, runTwo } = await fixture();
    const stops = [
      Promise.withResolvers<{ success: true; mode: 'sandbox' }>(),
      Promise.withResolvers<{ success: true; mode: 'sandbox' }>(),
    ];
    mocks.stopTaskRun
      .mockReturnValueOnce(stops[0]!.promise)
      .mockReturnValueOnce(stops[1]!.promise);

    const stopping = stopSessionTasksCommand(auth, session.id);
    await vi.waitFor(() => expect(mocks.stopTaskRun).toHaveBeenCalledTimes(2));
    expect(
      mocks.stopTaskRun.mock.calls.map(([input]) => input.run.id).sort(),
    ).toEqual([runOne.id, runTwo.id].sort((a, b) => a - b));
    for (const [input] of mocks.stopTaskRun.mock.calls) {
      expect(input).toMatchObject({
        authUserId: auth.userId,
        terminate: false,
        cancelledBy: { name: auth.name, source: 'web' },
      });
    }

    stops.forEach((stop) => stop.resolve({ success: true, mode: 'sandbox' }));
    await expect(stopping).resolves.toEqual({ success: true, stoppedCount: 2 });
  });

  it('checks session management permission before stopping any run', async () => {
    const { auth, session } = await fixture();
    const stranger = await userFactory.create();

    await expect(
      stopSessionTasksCommand({ ...auth, userId: stranger.id }, session.id),
    ).resolves.toEqual({ success: false, stoppedCount: 0 });
    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
  });
});
