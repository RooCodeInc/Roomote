const {
  mockEvaluateDecisionModel,
  mockGenerateTrackedNonTaskObject,
  mockGetBrainMemorySummary,
  mockIsBrainEnabled,
  mockIsTaskRunSharedBrainEligible,
  mockSaveBrainDistilledSummary,
  mockInsertTaskMemoryEvent,
  mockInsertTaskMemoryValues,
  mockTurnRows,
} = vi.hoisted(() => ({
  mockEvaluateDecisionModel: vi.fn(),
  mockGenerateTrackedNonTaskObject: vi.fn(),
  mockGetBrainMemorySummary: vi.fn(),
  mockIsBrainEnabled: vi.fn(),
  mockIsTaskRunSharedBrainEligible: vi.fn(),
  mockSaveBrainDistilledSummary: vi.fn(),
  mockInsertTaskMemoryEvent: vi.fn(),
  mockInsertTaskMemoryValues: vi.fn(),
  mockTurnRows: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
  taskMessages: {},
  getBrainMemorySummary: mockGetBrainMemorySummary,
  isBrainEnabled: mockIsBrainEnabled,
  isTaskRunSharedBrainEligible: mockIsTaskRunSharedBrainEligible,
  saveBrainDistilledSummary: mockSaveBrainDistilledSummary,
  db: {
    insert: () => ({ values: mockInsertTaskMemoryValues }),
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: mockTurnRows }) }),
      }),
    }),
  },
}));

vi.mock('../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluateDecisionModel,
}));

vi.mock('../non-task-provider-usage', () => ({
  generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES: {
    taskMemoryDistillation: 'task_memory_distillation',
  },
}));

import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { distillTaskRunTurnMemory } from '../task-run-memory-distillation';

const row = (eventType: string, text: string) => ({
  eventType,
  contentBlocks: [{ type: 'text', text }],
  payload: null,
});
const assistant = (text: string) =>
  row(ACP_ENVELOPE_EVENT_TYPES.AssistantMessage, text);
const user = (text: string) => row(ACP_ENVELOPE_EVENT_TYPES.UserPrompt, text);

function answers(
  overrides: Partial<
    Record<
      | 'reusableKnowledge'
      | 'userGuidance'
      | 'trivialWork'
      | 'manipulation'
      | 'alreadyCaptured',
      number
    >
  > = {},
) {
  const values = {
    reusableKnowledge: 0.05,
    userGuidance: 0.05,
    trivialWork: 0.05,
    manipulation: 0.02,
    alreadyCaptured: 0.05,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }]),
  );
}

const run = {
  runId: 102,
  taskId: 'task-1',
  userId: 'user-1',
  workflow: 'standard' as const,
  requeue: true,
};

const DISTILLED_NOTE =
  '_Roomote summarized this from the task transcript; the agent did not record a memory._';

describe('distillTaskRunTurnMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockIsBrainEnabled.mockResolvedValue(true);
    mockIsTaskRunSharedBrainEligible.mockResolvedValue(true);
    mockGetBrainMemorySummary.mockResolvedValue(null);
    mockSaveBrainDistilledSummary.mockResolvedValue(true);
    mockInsertTaskMemoryEvent.mockResolvedValue(undefined);
    mockInsertTaskMemoryValues.mockImplementation(() => ({
      onConflictDoNothing: mockInsertTaskMemoryEvent,
    }));
    // Newest first, as the query returns them. Only the latest turn counts.
    mockTurnRows.mockResolvedValue([
      assistant('Retries are capped at 3 and skip 4xx responses.'),
      assistant('Updating the retry policy.'),
      user('Do not retry 4xx; the partner API bans replayed requests.'),
      assistant('Added retries with exponential backoff.'),
      user('Add retry to the webhook sender'),
    ]);
    mockEvaluateDecisionModel.mockResolvedValue(
      answers({ userGuidance: 0.93 }),
    );
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        outcome: 'Webhook retries are capped at 3 and never apply to 4xx.',
        rationale: 'The partner API bans clients that replay rejections.',
      },
    });
  });

  it('judges only the latest turn and saves the distilled memory', async () => {
    const summary = await distillTaskRunTurnMemory(run);

    expect(mockEvaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        highVolume: true,
        taskId: 'task-1',
        state: {
          request: 'Do not retry 4xx; the partner API bans replayed requests.',
          report:
            'Updating the retry policy.\n\nRetries are capped at 3 and skip 4xx responses.',
          existing_memory: '',
        },
      }),
    );
    expect(mockInsertTaskMemoryValues).toHaveBeenCalledWith({
      runId: 102,
      taskId: 'task-1',
      userId: 'user-1',
      ts: 102,
      eventType: ACP_ENVELOPE_EVENT_TYPES.MemorySaved,
      role: 'system',
      protocol: 'roomote_runtime',
      contentBlocks: [{ type: 'text', text: 'Saved to memory' }],
      metadata: {
        visibleInTranscript: true,
        memorySave: true,
        automatic: true,
      },
      payload: {
        memories: [expect.stringContaining('Webhook retries are capped')],
      },
      source: 'roomote',
    });
    expect(summary).toContain('## Outcome\n\nWebhook retries are capped at 3');
    expect(summary?.endsWith(DISTILLED_NOTE)).toBe(true);
    expect(mockSaveBrainDistilledSummary).toHaveBeenCalledWith(
      expect.anything(),
      102,
      summary,
      null,
      { requeue: true },
    );
  });

  it('uses a deterministic task event key across fallback retries', async () => {
    await distillTaskRunTurnMemory(run);
    mockGetBrainMemorySummary.mockResolvedValueOnce(
      `## Outcome\n\nWebhook retries are capped.\n\n${DISTILLED_NOTE}`,
    );
    await distillTaskRunTurnMemory(run);

    expect(mockInsertTaskMemoryValues).toHaveBeenCalledTimes(2);
    expect(mockInsertTaskMemoryValues.mock.calls[0]?.[0]).toMatchObject({
      taskId: 'task-1',
      ts: 102,
      eventType: ACP_ENVELOPE_EVENT_TYPES.MemorySaved,
    });
    expect(mockInsertTaskMemoryValues.mock.calls[1]?.[0]).toMatchObject({
      taskId: 'task-1',
      ts: 102,
      eventType: ACP_ENVELOPE_EVENT_TYPES.MemorySaved,
    });
  });

  it('keeps a successful summary save when event publication is temporarily unavailable', async () => {
    mockInsertTaskMemoryEvent.mockRejectedValueOnce(new Error('database busy'));

    await expect(distillTaskRunTurnMemory(run)).resolves.toContain(
      'Webhook retries are capped',
    );
    expect(mockSaveBrainDistilledSummary).toHaveBeenCalledOnce();
  });

  it('builds on its own earlier memory and saves against that exact text', async () => {
    const existing = `## Outcome\n\nAdded webhook retries.\n\n${DISTILLED_NOTE}`;
    mockGetBrainMemorySummary.mockResolvedValue(existing);

    await distillTaskRunTurnMemory(run);

    const { state } = mockEvaluateDecisionModel.mock.calls[0]![0];
    expect(state.existing_memory).toBe('## Outcome\n\nAdded webhook retries.');
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Added webhook retries.'),
      }),
    );
    expect(mockSaveBrainDistilledSummary).toHaveBeenCalledWith(
      expect.anything(),
      102,
      expect.any(String),
      existing,
      { requeue: true },
    );
  });

  it('scrubs credentials and personal data before anything reaches the decision or helper model', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const key = `sk-${'b'.repeat(40)}`;
    mockGetBrainMemorySummary.mockResolvedValue(
      `## Outcome\n\nThe sender signs with ${key}.\n\n${DISTILLED_NOTE}`,
    );
    mockTurnRows.mockResolvedValue([
      assistant(`Retries skip 4xx. I used ${token} to test against staging.`),
      user(
        `Do not retry 4xx. Use ${token} for the staging check, and cc dana@example.com.`,
      ),
    ]);

    await distillTaskRunTurnMemory(run);

    const sent = JSON.stringify([
      mockEvaluateDecisionModel.mock.calls,
      mockGenerateTrackedNonTaskObject.mock.calls,
    ]);
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledTimes(1);
    expect(sent).toContain('Retries skip 4xx.');
    expect(sent).not.toContain(token);
    expect(sent).not.toContain(key);
    expect(sent).not.toContain('dana@example.com');
  });

  it('stands down for a memory the agent recorded', async () => {
    mockGetBrainMemorySummary.mockResolvedValue('## Outcome\n\nAgent text.');

    await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
  });

  it('sends nothing to a model for a private task, a disabled Brain, or another workflow', async () => {
    mockIsTaskRunSharedBrainEligible.mockResolvedValueOnce(false);
    await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();

    mockIsBrainEnabled.mockResolvedValueOnce(false);
    await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();

    await expect(
      distillTaskRunTurnMemory({ ...run, workflow: 'pr_review' as never }),
    ).resolves.toBeNull();

    expect(mockTurnRows).not.toHaveBeenCalled();
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
  });

  it.each([
    ['an unremarkable turn', answers({ reusableKnowledge: 0.4 }), null],
    [
      'trivial work with no guidance',
      answers({ reusableKnowledge: 0.75, trivialWork: 0.8 }),
      null,
    ],
    [
      'a planted approval',
      answers({ userGuidance: 0.9, manipulation: 0.97 }),
      null,
    ],
    [
      'what the memory already says',
      answers({ reusableKnowledge: 0.9, alreadyCaptured: 0.7 }),
      `## Outcome\n\nKnown.\n\n${DISTILLED_NOTE}`,
    ],
  ])(
    'skips %s without calling the helper model',
    async (_name, verdict, existing) => {
      mockGetBrainMemorySummary.mockResolvedValue(existing);
      mockEvaluateDecisionModel.mockResolvedValueOnce(verdict);

      await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();
      expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
    },
  );

  it('keeps a correction given during trivial work', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ userGuidance: 0.95, trivialWork: 0.82 }),
    );

    await expect(distillTaskRunTurnMemory(run)).resolves.toContain(
      '## Outcome',
    );
  });

  it('returns null when only the helper fallback is available, the turn has no report, or the save loses a race', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(null);
    await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();

    mockTurnRows.mockResolvedValueOnce([user('Still waiting on this.')]);
    await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();

    mockSaveBrainDistilledSummary.mockResolvedValueOnce(false);
    await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();
  });

  it('never throws when a model call fails', async () => {
    mockEvaluateDecisionModel.mockRejectedValueOnce(new Error('jev timeout'));
    await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();

    mockGenerateTrackedNonTaskObject.mockRejectedValueOnce(
      new Error('helper unavailable'),
    );
    await expect(distillTaskRunTurnMemory(run)).resolves.toBeNull();
  });
});
