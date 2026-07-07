import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import type { UserAuthSuccess, TaskMessageEnvelope } from '@/types';

const {
  mockGetTaskMessageEnvelopes,
  mockGenerateTrackedNonTaskObject,
  mockDbSelect,
} = vi.hoisted(() => {
  const mockLimit = vi.fn();
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockLeftJoin = vi.fn(() => ({ where: mockWhere }));
  const mockFrom = vi.fn(() => ({ leftJoin: mockLeftJoin }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));

  return {
    mockGetTaskMessageEnvelopes: vi.fn(),
    mockGenerateTrackedNonTaskObject: vi.fn(),
    mockDbSelect: {
      select: mockSelect,
      from: mockFrom,
      leftJoin: mockLeftJoin,
      where: mockWhere,
      limit: mockLimit,
    },
  };
});

vi.mock('@/lib/server', () => ({
  getTaskMessageEnvelopes: mockGetTaskMessageEnvelopes,
}));

vi.mock('@roomote/cloud-agents/server/non-task-provider-usage', () => ({
  NON_TASK_INFERENCE_SURFACES: {
    taskSummaryGeneration: 'task_summary_generation',
  },
  generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@roomote/db/server', () => ({
  db: { select: mockDbSelect.select },
  tasks: { id: 'id', userId: 'userId', orgId: 'orgId' },
  users: { id: 'id', name: 'name' },
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

import { generateTaskSummaryCommand } from '../generate-summary';

function envelope(
  overrides: Partial<TaskMessageEnvelope> & {
    id: string;
    ts: number;
    eventType: string;
    role: string;
    text?: string;
  },
): TaskMessageEnvelope {
  return {
    userId: 'user-summary-test',
    userName: null,
    userEmail: null,
    userImageUrl: null,
    taskId: 'task-test',
    createdAt: overrides.ts,
    sequence: null,
    kind: 'text',
    protocol: 'roomote_runtime',
    contentBlocks: [],
    metadata: null,
    payload: null,
    ...overrides,
  } as TaskMessageEnvelope;
}

describe('generateTaskSummaryCommand', () => {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'user-summary-test',
    name: 'Alice Example',
  } as UserAuthSuccess;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { summary: 'Summary response' },
    });

    // Default: DB returns the task creator's name
    mockDbSelect.limit.mockResolvedValue([
      {
        taskUserId: 'user-summary-test',
        userName: 'Bruno Bergher',
        userEmail: 'bruno@example.com',
      },
    ]);
  });

  it('returns not_enough_messages when there are no messages', async () => {
    mockGetTaskMessageEnvelopes.mockResolvedValue([]);

    const result = await generateTaskSummaryCommand(auth, {
      taskId: 'task-empty',
    });

    expect(mockGetTaskMessageEnvelopes).toHaveBeenCalledWith({
      taskId: 'task-empty',
      userId: auth.userId,
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'not_enough_messages',
      messageCount: 0,
    });
  });

  it('returns not_enough_messages when below threshold', async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      envelope({
        id: `message-${i}`,
        taskId: 'task-few',
        ts: i,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        text: `Message ${i}`,
      }),
    );

    mockGetTaskMessageEnvelopes.mockResolvedValue(messages);

    const result = await generateTaskSummaryCommand(auth, {
      taskId: 'task-few',
    });

    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'not_enough_messages',
      messageCount: 5,
    });
  });

  it('generates a summary from persisted messages', async () => {
    const persistedMessages = [
      envelope({
        id: 'message-1',
        taskId: 'task-has-messages',
        ts: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Please help me implement cloud job message persistence.',
      }),
      envelope({
        id: 'message-2',
        taskId: 'task-has-messages',
        ts: 2,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        text: 'Implemented Postgres persistence and wired historical hydration.',
      }),
      // Pad with enough messages to meet the minimum threshold.
      ...Array.from({ length: 10 }, (_, i) =>
        envelope({
          id: `message-pad-${i}`,
          taskId: 'task-has-messages',
          ts: 3 + i,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: 'assistant',
          text: `Additional message ${i}`,
        }),
      ),
    ];

    mockGetTaskMessageEnvelopes.mockResolvedValue(persistedMessages);

    const result = await generateTaskSummaryCommand(auth, {
      taskId: 'task-has-messages',
    });

    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledOnce();
    const prompt = mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0]
      ?.prompt as string;
    expect(prompt).toContain(
      'Bruno Bergher (task starter): Please help me implement cloud job message persistence.',
    );
    expect(prompt).toContain(
      'Roomote: Implemented Postgres persistence and wired historical hydration.',
    );

    // Verify the prompt uses the task creator's name, not the viewer's
    expect(prompt).toContain('The task was started by Bruno');
    expect(prompt).not.toContain('Alice');
    expect(prompt).not.toContain('User:');
    expect(prompt).not.toContain('Assistant:');

    expect(result).toEqual({
      success: true,
      summary: 'Summary response',
      messageCount: 12,
      generatedForMessageCount: 10,
    });
  });

  it('reads the summary field from structured output', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
      object: { summary: 'Actual summary text.' },
    });
    mockGetTaskMessageEnvelopes.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) =>
        envelope({
          id: `message-${i}`,
          taskId: 'task-summary-sanitized',
          ts: i,
          eventType:
            i === 0
              ? ACP_ENVELOPE_EVENT_TYPES.UserPrompt
              : ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: i === 0 ? 'user' : 'assistant',
          text: `Message ${i}`,
        }),
      ),
    );

    const result = await generateTaskSummaryCommand(auth, {
      taskId: 'task-summary-sanitized',
    });

    expect(result).toEqual({
      success: true,
      summary: 'Actual summary text.',
      messageCount: 12,
      generatedForMessageCount: 10,
    });
  });

  it('returns a stable error code instead of leaking generation command details', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const rawError =
      "Command failed: python3 -c 'import os, pty, subprocess' opencode run --format default --model openrouter/openai/gpt-5.4-mini";
    mockGenerateTrackedNonTaskObject.mockRejectedValueOnce(new Error(rawError));
    mockGetTaskMessageEnvelopes.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) =>
        envelope({
          id: `message-${i}`,
          taskId: 'task-summary-failure',
          ts: i,
          eventType:
            i === 0
              ? ACP_ENVELOPE_EVENT_TYPES.UserPrompt
              : ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: i === 0 ? 'user' : 'assistant',
          text: `Message ${i}`,
        }),
      ),
    );

    try {
      const result = await generateTaskSummaryCommand(auth, {
        taskId: 'task-summary-failure',
      });

      expect(result).toEqual({
        success: false,
        error: 'summary_generation_failed',
        messageCount: 12,
      });
      expect(JSON.stringify(result)).not.toContain('python3 -c');
      expect(JSON.stringify(result)).not.toContain('opencode run');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('excludes assistant thought events from summary input', async () => {
    const persistedMessages = [
      envelope({
        id: 'message-user',
        taskId: 'task-excludes-thought',
        ts: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Please summarize the actual conversation only.',
      }),
      envelope({
        id: 'message-thought',
        taskId: 'task-excludes-thought',
        ts: 2,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
        role: 'assistant',
        text: 'Internal reasoning that should never appear in summary input.',
      }),
      ...Array.from({ length: 9 }, (_, i) =>
        envelope({
          id: `message-assistant-${i}`,
          taskId: 'task-excludes-thought',
          ts: 3 + i,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: 'assistant',
          text: `Assistant message ${i}`,
        }),
      ),
    ];

    mockGetTaskMessageEnvelopes.mockResolvedValue(persistedMessages);

    const result = await generateTaskSummaryCommand(auth, {
      taskId: 'task-excludes-thought',
    });

    expect(result).toEqual({
      success: true,
      summary: 'Summary response',
      messageCount: 10,
      generatedForMessageCount: 10,
    });

    const prompt = mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0]
      ?.prompt as string;
    expect(prompt).toContain(
      'Bruno Bergher (task starter): Please summarize the actual conversation only.',
    );
    expect(prompt).toContain('Roomote: Assistant message 0');
    expect(prompt).not.toContain(
      'Internal reasoning that should never appear in summary input.',
    );
  });

  it('uses the task creator name from the database, not the current user', async () => {
    // DB returns a different creator than auth.name
    mockDbSelect.limit.mockResolvedValue([
      {
        taskUserId: 'user-creator',
        userName: 'Charlie Creator',
        userEmail: 'charlie@example.com',
      },
    ]);

    const messages = Array.from({ length: 12 }, (_, i) =>
      envelope({
        id: `message-${i}`,
        userId: 'user-creator',
        taskId: 'task-creator-test',
        ts: i,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        text: `Message ${i}`,
      }),
    );

    mockGetTaskMessageEnvelopes.mockResolvedValue(messages);

    await generateTaskSummaryCommand(auth, { taskId: 'task-creator-test' });

    const prompt = mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0]
      ?.prompt as string;
    expect(prompt).toContain('The task was started by Charlie');
    expect(prompt).not.toContain('Alice');
  });

  it('falls back to auth.name if task creator has no user record', async () => {
    mockDbSelect.limit.mockResolvedValue([
      {
        taskUserId: auth.userId,
        userName: null,
        userEmail: null,
      },
    ]);

    const messages = Array.from({ length: 12 }, (_, i) =>
      envelope({
        id: `message-${i}`,
        taskId: 'task-no-creator',
        ts: i,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        text: `Message ${i}`,
      }),
    );

    mockGetTaskMessageEnvelopes.mockResolvedValue(messages);

    await generateTaskSummaryCommand(auth, { taskId: 'task-no-creator' });

    const prompt = mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0]
      ?.prompt as string;
    expect(prompt).toContain('The task was started by Alice');
  });

  it('preserves distinct human speakers in prompt order', async () => {
    mockDbSelect.limit.mockResolvedValue([
      {
        taskUserId: 'user-creator',
        userName: 'Charlie Creator',
        userEmail: 'charlie@example.com',
      },
    ]);

    const persistedMessages = [
      envelope({
        id: 'message-1',
        userId: 'user-creator',
        taskId: 'task-multi-user',
        ts: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Please investigate the flaky summary output.',
      }),
      envelope({
        id: 'message-2',
        userId: 'user-reviewer',
        userName: 'Robin Reviewer',
        userEmail: 'robin@example.com',
        taskId: 'task-multi-user',
        ts: 2,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'I think the issue is speaker attribution.',
      }),
      envelope({
        id: 'message-3',
        taskId: 'task-multi-user',
        ts: 3,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        text: 'I will update the transcript serialization.',
      }),
      ...Array.from({ length: 9 }, (_, i) =>
        envelope({
          id: `message-pad-${i}`,
          taskId: 'task-multi-user',
          ts: 4 + i,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: 'assistant',
          text: `Assistant message ${i}`,
        }),
      ),
    ];

    mockGetTaskMessageEnvelopes.mockResolvedValue(persistedMessages);

    await generateTaskSummaryCommand(auth, { taskId: 'task-multi-user' });

    const prompt = mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0]
      ?.prompt as string;
    expect(prompt).toContain(
      'Charlie Creator (task starter): Please investigate the flaky summary output.',
    );
    expect(prompt).toContain(
      'Robin Reviewer: I think the issue is speaker attribution.',
    );
    expect(prompt).toContain(
      'Roomote: I will update the transcript serialization.',
    );
    expect(
      prompt.indexOf(
        'Charlie Creator (task starter): Please investigate the flaky summary output.',
      ),
    ).toBeLessThan(
      prompt.indexOf(
        'Robin Reviewer: I think the issue is speaker attribution.',
      ),
    );
    expect(
      prompt.indexOf(
        'Robin Reviewer: I think the issue is speaker attribution.',
      ),
    ).toBeLessThan(
      prompt.indexOf('Roomote: I will update the transcript serialization.'),
    );
  });
});
