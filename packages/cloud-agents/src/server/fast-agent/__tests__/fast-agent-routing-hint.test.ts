const { mockEvaluateTypeSafeJudgments } = vi.hoisted(() => ({
  mockEvaluateTypeSafeJudgments: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

import { ALL_REPOSITORIES } from '@roomote/types';

import {
  resolveFastAgentLaunchModelSelection,
  resolveFastAgentRoutingHint,
} from '../fast-agent-routing-hint';

const environments = [
  {
    id: 'env-web',
    name: 'web-app',
    description: 'Next.js frontend',
    repositoryNames: ['acme/web'],
  },
  {
    id: 'env-api',
    name: 'api',
    description: 'payments and auth backend',
    repositoryNames: ['acme/api'],
  },
  {
    id: 'env-infra',
    name: 'infra',
    description: 'Terraform',
    repositoryNames: ['acme/infra'],
  },
];

function mockChoice(choice: string, confidence: number) {
  mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
    environment: {
      type: 'choice',
      choice,
      confidence,
      probabilities: { [choice]: confidence },
    },
  });
}

const models = [
  { id: 'openai/gpt-5.6', displayName: 'GPT 5.6', family: 'GPT' },
  {
    id: 'anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    family: 'Claude',
  },
];

describe('resolveFastAgentRoutingHint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateTypeSafeJudgments.mockResolvedValue(null);
  });

  it('returns a hint naming a confidently chosen environment', async () => {
    mockChoice('env_2', 0.82);

    const hint = await resolveFastAgentRoutingHint({
      request: 'Refunds are double-charged, check the webhook handler',
      environments,
    });

    expect(hint?.context).toBe(
      'Routing hint: api [id: env-api] looks like the best environment (judgment model confidence 0.82). Verify against the configured routing rules before delegating; explicit user model and effort choices take precedence, and ask when the request is still ambiguous.',
    );
  });

  it('describes environments with their repositories and routing rules', async () => {
    mockChoice('unclear', 0.9);

    await resolveFastAgentRoutingHint({
      request: 'Fix the invoice PDF',
      threadContext: [{ text: 'Invoices look wrong since yesterday' }],
      environments,
      routingRules: [
        { description: 'Billing and invoices', target: 'env-api' },
        { description: 'Cross-repo refactors', target: ALL_REPOSITORIES },
      ],
    });

    const call = mockEvaluateTypeSafeJudgments.mock.calls[0]![0];
    expect(call.state).toEqual({
      request: 'Fix the invoice PDF',
      threadContext: ['Invoices look wrong since yesterday'],
    });
    const criteria = call.questions.environment.criteria;
    expect(Object.keys(criteria)).toEqual([
      'env_1',
      'env_2',
      'env_3',
      'no_workspace_needed',
      'all_repositories',
      'unclear',
    ]);
    expect(criteria.env_2).toContain('payments and auth backend');
    expect(criteria.env_2).toContain('acme/api');
    expect(criteria.env_2).toContain('"Billing and invoices"');
    expect(criteria.all_repositories).toContain('"Cross-repo refactors"');
  });

  it('returns no hint for a no-match choice', async () => {
    mockChoice('no_workspace_needed', 0.99);

    await expect(
      resolveFastAgentRoutingHint({
        request: 'What is our PTO policy?',
        environments,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns no hint when the environment choice is not confident', async () => {
    mockChoice('env_1', 0.55);

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Add a dark mode toggle',
        environments,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns no hint when the judgment model is not configured', async () => {
    await expect(
      resolveFastAgentRoutingHint({
        request: 'Fix the login page',
        environments,
      }),
    ).resolves.toBeUndefined();
    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledTimes(1);
  });

  it('returns no hint when the judgment model fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockEvaluateTypeSafeJudgments.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Fix the login page',
        environments,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[FastAgentRoutingHint]'),
    );
    warn.mockRestore();
  });

  it('skips the judgment model when there is no routing choice to make', async () => {
    await expect(
      resolveFastAgentRoutingHint({
        request: 'Fix the login page',
        environments: environments.slice(0, 1),
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveFastAgentRoutingHint({ request: '   ', environments }),
    ).resolves.toBeUndefined();
    expect(mockEvaluateTypeSafeJudgments).not.toHaveBeenCalled();
  });

  it('asks about a single environment when routing rules exist', async () => {
    mockChoice('env_1', 0.9);

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Fix the login page',
        environments: environments.slice(0, 1),
        routingRules: [{ description: 'Frontend work', target: 'env-web' }],
      }),
    ).resolves.toMatchObject({
      context: expect.stringContaining('Routing hint: web-app [id: env-web]'),
    });
  });

  it('lets a later strongly matching rule win independent of list order', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
      model: {
        type: 'choice',
        choice: 'model_rule_2',
        confidence: 0.91,
        probabilities: { model_rule_2: 0.91 },
      },
    });

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Refactor the scheduler concurrency model',
        environments: [],
        models,
        codingModelRoutingRules: [
          {
            modelId: 'openai/gpt-5.6',
            reasoningEffort: 'low',
            condition: 'Routine tasks where speed matters',
          },
          {
            modelId: 'anthropic/claude-sonnet-5',
            reasoningEffort: 'high',
            condition: 'Complex reasoning and engineering tasks',
          },
        ],
      }),
    ).resolves.toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: 'high',
      context: expect.stringContaining('Claude Sonnet 5'),
    });

    const modelQuestion =
      mockEvaluateTypeSafeJudgments.mock.calls[0]![0].questions.model;
    expect(modelQuestion.instructions).toContain(
      'Evaluate every coding-model routing rule',
    );
    expect(modelQuestion.instructions).toContain('independent of list order');
    expect(modelQuestion.instructions).toContain(
      'single strongest matching rule only when its saved condition clearly and strongly applies',
    );
  });

  it('keeps deployment defaults for a weak best-available model match', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
      model: {
        type: 'choice',
        choice: 'model_rule_1',
        confidence: 0.79,
        probabilities: { model_rule_1: 0.79 },
      },
    });

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Update a task',
        environments: [],
        models,
        codingModelRoutingRules: [
          {
            modelId: 'anthropic/claude-sonnet-5',
            reasoningEffort: 'high',
            condition: 'Complex reasoning and engineering tasks',
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps deployment defaults when similarly strong rules are ambiguous', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
      model: {
        type: 'choice',
        choice: 'unclear',
        confidence: 0.95,
        probabilities: { unclear: 0.95 },
      },
    });

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Refactor a complex scheduler',
        environments: [],
        models,
        codingModelRoutingRules: [
          {
            modelId: 'openai/gpt-5.6',
            reasoningEffort: 'high',
            condition: 'Complex refactors',
          },
          {
            modelId: 'anthropic/claude-sonnet-5',
            reasoningEffort: 'high',
            condition: 'Complex engineering tasks',
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps deployment defaults when no model rule matches', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
      model: {
        type: 'choice',
        choice: 'default_model',
        confidence: 0.99,
        probabilities: { default_model: 0.99 },
      },
    });

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Summarize this issue',
        environments: [],
        models,
        codingModelRoutingRules: [
          {
            modelId: 'anthropic/claude-sonnet-5',
            reasoningEffort: 'high',
            condition: 'Complex reasoning and engineering tasks',
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('ignores rules for models that are no longer enabled', async () => {
    await expect(
      resolveFastAgentRoutingHint({
        request: 'Refactor the scheduler',
        environments: [],
        models: models.slice(0, 1),
        codingModelRoutingRules: [
          {
            modelId: 'anthropic/claude-sonnet-5',
            reasoningEffort: 'high',
            condition: 'Complex reasoning and engineering tasks',
          },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(mockEvaluateTypeSafeJudgments).not.toHaveBeenCalled();
  });
});

describe('resolveFastAgentLaunchModelSelection', () => {
  const routingHint = {
    context: 'matched rule',
    model: 'anthropic/claude-sonnet-5',
    reasoningEffort: 'high' as const,
  };

  it('uses a matched routing rule when launch choices are absent', () => {
    expect(resolveFastAgentLaunchModelSelection({ routingHint })).toEqual({
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: 'high',
    });
  });

  it('keeps explicit model and effort choices ahead of routing', () => {
    expect(
      resolveFastAgentLaunchModelSelection({
        explicitModel: 'openai/gpt-5.6',
        explicitReasoningEffort: 'low',
        routingHint,
      }),
    ).toEqual({ model: 'openai/gpt-5.6', reasoningEffort: 'low' });
  });

  it('does not combine one explicit choice with a routing-rule choice', () => {
    expect(
      resolveFastAgentLaunchModelSelection({
        explicitModel: 'openai/gpt-5.6',
        routingHint,
      }),
    ).toEqual({ model: 'openai/gpt-5.6', reasoningEffort: null });
    expect(
      resolveFastAgentLaunchModelSelection({
        explicitReasoningEffort: 'medium',
        routingHint,
      }),
    ).toEqual({ model: null, reasoningEffort: 'medium' });
    expect(
      resolveFastAgentLaunchModelSelection({
        explicitModel: null,
        explicitReasoningEffort: null,
        routingHint,
      }),
    ).toEqual({ model: null, reasoningEffort: null });
  });
});
