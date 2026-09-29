import {
  db,
  eq,
  sessionFactory,
  sessionTasks,
  sessions,
  taskFactory,
  touchSessionActivity,
  userFactory,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';

const getDeploymentExperimentsMock = vi.hoisted(() => vi.fn());

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  getDeploymentExperiments: getDeploymentExperimentsMock,
}));

import { sessionStatusInputSchema, setSessionStatusCommand } from './index';

describe('setSessionStatusCommand', () => {
  beforeEach(() => {
    getDeploymentExperimentsMock.mockReset().mockResolvedValue({
      sessionStatusJudgment: true,
    });
  });

  async function fixture() {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      cachedStatus: 'ready',
    });
    const task = await taskFactory.create({
      state: 'active',
      initiatorUserId: owner.id,
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    const auth = {
      userId: owner.id,
      isAdmin: false,
    } as UserAuthSuccess;
    return { auth, owner, session };
  }

  it('persists manual done without changing the lifecycle cache and denies strangers', async () => {
    const { auth, owner, session } = await fixture();
    const stranger = await userFactory.create();

    await expect(
      setSessionStatusCommand(auth, session.id, 'done'),
    ).resolves.toMatchObject({
      id: session.id,
      cachedStatus: 'ready',
      manualStatus: 'done',
    });
    await touchSessionActivity(db, session.id, 100);
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toMatchObject({
      cachedStatus: 'ready',
      manualStatus: 'done',
    });

    await expect(
      setSessionStatusCommand(
        { userId: stranger.id, isAdmin: false } as UserAuthSuccess,
        session.id,
        'done',
      ),
    ).resolves.toBeNull();
    expect(owner.id).not.toBe(stranger.id);
    expect(getDeploymentExperimentsMock).toHaveBeenCalledTimes(1);
  });

  it('rejects status changes while the experiment is disabled', async () => {
    const { auth, session } = await fixture();
    getDeploymentExperimentsMock.mockResolvedValueOnce({
      sessionStatusJudgment: false,
    });

    await expect(
      setSessionStatusCommand(auth, session.id, 'done'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toMatchObject({ cachedStatus: 'ready' });
  });

  it('validates the manual status vocabulary and excludes active', async () => {
    const { session } = await fixture();

    expect(
      sessionStatusInputSchema.safeParse({
        sessionId: session.id,
        status: 'active',
      }).success,
    ).toBe(false);
    expect(
      sessionStatusInputSchema.safeParse({
        sessionId: session.id,
        status: 'done',
      }).success,
    ).toBe(true);
  });
});
