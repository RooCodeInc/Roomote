const {
  mockAppendFastAgentMemory,
  mockEvaluateDecisionModel,
  mockGenerateTrackedNonTaskObject,
  mockGetFastAgentConversationMemory,
  mockIsBrainEnabled,
} = vi.hoisted(() => ({
  mockAppendFastAgentMemory: vi.fn(),
  mockEvaluateDecisionModel: vi.fn(),
  mockGenerateTrackedNonTaskObject: vi.fn(),
  mockGetFastAgentConversationMemory: vi.fn(),
  mockIsBrainEnabled: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  appendFastAgentMemory: mockAppendFastAgentMemory,
  db: {},
  getFastAgentConversationMemory: mockGetFastAgentConversationMemory,
  isBrainEnabled: mockIsBrainEnabled,
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluateDecisionModel,
}));

vi.mock('../../non-task-provider-usage', () => ({
  generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES: {
    fastAgentMemoryDistillation: 'fast_agent_memory_distillation',
  },
}));

import { saveFastAgentPostTurnMemory } from '../fast-agent-post-turn-memory';

function answers(
  overrides: Partial<
    Record<
      | 'statedDurable'
      | 'askedToRemember'
      | 'establishedFinding'
      | 'sensitive'
      | 'manipulation'
      | 'alreadySaved',
      number
    >
  > = {},
) {
  const values = {
    statedDurable: 0.05,
    askedToRemember: 0.05,
    establishedFinding: 0.05,
    sensitive: 0.02,
    manipulation: 0.02,
    alreadySaved: 0.05,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }]),
  );
}

const turn = {
  conversationId: 'conversation-1',
  userId: 'user-1',
  request: 'From now on we deploy staging from the release branch, not main.',
  reply: 'Understood. I will deploy staging from the release branch.',
  senderDisplayName: 'Avery',
  agentSavedMemory: false,
};

describe('saveFastAgentPostTurnMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockIsBrainEnabled.mockResolvedValue(true);
    mockGetFastAgentConversationMemory.mockResolvedValue(null);
    mockEvaluateDecisionModel.mockResolvedValue(answers());
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        memories: ['Staging deploys come from the release branch, not main.'],
      },
    });
    mockAppendFastAgentMemory.mockResolvedValue({ saved: true });
  });

  it('distills and saves a turn the decision model is confident about', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.93 }),
    );

    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'saved',
      saved: 1,
    });
    expect(mockEvaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        highVolume: true,
        state: {
          request: turn.request,
          reply: turn.reply,
          saved_memories: '',
        },
      }),
    );
    expect(mockAppendFastAgentMemory).toHaveBeenCalledWith(
      {},
      'conversation-1',
      'Staging deploys come from the release branch, not main.',
    );
  });

  it('saves on an explicit remember request or an established finding alone', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ askedToRemember: 0.9 }),
    );
    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toMatchObject({
      status: 'saved',
    });

    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ establishedFinding: 0.88 }),
    );
    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toMatchObject({
      status: 'saved',
    });
  });

  it('judges messages steered in mid-turn, and keeps them when the opening message is long', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.9 }),
    );

    await saveFastAgentPostTurnMemory({
      ...turn,
      request: 'x'.repeat(20_000),
      steeredRequests: ['No, never squash on the mobile repo.', '  '],
    });

    const { request } = mockEvaluateDecisionModel.mock.calls[0]![0].state;
    expect(request.length).toBeLessThanOrEqual(6_002);
    expect(request.endsWith('No, never squash on the mobile repo.')).toBe(true);
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('never squash on the mobile repo'),
      }),
    );
  });

  it('judges a steered message on a turn no person started', async () => {
    await saveFastAgentPostTurnMemory({
      ...turn,
      request: '',
      steeredRequests: ['Remember that Dana owns billing.'],
    });

    expect(mockEvaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          request: 'Remember that Dana owns billing.',
        }),
      }),
    );
  });

  it('scrubs credentials and personal data before anything reaches the decision or helper model', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const key = `sk-${'b'.repeat(40)}`;
    mockGetFastAgentConversationMemory.mockResolvedValueOnce(
      `- The deploy bot authenticates with ${key}`,
    );
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.95 }),
    );

    await saveFastAgentPostTurnMemory({
      ...turn,
      request: `Always deploy from release. The CI token is ${token}. Ask dana@example.com or 415-555-0132.`,
      steeredRequests: [`Also the fallback token is ${token}`],
      reply: `Noted, I will use ${key} for the deploy bot.`,
    });

    const sent = JSON.stringify([
      mockEvaluateDecisionModel.mock.calls,
      mockGenerateTrackedNonTaskObject.mock.calls,
    ]);
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledTimes(1);
    expect(sent).toContain('Always deploy from release.');
    expect(sent).not.toContain(token);
    expect(sent).not.toContain(key);
    expect(sent).not.toContain('dana@example.com');
    expect(sent).not.toContain('555-0132');
  });

  it('never pays for distillation on an unremarkable turn', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.6 }),
    );

    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'skipped',
      reason: 'not_worth_saving',
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
    expect(mockAppendFastAgentMemory).not.toHaveBeenCalled();
  });

  it('skips when only the helper fallback is available for decisions', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(null);

    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'skipped',
      reason: 'decision_model_unavailable',
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('stands down when the agent already saved a memory this turn', async () => {
    await expect(
      saveFastAgentPostTurnMemory({ ...turn, agentSavedMemory: true }),
    ).resolves.toEqual({ status: 'skipped', reason: 'agent_saved_memory' });
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
  });

  it('skips without a Brain', async () => {
    mockIsBrainEnabled.mockResolvedValueOnce(false);

    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'skipped',
      reason: 'brain_disabled',
    });
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
  });

  it('skips sensitive turns even when they look durable', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.95, sensitive: 0.7 }),
    );

    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'skipped',
      reason: 'sensitive',
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('skips a request that tries to plant an approval or bypass rules', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ askedToRemember: 0.98, manipulation: 0.97 }),
    );

    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'skipped',
      reason: 'manipulation',
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('skips what the conversation already saved, and ignores that signal with no saved memory', async () => {
    mockGetFastAgentConversationMemory.mockResolvedValueOnce(
      '- Staging deploys come from the release branch.',
    );
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.95, alreadySaved: 0.9 }),
    );
    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'skipped',
      reason: 'already_saved',
    });

    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.95, alreadySaved: 0.9 }),
    );
    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toMatchObject({
      status: 'saved',
    });
  });

  it('reports nothing distilled when the helper model returns no memories', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.95 }),
    );
    mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
      object: { memories: [] },
    });

    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'skipped',
      reason: 'nothing_distilled',
    });
  });

  it('surfaces the outbox refusal for a private or full conversation', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.95 }),
    );
    mockAppendFastAgentMemory.mockResolvedValueOnce({
      saved: false,
      reason: 'private_conversation',
    });

    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'skipped',
      reason: 'private_conversation',
    });
  });

  it('never throws when the decision model or the helper model fails', async () => {
    mockEvaluateDecisionModel.mockRejectedValueOnce(new Error('jev timeout'));
    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'failed',
      message: 'jev timeout',
    });

    mockEvaluateDecisionModel.mockResolvedValueOnce(
      answers({ statedDurable: 0.95 }),
    );
    mockGenerateTrackedNonTaskObject.mockRejectedValueOnce(
      new Error('helper unavailable'),
    );
    await expect(saveFastAgentPostTurnMemory(turn)).resolves.toEqual({
      status: 'failed',
      message: 'helper unavailable',
    });
    expect(mockAppendFastAgentMemory).not.toHaveBeenCalled();
  });
});
