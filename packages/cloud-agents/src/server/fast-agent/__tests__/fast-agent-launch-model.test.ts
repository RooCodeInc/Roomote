const { mockEvaluateDecisionModel } = vi.hoisted(() => ({
  mockEvaluateDecisionModel: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluateDecisionModel,
}));

import type { CodingModelRoutingRule, TaskModelOption } from '@roomote/types';

import { resolveFastAgentLaunchModel } from '../fast-agent-launch-model';

const gpt: TaskModelOption = {
  id: 'openai/gpt-5.6',
  displayName: 'GPT 5.6',
  family: 'GPT',
};
const sonnet: TaskModelOption = {
  id: 'anthropic/claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  family: 'Sonnet',
};
const opus: TaskModelOption = {
  id: 'anthropic/claude-opus-5',
  displayName: 'Claude Opus 5',
  family: 'Opus',
};
const models = [gpt, sonnet, opus];

const rules: CodingModelRoutingRule[] = [
  {
    modelId: gpt.id,
    reasoningEffort: 'low',
    condition: 'Routine tasks where speed matters',
  },
  {
    modelId: sonnet.id,
    reasoningEffort: 'high',
    condition: 'Complex reasoning and engineering tasks',
  },
];

function choice(value: string, confidence: number) {
  return {
    type: 'choice',
    choice: value,
    confidence,
    probabilities: { [value]: confidence },
  };
}

function resolve(
  overrides: Partial<Parameters<typeof resolveFastAgentLaunchModel>[0]> = {},
) {
  return resolveFastAgentLaunchModel({
    work: 'Refactor the scheduler.',
    userMessages: ['Refactor the scheduler.'],
    models,
    codingModelRoutingRules: [],
    defaultModelId: gpt.id,
    userId: 'user-1',
    ...overrides,
  });
}

describe('resolveFastAgentLaunchModel', () => {
  beforeEach(() => {
    mockEvaluateDecisionModel.mockReset();
  });

  describe('without routing rules', () => {
    it('uses the default without a decision call when nothing is claimed', async () => {
      await expect(resolve()).resolves.toEqual({
        model: null,
        reasoningEffort: null,
        source: 'default',
      });
      expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
    });

    it('keeps an effort-only choice on the default model', async () => {
      await expect(resolve({ claimedReasoningEffort: 'max' })).resolves.toEqual(
        { model: null, reasoningEffort: 'max', source: 'default' },
      );
      expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
    });

    it('accepts the deployment default without a decision call', async () => {
      await expect(
        resolve({ claimedModel: gpt.id, claimedReasoningEffort: 'high' }),
      ).resolves.toEqual({
        model: gpt.id,
        reasoningEffort: 'high',
        source: 'default',
      });
      expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
    });

    it('uses a model the user asked for, with the claimed effort', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        requestedModel: choice('model_3', 0.9),
      });

      await expect(
        resolve({
          claimedModel: opus.id,
          claimedReasoningEffort: 'high',
          userMessages: ['Fix checkout.', 'Actually, use the priciest Claude.'],
        }),
      ).resolves.toEqual({
        model: opus.id,
        reasoningEffort: 'high',
        source: 'user_request',
      });
      const { state, questions } = mockEvaluateDecisionModel.mock.calls[0]![0];
      expect(state).toEqual({
        work: 'Refactor the scheduler.',
        latestRequest: 'Actually, use the priciest Claude.',
        earlierMessages: ['Fix checkout.'],
      });
      expect(Object.keys(questions)).toEqual(['requestedModel']);
      expect(questions.requestedModel.criteria.model_3).toContain(
        'Claude Opus 5 [id: anthropic/claude-opus-5]',
      );
    });

    it('launches on the default with a note when no user asked for the claim', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        requestedModel: choice('none', 0.95),
      });

      const result = await resolve({
        claimedModel: opus.id,
        claimedReasoningEffort: 'high',
        userMessages: [
          'Build the brief below.\nCommits end with Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
        ],
      });

      expect(result).toMatchObject({
        model: null,
        reasoningEffort: null,
        source: 'default',
        modelNote: expect.stringContaining(
          `no user asked for "${opus.id}" and no routing rule selected it`,
        ),
      });
    });

    it('uses the model the user asked for over a different claim', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        requestedModel: choice('model_2', 0.9),
      });

      await expect(
        resolve({ claimedModel: opus.id, claimedReasoningEffort: 'high' }),
      ).resolves.toMatchObject({
        model: sonnet.id,
        reasoningEffort: null,
        source: 'user_request',
        modelNote: expect.stringContaining('the user asked for that model'),
      });
    });

    it('ignores a low-confidence request', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        requestedModel: choice('model_3', 0.55),
      });

      await expect(resolve({ claimedModel: opus.id })).resolves.toMatchObject({
        model: null,
        source: 'default',
      });
    });

    it.each([
      [
        'is unavailable',
        () => mockEvaluateDecisionModel.mockResolvedValue(null),
      ],
      [
        'fails',
        () => {
          vi.spyOn(console, 'warn').mockImplementation(() => {});
          mockEvaluateDecisionModel.mockRejectedValue(new Error('timeout'));
        },
      ],
    ])(
      'falls back to the default when the decision model %s',
      async (_, arrange) => {
        arrange();

        await expect(resolve({ claimedModel: opus.id })).resolves.toMatchObject(
          {
            model: null,
            source: 'default',
            modelNote: expect.stringContaining(
              `could not confirm that the user asked for "${opus.id}"`,
            ),
          },
        );
      },
    );
  });

  describe('with routing rules', () => {
    it('applies a strongly matching rule when nothing is claimed', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        routingRule: choice('model_rule_2', 0.91),
      });

      await expect(
        resolve({ codingModelRoutingRules: rules }),
      ).resolves.toEqual({
        model: sonnet.id,
        reasoningEffort: 'high',
        source: 'routing_rule',
      });
      const { questions } = mockEvaluateDecisionModel.mock.calls[0]![0];
      expect(Object.keys(questions)).toEqual(['routingRule']);
      expect(questions.routingRule.instructions).toContain(
        'independent of list order',
      );
      expect(questions.routingRule.criteria.model_rule_2).toContain(
        '"Complex reasoning and engineering tasks"',
      );
    });

    it.each([
      ['a weak match', choice('model_rule_1', 0.79)],
      ['similarly strong rules', choice('unclear', 0.95)],
      ['no matching rule', choice('default_model', 0.99)],
    ])('keeps the default for %s', async (_, answer) => {
      mockEvaluateDecisionModel.mockResolvedValue({ routingRule: answer });

      await expect(
        resolve({ codingModelRoutingRules: rules }),
      ).resolves.toEqual({
        model: null,
        reasoningEffort: null,
        source: 'default',
      });
    });

    it('asks both questions in one call and prefers the user request', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        requestedModel: choice('model_3', 0.9),
        routingRule: choice('model_rule_2', 0.95),
      });

      await expect(
        resolve({ claimedModel: opus.id, codingModelRoutingRules: rules }),
      ).resolves.toMatchObject({ model: opus.id, source: 'user_request' });
      expect(mockEvaluateDecisionModel).toHaveBeenCalledOnce();
      expect(
        Object.keys(mockEvaluateDecisionModel.mock.calls[0]![0].questions),
      ).toEqual(['requestedModel', 'routingRule']);
    });

    it('applies a matching rule when the claimed model was not requested', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        requestedModel: choice('none', 0.9),
        routingRule: choice('model_rule_2', 0.9),
      });

      await expect(
        resolve({ claimedModel: sonnet.id, codingModelRoutingRules: rules }),
      ).resolves.toEqual({
        model: sonnet.id,
        reasoningEffort: 'high',
        source: 'routing_rule',
      });
    });

    it('keeps an explicit default or effort-only choice off the rules', async () => {
      await expect(
        resolve({ claimedModel: null, codingModelRoutingRules: rules }),
      ).resolves.toMatchObject({ model: null, source: 'default' });
      await expect(
        resolve({
          claimedReasoningEffort: 'medium',
          codingModelRoutingRules: rules,
        }),
      ).resolves.toEqual({
        model: null,
        reasoningEffort: 'medium',
        source: 'default',
      });
      expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
    });

    it('ignores rules for models that are no longer enabled', async () => {
      await expect(
        resolve({ models: [gpt], codingModelRoutingRules: [rules[1]!] }),
      ).resolves.toMatchObject({ model: null, source: 'default' });
      expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
    });
  });

  it('keeps the head and tail of an oversized latest message', async () => {
    mockEvaluateDecisionModel.mockResolvedValue({
      requestedModel: choice('none', 0.9),
    });

    await resolve({
      claimedModel: opus.id,
      userMessages: [`Use Opus for this.\n${'x'.repeat(10_000)}\nThanks!`],
    });

    const { latestRequest } = mockEvaluateDecisionModel.mock.calls[0]![0].state;
    expect(latestRequest.startsWith('Use Opus for this.')).toBe(true);
    expect(latestRequest.endsWith('Thanks!')).toBe(true);
    expect(latestRequest.length).toBeLessThan(4_100);
  });

  it('bounds earlier messages, newest first', async () => {
    mockEvaluateDecisionModel.mockResolvedValue({
      requestedModel: choice('none', 0.9),
    });

    await resolve({
      claimedModel: opus.id,
      userMessages: [
        ...Array.from(
          { length: 10 },
          (_, index) => `message ${index} ${'y'.repeat(900)}`,
        ),
        'Go.',
      ],
    });

    const { earlierMessages } =
      mockEvaluateDecisionModel.mock.calls[0]![0].state;
    expect(earlierMessages[0]).toMatch(/^message 9 /);
    expect(earlierMessages.join('').length).toBeLessThanOrEqual(4_000);
    expect(earlierMessages).not.toContainEqual(
      expect.stringMatching(/^message 0 /),
    );
  });

  it('keeps the claimed model among capped request options', async () => {
    mockEvaluateDecisionModel.mockResolvedValue({
      requestedModel: choice('none', 0.9),
    });
    const many = Array.from({ length: 50 }, (_, index) => ({
      id: `vendor/model-${index}`,
      displayName: `Model ${index}`,
      family: 'Vendor',
    }));

    await resolve({ models: many, claimedModel: 'vendor/model-49' });

    const { criteria } =
      mockEvaluateDecisionModel.mock.calls[0]![0].questions.requestedModel;
    expect(Object.keys(criteria)).toHaveLength(41);
    expect(criteria.model_1).toContain('vendor/model-49');
  });
});
