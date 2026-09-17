const { mockResolveModelProviderEnvValue } = vi.hoisted(() => ({
  mockResolveModelProviderEnvValue: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveModelProviderEnvValue: mockResolveModelProviderEnvValue,
}));

import { evaluateTypeSafeJudgments } from '../typesafe-judgment';

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
});
