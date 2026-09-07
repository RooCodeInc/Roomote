import type { UserAuthSuccess } from '@/types';

const { mockGetTaskSuggestableMessages, mockGenerateTrackedNonTaskObject } =
  vi.hoisted(() => ({
    mockGetTaskSuggestableMessages: vi.fn(),
    mockGenerateTrackedNonTaskObject: vi.fn(),
  }));

vi.mock('@/lib/server/task-messages', () => ({
  getTaskSuggestableMessages: mockGetTaskSuggestableMessages,
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

import { getComposerSuggestionCommand } from '../composer-suggestion';

type SuggestableRow = {
  id: string;
  eventType: string;
  role: string;
  text: string | null;
};

function userRow(id: string, text: string): SuggestableRow {
  return { id, eventType: 'roomote_runtime.user_prompt', role: 'user', text };
}

function assistantRow(id: string, text: string): SuggestableRow {
  return {
    id,
    eventType: 'roomote_runtime.assistant_message',
    role: 'assistant',
    text,
  };
}

const auth = {
  userId: 'user-1',
} as UserAuthSuccess;

describe('getComposerSuggestionCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the conversation is too short', async () => {
    mockGetTaskSuggestableMessages.mockResolvedValue([
      userRow('m1', 'Fix the login redirect'),
    ]);

    await expect(
      getComposerSuggestionCommand(auth, { taskId: 'task-1' }),
    ).resolves.toEqual({ suggestion: null, messageCount: 1 });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('generates a suggestion from user and assistant messages only', async () => {
    mockGetTaskSuggestableMessages.mockResolvedValue([
      userRow('m1', 'Fix the login redirect'),
      {
        id: 'm2',
        eventType: 'roomote_runtime.tool_call',
        role: 'assistant',
        text: 'tool output that must not leak into the prompt',
      },
      assistantRow('m3', 'Done. The redirect now preserves the return URL.'),
    ]);
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { suggestion: 'Add a return URL test' },
    });

    const result = await getComposerSuggestionCommand(auth, {
      taskId: 'task-1',
    });

    expect(result).toEqual({
      suggestion: 'Add a return URL test',
      messageCount: 2,
    });

    const call = mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0] as {
      prompt: string;
      surface: string;
      taskId: string;
      userId: string;
    };
    expect(call.surface).toBe('composer_suggestion_generation');
    expect(call.taskId).toBe('task-1');
    expect(call.userId).toBe('user-1');
    expect(call.prompt).toContain('User: Fix the login redirect');
    expect(call.prompt).toContain(
      'Roomote: Done. The redirect now preserves the return URL.',
    );
    expect(call.prompt).not.toContain('tool output that must not leak');
  });

  it('keeps the newest messages when the transcript exceeds the character budget', async () => {
    const filler = 'x'.repeat(20_000);
    mockGetTaskSuggestableMessages.mockResolvedValue([
      ...Array.from({ length: 4 }, (_, i) =>
        assistantRow(`old-${i}`, `Old message ${i} ${filler}`),
      ),
      userRow('newest', 'Newest instruction'),
    ]);
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { suggestion: 'Ship it' },
    });

    await getComposerSuggestionCommand(auth, { taskId: 'task-1' });

    const prompt = (
      mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0] as {
        prompt: string;
      }
    ).prompt;
    expect(prompt).toContain('User: Newest instruction');
    expect(prompt).not.toContain('Old message 0');
  });

  it('normalizes wrapping quotes and collapses whitespace', async () => {
    mockGetTaskSuggestableMessages.mockResolvedValue([
      userRow('m1', 'Fix it'),
      assistantRow('m2', 'Fixed'),
    ]);
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { suggestion: '"Now update\n the docs"' },
    });

    await expect(
      getComposerSuggestionCommand(auth, { taskId: 'task-1' }),
    ).resolves.toEqual({
      suggestion: 'Now update the docs',
      messageCount: 2,
    });
  });

  it('discards suggestions that overshoot the word budget', async () => {
    mockGetTaskSuggestableMessages.mockResolvedValue([
      userRow('m1', 'Fix it'),
      assistantRow('m2', 'Fixed'),
    ]);
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        suggestion:
          'Now please go ahead and update all of the documentation pages to describe this behavior',
      },
    });

    await expect(
      getComposerSuggestionCommand(auth, { taskId: 'task-1' }),
    ).resolves.toEqual({ suggestion: null, messageCount: 2 });
  });

  it('fails soft when generation throws', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockGetTaskSuggestableMessages.mockResolvedValue([
      userRow('m1', 'Fix it'),
      assistantRow('m2', 'Fixed'),
    ]);
    mockGenerateTrackedNonTaskObject.mockRejectedValue(
      new Error('provider unavailable'),
    );

    await expect(
      getComposerSuggestionCommand(auth, { taskId: 'task-1' }),
    ).resolves.toEqual({ suggestion: null, messageCount: 2 });
    consoleErrorSpy.mockRestore();
  });
});
