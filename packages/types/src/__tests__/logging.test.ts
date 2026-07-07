import {
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
});
