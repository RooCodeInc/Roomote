const {
  mockResolveModelProviderEnvValue,
  mockGetJudgmentSelection,
  mockGetDeploymentTaskModelOption,
  mockGenerateTrackedNonTaskObject,
  mockResolveNonTaskHelperModel,
  mockEnv,
} = vi.hoisted(() => ({
  mockResolveModelProviderEnvValue: vi.fn(),
  mockGetJudgmentSelection: vi.fn(),
  mockGetDeploymentTaskModelOption: vi.fn(),
  mockGenerateTrackedNonTaskObject: vi.fn(),
  mockResolveNonTaskHelperModel: vi.fn(),
  mockEnv: { R_JUDGMENT_MODEL: undefined as string | undefined },
}));

vi.mock('@roomote/env', () => ({ Env: mockEnv }));

vi.mock('@roomote/db/server', () => ({
  getDeploymentJudgmentModelSelection: mockGetJudgmentSelection,
  getDeploymentTaskModelOption: mockGetDeploymentTaskModelOption,
  resolveModelProviderEnvValue: mockResolveModelProviderEnvValue,
}));

vi.mock('../non-task-provider-usage', () => ({
  generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES: {
    decisionModelFallback: 'decision_model_fallback',
  },
  resolveNonTaskHelperModel: mockResolveNonTaskHelperModel,
}));

import {
  evaluateTypeSafeJudgments,
  evaluateDecisionModel,
  resetDecisionModelCache,
  resolveDecisionModel,
  resetJudgmentBackendCache,
  scoreTypeSafeRelevance,
} from '../typesafe-judgment';

const questions = {
  urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
  team: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Payments', technical: 'Bugs' },
  },
} as const;

function mockKeys(keys: {
  R_TYPESAFE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
}) {
  mockResolveModelProviderEnvValue.mockImplementation(
    async (names: readonly string[]) =>
      names.map((name) => keys[name as keyof typeof keys]).find(Boolean),
  );
}

function mockFetchResponse(body: unknown, init?: { status?: number }) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockFetchRawResponse(body: string) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const directAnswers = {
  urgent: { type: 'noul', noul: 0.92 },
  team: {
    type: 'choice',
    choice: 'technical',
    probabilities: { billing: 0.1, technical: 0.9 },
    confidence: 0.82,
  },
};

describe('evaluateTypeSafeJudgments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJudgmentBackendCache();
    resetDecisionModelCache();
    mockEnv.R_JUDGMENT_MODEL = undefined;
    mockGetJudgmentSelection.mockResolvedValue(null);
    mockGetDeploymentTaskModelOption.mockResolvedValue(undefined);
    mockResolveNonTaskHelperModel.mockResolvedValue({
      model: 'openrouter/helper',
      catalogModelId: 'openrouter/helper',
    });
    mockKeys({ R_TYPESAFE_API_KEY: 'ts-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null without a request when no judgment model is configured', async () => {
    mockKeys({ AI_GATEWAY_API_KEY: 'gw-key' });
    const fetchMock = mockFetchResponse({});

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses TypeSafe directly when only a TypeSafe key is configured', async () => {
    const fetchMock = mockFetchResponse({
      model: 'jev-latest',
      answers: directAnswers,
    });

    await expect(
      evaluateTypeSafeJudgments({
        state: { text: 'Payouts failing' },
        questions,
      }),
    ).resolves.toEqual(directAnswers);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ts-key' });
    expect(JSON.parse(init.body as string)).toEqual({
      state: { text: 'Payouts failing' },
      model: 'jev-latest',
      questions,
    });
  });

  it('resolves the hosted judgment model before the helper fallback', async () => {
    await expect(resolveDecisionModel()).resolves.toEqual({
      kind: 'judgment',
      supportsHighVolumeDecisions: true,
    });
    expect(mockResolveNonTaskHelperModel).not.toHaveBeenCalled();
  });

  it('uses the resolved helper model for ordinary decision fallback', async () => {
    mockKeys({});
    mockGetJudgmentSelection.mockResolvedValue('off');
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { answers: directAnswers },
    });

    await expect(
      evaluateDecisionModel({ state: 'hi', questions }),
    ).resolves.toEqual(directAnswers);
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'openrouter/helper',
        modelRole: 'small',
        surface: 'decision_model_fallback',
      }),
    );
  });

  it('gates high-volume helper decisions when the resolved model is not capable', async () => {
    mockKeys({});
    mockGetDeploymentTaskModelOption.mockResolvedValue({
      id: 'openrouter/helper',
      displayName: 'Helper',
      family: 'Helper',
      metadata: { supportsHighVolumeDecisions: false },
    });

    await expect(
      evaluateDecisionModel({ state: 'hi', questions, highVolume: true }),
    ).resolves.toBeNull();
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('propagates high-volume capability from the actual helper fallback model', async () => {
    mockKeys({});
    mockResolveNonTaskHelperModel.mockResolvedValue({
      model: 'bedrock-mantle-openai/gpt-5.6-luna',
      catalogModelId: 'bedrock-mantle/openai.gpt-5.6-luna',
    });
    mockGetDeploymentTaskModelOption.mockResolvedValue({
      id: 'bedrock-mantle/openai.gpt-5.6-luna',
      displayName: 'Luna',
      family: 'GPT',
      metadata: { supportsHighVolumeDecisions: true },
    });

    await expect(resolveDecisionModel()).resolves.toEqual({
      kind: 'helper',
      model: 'bedrock-mantle-openai/gpt-5.6-luna',
      catalogModelId: 'bedrock-mantle/openai.gpt-5.6-luna',
      supportsHighVolumeDecisions: true,
    });
  });

  it('uses a capable helper model for opted-in high-volume decisions', async () => {
    mockKeys({});
    mockGetDeploymentTaskModelOption.mockResolvedValue({
      id: 'openrouter/helper',
      displayName: 'Helper',
      family: 'Helper',
      metadata: { supportsHighVolumeDecisions: true },
    });
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { answers: directAnswers },
    });

    await expect(
      evaluateDecisionModel({ state: 'hi', questions, highVolume: true }),
    ).resolves.toEqual(directAnswers);
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledOnce();
  });

  it('does not cascade a hosted judgment failure into a helper call', async () => {
    mockFetchResponse({ error: 'overloaded' }, { status: 529 });

    await expect(
      evaluateDecisionModel({ state: 'hi', questions }),
    ).rejects.toThrow('HTTP 529');
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('stays off when an admin turned the judgment model off in Settings', async () => {
    mockGetJudgmentSelection.mockResolvedValue('off');
    const fetchMock = mockFetchResponse({});

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets R_JUDGMENT_MODEL override the Settings choice', async () => {
    mockGetJudgmentSelection.mockResolvedValue('typesafe');
    mockEnv.R_JUDGMENT_MODEL = 'off';
    const fetchMock = mockFetchResponse({});

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls Jev through Vercel AI Gateway and translates the evaluation spec', async () => {
    mockGetJudgmentSelection.mockResolvedValue('vercel');
    mockKeys({ R_TYPESAFE_API_KEY: 'ts-key', AI_GATEWAY_API_KEY: 'gw-key' });
    const fetchMock = mockFetchResponse({
      answers: {
        urgent: { type: 'boolean', probability: 0.92 },
        team: {
          type: 'choice',
          choice: 'technical',
          probabilities: { billing: 0.1, technical: 0.9 },
        },
      },
      providerMetadata: { typesafe: { confidence: { team: 0.82 } } },
    });

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toEqual(directAnswers);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer gw-key',
      'ai-model-id': 'typesafe-ai/jev',
      'ai-evaluation-model-specification-version': '4',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      state: 'hi',
      questions: {
        urgent: { type: 'boolean', instructions: 'Does this convey urgency?' },
        team: questions.team,
      },
    });
  });

  it('calls the OpenRouter Decisions API and normalizes optional confidence', async () => {
    mockGetJudgmentSelection.mockResolvedValue('openrouter');
    mockKeys({ OPENROUTER_API_KEY: 'or-key' });
    const fetchMock = mockFetchResponse({
      model: 'typesafe/jev-1.13',
      answers: {
        urgent: { type: 'noul', noul: 0.92 },
        team: {
          type: 'choice',
          choice: 'technical',
          probabilities: { billing: 0.1, technical: 0.9 },
        },
      },
    });

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toEqual({
      ...directAnswers,
      team: { ...directAnswers.team, confidence: 0.9 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer or-key' });
    expect(JSON.parse(init.body as string)).toEqual({
      state: 'hi',
      model: 'typesafe/jev-1.13',
      questions,
    });
  });

  it('does not replace malformed OpenRouter confidence', async () => {
    mockGetJudgmentSelection.mockResolvedValue('openrouter');
    mockKeys({ OPENROUTER_API_KEY: 'or-key' });
    mockFetchResponse({
      answers: {
        team: {
          type: 'choice',
          choice: 'technical',
          probabilities: { billing: 0.1, technical: 0.9 },
          confidence: 'high',
        },
      },
    });

    await expect(
      evaluateTypeSafeJudgments({
        state: 'hi',
        questions: { team: questions.team },
      }),
    ).rejects.toThrow('missing a valid answer');
  });

  it('rejects malformed OpenRouter probabilities used to derive confidence', async () => {
    mockGetJudgmentSelection.mockResolvedValue('openrouter');
    mockKeys({ OPENROUTER_API_KEY: 'or-key' });
    mockFetchResponse({
      answers: {
        severity: {
          type: 'score',
          score: 1.4,
          probabilities: { low: 0.1, medium: '0.7', high: 0.2 },
        },
      },
    });

    await expect(
      evaluateTypeSafeJudgments({
        state: 'hi',
        questions: {
          severity: {
            type: 'score',
            instructions: 'How severe?',
            criteria: ['Low', 'Medium', 'High'],
          },
        },
      }),
    ).rejects.toThrow('missing a valid answer');
  });

  it('uses the top probability when the gateway reports no confidence', async () => {
    mockEnv.R_JUDGMENT_MODEL = 'vercel';
    mockKeys({ AI_GATEWAY_API_KEY: 'gw-key' });
    mockFetchResponse({
      answers: {
        team: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.7, technical: 0.3 },
        },
      },
    });

    const answers = await evaluateTypeSafeJudgments({
      state: 'hi',
      questions: { team: questions.team },
    });

    expect(answers?.team.confidence).toBe(0.7);
  });

  it('does not fall back to TypeSafe when AI Gateway is selected without a key', async () => {
    mockGetJudgmentSelection.mockResolvedValue('vercel');
    const fetchMock = mockFetchResponse({});

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fall back to TypeSafe when OpenRouter is selected without a key', async () => {
    mockGetJudgmentSelection.mockResolvedValue('openrouter');
    const fetchMock = mockFetchResponse({});

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on an HTTP error', async () => {
    mockFetchResponse({ error: 'overloaded' }, { status: 529 });

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).rejects.toThrow('HTTP 529');
  });

  it.each([
    ['a missing answer', { urgent: { type: 'noul', noul: 0.5 } }],
    [
      'an out-of-range probability',
      {
        urgent: { type: 'noul', noul: 1.4 },
        team: {
          type: 'choice',
          choice: 'billing',
          probabilities: {},
          confidence: 0.9,
        },
      },
    ],
    [
      'a choice outside the criteria',
      {
        urgent: { type: 'noul', noul: 0.5 },
        team: {
          type: 'choice',
          choice: 'sales',
          probabilities: {},
          confidence: 0.9,
        },
      },
    ],
  ])('throws on %s', async (_label, answers) => {
    mockFetchResponse({ answers });

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).rejects.toThrow('missing a valid answer');
  });

  describe.each([
    { label: 'TypeSafe direct', backend: 'typesafe' },
    { label: 'OpenRouter', backend: 'openrouter' },
    { label: 'Vercel AI Gateway', backend: 'vercel' },
  ] as const)('$label choice answers', ({ backend }) => {
    it.each([
      ['a non-number', '{"billing":0.1,"technical":"0.9"}'],
      ['an out-of-range number', '{"billing":0.1,"technical":1.1}'],
      ['a non-finite number', '{"billing":0.1,"technical":1e309}'],
      ['a missing choice', '{"technical":0.9}'],
      ['an unexpected choice', '{"billing":0.1,"technical":0.9,"sales":0}'],
    ])('rejects probabilities with %s', async (_label, probabilities) => {
      if (backend === 'vercel') {
        mockEnv.R_JUDGMENT_MODEL = 'vercel';
        mockKeys({ AI_GATEWAY_API_KEY: 'gw-key' });
      } else if (backend === 'openrouter') {
        mockEnv.R_JUDGMENT_MODEL = 'openrouter';
        mockKeys({ OPENROUTER_API_KEY: 'or-key' });
      }

      const providerMetadata =
        backend === 'vercel'
          ? ',"providerMetadata":{"typesafe":{"confidence":{"team":0.9}}}'
          : '';
      mockFetchRawResponse(
        `{"answers":{"team":{"type":"choice","choice":"technical","probabilities":${probabilities},"confidence":0.9}}${providerMetadata}}`,
      );

      await expect(
        evaluateTypeSafeJudgments({
          state: 'hi',
          questions: { team: questions.team },
        }),
      ).rejects.toThrow('missing a valid answer');
    });
  });

  it('accepts score answers within the level range', async () => {
    mockFetchResponse({
      answers: { severity: { type: 'score', score: 1.4, confidence: 0.7 } },
    });

    await expect(
      evaluateTypeSafeJudgments({
        state: 'hi',
        questions: {
          severity: {
            type: 'score',
            instructions: 'How severe?',
            criteria: ['Low', 'Medium', 'High'],
          },
        },
      }),
    ).resolves.toEqual({
      severity: { type: 'score', score: 1.4, confidence: 0.7 },
    });
  });

  it('scores relevance across parallel batches keyed by candidate id', async () => {
    const candidates = Array.from({ length: 70 }, (_, index) => ({
      id: `tool-${index}`,
      text: `Tool ${index}`,
    }));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        state: { candidates: Record<string, string> };
      };
      return new Response(
        JSON.stringify({
          answers: Object.fromEntries(
            Object.entries(body.state.candidates).map(([key, text]) => [
              key,
              { type: 'noul', noul: Number(text.split(' ')[1]) / 100 },
            ]),
          ),
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const scores = await scoreTypeSafeRelevance({
      query: 'file a bug',
      candidateKind: 'integration tool',
      relevanceQuestion: 'Would this tool help?',
      candidates,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(scores?.get('tool-0')).toBe(0);
    expect(scores?.get('tool-69')).toBe(0.69);
    expect(scores?.size).toBe(70);
  });

  it('returns null from relevance scoring when no judgment model is configured', async () => {
    mockKeys({});

    await expect(
      scoreTypeSafeRelevance({
        query: 'q',
        candidateKind: 'skill',
        relevanceQuestion: 'Relevant?',
        candidates: [{ id: 'a', text: 'A' }],
      }),
    ).resolves.toBeNull();
  });
});
