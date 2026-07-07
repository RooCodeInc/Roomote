import type { IncomingHttpHeaders, IncomingMessage } from 'http';

import {
  generateTraceparent,
  getHeaderValue,
  isValidTraceparent,
  resolveRequestCorrelation,
} from '../request-correlation';

function createMockReq(
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    method: 'GET',
    url: '/',
    headers: { host: 'test.example.com' },
    ...overrides,
  } as IncomingMessage;
}

describe('request correlation helpers', () => {
  it('preserves a valid inbound traceparent', () => {
    const traceparent =
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    const result = resolveRequestCorrelation(
      createMockReq({
        headers: {
          host: 'test.example.com',
          traceparent,
          'x-request-id': 'req-123',
        },
      }),
    );

    expect(result.requestContext.requestId).toBe('req-123');
    expect(result.requestContext.traceparent).toBe(traceparent);
    expect(result.dropTracestate).toBe(false);
  });

  it('generates a request id and traceparent when missing', () => {
    const result = resolveRequestCorrelation(createMockReq());

    expect(result.requestContext.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(isValidTraceparent(result.requestContext.traceparent)).toBe(true);
    expect(result.dropTracestate).toBe(true);
  });

  it('restarts malformed inbound traceparent values', () => {
    const invalidTraceparent = '00-not-valid-parent';

    const result = resolveRequestCorrelation(
      createMockReq({
        headers: {
          host: 'test.example.com',
          traceparent: invalidTraceparent,
          tracestate: 'vendor=value',
        },
      }),
    );

    expect(result.requestContext.traceparent).not.toBe(invalidTraceparent);
    expect(isValidTraceparent(result.requestContext.traceparent)).toBe(true);
    expect(result.dropTracestate).toBe(true);
  });

  it('generates lowercase non-zero trace ids and parent ids', () => {
    const traceparent = generateTraceparent();
    const [, traceId, parentId, flags] =
      traceparent.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/) ??
      [];

    expect(traceId).toBeDefined();
    expect(parentId).toBeDefined();
    expect(flags).toBe('01');
    expect(traceId).not.toMatch(/^0+$/);
    expect(parentId).not.toMatch(/^0+$/);
  });

  it('normalizes array-valued header values', () => {
    const headers = {
      host: 'test.example.com',
      'x-request-id': ['', 'req-array'],
      traceparent: [
        '',
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      ],
      'x-forwarded-host': [' ', 'forwarded.example.com'],
    } as IncomingHttpHeaders;

    const req = createMockReq({
      headers,
    });

    expect(getHeaderValue(req.headers, 'x-forwarded-host')).toBe(
      'forwarded.example.com',
    );

    const result = resolveRequestCorrelation(req);
    expect(result.requestContext.requestId).toBe('req-array');
    expect(result.requestContext.traceparent).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
  });
});
