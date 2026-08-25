import type { UserAuthSuccess } from '@/types';
import { mockUserResource } from '@/lib/mock-utils';

const { mockGetTasks } = vi.hoisted(() => ({
  mockGetTasks: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  getTasks: mockGetTasks,
}));

import { getTasksCommand } from '../list';

describe('getTasksCommand', () => {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'user-list-test',
    isAdmin: false,
    name: 'List Tester',
    resource: mockUserResource,
  } as UserAuthSuccess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTasks.mockResolvedValue({
      tasks: [],
      hasMore: false,
      nextCursor: undefined,
    });
  });

  it('defaults to current user when there is no user or agent filter', async () => {
    await getTasksCommand(auth, {
      filters: [
        {
          type: 'repositoryName',
          value: 'roomote/roomote',
          label: 'roomote/roomote',
        },
      ],
    });

    expect(mockGetTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: auth.userId,
        isAdmin: auth.isAdmin,
        filters: [
          {
            type: 'repositoryName',
            value: 'roomote/roomote',
            label: 'roomote/roomote',
          },
          { type: 'userId', value: auth.userId, label: auth.userId },
        ],
      }),
    );
  });

  it('does not default to current user when a category filter is present', async () => {
    await getTasksCommand(auth, {
      filters: [
        {
          type: 'category',
          value: 'pr-reviews',
          label: 'PR Reviews',
        },
      ],
    });

    expect(mockGetTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          {
            type: 'category',
            value: 'pr-reviews',
            label: 'PR Reviews',
          },
        ],
      }),
    );
  });

  it('removes explicit all-user filter before querying', async () => {
    await getTasksCommand(auth, {
      filters: [{ type: 'userId', value: 'all', label: 'all' }],
    });

    expect(mockGetTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [],
      }),
    );
  });

  it('passes through an explicit user filter unchanged', async () => {
    await getTasksCommand(auth, {
      filters: [{ type: 'userId', value: 'user-456', label: 'user-456' }],
    });

    expect(mockGetTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: 'userId', value: 'user-456', label: 'user-456' }],
      }),
    );
  });

  it('preserves model filters while still defaulting to the current user', async () => {
    await getTasksCommand(auth, {
      filters: [
        {
          type: 'model',
          value: 'openrouter/openai/gpt-5.5',
          label: 'GPT 5.5',
        },
      ],
    });

    expect(mockGetTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          {
            type: 'model',
            value: 'openrouter/openai/gpt-5.5',
            label: 'GPT 5.5',
          },
          { type: 'userId', value: auth.userId, label: auth.userId },
        ],
      }),
    );
  });

  it('strips task-type filters when debug UI is not enabled', async () => {
    await getTasksCommand(auth, {
      filters: [
        {
          type: 'taskType',
          value: 'onboarding.task.suggestions',
          label: 'onboarding.task.suggestions',
        },
      ],
    });

    expect(mockGetTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTaskTypeFilter: false,
        filters: [{ type: 'userId', value: auth.userId, label: auth.userId }],
      }),
    );
  });

  it('passes a board column through to the task query', async () => {
    await getTasksCommand(auth, {
      boardColumn: 'blocked',
      filters: [{ type: 'userId', value: auth.userId, label: auth.userId }],
    });

    expect(mockGetTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        boardColumn: 'blocked',
      }),
    );
  });
});
