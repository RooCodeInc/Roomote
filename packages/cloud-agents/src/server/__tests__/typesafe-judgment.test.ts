const { mockResolveModelProviderEnvValue, mockGetJudgmentSelection, mockEnv } =
  vi.hoisted(() => ({
    mockResolveModelProviderEnvValue: vi.fn(),
    mockGetJudgmentSelection: vi.fn(),
    mockEnv: {
      R_JUDGMENT_MODEL: undefined as string | undefined,
      R_JUDGMENT_UPSTREAM_URL: undefined as string | undefined,
      R_JUDGMENT_UPSTREAM_API_KEY: undefined as string | undefined,
      R_JUDGMENT_SHADOW: undefined as string | undefined,
    },
  }));

vi.mock('@roomote/env', () => ({ Env: mockEnv }));

vi.mock('@roomote/db/server', () => ({
  getDeploymentJudgmentModelSelection: mockGetJudgmentSelection,
  resolveModelProviderEnvValue: mockResolveModelProviderEnvValue,
}));

import {
  evaluateTypeSafeJudgments,
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
    mockEnv.R_JUDGMENT_MODEL = undefined;
    mockEnv.R_JUDGMENT_UPSTREAM_URL = undefined;
    mockEnv.R_JUDGMENT_UPSTREAM_API_KEY = undefined;
    mockEnv.R_JUDGMENT_SHADOW = undefined;
    mockGetJudgmentSelection.mockResolvedValue(null);
    mockKeys({ R_TYPESAFE_API_KEY: 'ts-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Roomote judgment upstream', () => {
    const upstreamAnswers = {
      urgent: { type: 'noul', noul: 0.92 },
      team: {
        type: 'choice',
        choice: 'technical',
        probabilities: { billing: 0.1, technical: 0.9 },
      },
    };

    beforeEach(() => {
      mockEnv.R_JUDGMENT_UPSTREAM_URL = 'https://judgment.internal.test/';
      mockEnv.R_JUDGMENT_UPSTREAM_API_KEY = 'upstream-key';
    });

    it('is used by default when no TypeSafe key is configured', async () => {
      mockKeys({ OPENROUTER_API_KEY: 'or-key', AI_GATEWAY_API_KEY: 'gw-key' });
      const fetchMock = mockFetchResponse({ answers: upstreamAnswers });

      await expect(
        evaluateTypeSafeJudgments({ state: { text: 'hi' }, questions }),
      ).resolves.toEqual({
        urgent: { type: 'noul', noul: 0.92 },
        team: { ...upstreamAnswers.team, confidence: 0.9 },
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://judgment.internal.test/v1/decisions');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer upstream-key',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        state: { text: 'hi' },
        model: 'roomote-judgment',
        questions,
      });
      // A self-run model gets more room than a hosted API.
      expect((init.signal as AbortSignal | undefined)?.aborted).toBe(false);
    });

    it('sends no Authorization header for an upstream without a key', async () => {
      mockEnv.R_JUDGMENT_UPSTREAM_API_KEY = undefined;
      mockKeys({});
      const fetchMock = mockFetchResponse({ answers: upstreamAnswers });

      await evaluateTypeSafeJudgments({ state: 'hi', questions });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('yields to a TypeSafe key, which is an explicit opt-in', async () => {
      const fetchMock = mockFetchResponse({ answers: directAnswers });

      await evaluateTypeSafeJudgments({ state: 'hi', questions });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://api.typesafe.ai/v1/systemone',
      );
    });

    it('is chosen over a TypeSafe key when selected explicitly', async () => {
      mockGetJudgmentSelection.mockResolvedValue('roomote');
      const fetchMock = mockFetchResponse({ answers: upstreamAnswers });

      await evaluateTypeSafeJudgments({ state: 'hi', questions });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://judgment.internal.test/v1/decisions',
      );
    });

    it('resolves to no backend when selected without an upstream', async () => {
      mockEnv.R_JUDGMENT_UPSTREAM_URL = undefined;
      mockEnv.R_JUDGMENT_MODEL = 'roomote';
      const fetchMock = mockFetchResponse({ answers: upstreamAnswers });

      await expect(
        evaluateTypeSafeJudgments({ state: 'hi', questions }),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('validates upstream answers like any other backend', async () => {
      mockKeys({});
      mockFetchResponse({
        answers: { urgent: { type: 'noul', noul: 0.5 } },
      });

      await expect(
        evaluateTypeSafeJudgments({ state: 'hi', questions }),
      ).rejects.toThrow('missing a valid answer');
    });
  });

  describe('shadow comparison', () => {
    beforeEach(() => {
      mockEnv.R_JUDGMENT_UPSTREAM_URL = 'https://judgment.internal.test';
      mockEnv.R_JUDGMENT_SHADOW = 'on';
    });

    it('scores Jev judgments with the upstream and logs agreement without changing the answer', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ answers: directAnswers })),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              answers: {
                urgent: { type: 'noul', noul: 0.31 },
                team: {
                  type: 'choice',
                  choice: 'technical',
                  probabilities: { billing: 0.4, technical: 0.6 },
                },
              },
            }),
          ),
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        evaluateTypeSafeJudgments({ state: { text: 'secret' }, questions }),
      ).resolves.toEqual(directAnswers);

      await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toBe(
        'https://judgment.internal.test/v1/decisions',
      );
      const line = info.mock.calls[0]?.[0] as string;
      expect(line).toContain(
        '[JudgmentShadow] primary=typesafe questions=2 agreed=1',
      );
      expect(line).toContain('urgent:noul:differ:0.92/0.31');
      expect(line).toContain('team:choice:same:0.82/0.60');
      expect(line).not.toContain('secret');
      expect(line).not.toContain('technical');
    });

    it('never lets an upstream failure reach the caller', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ answers: directAnswers })),
        )
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        evaluateTypeSafeJudgments({ state: 'hi', questions }),
      ).resolves.toEqual(directAnswers);

      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(warn.mock.calls[0]?.[0]).toContain('ECONNREFUSED');
    });

    it('does not shadow the upstream against itself', async () => {
      mockKeys({});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const fetchMock = mockFetchResponse({
        answers: {
          urgent: { type: 'noul', noul: 0.9 },
          team: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.7, technical: 0.3 },
          },
        },
      });

      await evaluateTypeSafeJudgments({ state: 'hi', questions });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(info).not.toHaveBeenCalled();
    });
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
