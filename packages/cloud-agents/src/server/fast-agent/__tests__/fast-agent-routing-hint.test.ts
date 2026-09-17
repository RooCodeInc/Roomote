const { mockEvaluateTypeSafeJudgments } = vi.hoisted(() => ({
  mockEvaluateTypeSafeJudgments: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

import { ALL_REPOSITORIES } from '@roomote/types';

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
      'Routing hint: api [id: env-api] looks like the best fit (judgment model confidence 0.82). Verify against the environments and routing rules before delegating, and ask when the request is still ambiguous.',
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
    ).resolves.toContain('Routing hint: web-app [id: env-web]');
  });
});
