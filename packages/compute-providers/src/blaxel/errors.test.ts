import {
  getBlaxelErrorDetails,
  isBlaxelResourceNotFound,
  isBlaxelWorkloadUnavailable,
  shouldRetryBlaxelLifecycleError,
} from './errors';

describe('Blaxel structured errors', () => {
  it('parses platform errors embedded in SDK error messages', () => {
    const error = new Error(
      '404 {"error":{"code":"WORKLOAD_UNAVAILABLE","message":"not ready","origin":"platform","retryable":true,"status":404}}',
    );

    expect(getBlaxelErrorDetails(error)).toMatchObject({
      code: 'WORKLOAD_UNAVAILABLE',
      message: 'not ready',
      origin: 'platform',
      retryable: true,
      status: 404,
    });
    expect(isBlaxelWorkloadUnavailable(error)).toBe(true);
    expect(shouldRetryBlaxelLifecycleError(error)).toBe(false);
  });

  it('recognizes a missing sandbox record', () => {
    expect(
      isBlaxelResourceNotFound({
        error: {
          code: 'WORKLOAD_NOT_FOUND',
          origin: 'platform',
          status: 404,
        },
      }),
    ).toBe(true);
  });

  it('does not treat route or application 404s as missing sandboxes', () => {
    expect(
      isBlaxelResourceNotFound({
        error: { code: 'ROUTE_NOT_FOUND', origin: 'platform', status: 404 },
      }),
    ).toBe(false);
    expect(
      isBlaxelResourceNotFound({
        error: { code: 404, origin: 'application', message: 'not found' },
      }),
    ).toBe(false);
  });

  it('does not retry lifecycle operations for application-origin errors', () => {
    expect(
      shouldRetryBlaxelLifecycleError({
        error: { code: 404, origin: 'application', message: 'not found' },
      }),
    ).toBe(false);
  });

  it('honors an explicit non-retryable workload response', () => {
    expect(
      isBlaxelWorkloadUnavailable({
        error: {
          code: 'WORKLOAD_UNAVAILABLE',
          origin: 'platform',
          retryable: false,
        },
      }),
    ).toBe(false);
  });

  it('does not retry deterministic client errors', () => {
    const error = new Error(
      '400 {"error":{"status":400,"message":"metadata.externalId is invalid","origin":"platform"}}',
    );

    expect(shouldRetryBlaxelLifecycleError(error)).toBe(false);
  });

  it.each([408, 429])('allows retryable client status %s', (status) => {
    const error = new Error(
      `${status} {"error":{"status":${status},"message":"try again","origin":"platform","retryable":true}}`,
    );

    expect(shouldRetryBlaxelLifecycleError(error)).toBe(true);
  });

  it('reads structured details from a wrapped SDK error cause', () => {
    expect(
      getBlaxelErrorDetails(
        new Error('request failed', {
          cause: {
            error: {
              code: 'WORKLOAD_NOT_FOUND',
              origin: 'platform',
              status: 404,
            },
          },
        }),
      ),
    ).toMatchObject({
      code: 'WORKLOAD_NOT_FOUND',
      origin: 'platform',
      status: 404,
    });
  });
});
