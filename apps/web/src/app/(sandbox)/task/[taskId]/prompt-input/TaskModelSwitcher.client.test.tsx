import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskRunDetail } from '@/lib/server/task-runs';

const { launchModelsData, useMutationMock, useQueryMock } = vi.hoisted(() => ({
  launchModelsData: {
    current: null as {
      defaultModelId: string;
      defaultReasoningEffort: string;
      models: Array<{ id: string; displayName: string }>;
    } | null,
  },
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    taskModels: {
      roleDefaults: {
        queryOptions: vi.fn((input, options) => ({ input, ...options })),
      },
    },
    sandboxSession: {
      updateTaskModelSelection: {
        mutationOptions: vi.fn((options) => options),
      },
      byTaskId: { queryKey: vi.fn(() => ['sandboxSession']) },
    },
  }),
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({
    data: launchModelsData.current,
    isPending: launchModelsData.current === null,
  }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { TaskModelSwitcher } from './TaskModelSwitcher';

const taskRun = {
  id: 6500,
  payload: {
    harnessModelOverrides: { 'opencode-server': 'openai/gpt-6-astra' },
  },
} as unknown as TaskRunDetail;

describe('TaskModelSwitcher', () => {
  beforeEach(() => {
    useMutationMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    // Role defaults are gated on the popover being open, so the closed chip
    // renders before that query has any data.
    useQueryMock.mockReturnValue({ data: undefined });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    launchModelsData.current = null;
  });

  it('shows the deployment coding level on the closed chip when the run has no per-task level', () => {
    launchModelsData.current = {
      defaultModelId: 'openai/gpt-6-astra',
      defaultReasoningEffort: 'low',
      models: [{ id: 'openai/gpt-6-astra', displayName: 'GPT-6 Astra' }],
    };

    render(<TaskModelSwitcher taskRun={taskRun} />);

    const chip = screen.getByRole('button', { name: 'Models for this task' });
    expect(chip).toHaveTextContent('GPT-6 Astra');
    expect(chip).toHaveTextContent('Low');
    expect(chip).not.toHaveTextContent('Medium');
  });

  it('prefers the per-task level stamped on the run payload', () => {
    launchModelsData.current = {
      defaultModelId: 'openai/gpt-6-astra',
      defaultReasoningEffort: 'low',
      models: [{ id: 'openai/gpt-6-astra', displayName: 'GPT-6 Astra' }],
    };

    render(
      <TaskModelSwitcher
        taskRun={
          {
            ...taskRun,
            payload: { ...taskRun.payload, reasoningEffort: 'high' },
          } as unknown as TaskRunDetail
        }
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Models for this task' }),
    ).toHaveTextContent('High');
  });
});
