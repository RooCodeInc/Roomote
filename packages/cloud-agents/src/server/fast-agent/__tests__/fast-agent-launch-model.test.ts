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
    it('asks about a user request even without a claim', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        wantsNonDefaultModel: { type: 'noul', noul: 0.05 },
        requestedModel: choice('none', 0.97),
      });

      await expect(resolve()).resolves.toEqual({
        model: null,
        reasoningEffort: null,
        source: 'default',
      });
      const { questions } = mockEvaluateDecisionModel.mock.calls[0]![0];
      expect(Object.keys(questions)).toEqual([
        'wantsNonDefaultModel',
        'requestedModel',
      ]);
    });

    it('applies a confident user request the agent did not pass', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        wantsNonDefaultModel: { type: 'noul', noul: 0.9 },
        requestedModel: choice('model_3', 0.9),
      });

      await expect(resolve()).resolves.toEqual({
        model: opus.id,
        reasoningEffort: null,
        source: 'user_request',
      });
    });

    it('needs a confident pick without a claim to break a split request', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        wantsNonDefaultModel: { type: 'noul', noul: 0.9 },
        requestedModel: {
          type: 'choice',
          choice: 'model_3',
          confidence: 0.4,
          probabilities: { model_3: 0.4, model_2: 0.26, none: 0.34 },
        },
      });

      await expect(resolve()).resolves.toMatchObject({
        model: null,
        source: 'default',
      });
    });

    it('keeps an effort-only choice on the default model', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        wantsNonDefaultModel: { type: 'noul', noul: 0.05 },
        requestedModel: choice('none', 0.97),
      });

      await expect(resolve({ claimedReasoningEffort: 'max' })).resolves.toEqual(
        { model: null, reasoningEffort: 'max', source: 'default' },
      );
    });

    it('keeps a claimed deployment default and its effort', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        wantsNonDefaultModel: { type: 'noul', noul: 0.05 },
        requestedModel: choice('none', 0.97),
      });

      await expect(
        resolve({ claimedModel: gpt.id, claimedReasoningEffort: 'high' }),
      ).resolves.toEqual({
        model: gpt.id,
        reasoningEffort: 'high',
        source: 'default',
      });
    });

    it('uses a model the user asked for, with the claimed effort', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        wantsNonDefaultModel: { type: 'noul', noul: 0.9 },
        requestedModel: choice('model_3', 0.9),
      });

      await expect(
        resolve({
          claimedModel: opus.id,
          claimedReasoningEffort: 'high',
          userMessages: ['Fix checkout.', 'Actually, use the newest Opus.'],
        }),
      ).resolves.toEqual({
        model: opus.id,
        reasoningEffort: 'high',
        source: 'user_request',
      });
      const { state, questions } = mockEvaluateDecisionModel.mock.calls[0]![0];
      expect(state).toEqual({
        defaultModel: 'GPT 5.6 [id: openai/gpt-5.6], the deployment default',
        work: 'Refactor the scheduler.',
        latestRequest: 'Actually, use the newest Opus.',
        earlierMessages: ['Fix checkout.'],
      });
      expect(Object.keys(questions)).toEqual([
        'wantsNonDefaultModel',
        'requestedModel',
      ]);
      expect(questions.requestedModel.criteria.model_3).toContain(
        'Claude Opus 5 [id: anthropic/claude-opus-5]',
      );
    });

    it('launches on the default with a note when no user asked for the claim', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        wantsNonDefaultModel: { type: 'noul', noul: 0.05 },
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
        wantsNonDefaultModel: { type: 'noul', noul: 0.9 },
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

    function split(probabilities: Record<string, number>, wants = 0.9) {
      const [top, confidence] = Object.entries(probabilities).sort(
        (left, right) => right[1] - left[1],
      )[0]!;
      return {
        wantsNonDefaultModel: { type: 'noul', noul: wants },
        requestedModel: {
          type: 'choice',
          choice: top,
          confidence,
          probabilities,
        },
      };
    }

    it('accepts a claim that tops a split request, like "the newest Fable"', async () => {
      // model_2 = Sonnet, model_3 = Opus: a request split across two models.
      mockEvaluateDecisionModel.mockResolvedValue(
        split({ model_3: 0.4, model_2: 0.26, none: 0.34 }),
      );

      await expect(resolve({ claimedModel: opus.id })).resolves.toEqual({
        model: opus.id,
        reasoningEffort: null,
        source: 'user_request',
      });
    });

    it('accepts a claim for a capability ask that names no model', async () => {
      // "Throw your strongest model at this": a different model is wanted,
      // but no specific model is identified.
      mockEvaluateDecisionModel.mockResolvedValue(
        split({ none: 0.95, model_2: 0.05 }),
      );

      await expect(resolve({ claimedModel: opus.id })).resolves.toEqual({
        model: opus.id,
        reasoningEffort: null,
        source: 'user_request',
      });
    });

    it('keeps the default for a capability ask without a claim', async () => {
      mockEvaluateDecisionModel.mockResolvedValue(
        split({ none: 0.95, model_2: 0.05 }),
      );

      await expect(resolve()).resolves.toMatchObject({
        model: null,
        source: 'default',
      });
    });

    it('rejects a claim when no different model is wanted', async () => {
      // The attribution-trailer case: the model is named, but not requested.
      mockEvaluateDecisionModel.mockResolvedValue(
        split({ model_3: 0.6, none: 0.4 }, 0.03),
      );

      await expect(resolve({ claimedModel: opus.id })).resolves.toMatchObject({
        model: null,
        source: 'default',
      });
    });

    it('uses the claim when a different model is wanted but none is picked confidently', async () => {
      // "The newest Fable": Fable 5 and 5.1 split the probability.
      mockEvaluateDecisionModel.mockResolvedValue(
        split({ model_2: 0.34, model_3: 0.31, none: 0.35 }),
      );

      await expect(resolve({ claimedModel: opus.id })).resolves.toMatchObject({
        model: opus.id,
        source: 'user_request',
      });
    });

    it('rejects a top-ranked claim when no model request is likely', async () => {
      mockEvaluateDecisionModel.mockResolvedValue(
        split({ model_3: 0.3, model_2: 0.15, none: 0.55 }, 0.2),
      );

      await expect(resolve({ claimedModel: opus.id })).resolves.toMatchObject({
        model: null,
        source: 'default',
      });
    });

    it('uses a confident pick over a different claim', async () => {
      mockEvaluateDecisionModel.mockResolvedValue(
        split({ model_2: 0.65, model_3: 0, none: 0.35 }),
      );

      await expect(resolve({ claimedModel: opus.id })).resolves.toMatchObject({
        model: sonnet.id,
        source: 'user_request',
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
      expect(Object.keys(questions)).toEqual([
        'wantsNonDefaultModel',
        'requestedModel',
        'routingRule',
      ]);
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
        wantsNonDefaultModel: { type: 'noul', noul: 0.9 },
        requestedModel: choice('model_3', 0.9),
        routingRule: choice('model_rule_2', 0.95),
      });

      await expect(
        resolve({ claimedModel: opus.id, codingModelRoutingRules: rules }),
      ).resolves.toMatchObject({ model: opus.id, source: 'user_request' });
      expect(mockEvaluateDecisionModel).toHaveBeenCalledOnce();
      expect(
        Object.keys(mockEvaluateDecisionModel.mock.calls[0]![0].questions),
      ).toEqual(['wantsNonDefaultModel', 'requestedModel', 'routingRule']);
    });

    it('applies a matching rule when the claimed model was not requested', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        wantsNonDefaultModel: { type: 'noul', noul: 0.05 },
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

    it('routes a launch whose optional arguments are null fillers', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        routingRule: choice('model_rule_2', 0.91),
      });

      await expect(
        resolve({
          claimedModel: null,
          claimedReasoningEffort: null,
          codingModelRoutingRules: rules,
        }),
      ).resolves.toEqual({
        model: sonnet.id,
        reasoningEffort: 'high',
        source: 'routing_rule',
      });
    });

    it('keeps an effort-only choice off the rules', async () => {
      await expect(
        resolve({
          claimedModel: null,
          claimedReasoningEffort: 'medium',
          codingModelRoutingRules: rules,
        }),
      ).resolves.toEqual({
        model: null,
        reasoningEffort: 'medium',
        source: 'default',
      });
      expect(
        Object.keys(mockEvaluateDecisionModel.mock.calls[0]![0].questions),
      ).toEqual(['wantsNonDefaultModel', 'requestedModel']);
    });

    it('ignores rules for models that are no longer enabled', async () => {
      await expect(
        resolve({ models: [gpt], codingModelRoutingRules: [rules[1]!] }),
      ).resolves.toMatchObject({ model: null, source: 'default' });
      expect(
        Object.keys(mockEvaluateDecisionModel.mock.calls[0]![0].questions),
      ).toEqual(['wantsNonDefaultModel', 'requestedModel']);
    });
  });

  it('keeps the head and tail of an oversized latest message', async () => {
    mockEvaluateDecisionModel.mockResolvedValue({
      wantsNonDefaultModel: { type: 'noul', noul: 0.05 },
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
      wantsNonDefaultModel: { type: 'noul', noul: 0.05 },
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
      wantsNonDefaultModel: { type: 'noul', noul: 0.05 },
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
