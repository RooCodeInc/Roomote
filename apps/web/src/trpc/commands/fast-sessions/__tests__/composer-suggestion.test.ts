import type { UserAuthSuccess } from '@/types';

const {
  mockFindAccessibleFastSession,
  mockGetFastSessionSuggestableMessages,
  mockGenerateTrackedNonTaskObject,
} = vi.hoisted(() => ({
  mockFindAccessibleFastSession: vi.fn(),
  mockGetFastSessionSuggestableMessages: vi.fn(),
  mockGenerateTrackedNonTaskObject: vi.fn(),
}));

vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mockFindAccessibleFastSession,
  getFastSessionSuggestableMessages: mockGetFastSessionSuggestableMessages,
}));

vi.mock('@roomote/cloud-agents/server/non-task-provider-usage', () => ({
  NON_TASK_INFERENCE_SURFACES: {
    composerSuggestionGeneration: 'composer_suggestion_generation',
  },
  generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { getFastSessionComposerSuggestionCommand } from '../composer-suggestion';

const auth = { userId: 'user-1' } as UserAuthSuccess;

describe('getFastSessionComposerSuggestionCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAccessibleFastSession.mockResolvedValue({ id: 'session-1' });
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
