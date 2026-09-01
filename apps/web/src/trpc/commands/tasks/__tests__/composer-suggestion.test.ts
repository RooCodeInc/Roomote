import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import type { UserAuthSuccess, TaskMessageEnvelope } from '@/types';

const { mockGetTaskMessageEnvelopes, mockGenerateTrackedNonTaskObject } =
  vi.hoisted(() => ({
    mockGetTaskMessageEnvelopes: vi.fn(),
    mockGenerateTrackedNonTaskObject: vi.fn(),
  }));

vi.mock('@/lib/server', () => ({
  getTaskMessageEnvelopes: mockGetTaskMessageEnvelopes,
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

function envelope(
  overrides: Partial<TaskMessageEnvelope> & {
    id: string;
    eventType: string;
    role: string;
    text?: string;
  },
): TaskMessageEnvelope {
  return {
    taskId: 'task-1',
    ts: 1,
    createdAt: 1,
    contentBlocks: [],
    metadata: {},
    payload: {},
    ...overrides,
  } as unknown as TaskMessageEnvelope;
}

const auth = { userId: 'user-1' } as UserAuthSuccess;

describe('getComposerSuggestionCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the conversation is too short', async () => {
    mockGetTaskMessageEnvelopes.mockResolvedValue([
      envelope({
        id: 'm1',
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Fix the login redirect',
      }),
    ]);

    await expect(
      getComposerSuggestionCommand(auth, { taskId: 'task-1' }),
    ).resolves.toEqual({ suggestion: null, messageCount: 1 });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('generates a suggestion from user and assistant messages only', async () => {
    mockGetTaskMessageEnvelopes.mockResolvedValue([
      envelope({
        id: 'm1',
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Fix the login redirect',
      }),
      envelope({
        id: 'm2',
        eventType: 'roomote_runtime.tool_call',
        role: 'assistant',
        text: 'tool output that must not leak into the prompt',
      }),
      envelope({
        id: 'm3',
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        text: 'Done. The redirect now preserves the return URL.',
      }),
    ]);
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { suggestion: 'Add a test covering the return URL' },
    });

    const result = await getComposerSuggestionCommand(auth, {
      taskId: 'task-1',
    });

    expect(result).toEqual({
      suggestion: 'Add a test covering the return URL',
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
    mockGetTaskMessageEnvelopes.mockResolvedValue([
      ...Array.from({ length: 4 }, (_, i) =>
        envelope({
          id: `old-${i}`,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: 'assistant',
          text: `Old message ${i} ${filler}`,
        }),
      ),
      envelope({
        id: 'newest',
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Newest instruction',
      }),
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
    mockGetTaskMessageEnvelopes.mockResolvedValue([
      envelope({
        id: 'm1',
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Fix it',
      }),
      envelope({
        id: 'm2',
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        text: 'Fixed',
      }),
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

  it('fails soft when generation throws', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockGetTaskMessageEnvelopes.mockResolvedValue([
      envelope({
        id: 'm1',
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Fix it',
      }),
      envelope({
        id: 'm2',
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        text: 'Fixed',
      }),
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
