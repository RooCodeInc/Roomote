const { mockEvaluateTypeSafeJudgments } = vi.hoisted(() => ({
  mockEvaluateTypeSafeJudgments: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

import { resolveFastAgentRoutingHint } from '../fast-agent-routing-hint';

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

const models = [
  {
    id: 'openai/gpt-5.6',
    displayName: 'GPT-5.6',
    family: 'GPT',
    metadata: {
      contextWindow: null,
      inputTypes: null,
      inputPricePerToken: null,
      outputPricePerToken: null,
      lastRefreshedAt: null,
      supportsReasoning: true,
    },
  },
  {
    id: 'anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    family: 'Claude',
    metadata: {
      contextWindow: null,
      inputTypes: null,
      inputPricePerToken: null,
      outputPricePerToken: null,
      lastRefreshedAt: null,
      supportsReasoning: true,
    },
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

    expect(hint).toBe(
      'Routing hint: api [id: env-api] looks like the best environment (judgment model confidence 0.82). Verify against the listed environments, models, and routing guidance before delegating; an explicit user choice takes precedence, and ask when the request is still ambiguous.',
    );
  });

  it('returns enabled environment and model recommendations together', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
      environment: {
        type: 'choice',
        choice: 'env_2',
        confidence: 0.84,
        probabilities: { env_2: 0.84 },
      },
      model: {
        type: 'choice',
        choice: 'model_2',
        confidence: 0.91,
        probabilities: { model_2: 0.91 },
      },
    });

    const hint = await resolveFastAgentRoutingHint({
      request: 'Fix the payments API using Claude',
      environments,
      models,
      defaultModelId: 'openai/gpt-5.6',
      routingGuidance:
        'Payments work uses API. Prefer Claude Sonnet for backend fixes.',
    });

    expect(hint).toContain(
      'api [id: env-api] looks like the best environment (judgment model confidence 0.84)',
    );
    expect(hint).toContain(
      'Claude Sonnet 5 [id: anthropic/claude-sonnet-5] looks like the best coding model (judgment model confidence 0.91)',
    );
    expect(hint).not.toContain('reasoning effort');
    expect(
      mockEvaluateTypeSafeJudgments.mock.calls[0]![0].questions.model.criteria
        .model_1,
    ).toContain('supports configurable reasoning effort');
  });

  it('returns a model-only recommendation when no environment choice is needed', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
      model: {
        type: 'choice',
        choice: 'model_1',
        confidence: 0.88,
        probabilities: { model_1: 0.88 },
      },
    });

    const hint = await resolveFastAgentRoutingHint({
      request: 'Use GPT-5.6 for this planning task',
      environments: [],
      models,
      defaultModelId: 'anthropic/claude-sonnet-5',
      routingGuidance: 'Prefer GPT-5.6 for planning tasks.',
    });

    expect(hint).toContain(
      'GPT-5.6 [id: openai/gpt-5.6] looks like the best coding model',
    );
    expect(hint).not.toContain('best environment');
    expect(
      mockEvaluateTypeSafeJudgments.mock.calls[0]![0].questions,
    ).not.toHaveProperty('environment');
  });

  it('drops an unavailable model recommendation', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
      model: {
        type: 'choice',
        choice: 'model_99',
        confidence: 0.99,
        probabilities: { model_99: 0.99 },
      },
    });

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Use the unavailable model',
        environments: [],
        models,
        routingGuidance: 'Prefer a model that is not enabled.',
      }),
    ).resolves.toBeUndefined();
  });

  it('passes free-text routing guidance to the judgment model', async () => {
    mockChoice('unclear', 0.9);

    await resolveFastAgentRoutingHint({
      request: 'Fix the invoice PDF',
      threadContext: [{ text: 'Invoices look wrong since yesterday' }],
      environments,
      routingGuidance:
        'Billing and invoices use API. Cross-repo refactors use All repositories.',
    });

    const call = mockEvaluateTypeSafeJudgments.mock.calls[0]![0];
    expect(call.state).toEqual({
      request: 'Fix the invoice PDF',
      threadContext: ['Invoices look wrong since yesterday'],
      routingGuidance:
        'Billing and invoices use API. Cross-repo refactors use All repositories.',
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
    expect(criteria.all_repositories).toContain('all repositories');
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
        environments: [],
        models,
        routingGuidance: 'Prefer GPT-5.6 for frontend work.',
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

  it('asks about a single environment when routing guidance exists', async () => {
    mockChoice('env_1', 0.9);

    await expect(
      resolveFastAgentRoutingHint({
        request: 'Fix the login page',
        environments: environments.slice(0, 1),
        routingGuidance: 'Frontend work uses the web-app environment.',
      }),
    ).resolves.toContain('Routing hint: web-app [id: env-web]');
  });
});
