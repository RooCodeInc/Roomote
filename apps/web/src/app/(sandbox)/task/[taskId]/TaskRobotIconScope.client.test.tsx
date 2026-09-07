import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { parentSessionQueryMock, iconSessionQueryMock } = vi.hoisted(() => ({
  parentSessionQueryMock: vi.fn(),
  iconSessionQueryMock: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: {
      forTask: {
        queryOptions: (_input: unknown, options?: { enabled?: boolean }) => ({
          queryKey: ['sessions.forTask'],
          queryFn: parentSessionQueryMock,
          enabled: options?.enabled,
        }),
      },
      byId: {
        queryOptions: (_input: unknown, options?: { enabled?: boolean }) => ({
          queryKey: ['sessions.byId'],
          queryFn: iconSessionQueryMock,
          enabled: options?.enabled,
        }),
      },
    },
  }),
}));

import { TaskRobotIcon } from '@/components/tasks/TaskRobotIcon';
import { resolveTaskRobotIconId } from '@/lib/task-robot-icons';
import { TaskRobotIconScope } from './TaskRobotIconScope';

describe('TaskRobotIconScope', () => {
  it('gives standalone transcript activity the parent Session assignment', async () => {
    parentSessionQueryMock.mockResolvedValue({ sessionId: 'session-1' });
    iconSessionQueryMock.mockResolvedValue({
      tasks: [{ taskId: 'parent-task' }, { taskId: 'child-task' }],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <TaskRobotIconScope taskId="parent-task">
          <TaskRobotIcon taskId="child-task" />
        </TaskRobotIconScope>
      </QueryClientProvider>,
    );

    const expectedIcon = resolveTaskRobotIconId({
      sessionId: 'session-1',
      taskId: 'child-task',
      orderedTaskIds: ['parent-task', 'child-task'],
    });
    await waitFor(() => {
      expect(
        container.querySelector(`[data-task-robot-icon="${expectedIcon}"]`),
      ).toBeInTheDocument();
    });
  });
});
