import type { UserAuthSuccess } from '@/types';

const { syncTaskThreadTitleMock, returningMock } = vi.hoisted(() => ({
  syncTaskThreadTitleMock: vi.fn(),
  returningMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({ returning: returningMock }),
      }),
    }),
  },
  tasks: {
    id: 'tasks.id',
    title: 'tasks.title',
    deletedAt: 'tasks.deletedAt',
  },
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
}));

vi.mock('@roomote/sdk/server', () => ({
  syncTaskCommunicationThreadTitleBestEffort: syncTaskThreadTitleMock,
}));

import { updateTaskTitleCommand } from '../update-title';

describe('updateTaskTitleCommand', () => {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'user-title-test',
    isAdmin: false,
  } as UserAuthSuccess;

  beforeEach(() => {
    vi.clearAllMocks();
    returningMock.mockResolvedValue([
      { id: 'task-title-test', title: 'Canonical title' },
    ]);
    syncTaskThreadTitleMock.mockResolvedValue(undefined);
  });

  it('synchronizes the task-owned provider thread after renaming a task', async () => {
    const result = await updateTaskTitleCommand(auth, {
      taskId: 'task-title-test',
      title: '  Canonical title  ',
    });

    expect(syncTaskThreadTitleMock).toHaveBeenCalledWith({
      taskId: 'task-title-test',
    });
    expect(result.task.title).toBe('Canonical title');
  });
});
