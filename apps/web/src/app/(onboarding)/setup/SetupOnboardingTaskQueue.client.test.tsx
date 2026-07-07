import {
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';

const { mockSaveQueuedTasks, mockSuggestionsQueryFn, suggestionsStateRef } =
  vi.hoisted(() => ({
    mockSaveQueuedTasks: vi.fn(),
    mockSuggestionsQueryFn: vi.fn(),
    suggestionsStateRef: {
      current: 'ready' as 'ready' | 'pending' | 'empty',
    },
  }));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    taskSuggestions: {
      list: {
        queryKey: () => ['taskSuggestions.list'],
        queryOptions: () => ({
          queryKey: ['taskSuggestions.list'],
          queryFn: mockSuggestionsQueryFn,
        }),
      },
    },
    setupNew: {
      status: {
        queryKey: () => ['setupNew.status'],
      },
      saveQueuedTasks: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockSaveQueuedTasks,
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('@/components/system', () => ({
  ChevronDown: () => <svg aria-hidden="true" />,
  Checkbox: ({
    onCheckedChange,
    ...props
  }: ComponentProps<'input'> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      {...props}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

import { SetupOnboardingTaskQueue } from './SetupOnboardingTaskQueue';

function renderPanel(
  overrides: Partial<ComponentProps<typeof SetupOnboardingTaskQueue>> = {},
) {
  const queryClient = new QueryClient();

  return render(
    <QueryClientProvider client={queryClient}>
      <SetupOnboardingTaskQueue
        taskId="task-1"
        queuedOnboardingTasks={[]}
        matchingEnvironment={null}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe('SetupOnboardingTaskQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    suggestionsStateRef.current = 'ready';
    mockSaveQueuedTasks.mockResolvedValue({ queuedOnboardingTasks: [] });
    mockSuggestionsQueryFn.mockImplementation(async () => {
      if (suggestionsStateRef.current === 'pending') {
        return { generationStatus: 'pending', suggestions: [] };
      }

      if (suggestionsStateRef.current === 'empty') {
        return { generationStatus: 'empty', suggestions: [] };
      }

      return {
        generationStatus: 'ready',
        suggestions: [
          {
            id: 'suggestion-1',
            title: 'Stabilize a flaky test',
            brief:
              'Goal: Stabilize the flaky test.\nWhy it matters: Keeps CI trustworthy.\nScope: Find the failure mode and fix it.\nSuccess criteria: The test passes reliably.',
            environmentId: null,
          },
        ],
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden when there is no active onboarding task', () => {
    renderPanel({
      taskId: null,
    });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('saves selected suggestions', async () => {
    renderPanel();

    fireEvent.click(
      await screen.findByRole('checkbox', { name: /stabilize a flaky test/i }),
    );

    await waitFor(() => {
      expect(mockSaveQueuedTasks.mock.calls.at(-1)?.[0]).toEqual({
        selectedSuggestionIds: ['suggestion-1'],
        customTaskPrompt: '',
      });
    });
  });

  it('flushes a pending selection save when the step unmounts', async () => {
    const { unmount } = renderPanel();

    fireEvent.click(
      await screen.findByRole('checkbox', { name: /stabilize a flaky test/i }),
    );

    expect(mockSaveQueuedTasks).not.toHaveBeenCalled();

    unmount();

    await waitFor(() => {
      expect(mockSaveQueuedTasks.mock.calls.at(-1)?.[0]).toEqual({
        selectedSuggestionIds: ['suggestion-1'],
        customTaskPrompt: '',
      });
    });
  });

  it('shows a pending message while suggestions are still generating', async () => {
    suggestionsStateRef.current = 'pending';

    renderPanel();

    expect(
      await screen.findByText(
        /generating suggestions for this repository set/i,
      ),
    ).toBeInTheDocument();
  });

  it('shows an empty-state message when generation finishes without suggestions', async () => {
    suggestionsStateRef.current = 'empty';

    renderPanel();

    expect(
      await screen.findByText(
        /we couldn't generate suggestions for this repository set/i,
      ),
    ).toBeInTheDocument();
  });

  it('refetches suggestions while generation is pending', async () => {
    vi.useFakeTimers();
    suggestionsStateRef.current = 'pending';

    renderPanel();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSuggestionsQueryFn).toHaveBeenCalledTimes(1);

    suggestionsStateRef.current = 'ready';

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
    });

    expect(mockSuggestionsQueryFn).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('checkbox', { name: /stabilize a flaky test/i }),
    ).toBeInTheDocument();
  });
});
