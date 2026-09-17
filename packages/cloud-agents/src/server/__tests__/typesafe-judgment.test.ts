const {
  mockResolveModelProviderEnvValue,
  mockFindConnection,
  mockFindEnablement,
} = vi.hoisted(() => ({
  mockResolveModelProviderEnvValue: vi.fn(),
  mockFindConnection: vi.fn(),
  mockFindEnablement: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  mcpConnections: {},
  deploymentMcpEnablements: {},
  db: {
    query: {
      mcpConnections: { findFirst: mockFindConnection },
      deploymentMcpEnablements: { findFirst: mockFindEnablement },
    },
  },
  resolveModelProviderEnvValue: mockResolveModelProviderEnvValue,
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: (value: string) => value.replace(/^enc:/u, ''),
}));

import {
  evaluateTypeSafeJudgments,
  resetTypeSafeApiKeyCache,
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

function mockFetchResponse(body: unknown, init?: { status?: number }) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('evaluateTypeSafeJudgments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTypeSafeApiKeyCache();
    mockFindConnection.mockResolvedValue(undefined);
    mockFindEnablement.mockResolvedValue(undefined);
    mockResolveModelProviderEnvValue.mockResolvedValue('ts-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null without calling TypeSafe when no key is configured', async () => {
    mockResolveModelProviderEnvValue.mockResolvedValue(undefined);
    const fetchMock = mockFetchResponse({});

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toBeNull();
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledWith([
      'R_TYPESAFE_API_KEY',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts state and questions and returns typed answers', async () => {
    const answers = {
      urgent: { type: 'noul', noul: 0.92 },
      team: {
        type: 'choice',
        choice: 'technical',
        probabilities: { billing: 0.1, technical: 0.9 },
        confidence: 0.82,
      },
    };
    const fetchMock = mockFetchResponse({ model: 'jev-latest', answers });

    await expect(
      evaluateTypeSafeJudgments({
        state: { text: 'Payouts failing' },
        questions,
      }),
    ).resolves.toEqual(answers);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ts-key' });
    expect(JSON.parse(init.body as string)).toEqual({
      state: { text: 'Payouts failing' },
      model: 'jev-latest',
      questions,
    });
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

  it('prefers the key saved in Settings over the environment variable', async () => {
    mockFindConnection.mockResolvedValue({
      authConfig: { type: 'typesafe', encryptedApiKey: 'enc:settings-key' },
    });
    const fetchMock = mockFetchResponse({
      answers: { urgent: { type: 'noul', noul: 0.4 } },
    });

    await evaluateTypeSafeJudgments({
      state: 'hi',
      questions: { urgent: questions.urgent },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer settings-key',
    });
    expect(mockResolveModelProviderEnvValue).not.toHaveBeenCalled();
  });

  it('ignores a Settings key when an admin turned the integration off', async () => {
    mockFindConnection.mockResolvedValue({
      authConfig: { type: 'typesafe', encryptedApiKey: 'enc:settings-key' },
    });
    mockFindEnablement.mockResolvedValue({ enabled: false });
    mockResolveModelProviderEnvValue.mockResolvedValue(undefined);
    const fetchMock = mockFetchResponse({});

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
        state: { candidates: string[] };
      };
      return new Response(
        JSON.stringify({
          answers: Object.fromEntries(
            body.state.candidates.map((text, index) => [
              `c${index}`,
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

  it('returns null from relevance scoring when no key is configured', async () => {
    mockResolveModelProviderEnvValue.mockResolvedValue(undefined);

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
