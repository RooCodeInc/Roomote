import { sessionFactory, userFactory } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

const mocks = vi.hoisted(() => ({
  stopSessionTaskRuns: vi.fn(),
  stopTaskRun: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  settleLiveTaskMessageOnExit: vi.fn(),
  stopSessionTaskRuns: mocks.stopSessionTaskRuns,
  stopTaskRun: mocks.stopTaskRun,
}));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));

import { stopSessionTasksCommand } from './index';

describe('stopSessionTasksCommand', () => {
  beforeEach(() => {
    mocks.stopSessionTaskRuns.mockReset();
    mocks.stopTaskRun.mockReset();
  });

  async function fixture() {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    const auth = {
      userId: owner.id,
      isAdmin: false,
      name: 'Session owner',
    } as UserAuthSuccess;
    return { auth, session };
  }

  it('delegates an authorized session stop to the shared resumable stop path', async () => {
    const { auth, session } = await fixture();
    mocks.stopSessionTaskRuns.mockResolvedValue({
      success: true,
      stoppedCount: 2,
    });

    await expect(stopSessionTasksCommand(auth, session.id)).resolves.toEqual({
      success: true,
      stoppedCount: 2,
    });
    expect(mocks.stopSessionTaskRuns).toHaveBeenCalledWith({
      sessionId: session.id,
      authUserId: auth.userId,
      cancelledBy: { name: auth.name, source: 'web' },
    });
    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
  });

  it('checks session management permission before stopping any run', async () => {
    const { auth, session } = await fixture();
    const stranger = await userFactory.create();

    await expect(
      stopSessionTasksCommand({ ...auth, userId: stranger.id }, session.id),
    ).resolves.toEqual({ success: false, stoppedCount: 0 });
    expect(mocks.stopSessionTaskRuns).not.toHaveBeenCalled();
  });
});
