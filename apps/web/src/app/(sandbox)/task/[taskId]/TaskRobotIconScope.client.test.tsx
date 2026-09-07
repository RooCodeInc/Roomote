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

import {
  TaskRobotIcon,
  TaskRobotIconProvider,
  useTaskRobotIconContext,
} from '@/components/tasks/TaskRobotIcon';
import { resolveTaskRobotIconId } from '@/lib/task-robot-icons';
import { TaskRobotIconScope } from './TaskRobotIconScope';

describe('TaskRobotIconScope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves inherited Session identity, ordering and navigation while exposing the source task', () => {
    const contextSpy = vi.fn();
    function Probe() {
      contextSpy(useTaskRobotIconContext());
      return null;
    }
    const onOpenTask = vi.fn();
    const orderedTaskIds = ['first', 'source-task'];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TaskRobotIconProvider
          sessionId="session-1"
          orderedTaskIds={orderedTaskIds}
          onOpenTask={onOpenTask}
          currentTaskId="outer-task"
        >
          <TaskRobotIconScope
            taskId="source-task"
            fastAgentSessionId="legacy-session"
          >
            <Probe />
          </TaskRobotIconScope>
        </TaskRobotIconProvider>
      </QueryClientProvider>,
    );
    expect(contextSpy).toHaveBeenCalledWith({
      sessionId: 'session-1',
      orderedTaskIds,
      onOpenTask,
      currentTaskId: 'source-task',
    });
    expect(parentSessionQueryMock).not.toHaveBeenCalled();
    expect(iconSessionQueryMock).not.toHaveBeenCalled();
  });

  it('provides source identity even without a parent Session', async () => {
    parentSessionQueryMock.mockResolvedValue(null);
    const contextSpy = vi.fn();
    function Probe() {
      contextSpy(useTaskRobotIconContext());
      return null;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TaskRobotIconScope taskId="source-task">
          <Probe />
        </TaskRobotIconScope>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(parentSessionQueryMock).toHaveBeenCalled());
    expect(contextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTaskId: 'source-task',
        sessionId: null,
        orderedTaskIds: [],
      }),
    );
    expect(iconSessionQueryMock).not.toHaveBeenCalled();
  });

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
