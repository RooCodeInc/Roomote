import {
  formatOperationalEvent,
  getOperationalLogRuntimeFields,
  formatLogFieldValue,
  formatLogFields,
  formatSingleLineLog,
} from '../logging';

describe('logging helpers', () => {
  it('formats structured fields for single-line logs', () => {
    expect(
      formatLogFields({
        service: 'api',
        status: 200,
        ok: true,
        payload: { id: 'resp_123' },
        tags: ['openai', 'responses'],
        empty: null,
        skipped: undefined,
      }),
    ).toBe(
      'service="api" status=200 ok=true payload={"id":"resp_123"} tags=["openai","responses"] empty=null',
    );
  });

  it('formats errors as concise quoted field values', () => {
    const error = new Error('Connection closed');
    error.name = 'AbortError';

    expect(formatLogFieldValue(error)).toBe('"AbortError | Connection closed"');
  });

  it('builds single-line messages without a trailing separator', () => {
    expect(
      formatSingleLineLog('[Observed External Request]', {
        service: 'api',
        durationMs: 2063,
      }),
    ).toBe('[Observed External Request] service="api" durationMs=2063');

    expect(formatSingleLineLog('[Observed External Request]', {})).toBe(
      '[Observed External Request]',
    );
  });

  it('formats operational events with safe correlation and runtime fields', () => {
    expect(
      JSON.parse(
        formatOperationalEvent('webhook_terminal', {
          ...getOperationalLogRuntimeFields('api', {
            R_APP_ENV: 'staging',
            RELEASE_VERSION: 'develop-abc123',
            RAILWAY_PROJECT_ID: 'project-1',
            RAILWAY_DEPLOYMENT_ID: 'deployment-1',
          }),
          provider: 'github',
          deliveryId: 'delivery\n123',
          repository: 'RooCodeInc/Roomote',
          prNumber: 2750,
          outcome: 'skipped',
          reason: 'external_bot',
        }),
      ),
    ).toEqual({
      event: 'webhook_terminal',
      service: 'api',
      environment: 'staging',
      release: 'develop-abc123',
      projectId: 'project-1',
      deploymentId: 'deployment-1',
      provider: 'github',
      deliveryId: 'delivery 123',
      repository: 'RooCodeInc/Roomote',
      prNumber: 2750,
      outcome: 'skipped',
      reason: 'external_bot',
    });
  });

  it('drops fields that are not approved for operational logs', () => {
    const fields = {
      provider: 'telegram',
      outcome: 'received',
      payload: { secret: 'do-not-log' },
      body: 'private message',
      url: 'https://example.com/webhook?token=secret',
    } as Parameters<typeof formatOperationalEvent>[1];

    expect(
      JSON.parse(formatOperationalEvent('webhook_received', fields)),
    ).toEqual({
      event: 'webhook_received',
      provider: 'telegram',
      outcome: 'received',
    });
  });
});
