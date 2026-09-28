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

import { setSessionStatusCommand } from './index';

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

  it('persists canonical statuses for a session manager and denies strangers', async () => {
    const { auth, owner, session } = await fixture();
    const stranger = await userFactory.create();

    await expect(
      setSessionStatusCommand(auth, session.id, 'blocked'),
    ).resolves.toMatchObject({
      id: session.id,
      cachedStatus: 'blocked',
      manualStatus: 'blocked',
    });
    await touchSessionActivity(db, session.id, 100);
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toMatchObject({
      cachedStatus: 'blocked',
      manualStatus: 'blocked',
    });

    await expect(
      setSessionStatusCommand(
        { userId: stranger.id, isAdmin: false } as UserAuthSuccess,
        session.id,
        'active',
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
      setSessionStatusCommand(auth, session.id, 'active'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toMatchObject({ cachedStatus: 'ready' });
  });
});
