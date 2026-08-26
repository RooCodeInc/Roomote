import type { UserAuthSuccess } from '@/types';

const { acknowledgeMock, findTaskMock } = vi.hoisted(() => ({
  acknowledgeMock: vi.fn(),
  findTaskMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  acknowledgeTaskResolution: acknowledgeMock,
  db: { query: { tasks: { findFirst: findTaskMock } } },
  tasks: { id: 'tasks.id', deletedAt: 'tasks.deletedAt' },
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
}));

import { acknowledgeTaskResolutionCommand } from '../acknowledge-resolution';

describe('acknowledgeTaskResolutionCommand', () => {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'deployment-member',
    isAdmin: false,
  } as UserAuthSuccess;

  beforeEach(() => {
    vi.clearAllMocks();
    findTaskMock.mockResolvedValue({ id: 'task-1' });
    acknowledgeMock.mockResolvedValue(true);
  });

  it('allows a deployment member to acknowledge an actionable task', async () => {
    await expect(
      acknowledgeTaskResolutionCommand(auth, { taskId: 'task-1' }),
    ).resolves.toEqual({ success: true, changed: true });

    expect(acknowledgeMock).toHaveBeenCalledWith('task-1');
  });

  it('is successful when the resolution was already acknowledged', async () => {
    acknowledgeMock.mockResolvedValue(false);

    await expect(
      acknowledgeTaskResolutionCommand(auth, { taskId: 'task-1' }),
    ).resolves.toEqual({ success: true, changed: false });
  });

  it('rejects missing or deleted tasks', async () => {
    findTaskMock.mockResolvedValue(null);

    await expect(
      acknowledgeTaskResolutionCommand(auth, { taskId: 'missing' }),
    ).rejects.toThrow('Task not found');
    expect(acknowledgeMock).not.toHaveBeenCalled();
  });
});
