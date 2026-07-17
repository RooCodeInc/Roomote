import { describe, expect, it } from 'vitest';

import { getOpenCodeProviderErrorRecovery } from './provider-error-recovery';

describe('getOpenCodeProviderErrorRecovery', () => {
  it('detects an UnknownError-wrapped cyber policy refusal', () => {
    const recovery = getOpenCodeProviderErrorRecovery({
      name: 'UnknownError',
      data: {
        message: JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request',
            code: 'cyber_policy',
            message:
              'This content was flagged for possible cybersecurity risk.',
          },
        }),
      },
    });

    expect(recovery).toMatchObject({ kind: 'policy_refusal', maxRetries: 2 });
    expect(recovery?.promptText).toContain('Continue the legitimate task');
    expect(recovery?.promptText).toContain(
      'Do not attempt to bypass the policy',
    );
  });

  it('treats unknown provider errors as recoverable once', () => {
    expect(
      getOpenCodeProviderErrorRecovery({
        name: 'UnknownError',
        data: { message: 'Upstream connection closed unexpectedly.' },
      }),
    ).toMatchObject({ kind: 'provider_error', maxRetries: 1 });
  });

  it('classifies native ContentFilterError payloads as policy refusals', () => {
    const recovery = getOpenCodeProviderErrorRecovery({
      name: 'ContentFilterError',
      data: {
        message: "The response was blocked by the provider's content filter",
      },
    });

    expect(recovery).toMatchObject({ kind: 'policy_refusal', maxRetries: 2 });
    expect(recovery?.promptText).toContain('Continue the legitimate task');
  });

  it('does not retry explicit non-retryable configuration errors', () => {
    expect(
      getOpenCodeProviderErrorRecovery({
        name: 'APIError',
        data: {
          message: 'The selected model is not available in your region.',
          statusCode: 403,
          isRetryable: false,
        },
      }),
    ).toBeNull();
  });
});
