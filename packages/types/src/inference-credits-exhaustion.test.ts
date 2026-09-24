import {
  formatInferenceCreditsExhaustedMessage,
  isInferenceCreditsExhaustedError,
  resolveInferenceProviderDisplayName,
} from './inference-credits-exhaustion';

/** The OpenCode APIError shape for an HTTP failure with a JSON body. */
function openCodeApiError(options: {
  statusCode?: number;
  message: string;
  body?: unknown;
  isRetryable?: boolean;
}) {
  return {
    name: 'APIError',
    data: {
      message: options.message,
      ...(options.statusCode === undefined
        ? {}
        : { statusCode: options.statusCode }),
      isRetryable: options.isRetryable ?? options.statusCode === 429,
      responseHeaders: { 'content-type': 'application/json' },
      ...(options.body === undefined
        ? {}
        : { responseBody: JSON.stringify(options.body) }),
      metadata: { url: 'https://provider.example/v1/responses' },
    },
  };
}

const OPENAI_QUOTA_MESSAGE =
  'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.';
const GEMINI_RATE_LIMIT_MESSAGE =
  'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.';

describe('isInferenceCreditsExhaustedError', () => {
  it.each([
    [
      'a ChatGPT subscription usage limit (429 usage_limit_reached)',
      openCodeApiError({
        statusCode: 429,
        message: 'The usage limit has been reached',
        body: {
          error: {
            type: 'usage_limit_reached',
            message: 'The usage limit has been reached',
            plan_type: 'plus',
            resets_at: 1_790_000_000,
            resets_in_seconds: 7_200,
          },
        },
      }),
    ],
    [
      'a ChatGPT plan without Codex usage (429 usage_not_included)',
      openCodeApiError({
        statusCode: 429,
        message: 'Too Many Requests',
        body: { error: { type: 'usage_not_included' } },
      }),
    ],
    [
      'an OpenAI API quota error (429 insufficient_quota)',
      openCodeApiError({
        statusCode: 429,
        message: OPENAI_QUOTA_MESSAGE,
        body: {
          error: {
            message: OPENAI_QUOTA_MESSAGE,
            type: 'insufficient_quota',
            param: null,
            code: 'insufficient_quota',
          },
        },
      }),
    ],
    [
      'an OpenAI spend limit (429 organization_spend_limit_exceeded)',
      openCodeApiError({
        statusCode: 429,
        message: 'Spend limit reached.',
        body: { error: { code: 'organization_spend_limit_exceeded' } },
      }),
    ],
    [
      "OpenCode's rewrite of a streamed insufficient_quota error",
      openCodeApiError({
        message: 'Quota exceeded. Check your plan and billing details.',
        isRetryable: false,
        body: { type: 'error', error: { code: 'insufficient_quota' } },
      }),
    ],
    [
      'an Anthropic prepaid credit balance error (400)',
      openCodeApiError({
        statusCode: 400,
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
          },
        },
      }),
    ],
    [
      'an Anthropic self-set spend limit (400)',
      openCodeApiError({
        statusCode: 400,
        message:
          'You have reached your specified workspace API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
      }),
    ],
    [
      'an Anthropic monthly spend cap (429 enforced_spend_limit_reached)',
      openCodeApiError({
        statusCode: 429,
        message: 'Rate limited',
        body: {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message:
              "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-10-01 at 00:00 UTC.",
            details: { error_code: 'enforced_spend_limit_reached' },
          },
          request_id: 'req_018EeWyXxfu5pfWkrYcMdjWG',
        },
      }),
    ],
    [
      'an Anthropic billing error (402)',
      openCodeApiError({
        statusCode: 402,
        message: 'There is an issue with your billing or payment information.',
        body: { type: 'error', error: { type: 'billing_error' } },
      }),
    ],
    [
      'an OpenRouter credits error (402 openrouter_credits)',
      openCodeApiError({
        statusCode: 402,
        message:
          'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 14075.',
        body: {
          error: {
            code: 402,
            message:
              'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 14075.',
            metadata: {
              limit_source: 'openrouter_credits',
              remedy_hint:
                'Add credits at https://openrouter.ai/settings/credits.',
            },
          },
        },
      }),
    ],
    [
      'an OpenRouter key limit (402 openrouter_key_limit)',
      openCodeApiError({
        statusCode: 402,
        message: 'Key limit exceeded.',
        body: {
          error: {
            code: 402,
            message: 'Key limit exceeded.',
            metadata: { limit_source: 'openrouter_key_limit' },
          },
        },
      }),
    ],
    [
      'an exhausted Roomote inference trial (402 from the gateway)',
      openCodeApiError({
        statusCode: 402,
        message:
          'Payment Required: Roomote inference credits are exhausted. Connect an inference provider to continue.',
      }),
    ],
    [
      'a bare HTTP 402',
      {
        name: 'APIError',
        data: { statusCode: 402, message: 'Payment Required' },
      },
    ],
  ])('recognizes %s', (_label, error) => {
    expect(isInferenceCreditsExhaustedError(error)).toBe(true);
  });

  it.each([
    [
      'The usage limit has been reached',
      'the ChatGPT subscription usage limit',
    ],
    [
      `Too Many Requests: ${JSON.stringify({ error: { type: 'usage_limit_reached' } })}`,
      'an unparsed ChatGPT usage-limit body',
    ],
    [OPENAI_QUOTA_MESSAGE, 'the OpenAI quota message'],
    [
      'To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.',
      "OpenCode's usage_not_included rewrite",
    ],
    [
      'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 5000.',
      'the OpenRouter credits message',
    ],
  ])('recognizes the OpenCode retry status message %j (%s)', (message) => {
    // OpenCode's retry status carries only the message, no status or body.
    expect(
      isInferenceCreditsExhaustedError({
        type: 'retry',
        attempt: 1,
        message,
        next: Date.now() + 2_000,
      }),
    ).toBe(true);
    expect(isInferenceCreditsExhaustedError(new Error(message))).toBe(true);
  });

  it('finds provider codes nested below the depth other traversals stop at', () => {
    const error = {
      name: 'NonTaskOpenCodePromptError',
      providerError: {
        name: 'APIError',
        data: {
          message: 'Too Many Requests',
          responseBody: JSON.stringify({
            type: 'error',
            error: {
              type: 'rate_limit_error',
              details: { error_code: 'enforced_spend_limit_reached' },
            },
          }),
        },
      },
    };

    expect(isInferenceCreditsExhaustedError(error)).toBe(true);
  });

  it.each([
    [
      'a plain OpenAI rate limit',
      openCodeApiError({
        statusCode: 429,
        message:
          'Rate limit reached for gpt-5.5 in organization org-test on tokens per min (TPM): Limit 30000, Used 22999, Requested 12528. Please try again in 11.054s. Visit https://platform.openai.com/account/rate-limits to learn more.',
        body: {
          error: {
            type: 'tokens',
            code: 'rate_limit_exceeded',
            message: 'Rate limit reached for gpt-5.5.',
          },
        },
      }),
    ],
    [
      'a plain ChatGPT backend rate limit',
      openCodeApiError({
        statusCode: 429,
        message: 'Slow down.',
        body: {
          error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
        },
      }),
    ],
    [
      'an Anthropic rate limit',
      openCodeApiError({
        statusCode: 429,
        message:
          'This request would exceed the rate limit for your organization of 50,000 input tokens per minute.',
        body: {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'This request would exceed the rate limit.',
          },
        },
      }),
    ],
    [
      'a Gemini per-minute quota rate limit that reuses OpenAI wording',
      openCodeApiError({
        statusCode: 429,
        message: GEMINI_RATE_LIMIT_MESSAGE,
        body: {
          error: {
            code: 429,
            message: GEMINI_RATE_LIMIT_MESSAGE,
            status: 'RESOURCE_EXHAUSTED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: '17s',
              },
            ],
          },
        },
      }),
    ],
    [
      'the Gemini rate-limit message alone',
      new Error(GEMINI_RATE_LIMIT_MESSAGE),
    ],
    [
      'an OpenRouter rate limit',
      openCodeApiError({
        statusCode: 429,
        message: 'Rate limit exceeded: free-models-per-day.',
        body: {
          error: {
            code: 429,
            message: 'Rate limit exceeded',
            metadata: { error_type: 'rate_limit_exceeded' },
          },
        },
      }),
    ],
    [
      "OpenRouter's temporary in-flight budget (402 with Retry-After)",
      openCodeApiError({
        statusCode: 402,
        message:
          'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.',
        body: {
          error: {
            code: 402,
            message:
              'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.',
            metadata: {
              reason: 'in_flight_budget_exhausted',
              limit_source: 'openrouter_in_flight_budget',
            },
          },
        },
      }),
    ],
    [
      'an invalid API key',
      openCodeApiError({ statusCode: 401, message: 'Invalid API key.' }),
    ],
    [
      'an overloaded provider',
      openCodeApiError({ statusCode: 529, message: 'Overloaded' }),
    ],
    ['an unidentifiable error', new Error('Provider temporarily unavailable')],
    [
      'OpenCode rewriting an unrecognized error as overload',
      { type: 'retry', attempt: 2, message: 'Provider is overloaded' },
    ],
  ])('does not treat %s as exhausted credits', (_label, error) => {
    expect(isInferenceCreditsExhaustedError(error)).toBe(false);
  });

  it('ignores credit wording that only appears in the echoed request', () => {
    expect(
      isInferenceCreditsExhaustedError({
        name: 'APIError',
        data: {
          statusCode: 500,
          message: 'Internal server error',
          requestBodyValues: {
            messages: [
              { role: 'user', content: 'Why is my credit balance too low?' },
            ],
          },
        },
      }),
    ).toBe(false);
  });
});

describe('resolveInferenceProviderDisplayName', () => {
  it.each([
    ['openai/gpt-5.5', { chatgptConnected: true }, 'ChatGPT (subscription)'],
    ['openai/gpt-5.5', {}, 'OpenAI'],
    ['openrouter/anthropic/claude-sonnet-5', {}, 'OpenRouter'],
    ['anthropic/claude-sonnet-5', {}, 'Anthropic'],
    ['roomote/anthropic/claude-sonnet-5', {}, 'Roomote inference'],
    ['bedrock-mantle-openai/openai.gpt-oss-120b', {}, 'Amazon Bedrock'],
  ] as const)('names the provider for %s', (modelId, options, expected) => {
    expect(resolveInferenceProviderDisplayName(modelId, options)).toBe(
      expected,
    );
  });

  it('returns undefined without a model', () => {
    expect(resolveInferenceProviderDisplayName(undefined)).toBeUndefined();
  });
});

describe('formatInferenceCreditsExhaustedMessage', () => {
  it('names the provider', () => {
    expect(formatInferenceCreditsExhaustedMessage('OpenRouter')).toBe(
      'You seem to have run out of credits for OpenRouter. Choose another provider/model or reset your subscription to continue.',
    );
  });

  it('falls back to a generic provider name', () => {
    expect(formatInferenceCreditsExhaustedMessage(undefined)).toBe(
      'You seem to have run out of credits for the inference provider. Choose another provider/model or reset your subscription to continue.',
    );
  });
});
