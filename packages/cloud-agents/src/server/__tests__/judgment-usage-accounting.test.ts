const { mockRecordLlmUsage } = vi.hoisted(() => ({
  mockRecordLlmUsage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  recordLlmUsage: mockRecordLlmUsage,
}));

vi.mock('../non-task-provider-usage', () => ({
  NON_TASK_INFERENCE_SURFACES: { judgmentModel: 'judgment_model' },
}));

import {
  JudgmentHttpError,
  JudgmentResponseParseError,
  normalizeJudgmentUsage,
  trackJudgmentRequest,
  type JudgmentRequestTracking,
} from '../judgment-usage-accounting';

function response(
  body: Record<string, unknown>,
  init: { status?: number; headers?: HeadersInit } = {},
) {
  return {
    body,
    status: init.status ?? 200,
    headers: new Headers(init.headers),
  };
}

function tracking(
  overrides: Partial<JudgmentRequestTracking> = {},
): JudgmentRequestTracking {
  return {
    requestId: 'request-123',
    provider: 'typesafe' as const,
    model: 'jev-latest',
    role: 'primary' as const,
    ...overrides,
  };
}

async function waitForUsageCall() {
  await vi.waitFor(() => expect(mockRecordLlmUsage).toHaveBeenCalledTimes(1));
  return mockRecordLlmUsage.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('judgment usage accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordLlmUsage.mockResolvedValue({ recorded: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes provider response usage without recording judgment content', async () => {
    const tracked = await trackJudgmentRequest(tracking(), async () =>
      response({
        model: 'jev-1.13.0',
        answers: { decision: 'private answer' },
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          cost: 0.001234,
        },
      }),
    );

    tracked.finish('success');
    const usage = await waitForUsageCall();

    expect(usage).toMatchObject({
      source: 'judgment_model',
      usageType: 'inference',
      eventKey: 'judgment-model:typesafe:primary:request-123',
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
    });
    expect(JSON.stringify(usage)).not.toContain('private answer');
  });

  it('keeps missing metadata explicit and does not derive reported totals', async () => {
    const tracked = await trackJudgmentRequest(tracking(), async () =>
      response({ usage: { input_tokens: 12, output_tokens: 5 } }),
    );

    tracked.finish('success');

    await expect(waitForUsageCall()).resolves.toMatchObject({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 0,
      costMicroUsd: null,
      costSource: 'missing',
      details: {
        usageMetadataAvailable: true,
        usageMetadataSource: 'response',
        missingUsageFields: ['total_tokens', 'cost'],
      },
    });
  });

  it('exposes normalized token aliases through the typed metadata interface', () => {
    expect(
      normalizeJudgmentUsage(
        response({ usage: { prompt_tokens: '17', completion_tokens: 6 } }),
      ),
    ).toMatchObject({
      inputTokens: 17,
      outputTokens: 6,
      usageMetadataAvailable: true,
      usageMetadataSource: 'response',
    });
  });

  it('normalizes provider metadata from response headers', async () => {
    const tracked = await trackJudgmentRequest(
      tracking({ provider: 'openrouter', model: 'typesafe/jev-1.13' }),
      async () =>
        response(
          {},
          {
            headers: {
              'x-input-tokens': '11',
              'x-output-tokens': '4',
              'x-total-tokens': '15',
              'x-openrouter-cost': '0.0005',
              'x-provider-model': 'jev-provider-revision',
            },
          },
        ),
    );

    tracked.finish('success');

    await expect(waitForUsageCall()).resolves.toMatchObject({
      providerId: 'openrouter',
      modelId: 'jev-provider-revision',
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
      costMicroUsd: 500,
      costSource: 'provider_response',
      details: {
        usageMetadataAvailable: true,
        usageMetadataSource: 'header',
      },
    });
  });

  it('keeps primary and shadow requests distinct while sharing their request id', async () => {
    const primary = await trackJudgmentRequest(tracking(), async () =>
      response({}),
    );
    const shadow = await trackJudgmentRequest(
      tracking({
        provider: 'roomote',
        model: 'roomote-judgment',
        role: 'shadow',
        primaryProvider: 'typesafe',
      }),
      async () => response({}),
    );

    primary.finish('success');
    shadow.finish('validation_error');
    await vi.waitFor(() => expect(mockRecordLlmUsage).toHaveBeenCalledTimes(2));

    const entries = mockRecordLlmUsage.mock.calls.map(
      ([entry]) => entry as Record<string, unknown>,
    );
    expect(entries.map((entry) => entry.eventKey)).toEqual([
      'judgment-model:typesafe:primary:request-123',
      'judgment-model:roomote:shadow:request-123',
    ]);
    expect(entries[1]).toMatchObject({
      providerId: 'roomote',
      details: {
        requestRole: 'shadow',
        primaryProvider: 'typesafe',
        outcome: 'validation_error',
      },
    });
  });

  it('records HTTP status and safe headers without persisting the response body', async () => {
    const error = new JudgmentHttpError(
      529,
      'private upstream response body',
      new Headers({ 'x-input-tokens': '8' }),
    );

    await expect(
      trackJudgmentRequest(tracking(), async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    const usage = await waitForUsageCall();
    expect(usage).toMatchObject({
      inputTokens: 8,
      totalTokens: 0,
      details: {
        status: 529,
        outcome: 'http_error',
        usageMetadataSource: 'header',
        metadataReadFailed: false,
      },
    });
    expect(JSON.stringify(usage)).not.toContain(
      'private upstream response body',
    );
  });

  it.each([
    [
      'response_parse_error',
      () => new JudgmentResponseParseError(200, new Headers()),
      200,
      true,
    ],
    [
      'timeout',
      () => Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      null,
      false,
    ],
    ['transport_error', () => new Error('connection reset'), null, false],
  ] as const)(
    'classifies %s request failures',
    async (outcome, createError, status, metadataReadFailed) => {
      const error = createError();

      await expect(
        trackJudgmentRequest(tracking(), async () => {
          throw error;
        }),
      ).rejects.toBe(error);

      await expect(waitForUsageCall()).resolves.toMatchObject({
        details: {
          status,
          outcome,
          metadataReadFailed,
        },
      });
    },
  );

  it('records a later validation outcome once', async () => {
    const tracked = await trackJudgmentRequest(tracking(), async () =>
      response({ answers: { secret: 'not recorded' } }),
    );

    tracked.finish('validation_error');
    tracked.finish('success');

    const usage = await waitForUsageCall();
    expect(usage).toMatchObject({
      details: { outcome: 'validation_error' },
    });
    expect(JSON.stringify(usage)).not.toContain('not recorded');
  });

  it('keeps ledger persistence failures non-blocking', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRecordLlmUsage.mockRejectedValue(new Error('database unavailable'));
    const tracked = await trackJudgmentRequest(tracking(), async () =>
      response({}),
    );

    expect(() => tracked.finish('success')).not.toThrow();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[JudgmentUsage] Failed to record typesafe primary usage',
      ),
    );
  });
});
