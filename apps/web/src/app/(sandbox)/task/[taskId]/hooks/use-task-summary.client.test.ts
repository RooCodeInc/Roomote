import { renderHook } from '@testing-library/react';

type QueryResult = {
  data: unknown;
  isFetching: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
};

const { llmFeaturesRef, queryOptionsRef, queryResultRef } = vi.hoisted(() => ({
  llmFeaturesRef: {
    current: {
      enabled: true,
      setEnabled: vi.fn(),
      isLoading: false,
      isUpdating: false,
      isPersonalUser: false,
      canUpdate: false,
    },
  },
  queryOptionsRef: {
    current: null as Record<string, unknown> | null,
  },
  queryResultRef: {
    current: {
      data: undefined as unknown,
      isFetching: false,
      error: null as Error | null,
      refetch: vi.fn(),
    } satisfies QueryResult,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: Record<string, unknown>) => {
    queryOptionsRef.current = options;
    return queryResultRef.current;
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      generateSummary: {
        queryOptions: (
          input: { taskId: string },
          options: Record<string, unknown>,
        ) => ({
          queryKey: [['tasks', 'generateSummary', input.taskId]],
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('@/hooks/llm-features', () => ({
  useLLMEnhancedFeatures: () => llmFeaturesRef.current,
}));

import { useTaskSummary } from './use-task-summary';

describe('useTaskSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmFeaturesRef.current.enabled = true;
    queryOptionsRef.current = null;
    queryResultRef.current = {
      data: undefined,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
  });

  it('keeps summary generation disabled until explicitly enabled', () => {
    const { result } = renderHook(() =>
      useTaskSummary('task-1', { enabled: false }),
    );

    expect(queryOptionsRef.current).toMatchObject({
      enabled: false,
      staleTime: Infinity,
    });
    expect(result.current.enabled).toBe(false);
  });

  it('enables summary generation when the panel is active', () => {
    const { result } = renderHook(() =>
      useTaskSummary('task-1', { enabled: true }),
    );

    expect(queryOptionsRef.current).toMatchObject({
      enabled: true,
      staleTime: Infinity,
    });
    expect(result.current.enabled).toBe(true);
  });

  it('hides the summary section when there are not enough messages', () => {
    queryResultRef.current.data = {
      success: false,
      error: 'not_enough_messages',
      messageCount: 3,
    };

    const { result } = renderHook(() =>
      useTaskSummary('task-1', { enabled: true }),
    );

    expect(result.current.enabled).toBe(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it('maps summary generation failures to a safe retry message', () => {
    queryResultRef.current.data = {
      success: false,
      error: 'summary_generation_failed',
      messageCount: 12,
    };

    const { result } = renderHook(() =>
      useTaskSummary('task-1', { enabled: true }),
    );

    expect(result.current.enabled).toBe(true);
    expect(result.current.errorMessage).toBe(
      'Summary is temporarily unavailable. Try again in a moment.',
    );
    expect(result.current.errorMessage).not.toContain('python3 -c');
    expect(result.current.errorMessage).not.toContain('opencode run');
  });

  it('maps query errors to a safe retry message', () => {
    queryResultRef.current.error = new Error(
      "Command failed: python3 -c 'secret'",
    );

    const { result } = renderHook(() =>
      useTaskSummary('task-1', { enabled: true }),
    );

    expect(result.current.errorMessage).toBe(
      'Summary is temporarily unavailable. Try again in a moment.',
    );
  });
});
