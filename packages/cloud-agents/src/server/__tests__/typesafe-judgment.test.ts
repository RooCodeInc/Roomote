const {
  mockResolveModelProviderEnvValue,
  mockGetJudgmentSelection,
  mockGenerateTrackedNonTaskObject,
  mockResolveNonTaskHelperModel,
  mockRecordLlmUsage,
  mockCaptureJudgment,
  mockIsJudgmentCaptureEnabled,
  mockEnv,
} = vi.hoisted(() => ({
  mockResolveModelProviderEnvValue: vi.fn(),
  mockGetJudgmentSelection: vi.fn(),
  mockGenerateTrackedNonTaskObject: vi.fn(),
  mockResolveNonTaskHelperModel: vi.fn(),
  mockRecordLlmUsage: vi.fn(),
  mockCaptureJudgment: vi.fn(),
  mockIsJudgmentCaptureEnabled: vi.fn(),
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
  recordLlmUsage: mockRecordLlmUsage,
  resolveModelProviderEnvValue: mockResolveModelProviderEnvValue,
}));

vi.mock('../non-task-provider-usage', () => ({
  generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES: {
    decisionModelFallback: 'decision_model_fallback',
    judgmentModel: 'judgment_model',
  },
  resolveNonTaskHelperModel: mockResolveNonTaskHelperModel,
}));

vi.mock('../judgment-capture', () => ({
  captureJudgment: mockCaptureJudgment,
  isJudgmentCaptureEnabled: mockIsJudgmentCaptureEnabled,
}));

import {
  evaluateTypeSafeJudgments,
  evaluateDecisionModel,
  resetDecisionModelCache,
  resolveDecisionModel,
  resetJudgmentBackendCache,
  testJudgmentBackend,
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

function mockFetchResponse(
  body: unknown,
  init?: { status?: number; headers?: HeadersInit },
) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: init?.headers,
    }),
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
    mockEnv.R_JUDGMENT_UPSTREAM_URL = undefined;
    mockEnv.R_JUDGMENT_UPSTREAM_API_KEY = undefined;
    mockEnv.R_JUDGMENT_SHADOW = undefined;
    mockGetJudgmentSelection.mockResolvedValue(null);
    mockRecordLlmUsage.mockResolvedValue({ recorded: true });
    mockIsJudgmentCaptureEnabled.mockReturnValue(false);
    mockResolveNonTaskHelperModel.mockResolvedValue({
      model: 'openrouter/helper',
      catalogModelId: 'openrouter/helper',
    });
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

    it('is not used unless selected', async () => {
      mockKeys({ OPENROUTER_API_KEY: 'or-key', AI_GATEWAY_API_KEY: 'gw-key' });
      const fetchMock = mockFetchResponse({ answers: upstreamAnswers });

      await expect(
        evaluateTypeSafeJudgments({ state: 'hi', questions }),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is used when selected', async () => {
      mockKeys({ OPENROUTER_API_KEY: 'or-key', AI_GATEWAY_API_KEY: 'gw-key' });
      mockGetJudgmentSelection.mockResolvedValue('roomote');
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
      mockGetJudgmentSelection.mockResolvedValue('roomote');
      const fetchMock = mockFetchResponse({ answers: upstreamAnswers });

      await evaluateTypeSafeJudgments({ state: 'hi', questions });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('leaves a TypeSafe key in charge when not selected', async () => {
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
      mockGetJudgmentSelection.mockResolvedValue('roomote');
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
          new Response(
            JSON.stringify({
              answers: directAnswers,
              usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
            }),
          ),
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
              usage: { input_tokens: 18, output_tokens: 4, total_tokens: 22 },
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

      await vi.waitFor(() =>
        expect(mockRecordLlmUsage).toHaveBeenCalledTimes(2),
      );
      const usageCalls = mockRecordLlmUsage.mock.calls.map(
        ([usage]) => usage as Record<string, unknown>,
      );
      expect(new Set(usageCalls.map((usage) => usage.eventKey)).size).toBe(2);
      expect(usageCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: 'typesafe',
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
            details: expect.objectContaining({
              requestRole: 'primary',
              outcome: 'success',
            }),
          }),
          expect.objectContaining({
            providerId: 'roomote',
            inputTokens: 18,
            outputTokens: 4,
            totalTokens: 22,
            details: expect.objectContaining({
              requestRole: 'shadow',
              primaryProvider: 'typesafe',
              outcome: 'success',
            }),
          }),
        ]),
      );
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
      expect(warn.mock.calls[0]?.[0]).toContain('request_failed');
    });

    it('logs an upstream error as a status, never the response body', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ answers: directAnswers })),
        )
        .mockResolvedValueOnce(
          new Response('could not parse state: secret', { status: 400 }),
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        evaluateTypeSafeJudgments({ state: { text: 'secret' }, questions }),
      ).resolves.toEqual(directAnswers);

      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      const line = warn.mock.calls[0]?.[0] as string;
      expect(line).toContain('http_400');
      expect(line).not.toContain('secret');
    });

    it('does not shadow the upstream against itself', async () => {
      mockKeys({});
      mockGetJudgmentSelection.mockResolvedValue('roomote');
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

  it('records provider usage and cost without persisting judgment data', async () => {
    mockFetchResponse({
      model: 'jev-1.13.0',
      answers: directAnswers,
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 150,
        cost: 0.001234,
      },
    });

    await evaluateTypeSafeJudgments({
      state: { secret: 'do not record' },
      questions,
    });

    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'judgment_model',
          usageType: 'inference',
          eventKey: expect.stringMatching(
            /^judgment-model:typesafe:primary:[0-9a-f-]+$/u,
          ),
          providerId: 'typesafe',
          modelId: 'jev-1.13.0',
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          costMicroUsd: 1234,
          costSource: 'provider_response',
          details: {
            surface: 'judgment_model',
            requestRole: 'primary',
            status: 200,
            outcome: 'success',
            latencyMs: expect.any(Number),
            usageMetadataAvailable: true,
            usageMetadataSource: 'response',
            metadataReadFailed: false,
            missingUsageFields: [],
          },
        }),
      );
    });

    const [usage] = mockRecordLlmUsage.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(JSON.stringify(usage)).not.toContain('do not record');
  });

  it('records missing provider metadata with zero normalized totals', async () => {
    mockFetchResponse({ answers: directAnswers });

    await evaluateTypeSafeJudgments({ state: 'metadata-free', questions });

    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: null,
          outputTokens: null,
          totalTokens: 0,
          costMicroUsd: null,
          costSource: 'missing',
          details: expect.objectContaining({
            outcome: 'success',
            usageMetadataAvailable: false,
            usageMetadataSource: 'none',
            metadataReadFailed: false,
            missingUsageFields: [
              'input_tokens',
              'output_tokens',
              'total_tokens',
              'cost',
            ],
          }),
        }),
      );
    });
  });

  it('records usage metadata exposed through response headers', async () => {
    mockGetJudgmentSelection.mockResolvedValue('openrouter');
    mockKeys({ OPENROUTER_API_KEY: 'or-key' });
    mockFetchResponse(
      { answers: directAnswers },
      {
        headers: {
          'x-input-tokens': '11',
          'x-output-tokens': '4',
          'x-total-tokens': '15',
          'x-openrouter-cost': '0.0005',
        },
      },
    );

    await evaluateTypeSafeJudgments({ state: 'header metadata', questions });

    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'openrouter',
          modelId: 'typesafe/jev-1.13',
          inputTokens: 11,
          outputTokens: 4,
          totalTokens: 15,
          costMicroUsd: 500,
          costSource: 'provider_response',
          details: expect.objectContaining({
            usageMetadataAvailable: true,
            usageMetadataSource: 'header',
          }),
        }),
      );
    });
  });

  it('records an HTTP failure without recording the response body', async () => {
    mockFetchResponse({ error: 'secret response body' }, { status: 529 });

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).rejects.toThrow('HTTP 529');

    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            status: 529,
            outcome: 'http_error',
          }),
          inputTokens: null,
          outputTokens: null,
          totalTokens: 0,
          costSource: 'missing',
        }),
      );
    });

    expect(JSON.stringify(mockRecordLlmUsage.mock.calls[0])).not.toContain(
      'secret response body',
    );
  });

  it('records transport failures without affecting the thrown fallback error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).rejects.toThrow('connect ECONNREFUSED');

    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            status: null,
            outcome: 'transport_error',
          }),
        }),
      );
    });
  });

  it('records response validation failures after a successful HTTP request', async () => {
    mockFetchResponse({
      answers: { urgent: { type: 'noul', noul: 0.5 } },
    });

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).rejects.toThrow('missing a valid answer');

    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            status: 200,
            outcome: 'validation_error',
          }),
        }),
      );
    });
  });

  it('does not let ledger persistence failures change a valid judgment', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRecordLlmUsage.mockRejectedValue(new Error('database unavailable'));
    mockFetchResponse({ answers: directAnswers });

    await expect(
      evaluateTypeSafeJudgments({ state: 'hi', questions }),
    ).resolves.toEqual(directAnswers);

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[JudgmentUsage] Failed to record typesafe primary usage',
      ),
    );
  });

  it('resolves the hosted judgment model before the helper fallback', async () => {
    await expect(resolveDecisionModel()).resolves.toEqual({
      kind: 'judgment',
      supportsHighVolumeDecisions: true,
      roomoteModel: false,
    });
    expect(mockResolveNonTaskHelperModel).not.toHaveBeenCalled();
  });

  describe('excludeRoomoteModel', () => {
    it('lets Jev answer', async () => {
      mockFetchResponse({ answers: directAnswers });

      await expect(
        evaluateDecisionModel({
          state: 'hi',
          questions,
          excludeRoomoteModel: true,
        }),
      ).resolves.toEqual(directAnswers);
    });

    it('skips the decision on the Roomote-run model, even when cached', async () => {
      mockEnv.R_JUDGMENT_UPSTREAM_URL = 'https://judgment.internal.test/';
      mockGetJudgmentSelection.mockResolvedValue('roomote');
      const fetchMock = mockFetchResponse({ answers: directAnswers });

      await expect(resolveDecisionModel()).resolves.toMatchObject({
        kind: 'judgment',
        roomoteModel: true,
      });
      await expect(
        resolveDecisionModel({ excludeRoomoteModel: true }),
      ).resolves.toBeNull();
      await expect(
        evaluateDecisionModel({
          state: 'hi',
          questions,
          excludeRoomoteModel: true,
        }),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still shadows and captures the Jev answer, as training data for the Roomote-run model', async () => {
      mockIsJudgmentCaptureEnabled.mockReturnValue(true);
      mockEnv.R_JUDGMENT_SHADOW = 'on';
      mockEnv.R_JUDGMENT_UPSTREAM_URL = 'https://judgment.internal.test';
      const answers = { urgent: { type: 'noul', noul: 0.92 } };
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ answers })),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        evaluateDecisionModel({
          state: 'hi',
          questions: { urgent: questions.urgent },
          excludeRoomoteModel: true,
        }),
      ).resolves.toEqual(answers);
      expect(mockCaptureJudgment).toHaveBeenCalled();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it('does not fall back to the helper model', async () => {
      mockKeys({});
      mockGetJudgmentSelection.mockResolvedValue('off');

      await expect(
        evaluateDecisionModel({
          state: 'hi',
          questions,
          excludeRoomoteModel: true,
        }),
      ).resolves.toBeNull();
      expect(mockResolveNonTaskHelperModel).not.toHaveBeenCalled();
      expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
    });
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

  it('tells the helper model what a noul is, so it does not answer with its own confidence', async () => {
    mockKeys({});
    mockGetJudgmentSelection.mockResolvedValue('off');
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { answers: directAnswers },
    });

    await evaluateDecisionModel({ state: 'hi', questions });

    const call = mockGenerateTrackedNonTaskObject.mock.calls.at(-1)![0] as {
      prompt: string;
    };

    expect(call.prompt).toContain(
      '`noul` is the probability from 0 to 1 that the answer is yes',
    );
    expect(call.prompt).toContain(
      'It is not confidence in your own answer: a confident no is near 0 and a confident yes is near 1.',
    );
    expect(call.prompt).toContain(
      '`score` is the zero-based index of the criteria entry that fits best',
    );
  });

  it('short-circuits high-volume decisions before resolving the helper', async () => {
    mockKeys({});

    await expect(
      resolveDecisionModel({ highVolume: true }),
    ).resolves.toBeNull();
    expect(mockResolveNonTaskHelperModel).not.toHaveBeenCalled();

    await expect(
      evaluateDecisionModel({ state: 'hi', questions, highVolume: true }),
    ).resolves.toBeNull();
    expect(mockResolveNonTaskHelperModel).not.toHaveBeenCalled();
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
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

  it('retains opt-in capture and shadowing for decision state', async () => {
    mockIsJudgmentCaptureEnabled.mockReturnValue(true);
    mockEnv.R_JUDGMENT_SHADOW = 'on';
    mockEnv.R_JUDGMENT_UPSTREAM_URL = 'https://judgment.internal.test';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: { urgent: { type: 'noul', noul: 0.92 } },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      evaluateTypeSafeJudgments({
        state: { diff: 'sensitive code' },
        questions: { urgent: questions.urgent },
      }),
    ).resolves.toEqual({ urgent: { type: 'noul', noul: 0.92 } });

    expect(mockCaptureJudgment).toHaveBeenCalledWith(
      expect.objectContaining({ state: { diff: 'sensitive code' } }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
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
});

describe('testJudgmentBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJudgmentBackendCache();
    resetDecisionModelCache();
    mockEnv.R_JUDGMENT_MODEL = undefined;
    mockEnv.R_JUDGMENT_UPSTREAM_URL = undefined;
    mockEnv.R_JUDGMENT_UPSTREAM_API_KEY = undefined;
    mockEnv.R_JUDGMENT_SHADOW = undefined;
    mockGetJudgmentSelection.mockResolvedValue(null);
    mockRecordLlmUsage.mockResolvedValue({ recorded: true });
    mockIsJudgmentCaptureEnabled.mockReturnValue(false);
    mockKeys({ R_TYPESAFE_API_KEY: 'ts-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the configured backend without shadowing or capturing the decision', async () => {
    mockIsJudgmentCaptureEnabled.mockReturnValue(true);
    mockEnv.R_JUDGMENT_SHADOW = 'on';
    mockEnv.R_JUDGMENT_UPSTREAM_URL = 'https://judgment.internal.test';
    const fetchMock = mockFetchResponse({ answers: directAnswers });

    const result = await testJudgmentBackend({
      state: 'hi',
      questions,
      target: 'configured',
    });

    expect(result).toMatchObject({
      ok: true,
      provider: 'typesafe',
      answers: directAnswers,
      invalid: [],
    });
    // One request: the Roomote upstream is not called as a shadow.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockCaptureJudgment).not.toHaveBeenCalled();
  });

  it('asks the Roomote upstream directly while Jev is the configured backend', async () => {
    mockEnv.R_JUDGMENT_UPSTREAM_URL = 'https://judgment.internal.test/';
    const fetchMock = mockFetchResponse({ answers: directAnswers });

    const result = await testJudgmentBackend({
      state: 'hi',
      questions,
      target: 'roomote',
    });

    expect(result).toMatchObject({ ok: true, provider: 'roomote' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://judgment.internal.test/v1/decisions',
    );
  });

  it('reports a missing backend and invalid answers instead of throwing', async () => {
    await expect(
      testJudgmentBackend({ state: 'hi', questions, target: 'roomote' }),
    ).resolves.toMatchObject({ ok: false, provider: null });

    mockFetchResponse({
      answers: {
        urgent: { type: 'noul', noul: 1.4 },
        team: directAnswers.team,
      },
    });
    await expect(
      testJudgmentBackend({ state: 'hi', questions, target: 'configured' }),
    ).resolves.toMatchObject({ ok: true, invalid: ['urgent'] });
  });

  it('reports an HTTP failure as a category, never the response body', async () => {
    mockFetchResponse({ error: 'secret detail' }, { status: 503 });

    const result = await testJudgmentBackend({
      state: 'hi',
      questions,
      target: 'configured',
    });

    expect(result).toMatchObject({ ok: false, error: 'http_503' });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});
