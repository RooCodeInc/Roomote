import { renderHook } from '@testing-library/react';

const { useTaskSessionMock, useEnvironmentMock } = vi.hoisted(() => ({
  useTaskSessionMock: vi.fn(),
  useEnvironmentMock: vi.fn(),
}));

vi.mock('@/app/(sandbox)/task/[taskId]/hooks', () => ({
  useTaskSession: (...args: unknown[]) => useTaskSessionMock(...args),
}));

vi.mock('@/hooks/environments', () => ({
  useEnvironment: (...args: unknown[]) => useEnvironmentMock(...args),
}));

import { useEnvironmentDefinitionAgentState } from './EnvironmentDefinitionAgentTask';

describe('useEnvironmentDefinitionAgentState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks create mode as succeeded while the setup task is idle once the environment is linked', () => {
    useTaskSessionMock.mockReturnValue({
      taskRun: {
        status: 'idle',
        taskPhase: 'waiting_for_prompt',
        payload: {
          environmentDefinitionId: 'env-1',
        },
      },
    });
    useEnvironmentMock.mockImplementation((id?: string) =>
      id === 'env-1'
        ? {
            data: { id: 'env-1', name: 'Acme Stack' },
            isFetched: true,
            refetch: vi.fn(),
          }
        : {
            data: null,
            isFetched: false,
            refetch: vi.fn(),
          },
    );

    const { result } = renderHook(() =>
      useEnvironmentDefinitionAgentState({
        taskId: 'task-1',
        mode: 'create',
      }),
    );

    expect(result.current.succeeded).toBe(true);
    expect(result.current.failed).toBe(false);
    expect(result.current.taskIsActive).toBe(true);
    expect(result.current.matchingEnvironment).toEqual({
      id: 'env-1',
      name: 'Acme Stack',
    });
  });

  it('does not mark create mode as succeeded when the idle task is still running', () => {
    useTaskSessionMock.mockReturnValue({
      taskRun: {
        status: 'idle',
        taskPhase: 'running',
        payload: {
          environmentDefinitionId: 'env-1',
        },
      },
    });
    useEnvironmentMock.mockImplementation((id?: string) =>
      id === 'env-1'
        ? {
            data: { id: 'env-1', name: 'Acme Stack' },
            isFetched: true,
            refetch: vi.fn(),
          }
        : {
            data: null,
            isFetched: false,
            refetch: vi.fn(),
          },
    );

    const { result } = renderHook(() =>
      useEnvironmentDefinitionAgentState({
        taskId: 'task-1',
        mode: 'create',
      }),
    );

    expect(result.current.succeeded).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(result.current.taskIsActive).toBe(true);
  });

  it('marks create mode as succeeded once the setup task completes', () => {
    useTaskSessionMock.mockReturnValue({
      taskRun: {
        status: 'completed',
        payload: {
          environmentDefinitionId: 'env-1',
        },
      },
    });
    useEnvironmentMock.mockImplementation((id?: string) =>
      id === 'env-1'
        ? {
            data: { id: 'env-1', name: 'Acme Stack' },
            isFetched: true,
            refetch: vi.fn(),
          }
        : {
            data: null,
            isFetched: false,
            refetch: vi.fn(),
          },
    );

    const { result } = renderHook(() =>
      useEnvironmentDefinitionAgentState({
        taskId: 'task-1',
        mode: 'create',
      }),
    );

    expect(result.current.succeeded).toBe(true);
    expect(result.current.failed).toBe(false);
    expect(result.current.taskIsActive).toBe(false);
    expect(result.current.matchingEnvironment).toEqual({
      id: 'env-1',
      name: 'Acme Stack',
    });
  });
});
