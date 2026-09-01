import type { UserAuthSuccess } from '@/types';

const {
  mockFindAccessibleFastSession,
  mockGetFastSessionSuggestableMessages,
  mockGetFastSessionTasks,
  mockGenerateTrackedNonTaskObject,
  cacheKeys,
} = vi.hoisted(() => ({
  mockFindAccessibleFastSession: vi.fn(),
  mockGetFastSessionSuggestableMessages: vi.fn(),
  mockGetFastSessionTasks: vi.fn(),
  mockGenerateTrackedNonTaskObject: vi.fn(),
  cacheKeys: [] as unknown[][],
}));

vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mockFindAccessibleFastSession,
  getFastSessionSuggestableMessages: mockGetFastSessionSuggestableMessages,
  getFastSessionTasks: mockGetFastSessionTasks,
}));

vi.mock('@roomote/cloud-agents/server/non-task-provider-usage', () => ({
  NON_TASK_INFERENCE_SURFACES: {
    composerSuggestionGeneration: 'composer_suggestion_generation',
  },
  generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
}));

vi.mock('next/cache', () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => unknown,
    keyParts: unknown[],
  ) => {
    cacheKeys.push(keyParts);
    return fn;
  },
}));

import { getFastSessionComposerSuggestionCommand } from '../composer-suggestion';

const auth = {
  userId: 'user-1',
  featureFlags: { composerSuggestions: true },
} as UserAuthSuccess;

const flagOffAuth = { userId: 'user-1', featureFlags: {} } as UserAuthSuccess;

describe('getFastSessionComposerSuggestionCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheKeys.length = 0;
    mockFindAccessibleFastSession.mockResolvedValue({ id: 'session-1' });
    mockGetFastSessionTasks.mockResolvedValue([]);
  });

  it('returns null without loading the session when the flag is off', async () => {
    await expect(
      getFastSessionComposerSuggestionCommand(flagOffAuth, {
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({ suggestion: null, messageCount: 0 });
    expect(mockFindAccessibleFastSession).not.toHaveBeenCalled();
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('returns null without generating when the session is not accessible', async () => {
    mockFindAccessibleFastSession.mockResolvedValue(null);

    await expect(
      getFastSessionComposerSuggestionCommand(auth, {
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({ suggestion: null, messageCount: 0 });
    expect(mockGetFastSessionSuggestableMessages).not.toHaveBeenCalled();
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('generates a suggestion from the persisted session conversation', async () => {
    mockGetFastSessionSuggestableMessages.mockResolvedValue([
      {
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        text: 'Fix the login redirect',
      },
      {
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        text: 'Done. The redirect now preserves the return URL.',
      },
    ]);
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { suggestion: 'Add a return URL test' },
    });

    await expect(
      getFastSessionComposerSuggestionCommand(auth, {
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({
      suggestion: 'Add a return URL test',
      messageCount: 2,
    });

    const call = mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0] as {
      prompt: string;
      surface: string;
      taskId: string | null;
      userId: string;
    };
    expect(call.surface).toBe('composer_suggestion_generation');
    expect(call.taskId).toBeNull();
    expect(call.userId).toBe('user-1');
    expect(call.prompt).toContain('User: Fix the login redirect');
    expect(call.prompt).toContain(
      'Roomote: Done. The redirect now preserves the return URL.',
    );
  });

  it('includes delegated task titles and status as context', async () => {
    mockGetFastSessionSuggestableMessages.mockResolvedValue([
      {
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        text: 'Fix the login redirect',
      },
      {
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        text: 'Delegated that to a task.',
      },
    ]);
    mockGetFastSessionTasks.mockResolvedValue([
      {
        taskId: 'task-1',
        title: 'Fix login redirect',
        inferenceCostMicroUsd: 0,
        artifacts: [{ id: 'a1' }],
        latestRun: { status: 'running', taskPhase: 'running' },
      },
      {
        taskId: 'task-2',
        title: '',
        inferenceCostMicroUsd: 0,
        artifacts: [],
        latestRun: { status: 'completed', taskPhase: 'waiting_for_prompt' },
      },
    ]);
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { suggestion: 'Check on the redirect task' },
    });

    await getFastSessionComposerSuggestionCommand(auth, {
      sessionId: 'session-1',
    });

    const prompt = (
      mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0] as {
        prompt: string;
      }
    ).prompt;
    expect(prompt).toContain(
      'Tasks the agent has delegated in this session, with their current status:',
    );
    expect(prompt).toContain(
      '- Fix login redirect (running, running, 1 artifact)',
    );
    expect(prompt).toContain('- Untitled task (completed, waiting_for_prompt)');
    // Context precedes the transcript so the model reads state first.
    expect(prompt.indexOf('Tasks the agent has delegated')).toBeLessThan(
      prompt.indexOf('Here is the conversation:'),
    );

    const runningCacheKey = cacheKeys.at(-1);
    mockGetFastSessionTasks.mockResolvedValue([
      {
        taskId: 'task-1',
        title: 'Fix login redirect',
        inferenceCostMicroUsd: 0,
        artifacts: [{ id: 'a1', version: 1 }],
        latestRun: { status: 'completed', taskPhase: 'waiting_for_prompt' },
      },
    ]);

    await getFastSessionComposerSuggestionCommand(auth, {
      sessionId: 'session-1',
    });

    expect(cacheKeys.at(-1)).not.toEqual(runningCacheKey);
  });

  it('still generates when loading session tasks fails', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockGetFastSessionSuggestableMessages.mockResolvedValue([
      {
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        text: 'Fix it',
      },
      {
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        text: 'Fixed',
      },
    ]);
    mockGetFastSessionTasks.mockRejectedValue(new Error('tasks unavailable'));
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { suggestion: 'Ship it' },
    });

    await expect(
      getFastSessionComposerSuggestionCommand(auth, {
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({ suggestion: 'Ship it', messageCount: 2 });
    expect(
      (
        mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0] as {
          prompt: string;
        }
      ).prompt,
    ).not.toContain('Tasks the agent has delegated');
    consoleErrorSpy.mockRestore();
  });

  it('returns null without generating when the conversation is too short', async () => {
    mockGetFastSessionSuggestableMessages.mockResolvedValue([
      {
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        text: 'Fix it',
      },
    ]);

    await expect(
      getFastSessionComposerSuggestionCommand(auth, {
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({ suggestion: null, messageCount: 1 });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('fails soft when loading the session throws', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockFindAccessibleFastSession.mockRejectedValue(new Error('db down'));

    await expect(
      getFastSessionComposerSuggestionCommand(auth, {
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({ suggestion: null, messageCount: 0 });
    consoleErrorSpy.mockRestore();
  });
});
